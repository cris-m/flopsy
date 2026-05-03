import { z } from 'zod';
import { defineTool } from 'flopsygraph';
import { googleDeviceFlow, type StoredCredential } from '@flopsy/cli';
import type { IEventQueue } from '@flopsy/gateway';
import { startDevicePolling, type DevicePollerHandle } from '../auth/device-poller';
import type { TaskRegistry } from '../state/task-registry';
import { createBackgroundJobTask, toTerminal, toRunning } from '../state/task-state';

// Per-(provider, threadId) lock prevents concurrent pollers double-firing task_complete.
const ACTIVE_DEVICE_POLLS = new Map<string, DevicePollerHandle>();

function pollKey(provider: string, threadId: string): string {
    return `${provider}:${threadId}`;
}

interface ConnectServiceConfigurable {
    readonly onReply?: (
        text: string,
        options?: { buttons?: ReadonlyArray<{ label: string; value: string; style?: string }> },
    ) => Promise<void> | void;
    readonly threadId?: string;
    readonly eventQueue?: IEventQueue;
    readonly registry?: TaskRegistry;
    /** Restart MCP servers that requiresAuth for the given provider. */
    readonly onAuthSuccess?: (provider: string) => Promise<void>;
}

export const connectServiceTool = defineTool({
    name: 'connect_service',
    description: [
        'ONE-TIME OAUTH SETUP ONLY. Starts a Google device-code authorization',
        'flow. The user gets a URL + short code, signs in on their phone, and',
        'a success notification arrives in a later turn.',
        '',
        'DO NOT USE for reading / sending / listing email, calendar events,',
        'drive files, notes, etc. — those are already authorized via the',
        'existing credentials file and must be reached by DELEGATING to the',
        'worker that owns the corresponding MCP server (see the hard routing',
        'table in your role instructions). Calling connect_service when the',
        'user just wants to read their inbox will TRIGGER A DUPLICATE OAUTH',
        'CONSENT — which is noisy, confusing, and never what the user wants.',
        '',
        'ONLY call this tool when the user explicitly asks to authorize,',
        'connect, or link a new account, OR when a worker reports that the',
        'stored credential is revoked / expired / missing.',
    ].join('\n'),
    schema: z.object({
        provider: z
            .enum(['google'])
            .describe('Service to authorize. Today: only "google".'),
        scopes: z
            .array(z.string())
            .nullable()
            .optional()
            .describe(
                'Optional. OMIT THIS FIELD — the default scope set is correct. ' +
                'Defaults to device-flow-safe set: gmail.readonly, gmail.send, ' +
                'calendar, drive.file, openid, email, profile. ' +
                'Only override if you have a specific narrower or wider need. ' +
                'Any extra scope MUST be (a) on Google\'s device-flow allowlist ' +
                'and (b) registered on the OAuth consent screen, or Google ' +
                'rejects with `invalid_scope`. Passing `null` is treated as omit.',
            ),
    }),
    execute: async ({ provider, scopes: rawScopes }, ctx) => {
        const scopes = rawScopes ?? undefined;
        const cfg = (ctx.configurable ?? {}) as ConnectServiceConfigurable;
        const onReply = cfg.onReply;
        const threadId = cfg.threadId;
        const eventQueue = cfg.eventQueue;
        const registry = cfg.registry;
        const onAuthSuccess = cfg.onAuthSuccess;

        if (!onReply || !threadId || !eventQueue) {
            return 'connect_service: not wired (missing onReply/threadId/eventQueue in configurable).';
        }
        if (provider !== 'google') {
            return `connect_service: provider "${provider}" not supported yet.`;
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
            start = await googleDeviceFlow.start(scopes);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('invalid_scope')) {
                return [
                    'connect_service: Google rejected the scope request (invalid_scope).',
                    'This is a one-time setup issue — the OAuth consent screen needs the API scopes added.',
                    'Fix: Google Cloud Console → OAuth consent screen → "Add or Remove Scopes" → add:',
                    '  • Gmail API (gmail.readonly, gmail.send)',
                    '  • Google Calendar API',
                    '  • Google Drive API (drive.file)',
                    'Then retry. Do NOT ask the user which scopes to use — the defaults are correct.',
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
            provider: 'google',
            deviceCode: start.deviceCode,
            intervalSeconds: start.intervalSeconds,
            expiresAt: start.expiresAt,
            ...(scopes ? { scopes } : {}),
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
                        `MCP servers for ${provider} (gmail, calendar, drive, youtube) have been restarted with the new credentials — tools are ready immediately.`,
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

        return `Sent device-flow instructions to user (task ${taskId}). Poller running; no further action this turn.`;
    },
});
