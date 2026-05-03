/**
 * LearningStore smoke tests — covers session lifecycle and tool-failure
 * tracking. Per-peer agent memory (profile / notes / directives) was moved
 * to the unified BaseStore (memory.db); see SqliteMemoryStore tests.
 */
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

    describe('tool failures', () => {
        const peer = 'telegram:dm:smoke';

        it('records and aggregates tool failures', () => {
            store.recordToolFailure({
                peerId: peer,
                toolName: 'search',
                errorPattern: 'rate limit 429',
            });
            store.recordToolFailure({
                peerId: peer,
                toolName: 'search',
                errorPattern: 'rate limit 429',
            });
            const rows = store.listRecentToolFailures(peer, {
                limit: 10,
                windowMs: 60_000,
            });
            expect(rows).toHaveLength(1);
            expect(rows[0]!.count).toBe(2);
        });

        it('skips empty error patterns', () => {
            store.recordToolFailure({
                peerId: peer,
                toolName: 'search',
                errorPattern: '   ',
            });
            const rows = store.listRecentToolFailures(peer, {
                limit: 10,
                windowMs: 60_000,
            });
            expect(rows).toHaveLength(0);
        });
    });
});
