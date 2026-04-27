/**
 * `flopsy onboard` — interactive first-run wizard.
 *
 * Steps (skippable):
 *   1. Welcome + current-state summary
 *   2. Enable which channels? (multi-select, writes `channel.enabled`)
 *   3. For each enabled channel that needs a token: prompt, write to .env
 *   4. Offer to run `flopsy auth google` now (shell out)
 *   5. Offer to start the gateway
 *   6. Final: run doctor to confirm
 *
 * Non-destructive: re-running is safe. Existing values are the defaults
 * for each prompt; blank input keeps the current value.
 *
 * Secret writing: tokens land in `.env` at repo root (git-ignored in
 * our template). We never put literal tokens in flopsy.json5 because
 * that's meant to be shared.
 */

import { checkbox, confirm, password, select } from '@inquirer/prompts';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { Command } from 'commander';
import JSON5 from 'json5';
import { bad, dim, info, ok, row, section } from '../ui/pretty';
import { printBanner } from '../ui/banner';
import { readFlopsyConfig } from './config-reader';

/**
 * Which env var each channel needs. When a user enables a channel we
 * prompt for exactly these. Pulled from the default flopsy.json5
 * template where token placeholders are `${<ENV>}` per channel.
 */
const CHANNEL_TOKEN_VARS: Readonly<Record<string, string | null>> = {
    telegram: 'TELEGRAM_BOT_TOKEN',
    discord: 'DISCORD_BOT_TOKEN',
    line: 'LINE_CHANNEL_ACCESS_TOKEN',
    slack: 'SLACK_BOT_TOKEN',
    googlechat: 'GOOGLECHAT_SERVICE_ACCOUNT',
    whatsapp: null, // uses QR pairing, no single token
    signal: null,
    imessage: null,
};

const ENV_PATH = () => resolve(process.cwd(), '.env');

export function registerOnboardCommand(root: Command): void {
    root.command('onboard')
        .description('Interactive first-run wizard — enable channels, paste tokens, connect auth')
        .option('--skip-auth', 'Skip the auth connect step')
        .action(async (opts: { skipAuth?: boolean }) => {
            await runOnboard(Boolean(opts.skipAuth));
        });
}

async function runOnboard(skipAuth: boolean): Promise<void> {
    printBanner();
    console.log(section('FlopsyBot onboarding', '#9B59B6'));
    console.log(dim("Re-running is safe — blank input keeps the current value."));
    console.log('');

    const { path: cfgPath, config } = readFlopsyConfig();
    const channelsCfg = (config.channels ?? {}) as Record<string, { enabled?: boolean }>;
    const allChannelNames = Object.keys(channelsCfg).sort();

    console.log(section('Step 1: Channels', '#3498DB'));
    const defaultSelected = allChannelNames.filter((n) => channelsCfg[n]?.enabled === true);
    const selectedChannels = (await checkbox({
        message: 'Which channels should be enabled?',
        choices: allChannelNames.map((n) => ({
            name: `${n}${CHANNEL_TOKEN_VARS[n] ? '' : dim(' (pairing-only — no token)')}`,
            value: n,
            checked: defaultSelected.includes(n),
        })),
    })) as string[];

    flipChannels(cfgPath, allChannelNames, new Set(selectedChannels));
    console.log(ok(`${selectedChannels.length} channel(s) enabled.`));
    console.log('');

    console.log(section('Step 2: Tokens', '#F1C40F'));
    const envEntries: Record<string, string> = {};
    for (const name of selectedChannels) {
        const varName = CHANNEL_TOKEN_VARS[name];
        if (!varName) {
            console.log(dim(`  ${name}: uses QR pairing / manual setup — skipping token prompt`));
            continue;
        }
        const existing = process.env[varName] ?? readEnvVarFromFile(varName);
        const prompt = existing
            ? `${name} (${varName}) — paste new token or leave blank to keep current`
            : `${name} (${varName}) — paste token`;
        const value = await password({
            message: prompt,
            mask: '*',
        });
        if (value.trim().length > 0) {
            envEntries[varName] = value.trim();
        } else if (existing) {
            console.log(dim(`  (keeping current ${varName})`));
        } else {
            console.log(bad(`  ${varName} left blank — channel will fail to start`));
        }
    }
    if (Object.keys(envEntries).length > 0) {
        upsertEnvFile(envEntries);
        console.log(
            ok(`wrote ${Object.keys(envEntries).length} env var(s) to ${ENV_PATH()}`),
        );
    }
    console.log('');

    if (!skipAuth) {
        console.log(section('Step 3: Service auth', '#E67E22'));
        const provider = await select({
            message: 'Connect a third-party service account?',
            choices: [
                { name: 'Google (Gmail, Calendar, Drive)', value: 'google' },
                { name: 'Skip for now', value: 'skip' },
            ],
        });
        if (provider !== 'skip') {
            console.log(info(`running: flopsy auth ${provider}`));
            await shellOut(['run', 'flopsy', '--', 'auth', String(provider)]);
        } else {
            console.log(dim('  (run `flopsy auth <provider>` later when you need it)'));
        }
        console.log('');
    }

    console.log(section('Step 4: Start', '#2ECC71'));
    const start = await confirm({
        message: 'Start the gateway now?',
        default: false,
    });
    if (start) {
        console.log(info('running: flopsy run start'));
        await shellOut(['start']);
    } else {
        console.log(dim('  Start later with `flopsy run start` or `npm start`.'));
    }
    console.log('');

    console.log(section('All set', '#9B59B6'));
    console.log(row('config', cfgPath));
    console.log(row('env', ENV_PATH()));
    console.log('');
    console.log(info('run `flopsy doctor` to verify everything is healthy'));
    console.log(info('run `flopsy status` for the full system snapshot'));
}

/** Toggle `channels.<name>.enabled` for each channel in one atomic write. */
function flipChannels(cfgPath: string, all: readonly string[], enabled: ReadonlySet<string>): void {
    const raw = readFileSync(cfgPath, 'utf-8');
    const parsed = JSON5.parse(raw) as Record<string, unknown>;
    const channels = (parsed.channels ?? {}) as Record<string, Record<string, unknown>>;
    for (const name of all) {
        if (channels[name]) channels[name].enabled = enabled.has(name);
    }
    parsed.channels = channels;
    const tmp = `${cfgPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(parsed, null, 4) + '\n');
    renameSync(tmp, cfgPath);
}

/**
 * Parse existing `.env` and return the value for a given var (or
 * undefined). Tolerant of `KEY=value`, `KEY="value"`, `export KEY=`.
 */
function readEnvVarFromFile(name: string): string | undefined {
    const path = ENV_PATH();
    if (!existsSync(path)) return undefined;
    const raw = readFileSync(path, 'utf-8');
    for (const line of raw.split('\n')) {
        const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*["']?([^"'\n]*)["']?\s*$/);
        if (m && m[1] === name) return m[2];
    }
    return undefined;
}

/**
 * Upsert env vars into `.env`. Preserves comments and existing values
 * we weren't told to change. Simple line-based rewrite — good enough
 * for our shape (plain KEY=VALUE, no multiline).
 */
function upsertEnvFile(entries: Record<string, string>): void {
    const path = ENV_PATH();
    const existing = existsSync(path) ? readFileSync(path, 'utf-8').split('\n') : [];
    const updated = new Set<string>();
    const lines = existing.map((line) => {
        const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=/);
        if (!m) return line;
        const key = m[1];
        if (entries[key] !== undefined) {
            updated.add(key);
            return `${key}=${entries[key]}`;
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

/**
 * Shell out to the local CLI/npm without replacing our process — we
 * want to return to the wizard flow for the final summary.
 */
function shellOut(args: readonly string[]): Promise<void> {
    return new Promise((resolvePromise) => {
        const child = spawn('npm', args as string[], { stdio: 'inherit' });
        child.on('exit', () => resolvePromise());
        child.on('error', (err) => {
            console.log(bad(`spawn failed: ${err.message}`));
            resolvePromise();
        });
    });
}

