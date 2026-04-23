/**
 * `flopsy run ...` — process control for the gateway daemon.
 *
 * Subcommands:
 *   flopsy run status    — is the gateway up? pid, uptime, port
 *   flopsy run start     — shell out to `npm start` (foreground)
 *   flopsy run stop      — shell out to `npm run stop`
 *   flopsy run restart   — shell out to `npm run restart`
 *   flopsy run logs      — tail the log file (if configured)
 *
 * Shells to npm rather than re-implementing the daemon lifecycle so
 * whatever the root package.json scripts do stays the source of truth
 * (currently: stop kills `tsx src/main.ts` + preflight.cjs).
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import stripAnsi from 'strip-ansi';
import { workspace } from '@flopsy/shared';
import { bad, dim, info, link, ok, row, section } from '../ui/pretty';
import { styleRabbit } from '../ui/banner';
import { palette, tint } from '../ui/theme';
import { configPath, readFlopsyConfig } from './config-reader';
import { probeGatewayState } from './gateway-state';

export function registerRunCommands(root: Command): void {
    // `gateway` is an alias for `run` — more descriptive for users who
    // think in terms of the messaging gateway rather than a generic
    // process runner. Under the hood they're the same subcommand tree.
    const run = root
        .command('run')
        .alias('gateway')
        .description('Start / stop / restart the gateway daemon');

    run.command('status')
        .description('Show gateway process status')
        .action(async () => {
            const { config } = readFlopsyConfig();
            const port = config.gateway?.port ?? 18789;
            const state = await probeGatewayState(port);
            console.log(section('Gateway run status'));
            if (state.running) {
                console.log(row('state', ok('running')));
                console.log(row('pid', String(state.pid)));
                if (state.uptime) console.log(row('uptime', state.uptime.trim()));
                console.log(row('port', String(state.port)));
            } else {
                console.log(row('state', bad('not running')));
                console.log(row('port', dim(String(state.port))));
                console.log(row('start', dim('flopsy run start')));
            }
        });

    run.command('start')
        .description('Start the gateway detached in the background')
        .option('--attach', 'Start in the foreground and stream logs')
        .action((opts: { attach?: boolean }) => {
            if (opts.attach) {
                passthroughNpm(['start']);
            } else {
                void startDetached();
            }
        });

    run.command('stop')
        .description('Stop a running gateway (kills the tsx process)')
        .action(() => void stopWithBanner());

    run.command('restart')
        .description('Stop the gateway and start it detached in the background')
        .option('--attach', 'Attach to the new gateway instead of detaching')
        .action((opts: { attach?: boolean }) => {
            if (opts.attach) {
                passthroughNpm(['run', 'restart']);
            } else {
                void restartDetached();
            }
        });

    run.command('logs')
        .description('Tail the gateway log file (tail -f)')
        .option('-n, --lines <n>', 'Lines of history to include before following', '200')
        .action((opts: { lines: string }) => {
            const { config } = readFlopsyConfig();
            const fileRel = config.logging?.file;
            if (!fileRel) {
                console.log(
                    info("No log file configured. Set `logging.file` in flopsy.json5 (e.g. 'logs/flopsy.log')."),
                );
                return;
            }
            // Resolve relative to workspace root — respects FLOPSY_HOME.
            const abs = resolve(workspace.root(), fileRel);
            if (!existsSync(abs)) {
                console.log(bad(`Log file not found at ${abs}`));
                console.log(dim('Start the gateway first or adjust logging.file.'));
                return;
            }
            console.log(dim(`tail -f ${link(abs)}`));
            const child = spawn('tail', ['-F', '-n', opts.lines, abs], {
                stdio: 'inherit',
            });
            child.on('exit', (code) => process.exit(code ?? 0));
        });
}

/**
 * Shell out to npm in the repo root (dir containing flopsy.json5), not
 * cwd — users often run `flopsy run restart` from inside the workspace
 * (~/.flopsy) where there's no package.json.
 */
function passthroughNpm(npmArgs: string[]): void {
    const child = spawn('npm', npmArgs, {
        stdio: 'inherit',
        cwd: dirname(configPath()),
    });
    child.on('exit', (code) => process.exit(code ?? 0));
    child.on('error', (err) => {
        console.error(`error: failed to spawn npm: ${err.message}`);
        process.exit(1);
    });
}

/**
 * Stop any running gateway, then spawn a new one detached — so the CLI
 * returns control to the shell instead of streaming the gateway's logs.
 *
 * Gateway logs still flow to `logging.file` (if configured) AND to a
 * sidecar file under the workspace so `flopsy run logs` / `tail -f` can
 * pick them up.
 */
async function restartDetached(): Promise<void> {
    const repoRoot = dirname(configPath());
    const { config } = readFlopsyConfig();
    const port = config.gateway?.port ?? 18789;

    mkdirSync(workspace.logs(), { recursive: true, mode: 0o700 });
    const logPath = resolve(workspace.logs(), 'gateway-stdio.log');
    const logFd = openSync(logPath, 'a');

    // `npm run stop` is idempotent (trailing `|| true`) so we don't bail
    // when nothing was running.
    process.stdout.write(dim('stopping gateway…\n'));
    await runSilent('npm', ['run', 'stop'], repoRoot, logFd);

    await spawnDetachedAndReport(repoRoot, port, logFd, logPath, 'Gateway restarted');
}

async function startDetached(): Promise<void> {
    const repoRoot = dirname(configPath());
    const { config } = readFlopsyConfig();
    const port = config.gateway?.port ?? 18789;

    // Guard against double-start — two processes racing for the port
    // usually means the new one fails silently.
    const before = await probeGatewayState(port);
    if (before.running) {
        printGatewayBanner('Gateway already running', [
            row('state', tint.success('● running')),
            ...(before.pid !== undefined ? [row('pid', String(before.pid))] : []),
            row('port', String(before.port)),
            ...(before.uptime ? [row('uptime', before.uptime.trim())] : []),
        ]);
        return;
    }

    mkdirSync(workspace.logs(), { recursive: true, mode: 0o700 });
    const logPath = resolve(workspace.logs(), 'gateway-stdio.log');
    const logFd = openSync(logPath, 'a');

    await spawnDetachedAndReport(repoRoot, port, logFd, logPath, 'Gateway started');
}

/**
 * Spawn `npm start` detached, then poll until the port is bound.
 * Shared by `start` and `restart` so their banners stay in lockstep.
 */
async function spawnDetachedAndReport(
    repoRoot: string,
    port: number,
    logFd: number,
    logPath: string,
    title: string,
): Promise<void> {
    process.stdout.write(dim('starting gateway…\n'));
    const child = spawn('npm', ['start'], {
        cwd: repoRoot,
        detached: true,
        stdio: ['ignore', logFd, logFd],
    });
    child.unref();

    const started = await waitForPort(port, 15_000);
    if (started) {
        printGatewayBanner(title, [
            row('state', tint.success('● running')),
            ...(started.pid !== undefined ? [row('pid', String(started.pid))] : []),
            row('port', String(started.port)),
            row('uptime', started.uptime?.trim() || 'just started'),
        ]);
    } else {
        console.log(bad(`gateway did not come up on :${port} within 15s`));
        console.log(dim(`logs: ${link(logPath)}`));
        process.exitCode = 1;
    }
}

/**
 * Stop the running gateway and show a banner matching the restart
 * layout. If the gateway wasn't running, render the "already stopped"
 * form instead of a no-op.
 */
async function stopWithBanner(): Promise<void> {
    const repoRoot = dirname(configPath());
    const { config } = readFlopsyConfig();
    const port = config.gateway?.port ?? 18789;

    const before = await probeGatewayState(port);

    mkdirSync(workspace.logs(), { recursive: true, mode: 0o700 });
    const logPath = resolve(workspace.logs(), 'gateway-stdio.log');
    const logFd = openSync(logPath, 'a');

    process.stdout.write(dim('stopping gateway…\n'));
    await runSilent('npm', ['run', 'stop'], repoRoot, logFd);

    if (!before.running) {
        printGatewayBanner('Gateway stopped', [
            row('state', dim('○ was not running')),
            row('port', String(port)),
        ]);
        return;
    }

    printGatewayBanner('Gateway stopped', [
        row('state', tint.team('○ stopped')),
        ...(before.pid !== undefined ? [row('pid', String(before.pid))] : []),
        row('port', String(before.port)),
    ]);
}

/**
 * Two-column panel: mascot on the left, arbitrary status rows on the
 * right. ANSI-aware width math — `stripAnsi` gives the visible width so
 * the right column stays flush even when the rabbit is coloured.
 *
 * Title is built inline (not via `section()`) because `section()`
 * prepends a newline, which would break the row-by-row zip.
 */
function printGatewayBanner(title: string, rightLines: readonly string[]): void {
    const mascot = styleRabbit(true).split('\n').filter(Boolean);
    const mascotWidth = Math.max(...mascot.map((l) => stripAnsi(l).length));
    const gutter = '  ';

    const titleLine = `${chalk.hex(palette.brand)('▎')} ${chalk.bold(title)}`;
    const lines: string[] = [titleLine, ...rightLines];

    const rows = Math.max(mascot.length, lines.length);
    console.log('');
    for (let i = 0; i < rows; i++) {
        const left = mascot[i] ?? '';
        const pad = ' '.repeat(Math.max(0, mascotWidth - stripAnsi(left).length));
        console.log(left + pad + gutter + (lines[i] ?? ''));
    }
    console.log('');
}

function runSilent(
    cmd: string,
    args: readonly string[],
    cwd: string,
    logFd: number,
): Promise<void> {
    return new Promise((resolveP, rejectP) => {
        const child = spawn(cmd, args as string[], {
            stdio: ['ignore', logFd, logFd],
            cwd,
        });
        child.on('error', rejectP);
        child.on('exit', () => resolveP()); // ignore exit code — `stop` returns non-zero when nothing to kill
    });
}

async function waitForPort(port: number, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const state = await probeGatewayState(port);
        if (state.running) return state;
        await new Promise((r) => setTimeout(r, 250));
    }
    return null;
}
