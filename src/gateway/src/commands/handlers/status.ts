/**
 * `/status` slash command — chat-side status reply.
 *
 * Builds a `StatusSnapshot` from the gateway + thread context and renders
 * it via `renderChannelMarkdown()` from `@flopsy/shared`. The same DTO
 * powers `flopsy status` on the terminal side — only the renderer
 * differs, keeping the two output paths in lock-step without drift.
 */

import { renderChannelMarkdown, type StatusSnapshot } from '@flopsy/shared';
import type { CommandDef, CommandContext, GatewayStatusSnapshot, ThreadStatus } from '../types';

export const statusCommand: CommandDef = {
    name: 'status',
    aliases: ['s'],
    description: 'Show gateway + team status.',
    handler: async (ctx: CommandContext) => {
        const snapshot = buildSnapshot(ctx);
        return { text: renderChannelMarkdown(snapshot) };
    },
};

function buildSnapshot(ctx: CommandContext): StatusSnapshot {
    const g = ctx.gatewayStatus;
    const t = ctx.threadStatus;

    const gateway: StatusSnapshot['gateway'] = g
        ? {
              running: true,
              host: '127.0.0.1',
              port: g.port ?? 0,
              ...(g.uptimeMs !== undefined ? { uptimeMs: g.uptimeMs } : {}),
              ...(g.version ? { version: g.version } : {}),
              activeThreads: g.activeThreads,
          }
        : {
              running: false,
              host: '127.0.0.1',
              port: 0,
          };

    const channels: StatusSnapshot['channels'] = (g?.channels ?? []).map((c) => ({
        name: c.name,
        enabled: c.enabled,
        ...(c.enabled
            ? { status: normalizeChannelStatus(c.status) }
            : { status: 'disabled' as const }),
    }));

    const team: StatusSnapshot['team'] = (t?.team ?? []).map((m) => ({
        name: m.name,
        enabled: m.enabled,
        status: m.status === 'running' ? 'working' : m.status === 'disabled' ? 'disabled' : 'idle',
        ...(m.currentTask ? { currentTask: m.currentTask.description } : {}),
        ...(m.lastActiveAt !== undefined ? { lastActiveAgoMs: Date.now() - m.lastActiveAt } : {}),
    }));

    const proactive = buildProactive(g);

    const thread = t ? buildThread(t) : undefined;

    return {
        gateway,
        channels,
        team,
        proactive,
        integrations: {
            auth: [],
            mcp: { enabled: false, configured: 0, active: 0 },
            memory: { enabled: false },
        },
        paths: { config: '', state: '' },
        ...(thread ? { thread } : {}),
    };
}

function buildProactive(g?: GatewayStatusSnapshot): StatusSnapshot['proactive'] {
    const p = g?.proactive;
    const wh = g?.webhook;
    const now = Date.now();
    return {
        enabled: p !== undefined,
        ...(p ? { running: p.running } : {}),
        heartbeats: {
            count: p?.heartbeats ?? 0,
            enabled: p?.heartbeats ?? 0,
            ...(p?.lastHeartbeatAt ? { lastFireAgoMs: now - p.lastHeartbeatAt } : {}),
        },
        cron: {
            count: p?.cronJobs ?? 0,
            enabled: p?.cronJobs ?? 0,
        },
        webhooks: {
            count: p?.inboundWebhooks ?? 0,
            enabled: wh?.enabled ?? false,
        },
    };
}

function buildThread(t: ThreadStatus): NonNullable<StatusSnapshot['thread']> {
    const now = Date.now();
    return {
        entryAgent: t.entryAgent,
        ...(t.tokens
            ? {
                  tokensToday: {
                      input: t.tokens.input,
                      output: t.tokens.output,
                      calls: t.tokens.calls,
                      byModel: t.tokens.byModel.map((m) => ({
                          model: `${m.provider}:${m.model}`,
                          input: m.input,
                          output: m.output,
                          calls: m.calls,
                      })),
                  },
              }
            : {}),
        ...(t.activeTasks.length > 0
            ? {
                  activeTasks: t.activeTasks.map((a) => ({
                      id: a.id,
                      worker: a.worker,
                      description: a.description,
                      runningMs: now - a.startedAtMs,
                  })),
              }
            : {}),
        ...(t.recentTasks.length > 0
            ? {
                  recentTasks: t.recentTasks.map((r) => ({
                      id: r.id,
                      worker: r.worker,
                      description: r.description,
                      status: r.status,
                      ...(r.endedAtMs !== undefined ? { endedAgoMs: now - r.endedAtMs } : {}),
                  })),
              }
            : {}),
    };
}

function normalizeChannelStatus(s: string): StatusSnapshot['channels'][number]['status'] {
    switch (s) {
        case 'connected':
        case 'connecting':
        case 'disconnected':
        case 'error':
            return s;
        default:
            return 'unknown';
    }
}
