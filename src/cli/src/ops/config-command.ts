/**
 * `flopsy config ...` — read/write `flopsy.json5` by dotted path.
 *
 *   flopsy config            — pretty-print the whole config
 *   flopsy config path       — print the resolved config file path
 *   flopsy config get <key>  — fetch a nested value (dot/bracket paths)
 *   flopsy config set <key> <value>
 *       <value> is parsed as JSON first; falls back to a plain string
 *       (so booleans/numbers/arrays work without shell-quoting). Example:
 *         flopsy config set gateway.port 19000
 *         flopsy config set agents.0.enabled false
 *         flopsy config set channels.telegram.enabled true
 *   flopsy config unset <key>  — remove a key
 *   flopsy config edit         — open the file in $EDITOR / $VISUAL
 *
 * Writes go through the same atomic rename pattern as `flopsy mcp set`
 * (write .tmp, rename) so we can't leave a half-written JSON5 on disk.
 * Comments are lost when setting — round-tripping JSON5 with comments
 * is hard and we're an ops tool, not a JSON5 editor.
 */

import { renameSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { Command } from 'commander';
import { flopsyConfigSchema, RELOAD_RULES_META } from '@flopsy/shared';
import { bad, dim, info, ok, section, warn as warnLine } from '../ui/pretty';
import { configPath, readFlopsyConfig } from './config-reader';

export function registerConfigCommand(root: Command): void {
    const cfg = root
        .command('config')
        .description('Read or write values in flopsy.json5 by dotted path');

    cfg.command('path')
        .description('Print the resolved config file path')
        .action(() => {
            console.log(configPath());
        });

    cfg.command('get')
        .description('Read a nested value (dotted path, e.g. gateway.port)')
        .argument('<path>', 'Dotted path, e.g. agents.0.model')
        .option('--json', 'Emit raw JSON instead of a pretty print')
        .action((path: string, opts: { json?: boolean }) => {
            const { config } = readFlopsyConfig();
            const value = getByPath(config as Record<string, unknown>, path);
            if (value === undefined) {
                console.log(bad(`not set: ${path}`));
                process.exit(1);
            }
            if (opts.json) {
                console.log(JSON.stringify(value));
            } else {
                console.log(prettyValue(value));
            }
        });

    cfg.command('set')
        .description('Write a nested value; <value> is parsed as JSON, else string')
        .argument('<path>', 'Dotted path, e.g. gateway.port')
        .argument('<value>', 'JSON literal (true, 123, "x") or plain string')
        .action((path: string, rawValue: string) => {
            const { path: file, config } = readFlopsyConfig();
            const parsed = parseValue(rawValue);
            setByPath(config as Record<string, unknown>, path, parsed);
            atomicWrite(file, config);
            console.log(ok(`set ${path} = ${prettyValue(parsed)}`));
            console.log(dim(`wrote ${file}`));
        });

    cfg.command('unset')
        .description('Remove a nested key')
        .argument('<path>', 'Dotted path')
        .action((path: string) => {
            const { path: file, config } = readFlopsyConfig();
            const removed = unsetByPath(config as Record<string, unknown>, path);
            if (!removed) {
                console.log(info(`nothing to remove at ${path}`));
                return;
            }
            atomicWrite(file, config);
            console.log(ok(`removed ${path}`));
            console.log(dim(`wrote ${file}`));
        });

    cfg.command('edit')
        .description('Open flopsy.json5 in $EDITOR (falls back to $VISUAL, then vi)')
        .action(async () => {
            const editor = process.env['EDITOR'] || process.env['VISUAL'] || 'vi';
            const file = configPath();
            const child = spawn(editor, [file], { stdio: 'inherit' });
            await new Promise<void>((resolve, reject) => {
                child.on('exit', (code) =>
                    code === 0 ? resolve() : reject(new Error(`editor exited ${code}`)),
                );
                child.on('error', reject);
            });
        });

    // Default: `flopsy config` with no subcommand → show help (use `dump` for full config).
    cfg.action((_opts: unknown, cmd: { outputHelp(): void }) => cmd.outputHelp());

    cfg.command('dump').description('Print the full flopsy.json5 contents').action(() => {
        const { path, config } = readFlopsyConfig();
        console.log(section('Config'));
        console.log(dim(`file: ${path}`));
        console.log('');
        console.log(JSON.stringify(config, null, 2));
    });

    cfg.command('validate')
        .description('Type-check flopsy.json5 against the Zod schema without reloading the gateway')
        .option('--json', 'Emit machine-readable JSON (issues array, exit 0/1)', false)
        .action((opts: { json?: boolean }) => {
            const { path, config } = readFlopsyConfig();
            const result = flopsyConfigSchema.safeParse(config);
            if (result.success) {
                if (opts.json) {
                    console.log(JSON.stringify({ ok: true, file: path, issues: [] }));
                    return;
                }
                console.log(ok('flopsy.json5 is valid against the schema.'));
                console.log(dim(`file: ${path}`));
                return;
            }
            const issues = result.error.issues.map((i) => ({
                path: i.path.join('.') || '(root)',
                code: i.code,
                message: i.message,
            }));
            if (opts.json) {
                console.log(JSON.stringify({ ok: false, file: path, issues }, null, 2));
                process.exit(1);
            }
            console.log(bad(`flopsy.json5 has ${issues.length} schema issue${issues.length === 1 ? '' : 's'}`));
            console.log(dim(`file: ${path}`));
            console.log('');
            for (const iss of issues) {
                console.log(`  ${bad('✗')} ${iss.path}`);
                console.log(`    ${iss.message} ${dim(`(${iss.code})`)}`);
            }
            console.log('');
            console.log(dim(`  Fix the file, then re-run: flopsy config validate`));
            process.exit(1);
        });

    cfg.command('reload-info')
        .description('Show which config paths hot-reload vs require a gateway restart')
        .action(() => {
            console.log(section('Reload rules'));
            console.log(dim('  Order matters — first matching pattern wins.'));
            console.log('');
            const rows: string[][] = [['pattern', 'mode', 'reason']];
            for (const r of RELOAD_RULES_META) {
                const modeCell = r.mode === 'hot' ? ok(r.mode) : warnLine(r.mode);
                rows.push([r.pattern, modeCell, r.reason]);
            }
            const widths: number[] = new Array(rows[0].length).fill(0);
            const visible = (s: string): number => s.replace(/\x1b\[[0-9;]*m/g, '').length;
            for (const r of rows) for (let c = 0; c < r.length; c++) {
                widths[c] = Math.max(widths[c], visible(r[c]));
            }
            for (const r of rows) {
                console.log('  ' + r.map((cell, c) => cell + ' '.repeat(widths[c] - visible(cell))).join('  '));
            }
            console.log('');
            console.log(dim(`  hot = applied live;  restart = run \`flopsy gateway restart\` to take effect.`));
            console.log(dim(`  Anything not matched here is silently ignored on reload — file an issue if you hit one.`));
        });
}

/**
 * Walk a dotted path into an object. Numeric segments index arrays.
 * Returns `undefined` on any missing hop so callers can print a useful
 * error instead of throwing mid-chain.
 */
function getByPath(obj: Record<string, unknown>, path: string): unknown {
    const parts = splitPath(path);
    let cur: unknown = obj;
    for (const part of parts) {
        if (cur === null || cur === undefined) return undefined;
        if (Array.isArray(cur)) {
            const idx = Number(part);
            if (!Number.isInteger(idx)) return undefined;
            cur = cur[idx];
        } else if (typeof cur === 'object') {
            cur = (cur as Record<string, unknown>)[part];
        } else {
            return undefined;
        }
    }
    return cur;
}

function setByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
    const parts = splitPath(path);
    const last = parts.pop();
    if (!last) throw new Error('empty path');
    let cur: Record<string, unknown> | unknown[] = obj;
    for (const part of parts) {
        const idx = Number(part);
        if (Array.isArray(cur)) {
            if (!Number.isInteger(idx)) throw new Error(`expected array index, got "${part}"`);
            if (cur[idx] === undefined || typeof cur[idx] !== 'object' || cur[idx] === null) {
                cur[idx] = nextContainer(parts, parts.indexOf(part));
            }
            cur = cur[idx] as Record<string, unknown> | unknown[];
        } else {
            if (cur[part] === undefined || typeof cur[part] !== 'object' || cur[part] === null) {
                cur[part] = nextContainer(parts, parts.indexOf(part));
            }
            cur = cur[part] as Record<string, unknown> | unknown[];
        }
    }
    if (Array.isArray(cur)) {
        const idx = Number(last);
        if (!Number.isInteger(idx)) throw new Error(`expected array index, got "${last}"`);
        (cur as unknown[])[idx] = value;
    } else {
        (cur as Record<string, unknown>)[last] = value;
    }
}

function unsetByPath(obj: Record<string, unknown>, path: string): boolean {
    const parts = splitPath(path);
    const last = parts.pop();
    if (!last) return false;
    let cur: unknown = obj;
    for (const part of parts) {
        if (!cur || typeof cur !== 'object') return false;
        cur = (cur as Record<string, unknown>)[part];
    }
    if (!cur || typeof cur !== 'object') return false;
    if (Array.isArray(cur)) {
        const idx = Number(last);
        if (!Number.isInteger(idx) || idx >= cur.length) return false;
        cur.splice(idx, 1);
    } else {
        const c = cur as Record<string, unknown>;
        if (!(last in c)) return false;
        delete c[last];
    }
    return true;
}

/**
 * Split a path like `agents.0.approvals.tools` into ['agents','0','approvals','tools'].
 * Also accepts bracket form: `agents[0].model` → ['agents','0','model'].
 */
function splitPath(path: string): string[] {
    return path
        .replace(/\[(\d+)\]/g, '.$1')
        .split('.')
        .filter((s) => s.length > 0);
}

/**
 * Decide whether the NEXT step in a path should be an array or object:
 * if the next part looks numeric, make an array so auto-creation of
 * `foo.0.bar` yields [{bar: ...}] not {'0': {...}}.
 */
function nextContainer(parts: string[], idx: number): unknown[] | Record<string, unknown> {
    const next = parts[idx + 1];
    return next !== undefined && /^\d+$/.test(next) ? [] : {};
}

function parseValue(raw: string): unknown {
    try {
        return JSON.parse(raw);
    } catch {
        // Not valid JSON — treat as a plain string.
        return raw;
    }
}

function prettyValue(v: unknown): string {
    if (typeof v === 'string') return v;
    return JSON.stringify(v, null, 2);
}

function atomicWrite(file: string, value: unknown): void {
    // Re-serialise as indented JSON. JSON5 round-trip with comments is
    // hard; keep this tool honest and drop them on write.
    const body = JSON.stringify(value, null, 2) + '\n';
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, body, 'utf-8');
    renameSync(tmp, file);
}
