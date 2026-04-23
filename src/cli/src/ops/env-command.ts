/**
 * `flopsy env ...` — inspect / reload `.env`.
 *
 * We deliberately do NOT watch `.env` automatically (secret rotations
 * should be explicit, audit-traceable events). Instead this command
 * gives the user a one-step "I edited .env, apply it" flow that:
 *
 *   1. Re-reads `.env` from the repo root.
 *   2. Diffs the new values against the gateway's currently-loaded env.
 *   3. If there are changes, triggers `flopsy gateway restart`.
 *
 * The diff only reports WHICH keys changed, never the values, so
 * command output is safe to share for incident forensics.
 */

import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { Command } from 'commander';
import { bad, detail, dim, info, ok, section } from '../ui/pretty';
import { configPath } from './config-reader';

export function registerEnvCommands(root: Command): void {
    const env = root.command('env').description('Inspect or reload `.env` values');

    env.command('reload')
        .description('Re-read `.env` and restart the gateway if any key changed')
        .option('--dry-run', 'Only show what would change, do not restart')
        .action(async (opts: { dryRun?: boolean }) => {
            await runReload(Boolean(opts.dryRun));
        });

    env.command('status')
        .description('Show which `.env` keys are currently loaded (values hidden)')
        .action(() => renderEnvStatus());
}

function envPath(): string {
    // `.env` lives alongside the resolved flopsy.json5. If the user
    // moved the config, the sibling .env moves with it.
    const cfg = configPath();
    return resolve(dirname(cfg), '.env');
}

/**
 * Parse `.env` the same way dotenv does — minimal, no interpolation
 * (we don't need it here; dotenv will re-interpolate on gateway restart).
 */
function parseEnvFile(path: string): Record<string, string> {
    if (!existsSync(path)) return {};
    const out: Record<string, string> = {};
    const text = readFileSync(path, 'utf-8');
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim();
        let val = line.slice(eq + 1).trim();
        // Strip matching surrounding quotes if present.
        if (
            (val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))
        ) {
            val = val.slice(1, -1);
        }
        out[key] = val;
    }
    return out;
}

async function runReload(dryRun: boolean): Promise<void> {
    const path = envPath();
    if (!existsSync(path)) {
        console.log(bad(`No .env found at ${path}`));
        process.exit(1);
    }

    const fromFile = parseEnvFile(path);
    const fromProcess = process.env;

    const added: string[] = [];
    const changed: string[] = [];
    const removed: string[] = [];

    for (const [key, val] of Object.entries(fromFile)) {
        const current = fromProcess[key];
        if (current === undefined) added.push(key);
        else if (current !== val) changed.push(key);
    }
    // "removed" is harder — our running gateway has no way to report
    // which keys it LOADED from .env vs inherited from the shell. Skip.

    console.log(section('env reload'));
    console.log(detail('path', path));
    if (added.length === 0 && changed.length === 0) {
        console.log('');
        console.log(ok('no changes detected — gateway restart unnecessary'));
        return;
    }

    if (changed.length > 0) {
        console.log(detail('changed', changed.join(', ')));
    }
    if (added.length > 0) {
        console.log(detail('new', added.join(', ')));
    }
    if (removed.length > 0) {
        console.log(detail('removed', removed.join(', ')));
    }

    if (dryRun) {
        console.log('');
        console.log(info('--dry-run: skipping restart'));
        return;
    }

    console.log('');
    console.log(info('restarting gateway to apply .env changes …'));
    console.log(dim('(`npm run restart` from the repo root)'));
    console.log('');

    // Delegate to `npm run restart` — uses the stop+start scripts the
    // rest of the ops commands already rely on. We inherit stdio so
    // the user sees the gateway's boot log live.
    const child = spawn('npm', ['run', 'restart'], {
        stdio: 'inherit',
        cwd: dirname(path),
    });
    await new Promise<void>((resolvePromise, reject) => {
        child.on('exit', (code) => (code === 0 ? resolvePromise() : reject(new Error(`npm run restart exited ${code}`))));
        child.on('error', reject);
    });
}

function renderEnvStatus(): void {
    const path = envPath();
    console.log(section('env status'));
    console.log(detail('path', path));
    if (!existsSync(path)) {
        console.log(dim('  (no .env found)'));
        return;
    }
    const parsed = parseEnvFile(path);
    const keys = Object.keys(parsed).sort();
    console.log(detail('keys', String(keys.length)));
    for (const k of keys) {
        const isSet = parsed[k].length > 0;
        const marker = isSet ? ok('set') : dim('empty');
        console.log(`    ${dim(k.padEnd(32))} ${marker}`);
    }
}
