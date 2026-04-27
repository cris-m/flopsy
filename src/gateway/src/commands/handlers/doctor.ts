/**
 * `/doctor` slash command — fast health verdict for chat.
 *
 * Unlike `flopsy doctor` on the CLI (which runs 10 filesystem/env checks),
 * the chat-side `/doctor` focuses on runtime health observable from inside
 * the gateway: channel connection state, proactive engine state, per-agent
 * activity. It highlights PROBLEMS (with remediation hints) first and only
 * shows a short "all systems operational" line when nothing's wrong.
 */

import type { CommandDef, CommandContext, GatewayStatusSnapshot, ThreadStatus } from '../types';

interface Issue {
    severity: 'error' | 'warn';
    subject: string;
    message: string;
    hint?: string;
}

export const doctorCommand: CommandDef = {
    name: 'doctor',
    aliases: ['health', 'check'],
    description: 'Quick health verdict — surfaces problems + remediation hints.',
    handler: async (ctx: CommandContext) => {
        const issues = diagnose(ctx.gatewayStatus, ctx.threadStatus);
        return { text: render(issues) };
    },
};

function diagnose(g?: GatewayStatusSnapshot, t?: ThreadStatus): Issue[] {
    const out: Issue[] = [];

    // Gateway — should always be reachable when this handler runs, but the
    // snapshot may carry warnings.
    if (!g) {
        out.push({ severity: 'error', subject: 'gateway', message: 'no snapshot available' });
        return out;
    }

    // Channels — flag any enabled channel that isn't connected.
    for (const c of g.channels ?? []) {
        if (!c.enabled) continue;
        if (c.status === 'connected') continue;
        if (c.status === 'connecting') {
            out.push({
                severity: 'warn',
                subject: `channel.${c.name}`,
                message: 'still connecting',
                hint: 'give it a minute; if it sticks, check the channel credentials',
            });
        } else if (c.status === 'error') {
            out.push({
                severity: 'error',
                subject: `channel.${c.name}`,
                message: 'connection error',
                hint: 'check `flopsy status` on the server',
            });
        } else if (c.status === 'disconnected') {
            out.push({
                severity: 'warn',
                subject: `channel.${c.name}`,
                message: 'disconnected',
            });
        }
    }

    // Proactive — running flag should reflect config intent.
    if (g.proactive && !g.proactive.running) {
        out.push({
            severity: 'warn',
            subject: 'proactive',
            message: 'engine is stopped',
            hint: 'restart the gateway or check logs',
        });
    }

    // Webhook server — if enabled in config, it should be listening.
    if (g.webhook && !g.webhook.enabled && g.proactive && g.proactive.inboundWebhooks > 0) {
        out.push({
            severity: 'warn',
            subject: 'webhook',
            message: `${g.proactive.inboundWebhooks} route(s) configured but server off`,
            hint: 'set `webhook.enabled = true` in flopsy.json5',
        });
    }

    // Workers — flag consecutive-error backoff (would be in task state; we
    // look at recent failed tasks as a proxy).
    if (t?.recentTasks) {
        const recentFailed = t.recentTasks.filter((r) => r.status === 'failed' || r.status === 'killed');
        if (recentFailed.length >= 3) {
            out.push({
                severity: 'warn',
                subject: 'workers',
                message: `${recentFailed.length} tasks failed recently`,
                hint: 'use `/tasks --failed` or `flopsy tasks --failed` to inspect',
            });
        }
    }

    // Disabled main agent — the thread can't run without one.
    if (t?.team) {
        const main = t.team.find((m) => m.type === 'main' || m.name === t.entryAgent);
        if (main && !main.enabled) {
            out.push({
                severity: 'error',
                subject: 'team.leader',
                message: `main agent "${main.name}" is disabled`,
                hint: 'set `enabled: true` for the main agent in flopsy.json5',
            });
        }
    }

    return out;
}

function render(issues: Issue[]): string {
    if (issues.length === 0) {
        return '*/doctor*\n✅ All systems operational — no problems detected.';
    }

    const errors = issues.filter((i) => i.severity === 'error');
    const warns = issues.filter((i) => i.severity === 'warn');

    const lines: string[] = [];
    const counts: string[] = [];
    if (errors.length > 0) counts.push(`${errors.length} error${errors.length === 1 ? '' : 's'}`);
    if (warns.length > 0) counts.push(`${warns.length} warning${warns.length === 1 ? '' : 's'}`);
    lines.push(`*/doctor* — ${counts.join(', ')}`);

    for (const i of errors) {
        lines.push('');
        lines.push(`❌ *${i.subject}* — ${i.message}`);
        if (i.hint) lines.push(`   _${i.hint}_`);
    }
    for (const i of warns) {
        lines.push('');
        lines.push(`⚠️ *${i.subject}* — ${i.message}`);
        if (i.hint) lines.push(`   _${i.hint}_`);
    }

    return lines.join('\n');
}
