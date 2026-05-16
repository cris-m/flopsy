import { spawn } from 'node:child_process';
import { createLogger } from '@flopsy/shared';
import type { HookContext, RegisteredHook } from './types';

const log = createLogger('hooks-registry');

const MAX_CONCURRENT_HANDLERS = 8;
const SHELL_HOOK_TIMEOUT_MS = 30_000;

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

    emit(event: string, context: Omit<HookContext, 'eventType' | 'firedAt'>): void {
        const firedAt = Date.now();
        const ctx: HookContext = { ...context, eventType: event, firedAt };
        const matches = this.hooks.filter((h) => h.config.events.some((e) => matchesEvent(e, event)));
        if (matches.length === 0) return;

        void this.dispatch(event, ctx, matches);
    }

    private async dispatch(
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
    ): Promise<void> {
        const start = Date.now();
        try {
            if (hook.kind === 'ts' && hook.handler) {
                await hook.handler(event, ctx);
            } else if (hook.kind === 'script' && hook.scriptPath) {
                await this.runScript(hook.scriptPath, event, ctx);
            }
            const elapsed = Date.now() - start;
            log.debug({ hookId: hook.id, event, elapsedMs: elapsed }, 'hook fired');
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
        }
    }

    private runScript(scriptPath: string, event: string, ctx: HookContext): Promise<void> {
        return new Promise((resolve) => {
            const child = spawn(scriptPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
            const timer = setTimeout(() => {
                try {
                    child.kill('SIGTERM');
                } catch {
                    /* ignore */
                }
            }, SHELL_HOOK_TIMEOUT_MS);

            let stderr = '';
            child.stderr.on('data', (chunk: Buffer) => {
                if (stderr.length < 8 * 1024) stderr += chunk.toString('utf8');
            });
            child.on('close', (code) => {
                clearTimeout(timer);
                if (code !== 0) {
                    log.warn(
                        { scriptPath, event, exitCode: code, stderr: stderr.slice(0, 400) },
                        'shell hook exited non-zero',
                    );
                }
                resolve();
            });
            child.on('error', (err) => {
                clearTimeout(timer);
                log.warn({ scriptPath, event, err: err.message }, 'shell hook spawn error');
                resolve();
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
