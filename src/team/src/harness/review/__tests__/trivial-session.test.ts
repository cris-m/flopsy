import { describe, it, expect } from 'vitest';
import { hasToolCallSignal, TRIVIAL_SESSION_CHAR_THRESHOLD } from '../session-extractor';

// Local shape mirrors the extractor's internal `ExtractorMessage` —
// it only reads `role` + `content`. Was previously typed as `MessageRow`
// from storage, but the messages table was dropped when the team layer
// stopped mirroring messages into learning.db (kept only in checkpoints).
type Msg = { role: 'user' | 'assistant'; content: string };

function row(role: 'user' | 'assistant', content: string, _id = 1): Msg {
    return { role, content };
}

describe('hasToolCallSignal', () => {
    it('returns false for plain conversational replies', () => {
        const msgs: Msg[] = [
            row('user', 'what time is it?'),
            row('assistant', 'It is 4pm.', 2),
            row('user', 'thanks'),
            row('assistant', 'no problem', 4),
        ];
        expect(hasToolCallSignal(msgs)).toBe(false);
    });

    it('detects [delegated to <worker>] markers', () => {
        const msgs: Msg[] = [
            row('assistant', '[delegated to legolas] research the topic'),
        ];
        expect(hasToolCallSignal(msgs)).toBe(true);
    });

    it('detects [spawned background task] markers', () => {
        const msgs: Msg[] = [
            row('assistant', '[spawned background task #7 → saruman]'),
        ];
        expect(hasToolCallSignal(msgs)).toBe(true);
    });

    it('detects worker-reply-offload markers', () => {
        const msgs: Msg[] = [
            row('assistant', 'see [worker reply offloaded to /workspace/...]'),
        ];
        expect(hasToolCallSignal(msgs)).toBe(true);
    });

    it('detects iteration-cap stop suffixes', () => {
        const msgs: Msg[] = [
            row('assistant', 'partial answer (stopped after 30 tool calls)'),
        ];
        expect(hasToolCallSignal(msgs)).toBe(true);
    });

    it('detects __load_tool__ DCL traces', () => {
        const msgs: Msg[] = [
            row('assistant', 'used __load_tool__({"name":"gmail_search"}) earlier'),
        ];
        expect(hasToolCallSignal(msgs)).toBe(true);
    });

    it('ignores tool-call markers that appear in user messages only', () => {
        // Defensive: users don't tool-call, but if they paste a marker we
        // shouldn't be tricked into treating it as a signal.
        const msgs: Msg[] = [
            row('user', 'why did it print [delegated to legolas]?'),
            row('assistant', 'no idea'),
        ];
        expect(hasToolCallSignal(msgs)).toBe(false);
    });
});

describe('trivial-session threshold', () => {
    it('threshold is documented and stable at 800 chars', () => {
        // If you change this number, update docs/architecture.md and ensure
        // your existing integration runs don't suddenly start (or stop)
        // extracting on you.
        expect(TRIVIAL_SESSION_CHAR_THRESHOLD).toBe(800);
    });

    it('a typical "what time? / 4pm / thanks / yw" session falls below the threshold', () => {
        const msgs: Msg[] = [
            row('user', 'what time is it?'),
            row('assistant', 'It is 4pm.', 2),
            row('user', 'thanks'),
            row('assistant', 'no problem', 4),
        ];
        const total = msgs.reduce((n, m) => n + m.content.length, 0);
        expect(total).toBeLessThan(TRIVIAL_SESSION_CHAR_THRESHOLD);
        expect(hasToolCallSignal(msgs)).toBe(false);
    });

    it('a substantive multi-turn discussion clears the threshold', () => {
        // 400 chars per assistant message × 2 puts assistant content alone
        // at 800. Add a normal user side and the session clears.
        const long = 'x'.repeat(400);
        const msgs: Msg[] = [
            row('user', 'explain the difference between A and B'),
            row('assistant', long, 2),
            row('user', 'and what about C?'),
            row('assistant', long, 4),
        ];
        const total = msgs.reduce((n, m) => n + m.content.length, 0);
        expect(total).toBeGreaterThanOrEqual(TRIVIAL_SESSION_CHAR_THRESHOLD);
    });
});
