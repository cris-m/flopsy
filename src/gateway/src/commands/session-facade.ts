/**
 * Bridge between the /new slash command and the team layer's
 * SessionResolver. Set by TeamHandler during startup.
 */

export interface SkillProposalResult {
    readonly proposed: boolean;
    readonly reason?: string;
    readonly name?: string;
    readonly description?: string;
    readonly when_to_use?: string;
    readonly body?: string;
    readonly confidence?: number;
    readonly autoActivated?: boolean;
    readonly writtenPath?: string;
}

export interface SessionFacade {
    /**
     * Force-close the peer's current session and open a fresh one. Awaits
     * a single LLM extraction so the caller can show a recap in the
     * confirmation card. `rawKey` is the routing key.
     */
    forceNewSession(
        rawKey: string,
    ): Promise<{ sessionId: string; summary: string | null } | undefined>;

    /**
     * Run the session-extractor synchronously over the current session's
     * recent messages and propose a SKILL.md. Used by `/skill propose`.
     * If `confidence >= AUTO_PROMOTE_CONFIDENCE` (0.8), the skill is written
     * immediately to skills/<category>/<name>/SKILL.md and `autoActivated`
     * is true. Otherwise it's written to skills-proposed/ for review.
     *
     * Optional so the gateway can boot without team-side wiring; handlers
     * check `if (facade.proposeSkillFromCurrentSession)` before calling.
     */
    proposeSkillFromCurrentSession?(rawKey: string): Promise<SkillProposalResult>;
}

let facade: SessionFacade | null = null;

export function setSessionFacade(f: SessionFacade): void {
    facade = f;
}

export function getSessionFacade(): SessionFacade | null {
    return facade;
}
