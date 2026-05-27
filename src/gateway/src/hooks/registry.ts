import { spawn } from 'node:child_process';
import { createLogger } from '@flopsy/shared';
import type { HookAggregate, HookContext, HookResult, RegisteredHook } from './types';

const log = createLogger('hooks-registry');

const MAX_CONCURRENT_HANDLERS = 8;
const SHELL_HOOK_TIMEOUT_MS = 30_000;
const SHELL_STDOUT_MAX_BYTES = 16 * 1024;

/**
 * Events where a pre-hook handler may return `{action:'block'}` (to short-circuit
 * the chokepoint) or `{context:'...'}` (to inject into the agent's prompt). Each
 * entry MUST correspond to an emit site that uses `emitHookAwait` and actually
 * honors the result — declaring an event block-capable without gating its
 * chokepoint is a lie to hook authors.
 *
 * Observation-only events (turn.user.received, turn.assistant.completed,
 * goal.done, goal.paused) use `emitHook` and ignore the return value.
 */
export const BLOCK_CAPABLE_EVENTS: ReadonlySet<string> = new Set([
    'memory.fact.ingested',
    'skill.proposed',
]);

function matchesEvent(subscribed: string, fired: string): boolean {
    if (subscribed === fired) return true;
    if (subscribed.endsWith('.*')) {
        const prefix = subscribed.slice(0, -1);
        return fired.startsWith(prefix);
    }
    return false;
}

export class HookRegistry {
    private hooks: readonly RegisteredHook[] = [];

    setHooks(hooks: readonly RegisteredHook[]): void {
        this.hooks = hooks;
    }

    list(): readonly RegisteredHook[] {
        return this.hooks;
    }

    /**
     * Fire-and-forget dispatch for observation-only events. Handler return values
     * are discarded; concurrency is 8-wide batches.
     */
    emit(event: string, context: Omit<HookContext, 'eventType' | 'firedAt'>): void {
        const firedAt = Date.now();
        const ctx: HookContext = { ...context, eventType: event, firedAt };
        const matches = this.hooks.filter((h) => h.config.events.some((e) => matchesEvent(e, event)));
        if (matches.length === 0) return;

        void this.dispatchParallel(event, ctx, matches);
    }

    /**
     * Serial dispatch for block-capable events. Returns once all handlers have run
     * or the first one returns `{action:'block'}` — subsequent handlers do NOT run.
     * `{context:'...'}` results accumulate in `contexts`.
     */
    async emitAwait(
        event: string,
        context: Omit<HookContext, 'eventType' | 'firedAt'>,
    ): Promise<HookAggregate> {
        const firedAt = Date.now();
        const ctx: HookContext = { ...context, eventType: event, firedAt };
        const matches = this.hooks.filter((h) => h.config.events.some((e) => matchesEvent(e, event)));
        const out: HookAggregate = { blocked: null, contexts: [] };
        if (matches.length === 0) return out;

        for (const hook of matches) {
            const result = await this.runOne(event, ctx, hook);
            if (!result) continue;
            if ('action' in result && result.action === 'block') {
                out.blocked = { hookId: hook.id, ...(result.message !== undefined ? { message: result.message } : {}) };
                return out;
            }
            if ('context' in result && typeof result.context === 'string' && result.context.length > 0) {
                out.contexts.push(result.context);
            }
        }
        return out;
    }

    private async dispatchParallel(
        event: string,
        ctx: HookContext,
        matches: readonly RegisteredHook[],
    ): Promise<void> {
        for (let i = 0; i < matches.length; i += MAX_CONCURRENT_HANDLERS) {
            const batch = matches.slice(i, i + MAX_CONCURRENT_HANDLERS);
            await Promise.all(batch.map((h) => this.runOne(event, ctx, h)));
        }
    }

    private async runOne(
        event: string,
        ctx: HookContext,
        hook: RegisteredHook,
    ): Promise<HookResult> {
        const start = Date.now();
        try {
            let result: HookResult;
            if (hook.kind === 'ts' && hook.handler) {
                const ret = await hook.handler(event, ctx);
                result = ret ?? undefined;
            } else if (hook.kind === 'script' && hook.scriptPath) {
                result = await this.runScript(hook.scriptPath, event, ctx);
            }
            log.debug({ hookId: hook.id, event, elapsedMs: Date.now() - start }, 'hook fired');
            return result;
        } catch (err) {
            log.warn(
                {
                    hookId: hook.id,
                    event,
                    err: err instanceof Error ? err.message : String(err),
                    elapsedMs: Date.now() - start,
                },
                'hook handler threw — swallowed (other hooks continue)',
            );
            return undefined;
        }
    }

    private runScript(scriptPath: string, event: string, ctx: HookContext): Promise<HookResult> {
        return new Promise((resolve) => {
            const hookEnv: NodeJS.ProcessEnv = {
                PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
                HOME: process.env.HOME ?? '',
                LANG: process.env.LANG ?? 'C.UTF-8',
                FLOPSY_HOOK_EVENT: event,
                // Hooks resolve workspace paths against FLOPSY_HOME; pass it through
                // (not a secret — just the workspace root) so a shell hook writing to
                // <FLOPSY_HOME>/logs lands in the real workspace, not the HOME fallback.
                ...(process.env.FLOPSY_HOME ? { FLOPSY_HOME: process.env.FLOPSY_HOME } : {}),
            };
            const child = spawn(scriptPath, [], {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: hookEnv,
            });
            let killTimer: NodeJS.Timeout | undefined;
            const timer = setTimeout(() => {
                try { child.kill('SIGTERM'); } catch { /* ignore */ }
                killTimer = setTimeout(() => {
                    try { child.kill('SIGKILL'); } catch { /* ignore */ }
                }, 2000);
                killTimer.unref?.();
            }, SHELL_HOOK_TIMEOUT_MS);

            let stderr = '';
            let stdout = '';
            child.stderr.on('data', (chunk: Buffer) => {
                if (stderr.length < 8 * 1024) stderr += chunk.toString('utf8');
            });
            child.stdout.on('data', (chunk: Buffer) => {
                if (stdout.length < SHELL_STDOUT_MAX_BYTES) stdout += chunk.toString('utf8');
            });
            child.on('close', (code) => {
                if (killTimer) clearTimeout(killTimer);
                clearTimeout(timer);
                const trimmed = stdout.trim();
                if (code === 0) {
                    resolve(undefined);
                    return;
                }
                if (code === 1) {
                    resolve({ action: 'block', ...(trimmed ? { message: trimmed } : {}) });
                    return;
                }
                if (code === 2) {
                    if (trimmed) resolve({ context: trimmed });
                    else resolve(undefined);
                    return;
                }
                log.warn(
                    { scriptPath, event, exitCode: code, stderr: stderr.slice(0, 400) },
                    'shell hook exited with unrecognised code',
                );
                resolve(undefined);
            });
            child.on('error', (err) => {
                clearTimeout(timer);
                log.warn({ scriptPath, event, err: err.message }, 'shell hook spawn error');
                resolve(undefined);
            });
            try {
                child.stdin.end(JSON.stringify(ctx));
            } catch (err) {
                log.warn({ scriptPath, event, err: err instanceof Error ? err.message : String(err) }, 'shell hook stdin write failed');
            }
        });
    }
}

let registry: HookRegistry | null = null;

export function setHookRegistry(r: HookRegistry | null): void {
    registry = r;
}

export function getHookRegistry(): HookRegistry | null {
    return registry;
}

export function emitHook(event: string, context: Omit<HookContext, 'eventType' | 'firedAt'>): void {
    registry?.emit(event, context);
}

export async function emitHookAwait(
    event: string,
    context: Omit<HookContext, 'eventType' | 'firedAt'>,
): Promise<HookAggregate> {
    if (!registry) return { blocked: null, contexts: [] };
    return registry.emitAwait(event, context);
}
