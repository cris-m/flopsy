import { panel, row, STATE, type PanelSection } from '@flopsy/shared';
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
    if (!g) {
        out.push({ severity: 'error', subject: 'gateway', message: 'no snapshot available' });
        return out;
    }
    for (const c of g.channels ?? []) {
        if (!c.enabled) continue;
        if (c.status === 'connected') continue;
        if (c.status === 'connecting') {
            out.push({
                severity: 'warn',
                subject: `channel.${c.name}`,
                message: 'still connecting',
                hint: 'give it a minute; if it sticks, check channel credentials',
            });
        } else if (c.status === 'error') {
            out.push({
                severity: 'error',
                subject: `channel.${c.name}`,
                message: 'connection error',
                hint: 'check `flopsy status` on the server',
            });
        } else if (c.status === 'disconnected') {
            out.push({ severity: 'warn', subject: `channel.${c.name}`, message: 'disconnected' });
        }
    }
    if (g.proactive && !g.proactive.running) {
        out.push({
            severity: 'warn',
            subject: 'proactive',
            message: 'engine stopped',
            hint: 'restart the gateway or check logs',
        });
    }
    if (g.webhook && !g.webhook.enabled && g.proactive && (g.proactive.inboundWebhooks ?? 0) > 0) {
        out.push({
            severity: 'warn',
            subject: 'webhook',
            message: `${g.proactive.inboundWebhooks} route(s) configured but server off`,
            hint: 'set webhook.enabled = true in flopsy.json5',
        });
    }
    if (t?.recentTasks) {
        const failed = t.recentTasks.filter((r) => r.status === 'failed' || r.status === 'killed');
        if (failed.length >= 3) {
            out.push({
                severity: 'warn',
                subject: 'workers',
                message: `${failed.length} tasks failed recently`,
                hint: 'use /tasks to inspect',
            });
        }
    }
    if (t?.team) {
        const main = t.team.find((m) => m.type === 'main' || m.name === t.entryAgent);
        if (main && !main.enabled) {
            out.push({
                severity: 'error',
                subject: 'team.leader',
                message: `main agent "${main.name}" is disabled`,
                hint: 'set enabled: true for the main agent in flopsy.json5',
            });
        }
    }
    return out;
}

function render(issues: Issue[]): string {
    if (issues.length === 0) {
        return panel(
            [{ title: 'doctor', lines: [row('', `${STATE.ok}  all systems operational`)] }],
            { header: 'DOCTOR' },
        );
    }

    const errors = issues.filter((i) => i.severity === 'error');
    const warns = issues.filter((i) => i.severity === 'warn');
    const summary = [
        'DOCTOR',
        errors.length > 0 ? `${errors.length} error${errors.length === 1 ? '' : 's'}` : null,
        warns.length > 0 ? `${warns.length} warning${warns.length === 1 ? '' : 's'}` : null,
    ]
        .filter(Boolean)
        .join(' · ');

    const sections: PanelSection[] = [];
    if (errors.length > 0) sections.push({ title: 'errors', lines: errors.flatMap(issueLines) });
    if (warns.length > 0) sections.push({ title: 'warnings', lines: warns.flatMap(issueLines) });
    return panel(sections, { header: summary });
}

function issueLines(i: Issue): string[] {
    const glyph = i.severity === 'error' ? STATE.fail : STATE.warn;
    const lines = [row(i.subject, `${glyph}  ${i.message}`, 18)];
    if (i.hint) lines.push(row('', `  ↳ ${i.hint}`, 18));
    return lines;
}
