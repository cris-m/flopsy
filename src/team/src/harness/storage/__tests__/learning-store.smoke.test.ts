import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LearningStore } from '../learning-store';

describe('LearningStore — smoke', () => {
    let tmpDir: string;
    let dbPath: string;
    let store: LearningStore;
    let originalFlopsyHome: string | undefined;

    beforeEach(() => {
        // Every harness file MUST live under the configured workspace. Point
        // FLOPSY_HOME at a fresh tmp dir so the allowlist accepts our DB path.
        tmpDir = mkdtempSync(join(tmpdir(), 'flopsy-learning-'));
        originalFlopsyHome = process.env.FLOPSY_HOME;
        process.env.FLOPSY_HOME = tmpDir;

        dbPath = join(tmpDir, 'state.db');
        store = new LearningStore(dbPath);
    });

    afterEach(() => {
        store.close();
        rmSync(tmpDir, { recursive: true, force: true });
        if (originalFlopsyHome === undefined) delete process.env.FLOPSY_HOME;
        else process.env.FLOPSY_HOME = originalFlopsyHome;
    });

    it('opens a fresh DB and applies schema', () => {
        expect(store.getStrategiesForUser('alice')).toEqual([]);
        expect(store.getLessonsForUser('alice')).toEqual([]);
        expect(store.getTopSkills('alice')).toEqual([]);
    });

    it('round-trips a strategy: create → read → update → re-read', () => {
        const userId = 'alice';

        const created = store.createStrategy(userId, {
            name: 'break-complex-tasks',
            description: 'Decompose hard tasks into smaller steps',
            domain: 'coding',
            effectiveness: 0.5,
            uses: 0,
            lastUsed: 0,
            createdAt: Date.now(),
            refinements: 0,
            tags: ['decomposition'],
        });

        expect(created.id).toMatch(/^strategy_/);
        expect(created.effectiveness).toBe(0.5);

        const found = store.getStrategy(created.id);
        expect(found).not.toBeNull();
        expect(found?.name).toBe('break-complex-tasks');

        const before = found!.effectiveness;
        store.updateStrategyEffectiveness(created.id, 1.0); // positive signal
        const after = store.getStrategy(created.id);

        expect(after!.effectiveness).toBeGreaterThan(before);
        expect(after!.effectiveness).toBeLessThanOrEqual(1.0);
        expect(after!.uses).toBe(1);
        expect(after!.refinements).toBe(1);
    });

    it('clamps effectiveness to [0.2, 1.0] under repeated signals', () => {
        const userId = 'bob';
        const s = store.createStrategy(userId, {
            name: 'hot-strategy',
            description: '',
            domain: 'any',
            effectiveness: 0.8,
            uses: 0,
            lastUsed: 0,
            createdAt: Date.now(),
            refinements: 0,
            tags: [],
        });

        // Slam positive signals — should saturate at 1.0, not overflow.
        for (let i = 0; i < 50; i++) store.updateStrategyEffectiveness(s.id, 10);
        expect(store.getStrategy(s.id)!.effectiveness).toBeLessThanOrEqual(1.0);

        // Slam negative signals — should floor at 0.2, not go below.
        for (let i = 0; i < 50; i++) store.updateStrategyEffectiveness(s.id, -10);
        expect(store.getStrategy(s.id)!.effectiveness).toBeGreaterThanOrEqual(0.2);
    });

    it('scopes data by userId', () => {
        store.createStrategy('alice', {
            name: 'a',
            description: '',
            domain: 'x',
            effectiveness: 0.5,
            uses: 0,
            lastUsed: 0,
            createdAt: Date.now(),
            refinements: 0,
            tags: [],
        });
        store.createStrategy('bob', {
            name: 'b',
            description: '',
            domain: 'x',
            effectiveness: 0.5,
            uses: 0,
            lastUsed: 0,
            createdAt: Date.now(),
            refinements: 0,
            tags: [],
        });

        expect(store.getStrategiesForUser('alice').map((s) => s.name)).toEqual(['a']);
        expect(store.getStrategiesForUser('bob').map((s) => s.name)).toEqual(['b']);
    });

    it('records lessons with dedup via findLessonByRule', () => {
        const userId = 'alice';
        const lesson = store.createLesson(userId, {
            rule: 'Never use inline code on Discord',
            reason: 'User correction',
            domain: 'discord',
            severity: 'important',
            recordedAt: Date.now(),
            preventionCount: 0,
            appliesTo: 'user:all',
            tags: [],
        });

        expect(lesson.id).toMatch(/^lesson_/);
        const found = store.findLessonByRule(userId, 'Never use inline code on Discord');
        expect(found?.id).toBe(lesson.id);

        expect(store.findLessonByRule(userId, 'Some other rule')).toBeNull();
    });

    it('initialises and updates skill effectiveness with exponential smoothing', () => {
        const userId = 'alice';
        const init = store.initSkillMeta(userId, 'web-search', 'research');
        expect(init.effectiveness).toBe(0.5);
        expect(init.useCount).toBe(0);

        // Positive signal: 0.5 * 0.7 + ~0.6 * 0.3 ≈ 0.53
        const after = store.updateSkillMeta(userId, 'web-search', 1.0);
        expect(after.useCount).toBe(1);
        expect(after.successCount).toBe(1);
        expect(after.effectiveness).toBeGreaterThan(0.5);
        expect(after.effectiveness).toBeLessThan(0.6);
        expect(after.effectiveness).toBeLessThanOrEqual(1.0);
        expect(after.effectiveness).toBeGreaterThanOrEqual(0.2);
    });

    it('messages: records user + assistant turns and searches via FTS5', () => {
        const userId = 'alice';

        // Two threads, three messages each — simulates cross-thread history.
        store.recordMessage({
            userId,
            threadId: 'thread-1',
            role: 'user',
            content: 'I am planning a trip to Tokyo next month',
        });
        store.recordMessage({
            userId,
            threadId: 'thread-1',
            role: 'assistant',
            content: 'Nice — is this your first time in Tokyo?',
        });
        store.recordMessage({
            userId,
            threadId: 'thread-2',
            role: 'user',
            content: 'What was that coffee shop I liked in Kyoto?',
        });

        // Token match across threads.
        const tokyoHits = store.searchMessages(userId, 'Tokyo');
        expect(tokyoHits.length).toBe(2);
        expect(new Set(tokyoHits.map((h) => h.threadId))).toEqual(
            new Set(['thread-1']),
        );
        for (const h of tokyoHits) expect(h.snippet).toContain('‹');

        // Phrase match.
        const kyotoHits = store.searchMessages(userId, '"coffee shop"');
        expect(kyotoHits.length).toBe(1);
        expect(kyotoHits[0].threadId).toBe('thread-2');

        // Thread scoping.
        const thread2Only = store.searchMessages(userId, 'Tokyo', {
            threadId: 'thread-2',
        });
        expect(thread2Only.length).toBe(0);

        // User scoping: a second user's search sees nothing.
        const bobHits = store.searchMessages('bob', 'Tokyo');
        expect(bobHits.length).toBe(0);

        // Raw thread fetch returns oldest-first.
        const thread1 = store.getThreadMessages('thread-1');
        expect(thread1.length).toBe(2);
        expect(thread1[0].role).toBe('user');
        expect(thread1[1].role).toBe('assistant');
    });

    it('messages: porter stemming matches morphological variants', () => {
        const userId = 'alice';
        store.recordMessage({
            userId,
            threadId: 't',
            role: 'user',
            content: 'I was running late for the meeting',
        });

        // Porter stemmer: "run" should hit "running".
        const hits = store.searchMessages(userId, 'run');
        expect(hits.length).toBe(1);
    });

    it('messages: rejects empty content and sanitises noisy queries', () => {
        const userId = 'alice';

        // Empty content is a no-op (FTS5 would accept it but ranking is moot).
        store.recordMessage({
            userId,
            threadId: 't',
            role: 'user',
            content: '   ',
        });
        expect(store.getThreadMessages('t').length).toBe(0);

        store.recordMessage({
            userId,
            threadId: 't',
            role: 'user',
            content: 'C++ is my favourite language',
        });

        // Raw "C++" would be an FTS5 parse error; sanitiser quotes tokens.
        const hits = store.searchMessages(userId, 'C++ language');
        expect(hits.length).toBeGreaterThan(0);
    });

    it('facts are bi-temporal: new fact expires the previous one', () => {
        const userId = 'alice';
        const t1 = Date.now();
        store.recordFact({
            userId,
            subject: 'alice',
            predicate: 'uses',
            object: 'Python',
            validityStart: t1,
            validityEnd: null,
            confidence: 1.0,
            source: 'explicit',
        });

        const currentBefore = store.getCurrentFacts(userId, 'alice');
        expect(currentBefore.length).toBe(1);
        expect(currentBefore[0].object).toBe('Python');

        const t2 = t1 + 1_000;
        store.recordFact({
            userId,
            subject: 'alice',
            predicate: 'uses',
            object: 'Go',
            validityStart: t2,
            validityEnd: null,
            confidence: 1.0,
            source: 'explicit',
        });

        const currentAfter = store.getCurrentFacts(userId, 'alice');
        expect(currentAfter.length).toBe(1);
        expect(currentAfter[0].object).toBe('Go');
    });
});
