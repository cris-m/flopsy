/**
 * `flopsy channel ...` — list, inspect, enable/disable, and edit channel
 * configs in flopsy.json5.
 *
 * Subcommands:
 *   list                 — one-line summary per channel
 *   show <name>          — full config (secrets masked)
 *   enable <name>        — set enabled=true
 *   disable <name>       — set enabled=false
 *   set <name> <k> <v>   — update a top-level field via dot-path
 *                          (e.g. `dm.policy open`, `token '${TG_TOKEN}'`)
 *
 * Secrets (`token`, `secret`, anything under `credentials.*`) are
 * displayed as `(set — ab***)` to avoid accidental leaks into logs
 * or screenshots. Use `flopsy channel show <name> --reveal` if you
 * actually need the value.
 *
 * Every write path uses the atomic `.tmp → rename` pattern so a crash
 * mid-write can't leave a truncated config.
 */

import { input, password } from '@inquirer/prompts';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';
import JSON5 from 'json5';
import { detail, dim, info, ok, row, section, table } from '../ui/pretty';
import { tint } from '../ui/theme';
import { configPath, readFlopsyConfig } from './config-reader';

interface RawChannel {
    enabled?: boolean;
    token?: string;
    secret?: string;
    url?: string;
    [k: string]: unknown;
}

/**
 * Top-level keys that hold secrets. These are masked on display and
 * only shown verbatim when `--reveal` is passed. Fields are matched
 * both as full keys (e.g. `token`) and as trailing path segments
 * (e.g. `credentials.password`).
 */
const SECRET_KEYS: ReadonlySet<string> = new Set([
    'token',
    'secret',
    'apiKey',
    'password',
    'accessToken',
    'refreshToken',
    'clientSecret',
    'bearer',
]);

function isSecretKey(key: string): boolean {
    return SECRET_KEYS.has(key);
}

function maskSecret(value: unknown): string {
    if (typeof value !== 'string' || value.length === 0) return dim('(empty)');
    if (value.startsWith('${')) return dim(value); // env placeholder — safe
    return dim(`(set — ${value.slice(0, 2)}***)`);
}

function fail(msg: string, code = 1): never {
    process.stderr.write(`error: ${msg}\n`);
    process.exit(code);
}

function writeConfig(path: string, parsed: Record<string, unknown>): void {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(parsed, null, 4) + '\n');
    renameSync(tmp, path);
}

/**
 * Set a nested value by dot-path. Creates intermediate objects as
 * needed. Throws if a segment already exists as a non-object.
 */
function setByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
    const parts = path.split('.');
    let cur: Record<string, unknown> = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        const key = parts[i];
        const next = cur[key];
        if (next === undefined || next === null) {
            cur[key] = {};
        } else if (typeof next !== 'object' || Array.isArray(next)) {
            throw new Error(
                `cannot set "${path}": "${parts.slice(0, i + 1).join('.')}" is not an object`,
            );
        }
        cur = cur[key] as Record<string, unknown>;
    }
    cur[parts[parts.length - 1]] = value;
}

/**
 * Parse a scalar value from the CLI string form:
 *   "true"/"false"            → boolean
 *   "null"                    → null
 *   number-looking            → number
 *   JSON-looking (`[...]`)    → JSON.parse
 *   anything else             → string (verbatim)
 *
 * This lets the user write `flopsy channel set telegram dm.policy open`
 * for a string, AND `flopsy channel set telegram contextMessages 100` for
 * a number, without juggling quotes.
 */
function parseValue(raw: string): unknown {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (raw === 'null') return null;
    if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
    if (/^-?\d+\.\d+$/.test(raw)) return Number.parseFloat(raw);
    // JSON-looking: arrays or objects
    if ((raw.startsWith('[') && raw.endsWith(']')) || (raw.startsWith('{') && raw.endsWith('}'))) {
        try {
            return JSON5.parse(raw);
        } catch {
            /* fall through to string */
        }
    }
    return raw;
}

/**
 * Flatten a channel object into `(path, value)` pairs for the
 * `show` pretty-printer. Secrets are masked during the traversal
 * unless `reveal` is true.
 */
function flattenChannel(
    obj: Record<string, unknown>,
    reveal: boolean,
    prefix = '',
): Array<readonly [string, string]> {
    const rows: Array<readonly [string, string]> = [];
    for (const [key, value] of Object.entries(obj)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (isSecretKey(key) && !reveal) {
            rows.push([path, maskSecret(value)]);
            continue;
        }
        if (value === null) {
            rows.push([path, dim('null')]);
        } else if (typeof value === 'object' && !Array.isArray(value)) {
            rows.push(...flattenChannel(value as Record<string, unknown>, reveal, path));
        } else if (Array.isArray(value)) {
            rows.push([path, value.length === 0 ? dim('(empty)') : JSON.stringify(value)]);
        } else if (typeof value === 'boolean') {
            rows.push([path, value ? ok('true') : dim('false')]);
        } else {
            rows.push([path, String(value)]);
        }
    }
    return rows;
}

export function registerChannelCommands(root: Command): void {
    const ch = root
        .command('channel')
        .description('Inspect, enable/disable, and edit channel configs');

    ch.command('list')
        .description('List every channel with enabled status + key config')
        .action(() => {
            const { config } = readFlopsyConfig();
            const channels = (config.channels ?? {}) as Record<string, RawChannel>;
            const names = Object.keys(channels).sort();
            console.log(section('Channels'));
            if (names.length === 0) {
                console.log(row('channels', dim('none configured')));
                return;
            }
            // Status-dot column: ● enabled (channel-themed blue), ○ disabled.
            const rows: string[][] = names.map((name) => {
                const c = channels[name];
                const enabled = c.enabled === true;
                const dot = enabled ? tint.channel('●') : dim('○');
                const displayName = enabled ? name : dim(name);
                const dmPolicy = (c as { dm?: { policy?: string } }).dm?.policy;
                let hint = '';
                if (dmPolicy) hint = dim(`dm=${dmPolicy}`);
                else if (c.url) hint = dim(c.url);
                return [dot, displayName, hint];
            });
            console.log(table(rows));
        });

    ch.command('show')
        .description('Full config for one channel (secrets masked by default)')
        .argument('<name>', 'Channel name (e.g. telegram, discord, line)')
        .option('--reveal', 'Show secrets (token, password, ...) in plain text')
        .action((name: string, opts: { reveal?: boolean }) => {
            const { config } = readFlopsyConfig();
            const channels = (config.channels ?? {}) as Record<string, RawChannel>;
            const cfg = channels[name];
            if (!cfg) fail(`No channel named "${name}". Run \`flopsy channel list\`.`);
            const enabled = cfg.enabled === true;
            const dot = enabled ? tint.channel('●') : dim('○');
            const displayName = enabled ? name : dim(name);
            const state = enabled ? dim('enabled') : dim('disabled');
            console.log(section(`Channel: ${name}`, 'channel'));
            console.log(`  ${dot} ${displayName}  ${state}`);
            const rows = flattenChannel(cfg as Record<string, unknown>, opts.reveal === true);
            if (rows.length === 0) {
                console.log(detail('config', dim('empty')));
                return;
            }
            // Skip the top-level `enabled` key — it's already in the header.
            for (const [path, value] of rows) {
                if (path === 'enabled') continue;
                console.log(detail(path, value));
            }
            if (!opts.reveal && rows.some(([_, v]) => v.includes('(set —'))) {
                console.log('');
                console.log(info('use --reveal to show masked secrets'));
            }
        });

    ch.command('add')
        .description('Add a new channel entry via interactive prompts')
        .argument('<type>', 'Channel type (telegram, discord, slack, line, ...)')
        .action(async (type: string) => {
            await addChannel(type);
        });

    ch.command('enable')
        .description('Enable a channel')
        .argument('<name>', 'Channel name')
        .action((name: string) => flipEnabled(name, true));

    ch.command('disable')
        .description('Disable a channel')
        .argument('<name>', 'Channel name')
        .action((name: string) => flipEnabled(name, false));

    ch.command('set')
        .description('Update one config field (supports dot-paths and typed values)')
        .argument('<name>', 'Channel name')
        .argument('<path>', 'Dot-path, e.g. dm.policy or contextMessages')
        .argument('<value>', 'New value — true/false/null/number/string/JSON')
        .action((name: string, path: string, raw: string) => {
            const cfgPath = configPath();
            const rawText = readFileSync(cfgPath, 'utf-8');
            const parsed = JSON5.parse(rawText) as Record<string, unknown>;
            const channels = (parsed.channels ?? {}) as Record<string, unknown>;
            if (!channels[name]) fail(`No channel named "${name}".`);
            try {
                setByPath(channels[name] as Record<string, unknown>, path, parseValue(raw));
            } catch (err) {
                fail(err instanceof Error ? err.message : String(err));
            }
            parsed.channels = channels;
            writeConfig(cfgPath, parsed);
            console.log(
                ok(`set channels.${name}.${path} = ${JSON.stringify(parseValue(raw))}`),
            );
            console.log(dim('restart gateway for the change to take effect'));
        });

    // Default: `flopsy channel` with no subcommand → list.
    ch.action(() => {
        const { config } = readFlopsyConfig();
        const channels = (config.channels ?? {}) as Record<string, RawChannel>;
        console.log(section('Channels'));
        const names = Object.keys(channels).sort();
        if (names.length === 0) {
            console.log(row('channels', dim('none configured')));
            return;
        }
        for (const name of names) {
            const c = channels[name];
            console.log(row(name, c.enabled === true ? ok('enabled') : dim('disabled')));
        }
    });
}

function flipEnabled(name: string, value: boolean): void {
    const cfgPath = configPath();
    const raw = readFileSync(cfgPath, 'utf-8');
    const parsed = JSON5.parse(raw) as Record<string, unknown>;
    const channels = (parsed.channels ?? {}) as Record<string, Record<string, unknown>>;
    if (!channels[name]) fail(`No channel named "${name}".`);
    channels[name].enabled = value;
    parsed.channels = channels;
    writeConfig(cfgPath, parsed);
    console.log(ok(`${name} ${value ? 'enabled' : 'disabled'}`));
    console.log(dim('restart gateway for the change to take effect'));
}

/**
 * Minimal starter configs per channel type. Covers the fields each
 * adapter needs. Users can fine-tune later via `channel set`.
 */
const CHANNEL_TEMPLATES: Readonly<Record<string, Record<string, unknown>>> = {
    telegram: {
        enabled: true,
        token: '${TELEGRAM_BOT_TOKEN}',
        botUsername: '',
        dm: { policy: 'open', allowFrom: [], blockedFrom: [] },
        group: { policy: 'disabled', activation: 'mention', allowedGroups: [] },
        ackReaction: { emoji: '👀', direct: true, group: 'mentions' },
    },
    discord: {
        enabled: true,
        token: '${DISCORD_BOT_TOKEN}',
        dm: { policy: 'open', allowFrom: [], blockedFrom: [] },
        group: { policy: 'disabled', activation: 'mention', allowedGroups: [] },
        ackReaction: { emoji: '👀', direct: true, group: 'mentions' },
    },
    line: {
        enabled: true,
        channelAccessToken: '${LINE_CHANNEL_ACCESS_TOKEN}',
        channelSecret: '${LINE_CHANNEL_SECRET}',
        dm: { policy: 'open', allowFrom: [], blockedFrom: [] },
    },
    slack: {
        enabled: true,
        botToken: '${SLACK_BOT_TOKEN}',
        appToken: '${SLACK_APP_TOKEN}',
        dm: { policy: 'open', allowFrom: [], blockedFrom: [] },
        group: { policy: 'disabled', activation: 'mention', allowedGroups: [] },
    },
};

const ENV_VARS_PER_TYPE: Readonly<Record<string, readonly string[]>> = {
    telegram: ['TELEGRAM_BOT_TOKEN'],
    discord: ['DISCORD_BOT_TOKEN'],
    line: ['LINE_CHANNEL_ACCESS_TOKEN', 'LINE_CHANNEL_SECRET'],
    slack: ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'],
};

async function addChannel(type: string): Promise<void> {
    const template = CHANNEL_TEMPLATES[type];
    if (!template) {
        fail(
            `No template for channel type "${type}". Supported: ${Object.keys(CHANNEL_TEMPLATES).join(', ')}`,
        );
    }

    const cfgPath = configPath();
    const raw = readFileSync(cfgPath, 'utf-8');
    const parsed = JSON5.parse(raw) as Record<string, unknown>;
    const channels = (parsed.channels ?? {}) as Record<string, unknown>;

    // Ask for the channel NAME (how it'll be referenced in logs + /status).
    // Defaults to the type itself (`telegram`) but allows multiple telegram
    // bots per gateway (`telegram`, `telegram-work`, etc.).
    const name = await input({
        message: 'Channel name (how to reference it in logs)',
        default: channels[type] ? `${type}-2` : type,
        validate: (v) => {
            if (!/^[a-z][a-z0-9-]*$/.test(v)) return 'Name must match /^[a-z][a-z0-9-]*$/';
            if (channels[v]) return `"${v}" already exists — pick a different name`;
            return true;
        },
    });

    // Prompt for token values + write to .env.
    const envVars = ENV_VARS_PER_TYPE[type] ?? [];
    const envEntries: Record<string, string> = {};
    for (const v of envVars) {
        const value = await password({
            message: `${v} (paste token, blank to skip for now)`,
            mask: '*',
        });
        if (value.trim().length > 0) envEntries[v] = value.trim();
    }

    // Write the new channel block.
    channels[name] = structuredClone(template);
    parsed.channels = channels;
    writeConfig(cfgPath, parsed);
    console.log(ok(`added channel "${name}" (${type}) to ${cfgPath}`));

    // Upsert env vars.
    if (Object.keys(envEntries).length > 0) {
        upsertEnvFile(envEntries);
        console.log(
            ok(`wrote ${Object.keys(envEntries).length} env var(s) to .env`),
        );
    } else if (envVars.length > 0) {
        console.log(
            info(`set ${envVars.join(', ')} in .env before restarting`),
        );
    }

    console.log(dim('restart gateway (`flopsy run restart`) to activate'));
}

/**
 * Append-or-update keys in the repo-root `.env` file. Mirrors the logic
 * in onboard-command.ts; duplicated here so `channel add` works without
 * pulling in the full wizard.
 */
function upsertEnvFile(entries: Record<string, string>): void {
    const path = resolve(process.cwd(), '.env');
    const existing: string[] = (() => {
        try {
            return readFileSync(path, 'utf-8').split('\n');
        } catch {
            return [];
        }
    })();
    const updated = new Set<string>();
    const lines = existing.map((line) => {
        const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=/);
        if (!m) return line;
        if (entries[m[1]] !== undefined) {
            updated.add(m[1]);
            return `${m[1]}=${entries[m[1]]}`;
        }
        return line;
    });
    for (const [k, v] of Object.entries(entries)) {
        if (!updated.has(k)) lines.push(`${k}=${v}`);
    }
    const content = lines.filter((l, i) => !(i === lines.length - 1 && l === '')).join('\n') + '\n';
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, content);
    renameSync(tmp, path);
}
