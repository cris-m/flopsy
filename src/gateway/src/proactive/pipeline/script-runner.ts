/**
 * ScriptRunner — execute a sandbox-locked pre-check or no-agent script
 * for a proactive fire.
 *
 * Two use cases, both flowing through the same runner:
 *
 *   1. `job.noAgent === true` — the script IS the job. Its stdout becomes
 *      the message delivered to the channel. Empty stdout = silent tick
 *      (no delivery, no agent call). Non-zero exit = error alert.
 *
 *   2. `job.preCheckScript` — runs BEFORE the agent. Two control signals:
 *        - stdout containing the line `{"wakeAgent": false}` → caller
 *          should suppress the fire entirely.
 *        - otherwise → caller prepends stdout as a `<pre_check>` block
 *          to the agent's prompt, then proceeds normally.
 *
 * Security model (mirrors `execute_code`'s posture, scoped tighter because
 * these scripts run unattended on a schedule):
 *
 *   - Path is resolved against `<FLOPSY_HOME>/scripts/` only. Resolved
 *     absolute path MUST start with that directory — defeats `..`
 *     traversal and absolute-path arguments.
 *   - Env is stripped to a known-safe allowlist (`PATH`, `HOME`, `LANG`,
 *     `LC_ALL`, `TZ`). Variables containing KEY/TOKEN/SECRET/PASSWORD/
 *     CREDENTIAL/PASSWD/AUTH never reach the script. Skill-style
 *     per-script allowlists are a later concern.
 *   - Stdout capped at 50KB, stderr at 10KB. Anything beyond is truncated
 *     with a sentinel suffix the caller can detect.
 *   - Default 30s timeout (configurable per-call). On timeout the script
 *     is killed with SIGTERM, then SIGKILL 2s later.
 *   - Runs in its own process group so a forking child can't outlive the
 *     parent kill.
 *
 * This is intentionally cheaper than `execute_code` (no docker, no sandbox
 * session, no programmatic tool calling). The user authors these scripts
 * themselves and drops them in their own workspace — same trust boundary
 * as a cron entry. The path restriction is the only thing keeping a
 * malicious cron payload from escalating.
 */

import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { createLogger, resolveFlopsyHome } from '@flopsy/shared';

const log = createLogger('script-runner');

/** Envvar names that contain secret bytes — always stripped. */
const SECRET_NAME_PATTERNS = [
    'KEY',
    'TOKEN',
    'SECRET',
    'PASSWORD',
    'PASSWD',
    'CREDENTIAL',
    'AUTH',
];

/** Envvar names that ARE passed through. Everything else is dropped. */
const ENV_ALLOWLIST = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'USER', 'SHELL'];

export const DEFAULT_TIMEOUT_MS = 30_000;
export const STDOUT_CAP_BYTES = 50 * 1024;
export const STDERR_CAP_BYTES = 10 * 1024;
const TRUNCATION_SUFFIX = '\n[...truncated]';

export interface ScriptRunResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut: boolean;
    /** Resolved when stdout contains the `{"wakeAgent": false}` sentinel. */
    wakeAgent: boolean;
    durationMs: number;
}

export interface ScriptRunOptions {
    /** Hard timeout. Defaults to DEFAULT_TIMEOUT_MS. */
    timeoutMs?: number;
    /** Working directory. Defaults to FLOPSY_HOME. */
    cwd?: string;
}

/**
 * Validate that `scriptRel` resolves to a real file inside the scripts dir.
 * Returns the absolute path on success; throws on any rejection reason.
 */
export function resolveScriptPath(scriptRel: string): string {
    if (!scriptRel || typeof scriptRel !== 'string') {
        throw new Error('script path is empty');
    }
    if (isAbsolute(scriptRel)) {
        throw new Error(`script path must be relative to FLOPSY_HOME/scripts/ (got absolute: ${scriptRel})`);
    }
    const scriptsRoot = join(resolveFlopsyHome(), 'scripts');
    const candidate = resolve(scriptsRoot, scriptRel);
    if (!candidate.startsWith(scriptsRoot + '/') && candidate !== scriptsRoot) {
        throw new Error(`script path escapes scripts/ root: ${scriptRel}`);
    }
    if (!existsSync(candidate)) {
        throw new Error(`script not found: ${candidate}`);
    }
    const stat = statSync(candidate);
    if (!stat.isFile()) {
        throw new Error(`script is not a regular file: ${candidate}`);
    }
    // Owner-execute bit required — the runner invokes the script directly
    // so its shebang controls the interpreter.
    if ((stat.mode & 0o100) === 0) {
        throw new Error(`script not executable (chmod +x required): ${candidate}`);
    }
    return candidate;
}

/**
 * Build the stripped env that scripts run with. We start from a clean slate
 * (ENV_ALLOWLIST keys only), then drop any name that matches the secret
 * patterns even if it was in the allowlist (defense in depth).
 */
function buildSafeEnv(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const name of ENV_ALLOWLIST) {
        const v = process.env[name];
        if (v === undefined) continue;
        if (SECRET_NAME_PATTERNS.some((p) => name.toUpperCase().includes(p))) continue;
        out[name] = v;
    }
    return out;
}

/** Detect `{"wakeAgent": false}` sentinel on its own line in stdout. */
function parseWakeAgent(stdout: string): boolean {
    // Accept either a line that's exactly that JSON literal, or a JSON line
    // that decodes to an object with `wakeAgent: false`.
    for (const lineRaw of stdout.split('\n')) {
        const line = lineRaw.trim();
        if (!line || line[0] !== '{') continue;
        try {
            const parsed = JSON.parse(line);
            if (parsed && typeof parsed === 'object' && parsed.wakeAgent === false) {
                return false;
            }
        } catch {
            // Not JSON; ignore.
        }
    }
    return true;
}

/** Run a script. Invokes the script directly so its shebang controls the
 *  interpreter; bypassing the `/bin/bash` wrapper prevents `exec` from
 *  escaping the process group on kill. The script must be executable. */
export async function runScript(
    scriptRel: string,
    opts: ScriptRunOptions = {},
): Promise<ScriptRunResult> {
    const absScript = resolveScriptPath(scriptRel);
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const startedAt = Date.now();

    return new Promise((res) => {
        const child = spawn(absScript, [], {
            cwd: opts.cwd ?? resolveFlopsyHome(),
            env: buildSafeEnv(),
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true,
        });

        let stdoutBuf = '';
        let stderrBuf = '';
        let stdoutOver = false;
        let stderrOver = false;
        let timedOut = false;
        let settled = false;

        child.stdout.setEncoding('utf-8');
        child.stderr.setEncoding('utf-8');

        child.stdout.on('data', (chunk: string) => {
            if (stdoutOver) return;
            if (stdoutBuf.length + chunk.length > STDOUT_CAP_BYTES) {
                stdoutBuf = (stdoutBuf + chunk).slice(0, STDOUT_CAP_BYTES) + TRUNCATION_SUFFIX;
                stdoutOver = true;
            } else {
                stdoutBuf += chunk;
            }
        });
        child.stderr.on('data', (chunk: string) => {
            if (stderrOver) return;
            if (stderrBuf.length + chunk.length > STDERR_CAP_BYTES) {
                stderrBuf = (stderrBuf + chunk).slice(0, STDERR_CAP_BYTES) + TRUNCATION_SUFFIX;
                stderrOver = true;
            } else {
                stderrBuf += chunk;
            }
        });

        const timer = setTimeout(() => {
            if (settled) return;
            timedOut = true;
            try {
                // Negative pid sends to whole process group thanks to `detached: true`.
                process.kill(-child.pid!, 'SIGTERM');
            } catch (err) {
                log.warn({ err, scriptRel }, 'SIGTERM failed (script likely already exited)');
            }
            setTimeout(() => {
                try {
                    process.kill(-child.pid!, 'SIGKILL');
                } catch {
                    /* swallow — already dead */
                }
            }, 2_000);
        }, timeoutMs);

        const finalize = (exitCode: number): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const wakeAgent = parseWakeAgent(stdoutBuf);
            const durationMs = Date.now() - startedAt;
            log.debug(
                {
                    scriptRel,
                    exitCode,
                    timedOut,
                    durationMs,
                    stdoutLen: stdoutBuf.length,
                    stderrLen: stderrBuf.length,
                    wakeAgent,
                },
                'script finished',
            );
            res({ stdout: stdoutBuf, stderr: stderrBuf, exitCode, timedOut, wakeAgent, durationMs });
        };

        child.on('error', (err) => {
            // spawn-level failure (ENOENT, EACCES). Treat as exit-code 127
            // (command not found / not executable) for caller convenience.
            log.warn({ err, scriptRel }, 'script spawn failed');
            stderrBuf = (stderrBuf + `\n${err.message}`).slice(0, STDERR_CAP_BYTES);
            finalize(127);
        });
        child.on('exit', (code, signal) => {
            // signal kills (SIGTERM/SIGKILL from timeout) report exit 124
            // (the conventional "timeout" code on Linux) so callers can
            // distinguish from a normal non-zero exit.
            if (signal) finalize(timedOut ? 124 : 130);
            else finalize(code ?? 0);
        });
    });
}
