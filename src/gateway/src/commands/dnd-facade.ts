/**
 * Module-level singleton bridging the DND slash command + mgmt endpoints
 * to the live `PresenceManager` inside `ProactiveEngine`. Set by the
 * gateway when the proactive engine starts; cleared on stop.
 *
 * Why a singleton: the slash `/dnd` handler runs in the gateway process
 * but is constructed before the engine (router registration happens at
 * boot, engine starts in `onStart`). A late-binding facade avoids
 * shuttling the engine reference through the command dispatcher.
 */

export interface DndSnapshot {
    /** True while DND or quiet-hours is active. */
    readonly active: boolean;
    /** Human-readable reason (e.g. "dnd", "quiet hours"). */
    readonly reason?: string;
    /** Expiry wall-clock ms; undefined when not set. */
    readonly untilMs?: number;
    /** Optional user-supplied label for the DND window. */
    readonly label?: string;
}

export interface DndFacade {
    /**
     * Enable DND for `durationMs` (e.g. 2h). Returns the expiry timestamp.
     * Reason is a short free-text label the user sees in status output
     * (e.g. "meeting", "focus").
     */
    setDnd(durationMs: number, reason?: string): Promise<DndSnapshot>;
    /** Clear any active DND / explicit status. */
    clearDnd(): Promise<void>;
    /** Set quiet hours (no proactive messages until `untilMs`). */
    setQuietHours(untilMs: number): Promise<DndSnapshot>;
    /** Current DND state. */
    getStatus(): Promise<DndSnapshot>;
}

let facade: DndFacade | null = null;

export function setDndFacade(f: DndFacade | null): void {
    facade = f;
}

export function getDndFacade(): DndFacade | null {
    return facade;
}
