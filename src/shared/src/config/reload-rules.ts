// Reload-mode metadata for flopsy.json5 paths — pure data, no handlers.
//
// The gateway pairs each rule below with a handler at boot to build the
// runtime reload table; the CLI imports this same data to answer "which
// keys hot-reload, which need a restart". Single source of truth.

export type ReloadMode = 'hot' | 'restart';

export interface ReloadRuleMeta {
    /** `*` matches one segment, `**` matches any depth. */
    readonly pattern: string;
    readonly mode: ReloadMode;
    /** One-line reason shown to the user (CLI, config-edit banner). */
    readonly reason: string;
}

// Ordering matters — first match wins. Most specific first.
export const RELOAD_RULES_META: ReadonlyArray<ReloadRuleMeta> = [
    // Channels — toggle live-applies (disable side; enable still falls back to restart).
    { pattern: 'channels.*.enabled', mode: 'hot', reason: 'channel on/off toggle' },
    { pattern: 'channels.**', mode: 'restart', reason: 'channel config beyond on/off needs rebuild' },
    // Logging — trivial live setter.
    { pattern: 'logging.level', mode: 'hot', reason: 'pino logger level' },
    { pattern: 'logging.pretty', mode: 'hot', reason: 'pretty-printing toggle' },
    // Per-schedule enable toggles — engine has setRuntimeScheduleEnabled.
    { pattern: 'proactive.heartbeats.heartbeats.*.enabled', mode: 'hot', reason: 'heartbeat on/off toggle' },
    { pattern: 'proactive.scheduler.jobs.*.enabled', mode: 'hot', reason: 'cron job on/off toggle' },
    // MCP child lifecycle — hot: reload() re-reads config + (re)connects servers,
    // so install/edit/toggle applies live without a gateway restart.
    { pattern: 'mcp.servers.**', mode: 'hot', reason: 'MCP reload reconnects servers from fresh config' },
    // Agent factory — boot-only (rebuilding live would orphan threads).
    { pattern: 'agents.**', mode: 'restart', reason: 'agents are built once at boot' },
    { pattern: 'memory.**', mode: 'restart', reason: 'memory store + embedder init on boot' },
    // Catch-all proactive (engine wiring, dedup paths, etc.).
    { pattern: 'proactive.**', mode: 'restart', reason: 'heartbeat/cron/webhook rewire on boot' },
    { pattern: 'webhook.**', mode: 'restart', reason: 'webhook receiver binds on boot' },
    { pattern: 'gateway.**', mode: 'restart', reason: 'gateway host/port/token are boot-only' },
];

/** Find the first rule that matches a dotted path; null if no match. */
export function ruleForPath(path: string): ReloadRuleMeta | null {
    for (const r of RELOAD_RULES_META) {
        const src = r.pattern
            .replace(/[.+?^${}()|[\]\\*]/g, '\\$&')
            .replace(/\\\*\\\*/g, '.*')
            .replace(/\\\*/g, '[^.]+');
        if (new RegExp(`^${src}$`).test(path)) return r;
    }
    return null;
}
