/**
 * boot hook — fires on gateway.startup + gateway.shutdown.
 *
 * Deterministic (no LLM). Errors are caught + logged; a hook failure never
 * propagates to the gateway. The module is dynamically imported once at
 * gateway start; the exported `handle` runs per matching event.
 *
 * Context fields:
 *   gateway.startup  → version, enabledChannels[], pid, uptimeMs (0)
 *   gateway.shutdown → uptimeMs, reason
 */
export async function handle(eventType: string, context: Record<string, unknown>): Promise<void> {
    const at = new Date(Number(context.firedAt ?? Date.now())).toISOString();
    if (eventType === 'gateway.startup') {
        const channels = Array.isArray(context.enabledChannels) ? context.enabledChannels.join(', ') : '';
        console.log(`[boot] gateway.startup at ${at} — v${context.version ?? '?'} pid=${context.pid ?? '?'} channels=[${channels}]`);
    } else if (eventType === 'gateway.shutdown') {
        const upMs = Number(context.uptimeMs ?? 0);
        const upMin = Math.round(upMs / 60000);
        console.log(`[boot] gateway.shutdown at ${at} — uptime ${upMin}m, reason=${context.reason ?? 'unknown'}`);
    } else {
        console.log(`[boot] ${eventType} at ${at}`);
    }
}
