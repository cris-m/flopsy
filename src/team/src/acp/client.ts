import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import type * as Acp from '@agentclientprotocol/sdk';
import { createLogger } from '@flopsy/shared';
import { AcpSdkMissingError } from './errors';
import { decidePermission, pickOptionId } from './permission';
import type { AcpLaunchSpec, AcpPermissionMode, AcpRunResult } from './types';

const log = createLogger('acp-client');

// Default-deny env (mirror src/team/src/mcp/client-manager.ts): inheriting process.env would
// leak GATEWAY_TOKEN, OAuth refresh tokens, and API keys into the agent child.
const ENV_ALLOWLIST = [
    'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL',
    'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM', 'COLORTERM',
    'TMPDIR', 'TEMP', 'TMP', 'NODE_PATH', 'NVM_DIR', 'FLOPSY_HOME',
];

function scopedEnv(extra?: Record<string, string>): Record<string, string> {
    const env: Record<string, string> = {};
    for (const key of ENV_ALLOWLIST) {
        const value = process.env[key];
        if (typeof value === 'string') env[key] = value;
    }
    if (extra) Object.assign(env, extra);
    return env;
}

async function loadSdk(): Promise<typeof Acp> {
    try {
        return (await import('@agentclientprotocol/sdk')) as unknown as typeof Acp;
    } catch {
        throw new AcpSdkMissingError();
    }
}

export interface RunAcpAgentArgs {
    spec: AcpLaunchSpec;
    task: string;
    cwd: string;
    permissionMode: AcpPermissionMode;
    timeoutMs: number;
    signal?: AbortSignal;
    onProgress?: (text: string) => void;
}

export async function runAcpAgent(args: RunAcpAgentArgs): Promise<AcpRunResult> {
    const acp = await loadSdk();
    const { spec, task, cwd, permissionMode, timeoutMs, signal, onProgress } = args;

    const child: ChildProcess = spawn(spec.command, spec.args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: scopedEnv(spec.env),
    });

    const transcript: string[] = [];
    const toolCalls: string[] = [];
    const editedPaths = new Set<string>();
    const deniedPaths = new Set<string>();
    let lastProgressAt = 0;
    const emitProgress = (text: string): void => {
        if (!onProgress) return;
        const now = Date.now();
        if (now - lastProgressAt < 1500) return;
        lastProgressAt = now;
        onProgress(text);
    };

    const client: Acp.Client = {
        async sessionUpdate(params: Acp.SessionNotification): Promise<void> {
            const update = params.update as Record<string, unknown> & { sessionUpdate: string };
            switch (update.sessionUpdate) {
                case 'agent_message_chunk': {
                    const content = update['content'] as { type?: string; text?: string } | undefined;
                    if (content?.type === 'text' && content.text) transcript.push(content.text);
                    break;
                }
                case 'tool_call': {
                    const title = String(update['title'] ?? 'tool');
                    const status = String(update['status'] ?? '');
                    toolCalls.push(`${title} (${status})`);
                    const locations = (update['locations'] as Array<{ path?: string }> | undefined) ?? [];
                    for (const loc of locations) if (loc?.path) editedPaths.add(loc.path);
                    emitProgress(`▸ ${title}`);
                    break;
                }
                case 'tool_call_update': {
                    emitProgress(`▸ ${String(update['toolCallId'] ?? 'tool')}: ${String(update['status'] ?? '')}`);
                    break;
                }
                default:
                    break;
            }
        },
        async requestPermission(
            params: Acp.RequestPermissionRequest,
        ): Promise<Acp.RequestPermissionResponse> {
            const locations = params.toolCall?.locations ?? [];
            const paths = locations.map((l) => l.path).filter((p): p is string => Boolean(p));
            const decision = decidePermission(permissionMode, cwd, paths);
            if (!decision.allow) for (const p of paths) deniedPaths.add(p);
            const optionId = pickOptionId(params.options, decision.allow);
            if (!optionId) return { outcome: { outcome: 'cancelled' } };
            return { outcome: { outcome: 'selected', optionId } };
        },
    };

    const toAgent = Writable.toWeb(child.stdin!) as unknown as WritableStream<Uint8Array>;
    const fromAgent = Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(toAgent, fromAgent);
    const connection = new acp.ClientSideConnection(() => client, stream);

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
        if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });

    const kill = (): void => {
        try {
            child.kill('SIGTERM');
        } catch {
            // already dead
        }
    };
    const timer = setTimeout(() => {
        log.warn({ timeoutMs }, 'acp run exceeded timeout — killing agent');
        kill();
    }, timeoutMs);
    const onAbort = (): void => kill();
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
        await connection.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        });
        const session = await connection.newSession({ cwd, mcpServers: [] });
        const result = await connection.prompt({
            sessionId: session.sessionId,
            prompt: [{ type: 'text', text: task }],
        });
        return {
            stopReason: result.stopReason,
            transcript: transcript.join(''),
            toolCalls,
            editedPaths: [...editedPaths],
            deniedPaths: [...deniedPaths],
        };
    } catch (err) {
        const detail = stderr.trim() ? `\n--- agent stderr ---\n${stderr.trim()}` : '';
        throw new Error(`${err instanceof Error ? err.message : String(err)}${detail}`);
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        kill();
    }
}
