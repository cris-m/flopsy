/**
 * connect_service — in-chat OAuth onboarding via device flow.
 *
 * USAGE: agent calls this when the user says "connect my gmail" / "link
 * my Google account" / "I want to use Gmail tools". The tool:
 *   1. Initiates Google's device authorization flow (RFC 8628)
 *   2. Sends the user a chat message with the user_code + URL
 *   3. Spawns a background poller that hits Google's token endpoint
 *      every few seconds until the user completes the flow on their phone
 *   4. On completion, fires a chat message back to the same thread
 *      ("✓ Connected user@gmail.com — Gmail tools available next turn")
 *
 * Why device flow (not magic-link callback)?
 *   The user is on their phone in Telegram. A localhost callback link
 *   wouldn't reach the gateway. Device flow has the user authorize on
 *   Google's existing site (which they're already logged into) — works
 *   on any device, any network.
 *
 * Wiring contract (from ctx.configurable):
 *   - onReply: send the user_code + URL message
 *   - threadId: where to deliver the success notification
 *   - peer: user identity (logged for diagnostics)
 *   - eventQueue: where success notification lands as a task_complete event
 *   - registry: TaskRegistry — used to track the "connecting..." task in /status
 */

import { z } from 'zod';
import { defineTool } from 'flopsygraph';
import { googleDeviceFlow, type StoredCredential } from '@flopsy/cli';
import type { IEventQueue } from '@flopsy/gateway';
import { startDevicePolling } from '../auth/device-poller';
import type { TaskRegistry } from '../state/task-registry';
import { createBackgroundJobTask, toTerminal, toRunning } from '../state/task-state';

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
            .optional()
            .describe(
                'Optional scope override. Default = device-flow-safe set: ' +
                'gmail.readonly, gmail.send, calendar, drive.file, openid, email, profile. ' +
                'Any extra scope you pass MUST be (a) on Google\'s device-flow ' +
                'allowlist and (b) registered on the OAuth consent screen, or ' +
                'Google rejects with `invalid_scope`.',
            ),
    }),
    execute: async ({ provider, scopes }, ctx) => {
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

        let start: Awaited<ReturnType<typeof googleDeviceFlow.start>>;
        try {
            start = await googleDeviceFlow.start(scopes);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // invalid_scope means the OAuth consent screen is missing scopes —
            // give the user a direct fix instead of exposing RFC error text.
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

        // Register a task in the per-thread registry so /status shows
        // "connecting..." until completion. Reuses the background_job
        // shape — connect_service is morally similar to a long-running
        // background job (waits on user input, then settles).
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

        // Tell the user how to complete on their phone.
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

        // Kick off the poller in the background. It uses the eventQueue
        // to push a task_complete back to the channel-worker — gandalf
        // wakes up on the next turn and tells the user.
        startDevicePolling({
            provider: 'google',
            deviceCode: start.deviceCode,
            intervalSeconds: start.intervalSeconds,
            expiresAt: start.expiresAt,
            ...(scopes ? { scopes } : {}),
            onSuccess: async (cred: StoredCredential) => {
                if (registry) {
                    const t = registry.get(taskId);
                    if (t) {
                        const done = toTerminal(t, 'completed', {
                            result: `connected ${cred.email ?? '(unknown email)'}`,
                        });
                        if (done.ok) registry.replace(done.task);
                    }
                }
                // Restart MCP servers that use this provider so they pick up
                // the new credentials immediately — no gateway restart needed.
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

        return `Sent device-flow instructions to user (task ${taskId}). Poller running; no further action this turn.`;
    },
});
