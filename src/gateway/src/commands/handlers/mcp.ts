import { panel, row, STATE, formatCount } from '@flopsy/shared';
import type { PanelSection } from '@flopsy/shared';
import type { CommandContext, CommandDef } from '../types';
import { getMcpFacade, type McpServerStatus } from '../mcp-facade';

export const mcpCommand: CommandDef = {
    name: 'mcp',
    description: 'Show MCP server status. `/mcp reload` to reconnect after auth changes.',
    handler: async (ctx: CommandContext) => {
        const facade = getMcpFacade();
        if (!facade) {
            return { text: panel([{ title: '', lines: [row('mcp', `${STATE.fail}  facade not wired`, 8)] }]) };
        }

        const args = ctx.rawArgs.trim().toLowerCase();

        if (args === '' || args === 'list' || args === 'status') {
            return { text: renderList(facade.listServers()) };
        }

        if (args === 'reload' || args.startsWith('reload')) {
            const evict = args.includes('--evict') || args.includes('-e');
            try {
                const result = await facade.reload({ evictCachedThreads: evict });
                return { text: renderReload(result, facade.listServers()) };
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return {
                    text: panel(
                        [{ title: 'reload', lines: [row('error', `${STATE.fail}  ${msg}`, 8)] }],
                        { header: 'MCP RELOAD' },
                    ),
                };
            }
        }

        return {
            text: panel(
                [
                    {
                        title: 'usage',
                        lines: [
                            row('/mcp', 'show server status', 22),
                            row('/mcp reload', 'reconnect newly authed', 22),
                            row('/mcp reload --evict', 'reload + drop caches', 22),
                        ],
                    },
                ],
                { header: 'MCP' },
            ),
        };
    },
};

function glyph(status: McpServerStatus['status']): string {
    switch (status) {
        case 'connected': return STATE.ok;
        case 'skipped':   return STATE.warn;
        case 'failed':    return STATE.fail;
        case 'disabled':  return STATE.off;
    }
}

function statusLabel(s: McpServerStatus): string {
    if (s.status === 'connected') {
        const tools = s.toolCount != null ? ` · ${formatCount(s.toolCount)} tools` : '';
        return `connected${tools}`;
    }
    if (s.status === 'disabled') return 'disabled';
    return s.reason ? `${s.status} · ${s.reason}` : s.status;
}

function renderList(servers: readonly McpServerStatus[]): string {
    if (servers.length === 0) {
        return panel(
            [{ title: '', lines: [row('mcp', '(no servers configured)', 8)] }],
            { header: 'MCP SERVERS' },
        );
    }

    const order: Record<McpServerStatus['status'], number> = {
        connected: 0,
        skipped:   1,
        failed:    2,
        disabled:  3,
    };
    const sorted = [...servers].sort(
        (a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name),
    );

    const lines = sorted.map((s) => row(s.name, `${glyph(s.status)}  ${statusLabel(s)}`, 18));

    const counts = {
        connected: servers.filter((s) => s.status === 'connected').length,
        skipped:   servers.filter((s) => s.status === 'skipped').length,
        failed:    servers.filter((s) => s.status === 'failed').length,
        disabled:  servers.filter((s) => s.status === 'disabled').length,
    };
    const totalTools = servers.reduce((n, s) => n + (s.toolCount ?? 0), 0);

    const summary =
        `${counts.connected} live · ${totalTools} tools` +
        (counts.skipped ? ` · ${counts.skipped} skipped` : '') +
        (counts.failed ? ` · ${counts.failed} failed` : '');

    const sections: PanelSection[] = [
        { title: 'servers', lines },
    ];

    if (counts.skipped > 0 || counts.failed > 0) {
        sections.push({
            title: 'hint',
            lines: [
                row('', '`flopsy auth <provider>` to fix auth-skipped servers'),
                row('', '`/mcp reload` to reconnect after credentials change'),
            ],
        });
    }

    return panel(sections, { header: `MCP SERVERS  ${summary}` });
}

function renderReload(
    result: {
        connected: readonly string[];
        skipped: ReadonlyArray<{ name: string; reason: string }>;
        failed: ReadonlyArray<{ name: string; reason: string }>;
        evictedCachedThreads: boolean;
    },
    snapshot: readonly McpServerStatus[],
): string {
    const sections: PanelSection[] = [];

    const reloadLines: string[] = [];
    if (result.connected.length > 0) {
        for (const name of result.connected) {
            reloadLines.push(row(name, `${STATE.ok}  newly connected`, 18));
        }
    }
    if (result.failed.length > 0) {
        for (const f of result.failed) {
            reloadLines.push(row(f.name, `${STATE.fail}  ${f.reason}`, 18));
        }
    }
    if (reloadLines.length === 0) {
        reloadLines.push(row('', '(no new servers came online)'));
    }
    sections.push({ title: 'changes', lines: reloadLines });

    if (result.skipped.length > 0) {
        const skipLines = result.skipped.map((s) =>
            row(s.name, `${STATE.warn}  ${s.reason}`, 18),
        );
        sections.push({ title: 'still skipped', lines: skipLines });
    }

    const evictNote = result.evictedCachedThreads
        ? `${STATE.ok}  cached threads evicted — next message uses fresh toolset`
        : result.connected.length > 0
            ? `${STATE.warn}  new servers visible to NEW threads only · run \`/mcp reload --evict\` to refresh this thread`
            : `${STATE.off}  no eviction needed`;
    sections.push({ title: 'threads', lines: [row('', evictNote)] });

    const totalLive = snapshot.filter((s) => s.status === 'connected').length;
    const totalTools = snapshot.reduce((n, s) => n + (s.toolCount ?? 0), 0);
    return panel(sections, {
        header: `MCP RELOAD  ${totalLive} live · ${totalTools} tools`,
    });
}
