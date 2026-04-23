/**
 * Inspect whether the gateway process is running on its configured port.
 *
 * Intentionally NOT a real RPC call — a true control plane will land
 * later. For now we use the OS signals any ops-team reaches for:
 *   - `lsof -ti :<port>` → PID on that port (or empty)
 *   - `ps -p <pid> -o etime=` → elapsed time (for uptime display)
 *
 * Returns a structured snapshot so multiple commands (`status`, `run
 * status`) can render it consistently without duplicating shell calls.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GatewayState {
    readonly running: boolean;
    readonly pid?: number;
    /** Elapsed time from `ps` — e.g. "05:23" or "01:04:55". */
    readonly uptime?: string;
    /** Port that was checked — echoed back for display. */
    readonly port: number;
}

export async function probeGatewayState(port = 18789): Promise<GatewayState> {
    const pid = await lsofPortPid(port);
    if (!pid) return { running: false, port };

    const uptime = await psEtime(pid);
    return { running: true, pid, ...(uptime ? { uptime } : {}), port };
}

async function lsofPortPid(port: number): Promise<number | undefined> {
    try {
        const { stdout } = await execFileAsync('lsof', ['-ti', `:${port}`]);
        const first = stdout.trim().split(/\s+/)[0];
        if (!first) return undefined;
        const pid = Number.parseInt(first, 10);
        return Number.isFinite(pid) ? pid : undefined;
    } catch {
        // lsof returns non-zero on no match OR if lsof is missing. Either
        // way → gateway not observable.
        return undefined;
    }
}

async function psEtime(pid: number): Promise<string | undefined> {
    try {
        const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'etime=']);
        return stdout.trim() || undefined;
    } catch {
        return undefined;
    }
}
