/**
 * Regression tests — conversation log failures.
 *
 * Every test in this file was written from a real user conversation where
 * Flopsy underperformed. The format is:
 *
 *   Failure Fn: one-line symptom
 *   Input state: what the user said / what was loaded
 *   Expected:    what should have happened
 *   Failure mode: what actually happened
 *   Test:        the surface assertion that would have caught it
 *
 * Tests assert on the *contractual surface* that prevents each failure —
 * prompt text the model is given, code paths the gateway runs, error
 * messages exposed to the user. Some failures are pure LLM-output bugs
 * (F1 "wait one turn", F5 "$\\boxed{sent}$", F7 generic-greeting) and are
 * tested via the prompt strings the model receives, since asserting on
 * model output requires a live model call.
 *
 * If any of these tests fail, the corresponding behavior in the conversation
 * log is liable to recur — investigate before closing.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// Resolve repo root from this file's location: test/regression/* → repo root.
const REPO = join(__dirname, '..', '..');

function read(rel: string): string {
    const path = join(REPO, rel);
    if (!existsSync(path)) throw new Error(`fixture missing: ${path}`);
    return readFileSync(path, 'utf-8');
}

// ─────────────────────────────────────────────────────────────────────────────
// F1 — Tool load without immediate action
// User: "check my email"
// Bug:  Agent called __load_tool__(gmail), then said "Need one turn to load
//       the Gmail tools, then I can pull your last 2 emails."
// Want: Load and use chain in the SAME user turn — the planner already rebinds
//       tools after __load_tool__, the prompt was the bug.
// Fix:  flopsygraph DCL + react-planner prompts + main/worker role templates
//       all explicitly tell the model to chain.
// ─────────────────────────────────────────────────────────────────────────────
describe('F1 — DCL chains in a single turn (no "wait one turn" framing)', () => {
    it('flopsygraph DCL prompt forbids "wait one turn" framing', () => {
        const src = read('flopsygraph/src/prebuilt/graphs/react-agent/tools/dcl.ts');
        // The new DCL prompt must explicitly forbid load-and-wait framing.
        expect(src).toMatch(/CONTINUE in the same user turn/);
        expect(src).toMatch(/Do NOT tell the user to wait/);
        // The legacy "wait one turn" instruction must not be reachable.
        expect(src).not.toMatch(/^\s*'\s*2\.\s*wait one turn/m);
    });

    it('react-planner DCL catalog says next agent step within same user turn', () => {
        const src = read('flopsygraph/src/agent/planner/react-planner.ts');
        expect(src).toMatch(/Loading does NOT consume a user turn/);
        expect(src).toMatch(/never tell the user to wait for a tool to load/i);
    });

    it('main role template forbids "give me one turn to load X" framing', () => {
        const src = read('src/team/templates/roles/main/main.md');
        expect(src).toMatch(/Chain the call immediately/);
        expect(src).toMatch(/never tell the user "give me one turn to load X"/i);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// F2 — Raw parameter type errors exposed to user
// Bug:  Gmail rejected maxResults / unreadOnly because LLM passed them as
//       strings; raw zod error reached the user.
// Want: Coerce common LLM mistakes ("5" → 5, "true" → true) before validation.
// Fix:  jsonSchemaToZod uses z.coerce.number() and a custom coerceBoolean()
//       that handles "true"/"false"/"yes"/"no"/"1"/"0".
// ─────────────────────────────────────────────────────────────────────────────
describe('F2 — MCP tool input coercion (Gmail-style param mismatches)', () => {
    it('jsonSchemaToZod uses z.coerce.number for integer/number types', () => {
        const src = read('flopsygraph/src/mcp/json-schema-to-zod.ts');
        expect(src).toMatch(/return z\.coerce\.number\(\)/);
        // The pre-fix strict z.number() must not be reachable for number/integer.
        expect(src).not.toMatch(/case 'number':\s*\n\s*case 'integer':\s*\n\s*return z\.number\(\);/);
    });

    it('jsonSchemaToZod has a custom coerceBoolean that rejects "false" → true', () => {
        const src = read('flopsygraph/src/mcp/json-schema-to-zod.ts');
        expect(src).toMatch(/function coerceBoolean\(\)/);
        // The dangerous z.coerce.boolean() pattern must not be used (it would
        // turn the string "false" into true).
        expect(src).not.toMatch(/return z\.coerce\.boolean\(\)/);
        // Custom path must handle the common cases.
        expect(src).toMatch(/'true' \|\| s === 'yes' \|\| s === '1'/);
        expect(src).toMatch(/'false' \|\| s === 'no' \|\| s === '0'/);
    });

    it('the main role response-style rule says do NOT show raw type-validation errors', () => {
        const src = read('src/team/templates/roles/main/main.md');
        expect(src).toMatch(/type-validation error/i);
        expect(src).toMatch(/MCP layer already coerces common mismatches/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// F3 — Context collapse after /new
// User: After /new, "Can you check the email I have?"
// Bug:  Generic "How can I help today?" reply ignoring the recap.
// Want: Recap is injected on the first turn after /new AND tells the model
//       to act on continuity, not greet generically. Personality survives.
// Fix:  forceNewSession carries forward active_personality; recap prepend
//       has explicit "DO NOT reply with a generic 'How can I help today?'"
//       framing.
// ─────────────────────────────────────────────────────────────────────────────
describe('F3 — /new preserves personality and primes continuity', () => {
    it('forceNewSession carries forward active_personality from previous session', () => {
        const src = read('src/team/src/handler.ts');
        expect(src).toMatch(/getSessionPersonality\(result\.previousSessionId\)/);
        expect(src).toMatch(/setSessionPersonality\(result\.sessionId, prevPersonality\)/);
        expect(src).toMatch(/carried forward active personality/);
    });

    it('recap-prepend explicitly forbids generic "How can I help today?" reply', () => {
        const src = read('src/team/src/handler.ts');
        expect(src).toMatch(/DO NOT reply with a generic "How can I help today\?"/);
        // Old soft "let it inform context" framing must not be the only guidance.
        expect(src).toMatch(/Continuity context/);
    });

    it('main role template has greetings+memory rule against generic openers', () => {
        const src = read('src/team/templates/roles/main/main.md');
        expect(src).toMatch(/Greetings \+ memory/);
        expect(src).toMatch(/Generic "How can I help today\?" with no memory tie-in defeats the entire harness/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// F4 — "Something went wrong. Please try again." silence
// Bug:  Repeated identical messages with no debug hint, no recovery path.
// Want: Categorized errors (timeout/rate_limit/auth/network/context_limit)
//       AND for "unknown" errors, a sanitized snippet of the raw error so
//       the user gets a debugging breadcrumb, with credentials/paths redacted.
// Fix:  channel-worker.ts has sanitizeErrorHint() and uses it in the unknown
//       bucket + cmd-failure + bg-task-failure paths.
// ─────────────────────────────────────────────────────────────────────────────
describe('F4 — Error messages carry debug hints, redact secrets', () => {
    it('channel-worker has a sanitizeErrorHint helper', () => {
        const src = read('src/gateway/src/core/channel-worker.ts');
        expect(src).toMatch(/function sanitizeErrorHint/);
    });

    it('unknown-error reply includes a hint when one is available', () => {
        const src = read('src/gateway/src/core/channel-worker.ts');
        expect(src).toMatch(/Something went wrong on my end:/);
    });

    it('slash-command failure reply includes a sanitized hint', () => {
        const src = read('src/gateway/src/core/channel-worker.ts');
        expect(src).toMatch(/Command \/\$\{parsed\.name\} failed:/);
    });

    it('background-task failure reply offers retry, not silent dead-end', () => {
        const src = read('src/gateway/src/core/channel-worker.ts');
        expect(src).toMatch(/Want me to retry, or pick a different angle\?/);
    });

    it('error sanitizer redacts Bearer tokens, sk- keys, ya29 OAuth tokens', () => {
        const src = read('src/gateway/src/core/channel-worker.ts');
        // Redaction patterns must be wired in sanitizeErrorHint.
        expect(src).toMatch(/Bearer\\s\+\[A-Za-z0-9\._\\-\]\+/);
        expect(src).toMatch(/sk-\[A-Za-z0-9_\\-\]\{16,\}/);
        expect(src).toMatch(/ya29\\\.\[A-Za-z0-9_\\-\]\+/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// F5 — URL extraction broken / "$\\boxed{sent}$" hallucination
// Bug:  Agent emitted LaTeX-style boxed answer for a Twitter URL extraction.
// Want: Response-style rules forbid LaTeX/boxed/placeholder outputs and tell
//       agent to default to extracting URLs without asking for context.
// Fix:  main role template has explicit rules against \boxed{}, $$..$$, etc.
// ─────────────────────────────────────────────────────────────────────────────
describe('F5 — Response style forbids LaTeX boxed answers and placeholder tokens', () => {
    it('main role template forbids LaTeX-style boxed answers', () => {
        const src = read('src/team/templates/roles/main/main.md');
        expect(src).toMatch(/Never use LaTeX-style boxed answers/i);
        // Literal `$\boxed{x}$` — single backslash in the markdown.
        expect(src).toContain('$\\boxed{x}$');
        expect(src).toMatch(/Never use `\\boxed/);
    });

    it('main role template forbids placeholder tokens like "sent" / "[result]"', () => {
        const src = read('src/team/templates/roles/main/main.md');
        expect(src).toMatch(/Never reply with placeholder tokens/i);
    });

    it('main role template defaults URL handling to extraction without context-prompting', () => {
        const src = read('src/team/templates/roles/main/main.md');
        expect(src).toMatch(/When the user sends a URL/);
        expect(src).toMatch(/twitter_extract.*x\.com.*twitter\.com/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// F6 — /branch list ran the wrong handler
// Bug:  User reported /branch list returned proactive schedules.
// Want: dispatcher resolves /branch by name to branchCommand; sub='list'
//       calls facade.list and renders branches (NOT schedules).
// Verify: code path is correctly wired (handler dispatches list correctly).
// ─────────────────────────────────────────────────────────────────────────────
describe('F6 — /branch list dispatcher routing is correct', () => {
    it('dispatcher.resolve does case-insensitive lookup by command name', () => {
        const src = read('src/gateway/src/commands/dispatcher.ts');
        expect(src).toMatch(/this\.lookup\.get\(name\.toLowerCase\(\)\)/);
    });

    it('branch handler dispatches sub=="list" to facade.list, not to a schedule list', () => {
        const src = read('src/gateway/src/commands/handlers/branch.ts');
        expect(src).toMatch(/if \(sub === 'list'\)/);
        expect(src).toMatch(/facade\.list\(ctx\.threadId\)/);
        expect(src).toMatch(/renderList\(branches\)/);
        // The handler must NOT reference proactive engine APIs.
        expect(src).not.toMatch(/listSchedules/);
        expect(src).not.toMatch(/proactiveEngine/);
    });

    it('branch facade in handler.ts returns branch sessions, not schedules', () => {
        const src = read('src/team/src/handler.ts');
        // The setBranchFacade list closure pulls from listBranches, not from
        // any proactive surface.
        expect(src).toMatch(/list: \(rawKey\) => \{/);
        expect(src).toMatch(/this\.listBranches\(rawKey\)/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// F7 — Personality disappears under load
// Bug:  Replies like "Please let me know how I can assist you today!" — that
//       opener is in SOUL.md's BANNED list.
// Want: Personality is in the cached prefix and re-injected each turn.
//       SOUL.md's banned openings are the explicit gate.
// Verify: SOUL.md still bans those phrases; greetings+memory rule reinforces.
// ─────────────────────────────────────────────────────────────────────────────
describe('F7 — Personality bans corporate-bot openings', () => {
    it('SOUL.md bans "I\'d be happy to help!" / "Great question!" / "Absolutely!"', () => {
        const src = read('.flopsy/SOUL.md');
        expect(src).toMatch(/\*\*Banned openings:\*\*/);
        // Each banned opener appears somewhere in SOUL.md (the list spans lines).
        expect(src).toContain('"Great question!"');
        expect(src).toContain('"Absolutely!"');
        expect(src).toContain('"I\'d be happy to help!"');
    });

    it('SOUL.md has a "Read the room" mood-matching contract', () => {
        const src = read('.flopsy/SOUL.md');
        expect(src).toMatch(/Read the room/);
        expect(src).toMatch(/Casual \/ curious|Stressed \/ vented|Focused \/ working/);
    });

    it('main role template re-injects warmth + memory tie-in for greetings', () => {
        const src = read('src/team/templates/roles/main/main.md');
        expect(src).toMatch(/Hold the active personality across tool calls and errors/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// F8 — Simple web request (HN top stories) ignored 3x
// Bug:  Agent deflected, said it had no input, ignored a trivial web fetch.
// Want: Web tools are reachable and the prompt prefers them when needed.
//       Same root cause as F1 (DCL chaining) for fast tool acquisition.
// ─────────────────────────────────────────────────────────────────────────────
describe('F8 — Web tool routing is documented and discoverable', () => {
    it('main role template names legolas as the worker for "what\'s the latest" / news', () => {
        const src = read('src/team/templates/roles/main/main.md');
        expect(src).toMatch(/News.*single-fact web lookup.*legolas|legolas.*news/i);
    });

    it('AGENTS.md hard rule: always use a tool for live state, do not answer from training', () => {
        const src = read('.flopsy/AGENTS.md');
        // The phrase is hard-wrapped across two lines in the source — use [\s\S]
        // for newline-tolerant match.
        expect(src).toMatch(/depends on external[\s\S]*?state/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// F9 — Gmail retry loop with no clean exit
// Bug:  Agent retried Gmail multiple times with different partial errors,
//       never succeeded or failed cleanly.
// Want: AGENTS.md has explicit retry-ceiling rules + try-different-angles.
// Fix:  AGENTS.md "Error recovery — try at least two alternatives before
//       'I can't'" section + main.md "one retry, then surface" section.
// ─────────────────────────────────────────────────────────────────────────────
describe('F9 — Retry has a ceiling and a clean exit', () => {
    it('AGENTS.md documents the two-alternatives-before-surface rule', () => {
        const src = read('.flopsy/AGENTS.md');
        // AGENTS.md uses the "try at least two alternatives" framing in a
        // dedicated section. Newline-tolerant.
        expect(src).toMatch(/try at least two alternatives before "I can't"/i);
        expect(src).toMatch(/Two attempts minimum/);
    });

    it('SOUL.md documents the "two more angles" recovery rule', () => {
        const src = read('.flopsy/SOUL.md');
        expect(src).toMatch(/try at least two more angles before saying "I can't\."/i);
    });

    it('main role template caps retries with explicit thrash-avoidance language', () => {
        const src = read('src/team/templates/roles/main/main.md');
        expect(src).toMatch(/More than one retry without progress is thrashing/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Worker checkpointing (Fix A — child-threadId pattern)
// Prevents the regression: gateway restart mid-delegated-research loses minutes
// of worker work because (a) workers had no checkpointer, or (b) workers shared
// main's threadId so any checkpointer would clobber main's slot.
// ─────────────────────────────────────────────────────────────────────────────
describe('Worker checkpointing — child-threadId pattern is wired', () => {
    it('handler derives a child threadId for worker invocations', () => {
        const src = read('src/team/src/handler.ts');
        // The pattern `${threadId}:worker:${def.name}:${stableHash(task)}`
        // must be present at the worker invoke call site.
        expect(src).toMatch(/childThreadId.*=.*\$\{threadId\}:worker:\$\{def\.name\}:\$\{stableHash\(task\)\}/);
    });

    it('handler passes the checkpointer through to createTeamMember for workers', () => {
        const src = read('src/team/src/handler.ts');
        // Inside makeSubAgentFactory the worker createTeamMember call must
        // pass `checkpointer: this.checkpointer` — without it, child threadId
        // is wasted because no persistence happens.
        expect(src).toMatch(/checkpointer: this\.checkpointer,\s*\n\s*\.\.\.\(this\.config\.observability/);
    });

    it('worker invoke uses childThreadId, not parent threadId', () => {
        const src = read('src/team/src/handler.ts');
        // The fix: invoke must pass childThreadId in BOTH the top-level
        // threadId AND configurable.threadId. The old bug used parent threadId.
        expect(src).toMatch(/threadId: childThreadId,\s*\n\s*configurable: \{[\s\S]*?threadId: childThreadId,/);
        expect(src).toMatch(/parentThreadId: threadId,/);
    });

    it('factory contract documents shared-checkpointer / child-threadId pattern', () => {
        const src = read('src/team/src/factory.ts');
        // The legacy "Main-agent only — workers share parent's threadId, would
        // clobber" comment must be replaced.
        expect(src).not.toMatch(/Main-agent only — workers share the parent's threadId/);
        expect(src).toMatch(/Shared between main and workers/);
        expect(src).toMatch(/derived child threadId/);
    });

    it('deep-research workers also accept the shared checkpointer', () => {
        const src = read('src/team/src/factory.ts');
        // The role-gated `role === 'main' && opts.checkpointer` guard must
        // be gone — replaced with the unconditional pass-through.
        expect(src).not.toMatch(/role === 'main' && opts\.checkpointer/);
    });

    it('session-close sweeps child-worker checkpoints under the closed thread prefix', () => {
        const src = read('src/team/src/handler.ts');
        // Without this sweep, the checkpoint DB would grow unbounded as
        // every delegated task accumulates 30 rows (keepLatestPerThread).
        expect(src).toMatch(/pruneByThreadPrefix\(\s*`\$\{closedThreadId\}:worker:`/);
    });

    it('stableHash is deterministic and string-safe', () => {
        const src = read('src/team/src/handler.ts');
        // The whole point of using a hash (vs. random nonce) is determinism
        // across restart. The function must exist and be a closed-form hash.
        expect(src).toMatch(/function stableHash\(input: string\): string/);
        expect(src).toMatch(/0x811c9dc5/); // FNV-1a offset basis — sentinel for the algorithm
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool-call reactions + semantic preview emoji
// Asserts that the emoji surface remains wired across refactors. This was the
// "I don't see it firing" report — the wiring is correct on Telegram/Discord/
// Slack/Signal/WhatsApp/GoogleChat; iMessage and Line are platform-limited
// stubs that intentionally don't advertise 'reactions' in capabilities.
// ─────────────────────────────────────────────────────────────────────────────
describe('Tool-call reaction wiring', () => {
    it('channel-worker maps tool names to category emojis in the stream preview', () => {
        const src = read('src/gateway/src/core/channel-worker.ts');
        // Helper must exist and the tool_start case must use it (not the
        // legacy hard-coded 🛠️ prefix).
        expect(src).toMatch(/function toolCategoryEmoji/);
        expect(src).toMatch(/statusLine = `\$\{toolCategoryEmoji\(chunk\.toolName\)\}/);
        // Common buckets — break in either direction would mask a regression.
        expect(src).toMatch(/gmail\|email\|inbox.*'📧'/);
        expect(src).toMatch(/calendar\|cal_.*'📅'/);
        expect(src).toMatch(/web_search\|web_extract.*'🔍'/);
    });

    it('channel-worker.beginTaskPresence fires ⏳ on channels that advertise reactions', () => {
        const src = read('src/gateway/src/core/channel-worker.ts');
        // The wire that matters: caps.includes('reactions') gates the react
        // call. Don't let anyone "simplify" this back to an unconditional
        // react that throws on stub channels.
        expect(src).toMatch(/supportsReactions = caps\.includes\('reactions'\)/);
        expect(src).toMatch(/this\.channel\s*\.react\(\{\s*messageId,\s*peer,\s*emoji: '⏳'\s*\}\)/);
    });

    it('channel-worker.endTaskPresence stamps ✅ or ❌ at task end', () => {
        const src = read('src/gateway/src/core/channel-worker.ts');
        expect(src).toMatch(/finalEmoji: '✅' \| '❌'/);
        expect(src).toMatch(/this\.endTaskPresence\(event\.taskId, peer, '✅'\)/);
        expect(src).toMatch(/this\.endTaskPresence\(event\.taskId, peer, '❌'\)/);
    });

    it('Telegram channel maps ⏳ to a Telegram-allowlist emoji', () => {
        // Telegram's reactions endpoint rejects emojis outside its whitelist.
        // The mapping (currently ⏳ → 🤔) must stay so reactions don't 400.
        const src = read('src/gateway/src/channels/telegram/channel.ts');
        expect(src).toMatch(/'⏳':\s*'🤔'/);
        expect(src).toMatch(/function mapToTelegramAllowedEmoji/);
    });

    it('GoogleChat channel implements react() and advertises the capability', () => {
        const src = read('src/gateway/src/channels/googlechat/channel.ts');
        // The 2023 reactions endpoint — POST /v1/{message=...}/reactions
        expect(src).toMatch(/\$\{CHAT_API\}\/\$\{options\.messageId\}\/reactions/);
        expect(src).toMatch(/emoji: \{ unicode: options\.emoji \}/);
        // Capability declaration must be there — without it
        // beginTaskPresence skips the channel.
        expect(src).toMatch(/capabilities:\s*readonly InteractiveCapability\[\]\s*=\s*\['reactions'\]/);
        // Token scope must include chat.messages.reactions or react() will
        // 401 silently after auth.
        expect(src).toMatch(/chat\.messages\.reactions/);
    });

    it('iMessage and Line stubs document why they do not implement react()', () => {
        // Stubs should explain the platform limitation so a future audit
        // doesn't try to "fix" them naively. Not a behaviour test — just a
        // discoverability guard.
        const imsgSrc = read('src/gateway/src/channels/imessage/channel.ts');
        const lineSrc = read('src/gateway/src/channels/line/channel.ts');
        expect(imsgSrc).toMatch(/iMessage tapbacks are not exposed/);
        expect(lineSrc).toMatch(/LINE Messaging API does not expose a bot-side/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Smoke — soul/identity files exist and contain non-trivial content
// ─────────────────────────────────────────────────────────────────────────────
describe('soul + identity files are present and non-trivial', () => {
    it.each([
        ['SOUL.md',           '.flopsy/SOUL.md',               1500],
        ['AGENTS.md',         '.flopsy/AGENTS.md',             3000],
        ['personalities.yaml','.flopsy/personalities.yaml',     2000],
    ])('%s exists with at least %i chars', (_label, rel, minChars) => {
        const src = read(rel);
        expect(src.length).toBeGreaterThanOrEqual(minChars);
    });

    it('personalities.yaml defines at least 5 distinct overlays', () => {
        const src = read('.flopsy/personalities.yaml');
        const topLevelKeys = src.match(/^[a-z][a-z0-9_]*:\s*$/gm);
        expect(topLevelKeys?.length ?? 0).toBeGreaterThanOrEqual(5);
    });
});
