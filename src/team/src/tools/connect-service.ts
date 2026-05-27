import { z } from 'zod';
import { defineTool } from 'flopsygraph';
import {
    googleDeviceFlow,
    DEVICE_FLOW_SUPPORTED_SCOPES,
    type StoredCredential,
} from '@flopsy/cli';
import type { IEventQueue } from '@flopsy/gateway';
import { startDevicePolling, type DevicePollerHandle } from '../auth/device-poller';
import type { TaskRegistry } from '../state/task-registry';
import { createBackgroundJobTask, toTerminal, toRunning } from '../state/task-state';

const ACTIVE_DEVICE_POLLS = new Map<string, DevicePollerHandle>();

function pollKey(provider: string, threadId: string): string {
    return `${provider}:${threadId}`;
}

const PER_SERVICE_PROVIDERS = ['gmail', 'drive', 'calendar', 'youtube', 'contacts'] as const;
type PerServiceProvider = (typeof PER_SERVICE_PROVIDERS)[number];

const DEVICE_FLOW_BLOCKED_REASON: Readonly<Record<PerServiceProvider, string | null>> = {
    gmail: 'Google blocks Gmail scopes from the device-flow client type',
    drive: 'Google device flow only grants narrow drive.file scope (would lose full drive access)',
    contacts: 'Google does not allow contacts scopes via device flow',
    youtube: null,
    calendar: null,
};

interface ConnectServiceConfigurable {
    readonly onReply?: (
        text: string,
        options?: { buttons?: ReadonlyArray<{ label: string; value: string; style?: string }> },
    ) => Promise<void> | void;
    readonly threadId?: string;
    readonly eventQueue?: IEventQueue;
    readonly registry?: TaskRegistry;
    readonly onAuthSuccess?: (provider: string) => Promise<void>;
}

export const connectServiceTool = defineTool({
    name: 'connect_service',
    description: [
        'One-time per-service Google OAuth setup. Each provider writes its own credential file; there is no "google" catch-all.',
        '',
        'Providers:',
        '  gmail    — email/inbox',
        '  calendar — schedule/meetings',
        '  drive    — documents/files',
        '  youtube  — subscriptions/videos',
        '  contacts — address book',
        '',
        'Behaviour (set by Google policy):',
        '  - youtube, calendar — device flow works. User receives URL + code, authorises on another device, success arrives in a later turn.',
        '  - gmail, drive, contacts — device flow blocked by Google. Tool returns instructions to run `flopsy auth <service>` in a terminal and starts no OAuth flow.',
        '',
        'Call when the user asks to authenticate/connect/link a specific service, or a worker reports invalid_grant / revoked / "credential missing" for that service.',
        '',
        'Style:',
        '  - if the user says "connect google" generically, ask which service first.',
        '  - for plain use requests ("read my email"), delegate to the owning worker. Don\'t trigger a duplicate consent.',
    ].join('\n'),
    schema: z.object({
        provider: z
            .enum(PER_SERVICE_PROVIDERS)
            .describe(
                'Which Google service to authorize. Pick the specific one the ' +
                    'user named or implied. There is no "google" catch-all.',
            ),
    }),
    execute: async ({ provider }, ctx) => {
        const cfg = (ctx.configurable ?? {}) as ConnectServiceConfigurable;
        const onReply = cfg.onReply;
        const threadId = cfg.threadId;
        const eventQueue = cfg.eventQueue;
        const registry = cfg.registry;
        const onAuthSuccess = cfg.onAuthSuccess;

        if (!onReply || !threadId || !eventQueue) {
            return 'connect_service: not wired (missing onReply/threadId/eventQueue in configurable).';
        }

        const blockedReason = DEVICE_FLOW_BLOCKED_REASON[provider];
        if (blockedReason) {
            const message = [
                `I can't connect ${provider} from here — ${blockedReason}.`,
                ``,
                `To authorize ${provider}, run this in a terminal on the machine running Flopsy:`,
                ``,
                `  flopsy auth ${provider}`,
                ``,
                `That opens a browser for the OAuth consent (which Google allows for ${provider} scopes),`,
                `saves the credential to .flopsy/auth/${provider}.json, and the ${provider} MCP will`,
                `pick it up on the next request.`,
            ].join('\n');
            try {
                await onReply(message);
            } catch (err) {
                return `connect_service: failed to send instructions: ${err instanceof Error ? err.message : String(err)}`;
            }
            return `Told user to run \`flopsy auth ${provider}\` in a terminal (device flow not available for ${provider}).`;
        }

        const deviceScopes = DEVICE_FLOW_SUPPORTED_SCOPES[provider];
        if (!deviceScopes) {
            return `connect_service: internal error — no device-flow scope set for "${provider}".`;
        }

        const key = pollKey(provider, threadId);
        if (ACTIVE_DEVICE_POLLS.has(key)) {
            return [
                `connect_service: a ${provider} authorization is already in progress for this thread.`,
                `Check the verification code I sent earlier and complete the flow on your phone.`,
                `If you want to start over, ignore the old code — once it expires (~15 min), call connect_service again.`,
            ].join('\n');
        }

        let start: Awaited<ReturnType<typeof googleDeviceFlow.start>>;
        try {
            start = await googleDeviceFlow.start(deviceScopes);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('invalid_scope')) {
                return [
                    `connect_service: Google rejected the scope request for ${provider} (invalid_scope).`,
                    `This usually means the OAuth consent screen is missing the API scopes for ${provider}.`,
                    `Fix: Google Cloud Console → OAuth consent screen → Add or Remove Scopes →`,
                    provider === 'youtube'
                        ? `add YouTube Data API v3 scopes (youtube, youtube.readonly).`
                        : `add Google Calendar API scope (auth/calendar).`,
                    `Then retry.`,
                ].join('\n');
            }
            return `connect_service: ${msg}`;
        }

        const taskId = registry ? registry.nextId('background_job') : `auth_${Date.now()}`;
        if (registry) {
            const task = createBackgroundJobTask({
                id: taskId,
                prompt: `OAuth device flow: connect ${provider} account`,
                description: `connect ${provider} account`,
                depth: 0,
            });
            registry.register(task);
            const running = toRunning(task);
            if (running.ok) registry.replace(running.task);
        }

        const expiresMins = Math.max(1, Math.round((start.expiresAt - Date.now()) / 60_000));
        const verifyUrl = start.verificationUrlComplete ?? start.verificationUrl;
        const message = [
            `Authorize ${provider} on your phone:`,
            ``,
            `  1. Open: ${verifyUrl}`,
            `  2. Enter code: \`${start.userCode}\``,
            ``,
            `Code expires in ~${expiresMins} min. I'll let you know when it's done.`,
        ].join('\n');

        try {
            await onReply(message);
        } catch (err) {
            return `connect_service: failed to send instructions: ${err instanceof Error ? err.message : String(err)}`;
        }

        const handle = startDevicePolling({
            provider,
            deviceCode: start.deviceCode,
            intervalSeconds: start.intervalSeconds,
            expiresAt: start.expiresAt,
            scopes: deviceScopes,
            onSuccess: async (cred: StoredCredential) => {
                ACTIVE_DEVICE_POLLS.delete(key);
                if (registry) {
                    const t = registry.get(taskId);
                    if (t) {
                        const done = toTerminal(t, 'completed', {
                            result: `connected ${cred.email ?? '(unknown email)'}`,
                        });
                        if (done.ok) registry.replace(done.task);
                    }
                }
                if (onAuthSuccess) {
                    try { await onAuthSuccess(provider); } catch { /* logged inside */ }
                }
                eventQueue.push({
                    type: 'task_complete',
                    taskId,
                    result: [
                        `Authorized ${provider} as ${cred.email ?? '(account)'}.`,
                        `Scopes granted: ${cred.scopes.join(', ')}`,
                        `The ${provider} MCP has been restarted with the new credential — its tools are ready immediately.`,
                    ].join('\n'),
                    completedAt: Date.now(),
                });
            },
            onFailure: (reason, detail) => {
                ACTIVE_DEVICE_POLLS.delete(key);
                if (registry) {
                    const t = registry.get(taskId);
                    if (t) {
                        const failed = toTerminal(t, 'failed', { error: detail ?? reason });
                        if (failed.ok) registry.replace(failed.task);
                    }
                }
                eventQueue.push({
                    type: 'task_error',
                    taskId,
                    error: `Authorization ${reason}${detail ? `: ${detail}` : ''}.`,
                    completedAt: Date.now(),
                });
            },
        });

        ACTIVE_DEVICE_POLLS.set(key, handle);

        return `Sent device-flow instructions to user for ${provider} (task ${taskId}). Poller running; no further action this turn.`;
    },
});
