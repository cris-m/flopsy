/**
 * Module-level singleton bridging the /compact slash command to the
 * TeamHandler's compactSession implementation. Follows the same pattern as
 * session-facade.ts.
 *
 * Set by FlopsyGateway.setAgentHandler when the handler implements
 * compactSession. Commands call getCompactFacade()?.compact(rawKey) to
 * summarise and truncate the active session's checkpoint without the command
 * layer needing to know about team package internals.
 */

export interface CompactFacade {
    /**
     * Summarise the peer's active session history via LLM and replace the
     * checkpoint state with a single synthetic system message containing
     * that summary.
     *
     * `rawKey` is the peer routing key (`channel:scope:nativeId`) held by
     * the ChannelWorker — the same string passed as `threadId` to `invoke()`.
     *
     * Resolves to `{ messageCount, summary }` where `messageCount` is the
     * number of messages condensed into the summary. Returns undefined when
     * the session layer is not wired up or the thread has no history.
     */
    compact(rawKey: string): Promise<{ messageCount: number; summary: string } | undefined>;
}

let facade: CompactFacade | null = null;

export function setCompactFacade(f: CompactFacade | null): void {
    facade = f;
}

export function getCompactFacade(): CompactFacade | null {
    return facade;
}
