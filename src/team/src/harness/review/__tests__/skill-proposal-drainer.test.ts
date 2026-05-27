import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { drainSkillProposals, type PersistedSignal } from '../skill-proposal-drainer';

function makeSignal(overrides: Partial<PersistedSignal> = {}): PersistedSignal {
    return {
        signal_type: 'procedure_taught',
        confidence: 0.9,
        summary: 'User taught a deploy procedure: build, test, tag, push.',
        suggested_skill_name: 'deploy-to-prod',
        suggested_existing_skill: null,
        reasoning: 'Clear 4-step procedure.',
        ts: Date.now(),
        threadId: 't1',
        turnNumber: 5,
        ...overrides,
    };
}

function writeJsonl(path: string, signals: PersistedSignal[]): void {
    writeFileSync(path, signals.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8');
}

describe('drainSkillProposals', () => {
    let tmp: string;
    let proposalsPath: string;
    let skillsPath: string;
    let skillsProposedPath: string;

    beforeEach(() => {
        tmp = mkdtempSync(join(tmpdir(), 'flopsy-drain-'));
        proposalsPath = join(tmp, 'skill-proposals.jsonl');
        skillsPath = join(tmp, 'skills');
        skillsProposedPath = join(tmp, 'skills-proposed');
    });

    afterEach(() => {
        rmSync(tmp, { recursive: true, force: true });
    });

    it('returns empty result when JSONL does not exist', async () => {
        const result = await drainSkillProposals({ proposalsPath, skillsPath, skillsProposedPath });
        expect(result).toEqual({ created: [], appended: [], archived: 0, skipped: 0 });
    });

    it('returns empty result when JSONL is empty', async () => {
        writeFileSync(proposalsPath, '', 'utf8');
        const result = await drainSkillProposals({ proposalsPath, skillsPath, skillsProposedPath });
        expect(result.created).toEqual([]);
        expect(result.archived).toBe(0);
    });

    it('writes a new proposed skill from a single high-confidence signal', async () => {
        writeJsonl(proposalsPath, [makeSignal()]);
        const result = await drainSkillProposals({
            proposalsPath,
            skillsPath,
            skillsProposedPath,
            minConfidence: 0.75,
        });
        expect(result.created).toEqual(['deploy-to-prod']);
        expect(existsSync(join(skillsProposedPath, 'deploy-to-prod', 'SKILL.md'))).toBe(true);
        const body = readFileSync(join(skillsProposedPath, 'deploy-to-prod', 'SKILL.md'), 'utf8');
        expect(body).toContain('name: deploy-to-prod');
        expect(body).toContain('signal_type: procedure_taught');
        expect(body).toContain('# deploy-to-prod');
        expect(body).toContain('## Evidence');
    });

    it('deduplicates multiple signals for the same new skill into ONE file', async () => {
        writeJsonl(proposalsPath, [
            makeSignal({ confidence: 0.85, summary: 'first observation of deploy procedure' }),
            makeSignal({ confidence: 0.92, summary: 'second observation, more detail on tagging' }),
            makeSignal({ confidence: 0.78, summary: 'third observation with edge case' }),
        ]);
        const result = await drainSkillProposals({ proposalsPath, skillsPath, skillsProposedPath });
        expect(result.created).toEqual(['deploy-to-prod']);
        const files = readdirSync(skillsProposedPath);
        expect(files).toHaveLength(1);
        const body = readFileSync(join(skillsProposedPath, 'deploy-to-prod', 'SKILL.md'), 'utf8');
        expect(body).toContain('signals_count: 3');
        expect(body).toContain('first observation');
        expect(body).toContain('second observation');
        expect(body).toContain('third observation');
    });

    it('appends to an existing skill when suggested_existing_skill is set', async () => {
        const existingDir = join(skillsPath, 'deploy-to-prod');
        const { mkdirSync } = await import('fs');
        mkdirSync(existingDir, { recursive: true });
        writeFileSync(
            join(existingDir, 'SKILL.md'),
            '---\nname: deploy-to-prod\ndescription: existing\n---\n\n# deploy-to-prod\n\nbody\n',
            'utf8',
        );

        writeJsonl(proposalsPath, [
            makeSignal({
                suggested_skill_name: null,
                suggested_existing_skill: 'deploy-to-prod',
                summary: 'rebuild Docker after node version change',
            }),
        ]);
        const result = await drainSkillProposals({ proposalsPath, skillsPath, skillsProposedPath });
        expect(result.appended).toEqual(['deploy-to-prod']);
        const body = readFileSync(join(existingDir, 'SKILL.md'), 'utf8');
        expect(body).toContain('rebuild Docker after node version change');
    });

    it('skips signals below minConfidence', async () => {
        writeJsonl(proposalsPath, [
            makeSignal({ confidence: 0.3, summary: 'weak signal' }),
            makeSignal({ confidence: 0.95, summary: 'strong signal' }),
        ]);
        const result = await drainSkillProposals({
            proposalsPath,
            skillsPath,
            skillsProposedPath,
            minConfidence: 0.5,
        });
        expect(result.created).toEqual(['deploy-to-prod']);
        expect(result.skipped).toBe(1);
        const body = readFileSync(join(skillsProposedPath, 'deploy-to-prod', 'SKILL.md'), 'utf8');
        expect(body).toContain('signals_count: 1');
        expect(body).not.toContain('weak signal');
        expect(body).toContain('strong signal');
    });

    it('archives JSONL after successful drain (rename, not truncate)', async () => {
        writeJsonl(proposalsPath, [makeSignal()]);
        await drainSkillProposals({ proposalsPath, skillsPath, skillsProposedPath });
        expect(existsSync(proposalsPath)).toBe(false);
        const archived = readdirSync(tmp).filter((f) => f.includes('processed-'));
        expect(archived.length).toBe(1);
    });

    it('handles malformed JSON lines without crashing', async () => {
        writeFileSync(
            proposalsPath,
            [
                'not json',
                JSON.stringify(makeSignal()),
                '{"partial":',
            ].join('\n') + '\n',
            'utf8',
        );
        const result = await drainSkillProposals({ proposalsPath, skillsPath, skillsProposedPath });
        expect(result.created).toEqual(['deploy-to-prod']);
        expect(result.skipped).toBe(2);
    });
});
