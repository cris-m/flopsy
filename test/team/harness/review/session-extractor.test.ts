/**
 * SessionExtractor — single-LLM-call session-close extractor.
 *
 * Returns null on every failure path (too few messages, model timeout,
 * malformed JSON, wrong shape). Caller treats null as "no extraction
 * this time"; never throws into the gateway turn.
 *
 * The extractor now produces only `summary` + skill outputs; per-peer
 * agent memory (profile / notes / directives) lives in the unified
 * BaseStore (memory.db) and is no longer touched here.
 */
import { describe, expect, it } from 'vitest';
import { SessionExtractor } from '@flopsy/team/harness/review/session-extractor';
import type { MessageRow } from '@flopsy/team/harness/storage';

type ContentBlock = { type: 'text'; text: string };

interface FakeStore {
    getThreadMessages(threadId: string, limit?: number): MessageRow[];
}

const PAD = 'lorem ipsum dolor sit amet '.repeat(15);
function makeMessages(count: number): MessageRow[] {
    const now = Date.now();
    const out: MessageRow[] = [];
    for (let i = 0; i < count; i++) {
        out.push({
            id: i + 1,
            userId: '5257796557',
            threadId: 'telegram:dm:5257796557#s-1',
            role: i % 2 === 0 ? 'user' : 'assistant',
            content: `message ${i} — ${PAD}`,
            createdAt: now + i,
        });
    }
    return out;
}

interface FakeModelOpts {
    response: string | ContentBlock[];
    throwOnInvoke?: boolean;
}

function makeModel(opts: FakeModelOpts) {
    return {
        invoke: async (): Promise<{ content: string | ContentBlock[] }> => {
            if (opts.throwOnInvoke) throw new Error('aborted');
            return { content: opts.response };
        },
    };
}

function makeStore(messages: MessageRow[]): FakeStore {
    return { getThreadMessages: () => messages };
}

function newExtractor(model: ReturnType<typeof makeModel>, store: FakeStore) {
    return new SessionExtractor({
        model: model as unknown as Parameters<typeof SessionExtractor>[0]['model'],
        store: store as unknown as Parameters<typeof SessionExtractor>[0]['store'],
    });
}

describe('SessionExtractor.extract', () => {
    it('returns the parsed extraction result on a valid response', async () => {
        const valid = JSON.stringify({
            summary: 'Discussed memory refactor and shipped Phase 1.',
            skill_proposal: null,
            skill_lessons: [],
        });
        const ex = newExtractor(makeModel({ response: valid }), makeStore(makeMessages(10)));

        const result = await ex.extract('thread-1');

        expect(result).not.toBeNull();
        expect(result!.summary).toContain('memory refactor');
        expect(result!.skill_proposal).toBeNull();
        expect(result!.skill_lessons).toEqual([]);
    });

    it('handles content blocks (Anthropic-style) as well as raw strings', async () => {
        const block: ContentBlock[] = [
            { type: 'text', text: '{"summary":"hi","skill_proposal":null,"skill_lessons":[]}' },
        ];
        const ex = newExtractor(makeModel({ response: block }), makeStore(makeMessages(10)));
        const result = await ex.extract('thread-1');
        expect(result?.summary).toBe('hi');
    });

    it('strips ```json ... ``` code fences before parsing', async () => {
        const fenced = [
            '```json',
            JSON.stringify({ summary: 'ok', skill_proposal: null, skill_lessons: [] }),
            '```',
        ].join('\n');
        const ex = newExtractor(makeModel({ response: fenced }), makeStore(makeMessages(10)));
        const result = await ex.extract('thread-1');
        expect(result?.summary).toBe('ok');
    });

    it('parses a valid skill_proposal', async () => {
        const raw = JSON.stringify({
            summary: 'shipped a thing',
            skill_proposal: {
                name: 'memory-debug',
                description: 'how to debug memory issues',
                when_to_use: 'when memory tools fail unexpectedly',
                body: '## Steps\n1. inspect',
            },
            skill_lessons: [],
        });
        const ex = newExtractor(makeModel({ response: raw }), makeStore(makeMessages(10)));
        const result = await ex.extract('thread-1');
        expect(result?.skill_proposal?.name).toBe('memory-debug');
        expect(result?.skill_proposal?.body).toContain('Steps');
    });

    it('parses skill_lessons appended to existing skills', async () => {
        const raw = JSON.stringify({
            summary: 'ok',
            skill_proposal: null,
            skill_lessons: [
                { name: 'web-search', lessons: ['rate limits at 100/min', 'use json output'] },
            ],
        });
        const ex = newExtractor(makeModel({ response: raw }), makeStore(makeMessages(10)));
        const result = await ex.extract('thread-1');
        expect(result?.skill_lessons).toHaveLength(1);
        expect(result?.skill_lessons[0]?.name).toBe('web-search');
        expect(result?.skill_lessons[0]?.lessons).toHaveLength(2);
    });
});

describe('SessionExtractor.extract — null on failure', () => {
    it('returns null when fewer than 4 messages exist', async () => {
        const ex = newExtractor(makeModel({ response: '{}' }), makeStore(makeMessages(3)));
        expect(await ex.extract('thread-1')).toBeNull();
    });

    it('returns null when the model output is not JSON', async () => {
        const ex = newExtractor(makeModel({ response: 'sorry, I cannot' }), makeStore(makeMessages(10)));
        expect(await ex.extract('thread-1')).toBeNull();
    });

    it('returns null when the JSON is missing a summary', async () => {
        const wrong = JSON.stringify({ skill_proposal: null, skill_lessons: [] });
        const ex = newExtractor(makeModel({ response: wrong }), makeStore(makeMessages(10)));
        expect(await ex.extract('thread-1')).toBeNull();
    });

    it('returns null when model.invoke throws (abort/timeout)', async () => {
        const ex = newExtractor(
            makeModel({ response: '', throwOnInvoke: true }),
            makeStore(makeMessages(10)),
        );
        expect(await ex.extract('thread-1')).toBeNull();
    });
});

describe('SessionExtractor.extract — sanitization', () => {
    it('truncates summary above 500 chars', async () => {
        const raw = JSON.stringify({
            summary: 'a'.repeat(700),
            skill_proposal: null,
            skill_lessons: [],
        });
        const ex = newExtractor(makeModel({ response: raw }), makeStore(makeMessages(10)));
        const result = await ex.extract('thread-1');
        expect(result?.summary.length).toBe(500);
    });

    it('drops invalid skill_proposal names', async () => {
        const raw = JSON.stringify({
            summary: 'ok',
            skill_proposal: {
                name: 'Bad Name With Spaces',
                description: 'desc',
                when_to_use: 'wtu',
                body: 'body',
            },
            skill_lessons: [],
        });
        const ex = newExtractor(makeModel({ response: raw }), makeStore(makeMessages(10)));
        const result = await ex.extract('thread-1');
        expect(result?.skill_proposal).toBeNull();
    });

    it('drops skill_proposal when any required field is empty', async () => {
        const raw = JSON.stringify({
            summary: 'ok',
            skill_proposal: { name: 'ok-name', description: '', when_to_use: 'x', body: 'y' },
            skill_lessons: [],
        });
        const ex = newExtractor(makeModel({ response: raw }), makeStore(makeMessages(10)));
        const result = await ex.extract('thread-1');
        expect(result?.skill_proposal).toBeNull();
    });

    it('caps skill_lessons at 10 items and 5 lessons each', async () => {
        const lessons = Array.from({ length: 15 }, (_, i) => ({
            name: `skill-${i}`,
            lessons: Array.from({ length: 8 }, (_, j) => `lesson ${j}`),
        }));
        const raw = JSON.stringify({
            summary: 'ok',
            skill_proposal: null,
            skill_lessons: lessons,
        });
        const ex = newExtractor(makeModel({ response: raw }), makeStore(makeMessages(10)));
        const result = await ex.extract('thread-1');
        expect(result?.skill_lessons).toHaveLength(10);
        expect(result?.skill_lessons[0]?.lessons.length).toBeLessThanOrEqual(5);
    });
});
