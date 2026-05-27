export interface PlanFacade {
    cancel(threadId: string): boolean;
}

let facade: PlanFacade | null = null;

export function setPlanFacade(f: PlanFacade): void {
    facade = f;
}

export function getPlanFacade(): PlanFacade | null {
    return facade;
}
