// Resolve placeholders in prompts / role-deltas / skill bodies against the
// live team roster. Lets authors write portable text that survives a rename:
//
//   "${main}" → name of the agent with role: 'main'
//   "${peer:research}" → first enabled worker whose domain (or type) == 'research'
//
// Why: hardcoding "gandalf"/"saruman"/etc. in role-deltas and skill bodies
// breaks the moment someone renames their team. The team roster IS in
// flopsy.json5, so prompts should reference it by ROLE / DOMAIN, not literal.
// Backward compatible: text with no placeholders passes through unchanged.

export interface TeamMemberLite {
    readonly name: string;
    readonly role?: string;
    readonly domain?: string;
    readonly type?: string;
    readonly enabled?: boolean;
}

// Case-insensitive on the keyword so authors can match the surrounding prose:
//   ${main}  ${Main}  ${MAIN}   /   ${peer:x}  ${Peer:x}  ${PEER:x}
// The captured keyword's own case decides the OUTPUT case of the resolved name,
// so a sentence-start "Gandalf" stays title-case and an emphatic "SARUMAN"
// stays upper — config names are stored lower-case and re-cased on render.
const PLACEHOLDER_RE = /\$\{(main|peer:[^}]+)\}/gi;

type NameCase = 'lower' | 'title' | 'upper';

function detectCase(word: string): NameCase {
    if (word !== word.toLowerCase() && word === word.toUpperCase()) return 'upper';
    if (word.charAt(0) === word.charAt(0).toUpperCase() && word !== word.toLowerCase()) return 'title';
    return 'lower';
}

function applyCase(name: string, mode: NameCase): string {
    if (mode === 'upper') return name.toUpperCase();
    if (mode === 'title') return name.charAt(0).toUpperCase() + name.slice(1);
    return name;
}

/**
 * Substitute `${main}` and `${peer:<key>}` placeholders against the team
 * roster. Unknown placeholders are left intact (visible to the agent as a
 * tell — better than silently substituting the wrong name). The placeholder's
 * own case is preserved onto the resolved name (see PLACEHOLDER_RE comment).
 *
 * `key` for `${peer:<key>}` matches in this order:
 *   1. agent.name (exact, case-insensitive)
 *   2. agent.domain (exact, case-insensitive)
 *   3. agent.type (exact, case-insensitive)
 * Disabled agents are skipped.
 */
export function substituteAgentRefs(text: string, roster: ReadonlyArray<TeamMemberLite>): string {
    if (!text.includes('${')) return text;

    const enabled = roster.filter((a) => a.enabled !== false);
    const mainAgent = enabled.find((a) => a.role === 'main');

    return text.replace(PLACEHOLDER_RE, (match, captured: string) => {
        const colon = captured.indexOf(':');
        const keyword = (colon === -1 ? captured : captured.slice(0, colon)).toLowerCase();
        const mode = detectCase(colon === -1 ? captured : captured.slice(0, colon));
        if (keyword === 'main') {
            return mainAgent ? applyCase(mainAgent.name, mode) : match;
        }
        if (keyword === 'peer') {
            const key = captured.slice(colon + 1).toLowerCase().trim();
            const hit = enabled.find(
                (a) =>
                    a.name.toLowerCase() === key ||
                    (a.domain ?? '').toLowerCase() === key ||
                    (a.type ?? '').toLowerCase() === key,
            );
            return hit ? applyCase(hit.name, mode) : match;
        }
        return match;
    });
}

/**
 * Report unresolved placeholders without substituting — useful for `flopsy doctor`
 * and skill-create validation to flag broken references early. Uses matchAll so
 * we never call regex.exec directly.
 */
export function findUnresolvedAgentRefs(
    text: string,
    roster: ReadonlyArray<TeamMemberLite>,
): string[] {
    const out = new Set<string>();
    for (const m of text.matchAll(PLACEHOLDER_RE)) {
        const captured = m[1];
        if (!captured) continue;
        const colon = captured.indexOf(':');
        const keyword = (colon === -1 ? captured : captured.slice(0, colon)).toLowerCase();
        if (keyword === 'main') {
            if (!roster.some((a) => a.role === 'main' && a.enabled !== false)) out.add(m[0]);
            continue;
        }
        if (keyword === 'peer') {
            const key = captured.slice(colon + 1).toLowerCase().trim();
            const found = roster.some(
                (a) =>
                    a.enabled !== false &&
                    (a.name.toLowerCase() === key ||
                        (a.domain ?? '').toLowerCase() === key ||
                        (a.type ?? '').toLowerCase() === key),
            );
            if (!found) out.add(m[0]);
        }
    }
    return [...out];
}
