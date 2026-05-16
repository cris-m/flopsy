/**
 * `flopsy hooks` — list / show / test event hooks declared under
 * `.flopsy/content/hooks/`.
 *
 * Reads directly from disk (no HTTP round-trip) so it works whether or not
 * the gateway is running. The gateway loads the same files on startup;
 * differences between what's on disk and what's live in memory mean the
 * gateway needs a restart to pick up changes.
 *
 * Subcommands:
 *   list                        — table of registered hooks
 *   show <id>                   — detail panel for one hook
 *   test <event> [--payload F]  — fire a synthetic event through the live
 *                                  gateway (via mgmt API) so a handler
 *                                  runs against a known payload
 *
 * Rendering matches `flopsy cron list` / `flopsy heartbeat list`:
 * section header + aligned table + dim legend footer. Same visual
 * language as the other schedule-listing commands so the CLI feels
 * uniform.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { Command } from 'commander';
import * as yaml from 'js-yaml';
import { resolveFlopsyHome } from '@flopsy/shared';
import { bad, detail, dim, ok, row, section, table } from '../ui/pretty';
import { managementFetch } from './schedule-client';

interface HookRow {
    readonly id: string;
    readonly enabled: boolean;
    readonly events: readonly string[];
    readonly kind: 'ts' | 'script' | 'unknown';
    readonly description?: string;
    readonly error?: string;
    readonly dir: string;
    readonly handlerPath?: string;
    readonly scriptPath?: string;
}

function hooksRootPath(): string {
    return join(resolveFlopsyHome(), 'content', 'hooks');
}

/** Disk inventory. Mirrors loader.ts's discovery logic but never imports
 *  modules — we only need to render metadata. */
function readHooks(): HookRow[] {
    const root = hooksRootPath();
    if (!existsSync(root)) return [];
    const out: HookRow[] = [];
    for (const entry of readdirSync(root).sort()) {
        const dir = join(root, entry);
        let st;
        try {
            st = statSync(dir);
        } catch {
            continue;
        }
        if (!st.isDirectory()) continue;
        const yamlPath = join(dir, 'HOOK.yaml');
        if (!existsSync(yamlPath)) continue;
        let raw: string;
        try {
            raw = readFileSync(yamlPath, 'utf8');
        } catch (err) {
            out.push({
                id: entry,
                enabled: false,
                events: [],
                kind: 'unknown',
                error: `read failed: ${err instanceof Error ? err.message : String(err)}`,
                dir,
            });
            continue;
        }
        let parsed: unknown;
        try {
            parsed = yaml.load(raw);
        } catch (err) {
            out.push({
                id: entry,
                enabled: false,
                events: [],
                kind: 'unknown',
                error: `yaml parse failed: ${err instanceof Error ? err.message : String(err)}`,
                dir,
            });
            continue;
        }
        const cfg = (parsed ?? {}) as Record<string, unknown>;
        const events = Array.isArray(cfg.events) ? (cfg.events as string[]) : [];
        const enabled = cfg.enabled !== false;
        const hasScript = typeof cfg.script === 'string' && (cfg.script as string).length > 0;
        const handlerName = (cfg.handler as string | undefined) ?? 'handler.ts';
        const handlerPath = resolvePath(dir, handlerName);
        const scriptPath = hasScript ? resolvePath(dir, cfg.script as string) : undefined;
        const kind: HookRow['kind'] = hasScript
            ? 'script'
            : existsSync(handlerPath)
                ? 'ts'
                : 'unknown';
        out.push({
            id: (cfg.name as string | undefined) ?? entry,
            enabled,
            events,
            kind,
            description: typeof cfg.description === 'string' ? cfg.description : undefined,
            dir,
            handlerPath: kind === 'ts' ? handlerPath : undefined,
            scriptPath,
        });
    }
    return out;
}

function dotFor(h: HookRow): string {
    if (h.error) return ok('!').replace(/\x1b\[[0-9;]*m/g, ''); // plain glyph; legend explains
    return h.enabled ? '●' : '○';
}

function kindTag(h: HookRow): string {
    if (h.error) return dim('[err]');
    if (h.kind === 'script') return dim('[shell]');
    if (h.kind === 'ts') return dim('[ts]');
    return dim('[?]');
}

function listHooks(): void {
    const rows = readHooks();
    console.log(section('Hooks'));
    if (rows.length === 0) {
        console.log(row('hooks', dim('none — drop a HOOK.yaml under content/hooks/<name>/')));
        return;
    }
    const tableRows = rows.map((h) => {
        const events = h.events.length > 0 ? h.events.join(', ') : dim('(no events)');
        return [
            dotFor(h),
            h.id,
            kindTag(h),
            events,
            h.error ? dim(`· ${h.error}`) : '',
        ];
    });
    console.log(table(tableRows));
    console.log('');
    console.log(
        dim(
            '  ● enabled · ○ disabled · ! errored · kinds: [ts] handler.ts | [shell] script · restart to pick up new hooks',
        ),
    );
}

function showHook(id: string): void {
    const found = readHooks().find((h) => h.id === id);
    if (!found) {
        console.log(bad(`No hook with id "${id}"`));
        console.log(dim('  Run `flopsy hooks list` to see all hooks.'));
        return;
    }
    console.log(section(`Hook: ${found.id}`));
    console.log(detail('enabled', found.enabled ? '✓ yes' : '○ no'));
    console.log(detail('kind', found.kind));
    console.log(detail('events', found.events.join(', ') || '(none)'));
    console.log(detail('dir', found.dir));
    if (found.handlerPath) console.log(detail('handler', found.handlerPath));
    if (found.scriptPath) console.log(detail('script', found.scriptPath));
    if (found.error) console.log(detail('error', found.error));
    if (found.description) {
        console.log('');
        console.log(dim('  description:'));
        for (const line of found.description.split('\n')) {
            console.log(dim(`    ${line.trim() || ' '}`));
        }
    }
}

/** Fire a synthetic event through the live gateway's mgmt endpoint. Lets
 *  operators verify a hook works without waiting for the natural event to
 *  occur. Payload is `--payload <json-file>` (loaded as the context blob).
 *  When omitted, sends a minimal `{}` payload with just `eventType` +
 *  `firedAt` injected server-side. */
async function testHook(event: string, payloadFile?: string): Promise<void> {
    let payload: Record<string, unknown> = {};
    if (payloadFile) {
        if (!existsSync(payloadFile)) {
            console.log(bad(`payload file not found: ${payloadFile}`));
            process.exit(1);
        }
        try {
            payload = JSON.parse(readFileSync(payloadFile, 'utf8')) as Record<string, unknown>;
        } catch (err) {
            console.log(bad(`payload JSON parse failed: ${err instanceof Error ? err.message : String(err)}`));
            process.exit(1);
        }
    }
    await managementFetch('POST', '/management/hooks/test', { event, payload });
}

export function registerHooksCommands(program: Command): void {
    const hooks = program.command('hooks').description('Manage event-reactive hooks');

    hooks.command('list')
        .description('List every hook on disk + enabled state')
        .action(() => listHooks());

    hooks.command('show')
        .description('Show details for one hook')
        .argument('<id>', 'Hook id (directory name)')
        .action((id: string) => showHook(id));

    hooks.command('test')
        .description('Fire a synthetic event against the live gateway. Subscribed hooks run with the given payload.')
        .argument('<event>', 'Event name (e.g. proactive.fire.delivered, command.cron)')
        .option('--payload <file>', 'Path to a JSON file with the event context. Default: empty object.')
        .action((event: string, opts: { payload?: string }) => void testHook(event, opts.payload));

    hooks.action((_opts: unknown, cmd: { outputHelp(): void }) => cmd.outputHelp());
}
