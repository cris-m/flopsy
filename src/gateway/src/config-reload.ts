/**
 * Live config reloader for `flopsy.json5`.
 *
 * Watches the config file (polling via `fs.watchFile` — handles atomic
 * `.tmp → rename` writes cleanly, unlike `fs.watch`), diffs each change
 * against the in-memory config, and dispatches per-path handlers.
 *
 * Design borrowed from openclaw's `src/gateway/config-reload.ts`:
 *   1. File watcher with debounce + write-settle delay
 *   2. Recursive diff producing a list of changed dotted paths
 *   3. Rule table — each path declares mode ('hot' | 'restart') + handler
 *   4. Planner matches changed paths against rules, produces a plan,
 *      then executes hot handlers (restart-required changes are logged
 *      with a clear warning; the user triggers `flopsy gateway restart`
 *      when ready).
 *
 * Scope of this module:
 *   - The MACHINERY (watch, diff, dispatch) is complete.
 *   - The HANDLERS are wired per-subsystem by callers (see `gateway.ts`).
 *   - We do NOT watch `.env` here — secret rotation has different
 *     semantics (subprocess env is frozen at spawn); `.env` changes are
 *     handled by the explicit `flopsy env reload` CLI command.
 */

import { watchFile, unwatchFile } from 'node:fs';
import { createLogger, loadConfig, clearConfigCache, type FlopsyConfig } from '@flopsy/shared';

const log = createLogger('config-reload');

/** How a changed path should be handled. */
export type ReloadMode = 'hot' | 'restart';

export interface ReloadHandlerContext {
    readonly oldConfig: FlopsyConfig;
    readonly newConfig: FlopsyConfig;
    readonly changedPath: string;
    readonly oldValue: unknown;
    readonly newValue: unknown;
}

export interface ReloadRule {
    /**
     * Dotted path pattern. `*` matches a single segment, `**` matches
     * any depth. Examples:
     *   - `channels.telegram.enabled`    — exact
     *   - `channels.*.enabled`           — any channel's enabled flag
     *   - `proactive.**`                 — anything under proactive
     */
    readonly pattern: string;
    readonly mode: ReloadMode;
    readonly handler?: (ctx: ReloadHandlerContext) => Promise<void>;
    /** Human-readable reason shown in logs when this rule fires. */
    readonly reason?: string;
}

/** Tighten a dotted-path glob into a RegExp for matching. */
function compilePattern(pattern: string): RegExp {
    const src = pattern
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\\\*\\\*/g, '.*')
        .replace(/\\\*/g, '[^.]+');
    return new RegExp(`^${src}$`);
}

/**
 * Recursively compare two config trees and return the dotted paths where
 * they differ. Handles arrays (by index), nested objects, and scalar
 * changes. Deletions appear as paths whose new value is `undefined`.
 */
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
    // Scalar diff or type-change.
    return [prefix || '(root)'];
}

/** Read a value from a config tree by dotted path. */
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

/**
 * One reload plan — the outcome of diff + rule matching. Hot entries
 * carry their handler; restart entries carry the reason for the log.
 */
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
    /** How long to wait for writes to settle (ms). Default 300. */
    readonly debounceMs?: number;
    /** Polling interval (ms). Default 1000 — minimal CPU cost. */
    readonly pollMs?: number;
    /**
     * Called after a successful hot reload so the caller can replace
     * its cached config reference.
     */
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

    /** Manually trigger a reload (useful for tests + `flopsy mgmt reload`). */
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
            // Force re-read of the file — the shared loader caches, so
            // we must invalidate first.
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

            // Run hot handlers. Errors are logged but don't abort the
            // reload — partial apply is better than zero apply.
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

            // Surface restart-required changes clearly in the log — user
            // runs `flopsy gateway restart` when ready.
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
