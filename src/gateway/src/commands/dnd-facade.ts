/** Late-bound bridge between /dnd + mgmt endpoints and PresenceManager. */

export interface DndSnapshot {
    readonly active: boolean;
    readonly reason?: string;
    readonly untilMs?: number;
    readonly label?: string;
}

export interface DndFacade {
    setDnd(durationMs: number, reason?: string): Promise<DndSnapshot>;
    clearDnd(): Promise<void>;
    setQuietHours(untilMs: number): Promise<DndSnapshot>;
    getStatus(): Promise<DndSnapshot>;
}

let facade: DndFacade | null = null;

export function setDndFacade(f: DndFacade | null): void {
    facade = f;
}

export function getDndFacade(): DndFacade | null {
    return facade;
}
