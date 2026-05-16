import type { SessionGoalRow, SetGoalArgs, MaybeContinueResult } from '@flopsy/team';

export interface GoalFacade {
    get(threadId: string): SessionGoalRow | null;
    set(args: SetGoalArgs): SessionGoalRow;
    pause(threadId: string): SessionGoalRow | null;
    resume(threadId: string): SessionGoalRow | null;
    clear(threadId: string): boolean;
    maybeContinue(args: { threadId: string; agentReply: string }): Promise<MaybeContinueResult | null>;
}

let facade: GoalFacade | null = null;

export function setGoalFacade(f: GoalFacade | null): void {
    facade = f;
}

export function getGoalFacade(): GoalFacade | null {
    return facade;
}
