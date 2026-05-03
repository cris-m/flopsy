/**
 * Live config reloader for `flopsy.json5`. Polls via `fs.watchFile` (handles
 * atomic .tmp→rename cleanly), diffs against in-memory config, and dispatches
 * per-path hot/restart handlers.
 *
 * `.env` is NOT watched — subprocess env is frozen at spawn, so secret
 * rotation goes through `flopsy env reload` instead.
 */

import { watchFile, unwatchFile } from 'node:fs';
import { createLogger, loadConfig, clearConfigCache, type FlopsyConfig } from '@flopsy/shared';

const log = createLogger('config-reload');

export type ReloadMode = 'hot' | 'restart';

export interface ReloadHandlerContext {
    readonly oldConfig: FlopsyConfig;
    readonly newConfig: FlopsyConfig;
    readonly changedPath: string;
    readonly oldValue: unknown;
    readonly newValue: unknown;
}

export interface ReloadRule {
    /** `*` matches one segment, `**` matches any depth. */
    readonly pattern: string;
    readonly mode: ReloadMode;
    readonly handler?: (ctx: ReloadHandlerContext) => Promise<void>;
    readonly reason?: string;
}

function compilePattern(pattern: string): RegExp {
    // `*` MUST be in the escape class — without it `**` survives unchanged
    // through step 1, leaving a literal `**` that RegExp rejects.
    const src = pattern
        .replace(/[.+?^${}()|[\]\\*]/g, '\\$&')
        .replace(/\\\*\\\*/g, '.*')
        .replace(/\\\*/g, '[^.]+');
    return new RegExp(`^${src}$`);
}

/** Returns dotted paths where `before` and `after` differ. */
export function diffConfigPaths(
    before: unknown,
    after: unknown,
    prefix = '',
): string[] {
    if (before === after) return [];
    const isObj = (v: unknown): v is Record<string, unknown> =>
        v !== null && typeof v === 'object' && !Array.isArray(v);

    if (isObj(before) && isObj(after)) {
        const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
        const out: string[] = [];
        for (const k of keys) {
            const p = prefix ? `${prefix}.${k}` : k;
            out.push(...diffConfigPaths(before[k], after[k], p));
        }
        return out;
    }
    if (Array.isArray(before) && Array.isArray(after)) {
        const max = Math.max(before.length, after.length);
        const out: string[] = [];
        for (let i = 0; i < max; i++) {
            out.push(...diffConfigPaths(before[i], after[i], `${prefix}.${i}`));
        }
        return out;
    }
    return [prefix || '(root)'];
}

export function getByPath(obj: unknown, path: string): unknown {
    const parts = path.split('.');
    let cur: unknown = obj;
    for (const p of parts) {
        if (cur === null || cur === undefined) return undefined;
        if (Array.isArray(cur)) cur = cur[Number(p)];
        else if (typeof cur === 'object') cur = (cur as Record<string, unknown>)[p];
        else return undefined;
    }
    return cur;
}

export interface ReloadPlan {
    readonly hot: ReadonlyArray<{
        path: string;
        rule: ReloadRule;
    }>;
    readonly restartRequired: ReadonlyArray<{
        path: string;
        rule: ReloadRule;
    }>;
    readonly ignored: ReadonlyArray<string>;
}

export function buildReloadPlan(
    changedPaths: readonly string[],
    rules: readonly ReloadRule[],
): ReloadPlan {
    const hot: Array<{ path: string; rule: ReloadRule }> = [];
    const restartRequired: Array<{ path: string; rule: ReloadRule }> = [];
    const ignored: string[] = [];
    for (const path of changedPaths) {
        const rule = rules.find((r) => compilePattern(r.pattern).test(path));
        if (!rule) {
            ignored.push(path);
            continue;
        }
        if (rule.mode === 'hot') hot.push({ path, rule });
        else restartRequired.push({ path, rule });
    }
    return { hot, restartRequired, ignored };
}

export interface ConfigReloaderOptions {
    readonly configPath: string;
    readonly rules: readonly ReloadRule[];
    /** Default 300. */
    readonly debounceMs?: number;
    /** Default 1000. */
    readonly pollMs?: number;
    readonly onApplied?: (newConfig: FlopsyConfig, plan: ReloadPlan) => void;
}

export class ConfigReloader {
    private current: FlopsyConfig;
    private debounceHandle: NodeJS.Timeout | null = null;
    private running = false;

    constructor(initial: FlopsyConfig, private readonly opts: ConfigReloaderOptions) {
        this.current = initial;
    }

    start(): void {
        if (this.running) return;
        this.running = true;
        watchFile(
            this.opts.configPath,
            { interval: this.opts.pollMs ?? 1000 },
            () => this.scheduleReload(),
        );
        log.info(
            { path: this.opts.configPath, rules: this.opts.rules.length },
            'config-reload: watching',
        );
    }

    stop(): void {
        if (!this.running) return;
        this.running = false;
        if (this.debounceHandle) clearTimeout(this.debounceHandle);
        unwatchFile(this.opts.configPath);
        log.info('config-reload: stopped');
    }

    async reload(): Promise<ReloadPlan | null> {
        return this.doReload();
    }

    private scheduleReload(): void {
        if (this.debounceHandle) clearTimeout(this.debounceHandle);
        this.debounceHandle = setTimeout(
            () => void this.doReload(),
            this.opts.debounceMs ?? 300,
        );
    }

    private async doReload(): Promise<ReloadPlan | null> {
        try {
            // Shared loader caches; invalidate before re-read.
            clearConfigCache();
            const next = loadConfig(this.opts.configPath);
            const changes = diffConfigPaths(this.current, next);
            if (changes.length === 0) {
                log.debug('config-reload: file changed but no semantic diff');
                this.current = next;
                return null;
            }

            const plan = buildReloadPlan(changes, this.opts.rules);
            log.info(
                {
                    hot: plan.hot.length,
                    restartRequired: plan.restartRequired.length,
                    ignored: plan.ignored.length,
                },
                'config-reload: plan built',
            );

            // Partial apply preferred over zero apply on handler errors.
            for (const { path, rule } of plan.hot) {
                const ctx: ReloadHandlerContext = {
                    oldConfig: this.current,
                    newConfig: next,
                    changedPath: path,
                    oldValue: getByPath(this.current, path),
                    newValue: getByPath(next, path),
                };
                try {
                    if (rule.handler) await rule.handler(ctx);
                    log.info({ path, reason: rule.reason }, 'config-reload: hot-applied');
                } catch (err) {
                    log.error({ err, path }, 'config-reload: hot handler failed');
                }
            }

            for (const { path, rule } of plan.restartRequired) {
                log.warn(
                    { path, reason: rule.reason },
                    'config-reload: restart required — run `flopsy gateway restart`',
                );
            }

            this.current = next;
            this.opts.onApplied?.(next, plan);
            return plan;
        } catch (err) {
            log.error({ err }, 'config-reload: reload failed, keeping old config');
            return null;
        }
    }
}
