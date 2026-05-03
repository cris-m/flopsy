/**
 * Late-bound bridge between `/plan` and TeamHandler's planning interceptors.
 * Exists as an escape hatch — the planning state machine is closed
 * (drafting → approve/reject only; approved has no exit), so a stuck
 * plan can otherwise leave the user with no way out.
 */

export interface PlanFacade {
    /** Returns false when nothing was cleared. */
    cancel(threadId: string): boolean;
    /** Null when no plan exists for this thread. */
    getState(threadId: string): { mode: 'idle' | 'drafting' | 'approved'; hasPlan: boolean; objective?: string } | null;
}

let facade: PlanFacade | null = null;

export function setPlanFacade(f: PlanFacade): void {
    facade = f;
}

export function getPlanFacade(): PlanFacade | null {
    return facade;
}
