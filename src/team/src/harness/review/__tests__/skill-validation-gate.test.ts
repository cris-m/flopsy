import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
    SkillUsageStore,
    lessonFingerprint,
    validatePendingEdits,
    appendLessonsToSkill,
} from '../index';

function makeProactiveSkill(skillsPath: string): void {
    const dir = join(skillsPath, 'productivity', 'proactive');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
        join(dir, 'SKILL.md'),
        '---\nname: proactive\ncategory: productivity\n---\n\n# Proactive\n\nBody.\n',
        'utf-8',
    );
}

const fakeEngagement = (delivered: number, replied: number) => ({
    getProactiveEngagement: () => ({ delivered, replied }),
});

const skillBody = (skillsPath: string): string =>
    readFileSync(join(skillsPath, 'productivity', 'proactive', 'SKILL.md'), 'utf-8');

const DAY = 24 * 60 * 60 * 1000;

let skillsPath: string;
beforeEach(() => {
    skillsPath = mkdtempSync(join(tmpdir(), 'flopsy-skillgate-'));
    makeProactiveSkill(skillsPath);
});
afterEach(() => rmSync(skillsPath, { recursive: true, force: true }));

describe('skill-edit validation gate', () => {
    it('reverts an edit that hurt engagement and buffers its fingerprint', async () => {
        const store = new SkillUsageStore(skillsPath);
        await appendLessonsToSkill(skillsPath, 'proactive', ['Bad lesson that hurt.']);
        const fp = lessonFingerprint('Bad lesson that hurt.');
        store.recordPendingEdit('proactive', {
            fingerprints: [fp],
            bullets: ['Bad lesson that hurt.'],
            appliedAt: Date.now() - 25 * 60 * 60 * 1000,
            baselineRate: 0.7,
            baselineN: 10,
        });
        const res = await validatePendingEdits(skillsPath, store, fakeEngagement(10, 2)); // 0.2 << 0.7

        expect(res.rejected).toContain('proactive');
        expect(store.getPendingEdit('proactive')).toBeNull();
        expect(store.isRejected('proactive', fp)).toBe(true);
        expect(skillBody(skillsPath)).not.toContain('Bad lesson that hurt.');
    });

    it('accepts an edit whose engagement held up', async () => {
        const store = new SkillUsageStore(skillsPath);
        await appendLessonsToSkill(skillsPath, 'proactive', ['Good lesson.']);
        store.recordPendingEdit('proactive', {
            fingerprints: [lessonFingerprint('Good lesson.')],
            bullets: ['Good lesson.'],
            appliedAt: Date.now() - 25 * 60 * 60 * 1000,
            baselineRate: 0.5,
            baselineN: 10,
        });
        const res = await validatePendingEdits(skillsPath, store, fakeEngagement(10, 6)); // 0.6 ≥ 0.5

        expect(res.accepted).toContain('proactive');
        expect(store.getPendingEdit('proactive')).toBeNull();
        expect(skillBody(skillsPath)).toContain('Good lesson.');
    });

    it('leaves a too-recent trial pending (no premature judgement)', async () => {
        const store = new SkillUsageStore(skillsPath);
        store.recordPendingEdit('proactive', {
            fingerprints: ['x'],
            bullets: ['x'],
            appliedAt: Date.now(), // < 24h old
            baselineRate: 0.5,
            baselineN: 10,
        });
        const res = await validatePendingEdits(skillsPath, store, fakeEngagement(100, 0));
        expect(res.stillPending).toContain('proactive');
        expect(store.getPendingEdit('proactive')).not.toBeNull();
    });

    it('leaves a trial pending when too few fires to judge', async () => {
        const store = new SkillUsageStore(skillsPath);
        store.recordPendingEdit('proactive', {
            fingerprints: ['x'],
            bullets: ['x'],
            appliedAt: Date.now() - 2 * DAY,
            baselineRate: 0.9,
            baselineN: 10,
        });
        const res = await validatePendingEdits(skillsPath, store, fakeEngagement(3, 0)); // n<8
        expect(res.stillPending).toContain('proactive');
        expect(store.getPendingEdit('proactive')).not.toBeNull();
    });

    it('serializes trials — a second recordPendingEdit is a no-op', () => {
        const store = new SkillUsageStore(skillsPath);
        expect(
            store.recordPendingEdit('proactive', { fingerprints: ['a'], bullets: ['a'], appliedAt: Date.now(), baselineRate: 0.5, baselineN: 5 }),
        ).toBe(true);
        expect(
            store.recordPendingEdit('proactive', { fingerprints: ['b'], bullets: ['b'], appliedAt: Date.now(), baselineRate: 0.5, baselineN: 5 }),
        ).toBe(false);
        expect(store.getPendingEdit('proactive')?.fingerprints).toEqual(['a']);
    });

    it('rejected-edit buffer blocks re-applying a reverted lesson', async () => {
        const store = new SkillUsageStore(skillsPath);
        store.addRejectedEdit('proactive', lessonFingerprint('Bad lesson.'));
        const ok = await appendLessonsToSkill(skillsPath, 'proactive', ['Bad lesson.']);
        expect(ok).toBe(false); // every lesson filtered → nothing appended
        expect(skillBody(skillsPath)).not.toContain('Bad lesson.');
    });

    it('caps the rejected buffer and de-dups fingerprints', () => {
        const store = new SkillUsageStore(skillsPath);
        for (let i = 0; i < 60; i++) store.addRejectedEdit('proactive', `fp-${i}`);
        store.addRejectedEdit('proactive', 'fp-59'); // duplicate → moves to end, no growth
        const list = store.getRejectedEdits('proactive');
        expect(list.length).toBe(50);
        expect(list.at(-1)).toBe('fp-59');
        expect(list.filter((f) => f === 'fp-59').length).toBe(1);
    });
});
