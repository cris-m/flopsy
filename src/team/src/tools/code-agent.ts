import { join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { z } from 'zod';
import { defineTool } from 'flopsygraph';
import { resolveFlopsyHome } from '@flopsy/shared';
import { createBackgroundJobTask, toRunning, toTerminal } from '../state/task-state';
import type { TaskRegistry } from '../state/task-registry';
import type { BackgroundEventSink, BackgroundTaskStore } from './spawn-background-task';
import { runAcpAgent } from '../acp/client';
import { resolveLaunchSpec, knownAgents } from '../acp/registry';
import { isPathInside } from '../acp/permission';
import { tryAcquireSlot, releaseSlot } from '../acp/session-manager';
import type { AcpConfig, AcpRunResult } from '../acp/types';

interface CodeAgentConfigurable {
    registry?: TaskRegistry;
    eventQueue?: BackgroundEventSink;
    taskStore?: BackgroundTaskStore;
    threadId?: string;
    acp?: AcpConfig;
}

const schema = z.object({
    agent: z
        .string()
        .describe('Coding agent to drive. Currently: "claude-code".'),
    task: z
        .string()
        .min(1)
        .describe('The coding task. Brief it like a colleague: goal, constraints, which files, what "done" looks like.'),
    cwd: z
        .string()
        .optional()
        .describe('Working dir relative to the code root. Defaults to a fresh job dir. Must stay within the allowed root.'),
});

export const codeAgentTool = defineTool({
    name: 'code_agent',
    description: [
        'Hand a coding task to an external coding agent (e.g. Claude Code) running in a sandboxed working dir. Returns a ticket immediately; a task-notification arrives when it finishes with the edits + summary.',
        '',
        'Use for: writing/refactoring code, fixing failing tests, implementing a feature in a repo under the code root. The agent reads/edits files and runs code within its working dir only — edits outside are blocked.',
        '',
        'Brief the task well: the agent has no memory of this chat. State the goal, constraints, target files, and what done looks like. Long jobs run in the background — call send_message to tell the user it started.',
    ].join('\n'),
    schema,
    execute: async (args, ctx) => {
        const cfg = (ctx.configurable ?? {}) as CodeAgentConfigurable;
        const acp = cfg.acp;
        if (!acp || !acp.enabled) {
            return 'code_agent: ACP is disabled. Set acp.enabled=true in .flopsy/config/flopsy.json5 and run `npm i @agentclientprotocol/sdk`.';
        }
        if (!cfg.registry || !cfg.eventQueue) {
            return 'code_agent: not wired (missing registry/eventQueue) — must run inside a normal agent turn.';
        }
        const spec = resolveLaunchSpec(args.agent, acp.agents);
        if (!spec) {
            return `code_agent: unknown agent "${args.agent}". Available: ${knownAgents(acp.agents).join(', ')}.`;
        }

        const root = resolve(resolveFlopsyHome(), acp.cwdRoot || 'work/code');
        const registry = cfg.registry;
        const eventQueue = cfg.eventQueue;
        const jobId = registry.nextId('background_job');
        const cwd = args.cwd ? resolve(root, args.cwd) : join(root, jobId);
        if (!isPathInside(cwd, root)) {
            return `code_agent: cwd "${args.cwd}" escapes the allowed code root (${root}). Refused.`;
        }

        if (!tryAcquireSlot()) {
            return 'code_agent: too many coding agents already running. Wait for one to finish, then retry.';
        }
        try {
            mkdirSync(cwd, { recursive: true });
        } catch {
            // best-effort; the agent will surface a clearer error if cwd is unusable
        }

        const task = createBackgroundJobTask({
            id: jobId,
            prompt: args.task,
            description: `code_agent:${args.agent}`,
            depth: 1,
        });
        registry.register(task);
        const running = toRunning(task);
        if (running.ok) registry.replace(running.task);

        const agentLabel = args.agent;
        const timeoutMs = acp.timeoutMs;
        const permissionMode = acp.permissionMode;

        void (async () => {
            try {
                const result = await runAcpAgent({
                    spec,
                    task: args.task,
                    cwd,
                    permissionMode,
                    timeoutMs,
                    signal: task.abortPair?.whole.signal,
                    onProgress: (text) =>
                        eventQueue.push({
                            type: 'task_progress',
                            taskId: jobId,
                            progress: text,
                            completedAt: Date.now(),
                            workerName: agentLabel,
                        }),
                });
                const summary = formatResult(agentLabel, cwd, result);
                const current = registry.get(jobId);
                if (current) {
                    const done = toTerminal(current, 'completed', { result: summary });
                    if (done.ok) registry.replace(done.task);
                }
                eventQueue.push({
                    type: 'task_complete',
                    taskId: jobId,
                    result: summary,
                    completedAt: Date.now(),
                    workerName: agentLabel,
                });
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                const current = registry.get(jobId);
                if (current) {
                    const done = toTerminal(current, 'failed', { error: message });
                    if (done.ok) registry.replace(done.task);
                }
                eventQueue.push({
                    type: 'task_error',
                    taskId: jobId,
                    error: message,
                    completedAt: Date.now(),
                    workerName: agentLabel,
                });
            } finally {
                releaseSlot();
            }
        })();

        return `#${jobId} started → ${agentLabel} (cwd ${cwd}). I'll report back when it finishes.`;
    },
});

function formatResult(agent: string, cwd: string, r: AcpRunResult): string {
    const lines = [`${agent} finished (stop: ${r.stopReason}).`, `cwd: ${cwd}`];
    if (r.editedPaths.length) lines.push(`edited: ${r.editedPaths.join(', ')}`);
    if (r.deniedPaths.length) lines.push(`blocked (outside cwd): ${r.deniedPaths.join(', ')}`);
    if (r.toolCalls.length) lines.push(`tools: ${r.toolCalls.slice(-12).join(' · ')}`);
    const transcript = r.transcript.trim();
    if (transcript) {
        lines.push('');
        lines.push(transcript.length > 6000 ? transcript.slice(0, 6000) + '…' : transcript);
    }
    return lines.join('\n');
}
