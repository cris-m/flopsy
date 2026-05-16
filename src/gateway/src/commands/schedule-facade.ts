/**
 * Late-bound bridge between `/cron` + `/heartbeat` slash commands and the live
 * ProactiveEngine. Mirrors the DndFacade pattern — module singleton wired by
 * gateway.ts at engine startup, cleared on shutdown so /cron returns "engine
 * not running" instead of crashing.
 *
 * Each method here is a thin shim around an engine call; the slash handlers
 * never touch the engine directly. This indirection makes the slash layer
 * unit-testable (stub the facade), keeps engine internals out of the command
 * surface, and lets the chat-handler reuse the same surface as the CLI's
 * managementXxx calls — both ultimately funnel through the engine.
 */

export type ScheduleKind = 'cron' | 'heartbeat';

export interface ScheduleRowSnapshot {
    readonly id: string;
    readonly name?: string;
    readonly kind: ScheduleKind;
    readonly enabled: boolean;
    readonly intervalOrCron?: string;
    readonly skills?: readonly string[];
}

export interface ScheduleFacade {
    list(kind: ScheduleKind): readonly ScheduleRowSnapshot[];
    setEnabled(id: string, enabled: boolean): { ok: boolean; message?: string };
    trigger(id: string): Promise<{ ok: boolean; message?: string }>;
    tick(kind: ScheduleKind): { ok: boolean; dispatched: string[] };
    remove(id: string): { ok: boolean; message?: string };
    setSkills(id: string, skills: string[]): { ok: boolean; message?: string };
    /** Returns null if the schedule doesn't exist. Empty array = no skills bound. */
    currentSkills(id: string, kind: ScheduleKind): readonly string[] | null;
}

let facade: ScheduleFacade | null = null;

export function setScheduleFacade(f: ScheduleFacade | null): void {
    facade = f;
}

export function getScheduleFacade(): ScheduleFacade | null {
    return facade;
}
