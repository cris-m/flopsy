import type { SessionGoalRow, SetGoalArgs, MaybeContinueResult } from '@flopsy/team';

export interface GoalFacade {
    get(threadId: string): SessionGoalRow | null;
    set(args: SetGoalArgs): SessionGoalRow;
    pause(threadId: string): SessionGoalRow | null;
    resume(threadId: string): SessionGoalRow | null;
    clear(threadId: string): boolean;
    maybeContinue(args: { threadId: string; agentReply: string }): Promise<MaybeContinueResult | null>;
    addSubgoal(threadId: string, text: string): SessionGoalRow;
    removeSubgoal(threadId: string, oneBasedIndex: number): { removed: string; remaining: number };
    clearSubgoals(threadId: string): number;
    renderSubgoals(threadId: string): string;
}

let facade: GoalFacade | null = null;

export function setGoalFacade(f: GoalFacade | null): void {
    facade = f;
}

export function getGoalFacade(): GoalFacade | null {
    return facade;
}
