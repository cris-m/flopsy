/** Late-bound bridge between `/branch` and TeamHandler. */

export interface BranchSummary {
    readonly sessionId: string;
    readonly label: string | null;
    readonly active: boolean;
    readonly turnCount: number;
    readonly summary: string | null;
    readonly lastUserMessageAt: number;
}

export type BranchOutcome =
    | { ok: true; sessionId: string; label: string }
    | {
          ok: false;
          reason:
              | 'no-active-session'
              | 'duplicate'
              | 'invalid-label'
              | 'unknown-label'
              | 'failed';
      };

export interface BranchFacade {
    /** Fork the active session; new session inherits the message prefix. */
    fork(rawKey: string, label: string): Promise<BranchOutcome>;
    /** Close current and reopen the named branch. */
    switch(rawKey: string, label: string): Promise<BranchOutcome>;
    /** Active first, then labeled-but-closed newest-first. */
    list(rawKey: string): ReadonlyArray<BranchSummary>;
}

let facade: BranchFacade | null = null;

export function setBranchFacade(f: BranchFacade | null): void {
    facade = f;
}

export function getBranchFacade(): BranchFacade | null {
    return facade;
}
