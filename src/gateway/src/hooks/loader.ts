import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as yaml from 'js-yaml';
import { createLogger, workspace } from '@flopsy/shared';
import { HookConfigSchema, type RegisteredHook, type HookHandler } from './types';

const log = createLogger('hooks-loader');

/** Read + parse `HOOK.yaml` for one directory. Returns null on any problem. */
function parseHookYaml(absDir: string): ReturnType<typeof HookConfigSchema.parse> | null {
    const yamlPath = join(absDir, 'HOOK.yaml');
    if (!existsSync(yamlPath)) return null;
    let raw: string;
    try {
        raw = readFileSync(yamlPath, 'utf8');
    } catch (err) {
        log.warn({ dir: absDir, err: err instanceof Error ? err.message : String(err) }, 'failed to read HOOK.yaml');
        return null;
    }
    let parsed: unknown;
    try {
        parsed = yaml.load(raw);
    } catch (err) {
        log.warn({ dir: absDir, err: err instanceof Error ? err.message : String(err) }, 'HOOK.yaml parse failed');
        return null;
    }
    const result = HookConfigSchema.safeParse(parsed);
    if (!result.success) {
        log.warn(
            { dir: absDir, issues: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
            'HOOK.yaml validation failed',
        );
        return null;
    }
    return result.data;
}

/** Dynamic import of the handler module. Returns null if the module can't
 *  be loaded OR doesn't export `handle`. Logs the cause either way. */
async function loadTsHandler(absHandlerPath: string): Promise<HookHandler | null> {
    if (!existsSync(absHandlerPath)) {
        log.warn({ path: absHandlerPath }, 'hook handler file missing');
        return null;
    }
    const moduleUrl = pathToFileURL(absHandlerPath).href;
    try {
        const mod = (await import(moduleUrl)) as { handle?: unknown };
        if (typeof mod.handle !== 'function') {
            log.warn({ path: absHandlerPath }, 'hook handler missing `handle` export');
            return null;
        }
        return mod.handle as HookHandler;
    } catch (err) {
        log.warn(
            { path: absHandlerPath, err: err instanceof Error ? err.message : String(err) },
            'hook handler import failed',
        );
        return null;
    }
}

/**
 * Discover and load every hook under <FLOPSY_HOME>/content/hooks/.
 *
 * Returns the list of successfully-loaded hooks. Skipped/failed hooks are
 * logged at warn level. The list is in directory-name order (stable across
 * boots) so multi-hook dispatch order is predictable — important when two
 * hooks subscribe to the same event and operators need to reason about
 * which fires first.
 */
export async function discoverAndLoadHooks(): Promise<RegisteredHook[]> {
    const hooksRoot = workspace.hooks();
    if (!existsSync(hooksRoot)) {
        log.debug({ hooksRoot }, 'no hooks directory — skipping discovery');
        return [];
    }

    let entries: string[];
    try {
        entries = readdirSync(hooksRoot).sort();
    } catch (err) {
        log.warn({ hooksRoot, err: err instanceof Error ? err.message : String(err) }, 'failed to read hooks dir');
        return [];
    }

    const loaded: RegisteredHook[] = [];
    for (const entry of entries) {
        const absDir = join(hooksRoot, entry);
        let dirStat;
        try {
            dirStat = statSync(absDir);
        } catch {
            continue;
        }
        if (!dirStat.isDirectory()) continue;

        const config = parseHookYaml(absDir);
        if (!config) continue;

        const id = config.name ?? entry;
        const isEnabled = config.enabled !== false;
        if (!isEnabled) {
            log.info({ id, dir: absDir }, 'hook disabled (enabled: false) — skipping load');
            continue;
        }

        // Decide handler vs script. Default: handler.ts next to HOOK.yaml.
        if (config.script) {
            // Shell script path resolution. The script lives under the
            // hook's own dir OR under <FLOPSY_HOME>/scripts/ — try the
            // hook dir first (collocated with HOOK.yaml is the simplest
            // mental model), fall back to scripts/ for shared scripts.
            const collocated = resolvePath(absDir, config.script);
            const absScript = existsSync(collocated)
                ? collocated
                : resolvePath(workspace.root(), 'scripts', config.script);
            if (!existsSync(absScript)) {
                log.warn({ id, script: config.script }, 'shell hook script not found');
                continue;
            }
            loaded.push({ id, config, absDir, kind: 'script', scriptPath: absScript });
            log.info({ id, events: config.events, script: absScript }, 'hook registered (shell)');
            continue;
        }

        const handlerName = config.handler ?? 'handler.ts';
        const absHandler = resolvePath(absDir, handlerName);
        const handler = await loadTsHandler(absHandler);
        if (!handler) continue;
        loaded.push({ id, config, absDir, kind: 'ts', handler });
        log.info({ id, events: config.events, handler: absHandler }, 'hook registered (ts)');
    }

    log.info({ count: loaded.length, hooksRoot }, 'hook discovery complete');
    return loaded;
}
