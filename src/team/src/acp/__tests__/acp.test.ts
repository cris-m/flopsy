import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decidePermission, isPathInside, pickOptionId } from '../permission';
import { knownAgents, resolveLaunchSpec } from '../registry';
import { normalizeAcpConfig } from '../config';
import { runAcpAgent } from '../client';

describe('permission policy', () => {
    it('isPathInside accepts contained paths and rejects escapes', () => {
        expect(isPathInside('/work/code/job/x.ts', '/work/code/job')).toBe(true);
        expect(isPathInside('/work/code/job', '/work/code/job')).toBe(true);
        expect(isPathInside('/work/code/job/../../etc/passwd', '/work/code/job')).toBe(false);
        expect(isPathInside('/etc/passwd', '/work/code/job')).toBe(false);
    });

    it('auto-allow-in-cwd allows in-cwd, denies out-of-cwd', () => {
        const cwd = '/work/code/job';
        expect(decidePermission('auto-allow-in-cwd', cwd, [`${cwd}/a.ts`]).allow).toBe(true);
        expect(decidePermission('auto-allow-in-cwd', cwd, []).allow).toBe(true);
        expect(decidePermission('auto-allow-in-cwd', cwd, ['/etc/passwd']).allow).toBe(false);
        expect(decidePermission('auto-allow-in-cwd', cwd, [`${cwd}/a.ts`, '/etc/x']).allow).toBe(false);
    });

    it('deny-all always denies', () => {
        expect(decidePermission('deny-all', '/work', [`/work/a.ts`]).allow).toBe(false);
    });

    it('pickOptionId selects allow/reject by kind, null when absent', () => {
        const opts = [
            { optionId: 'a', kind: 'allow_once' },
            { optionId: 'r', kind: 'reject_once' },
        ];
        expect(pickOptionId(opts, true)).toBe('a');
        expect(pickOptionId(opts, false)).toBe('r');
        expect(pickOptionId([{ optionId: 'x', kind: 'something' }], true)).toBeNull();
    });
});

describe('registry', () => {
    it('resolves the built-in claude-code spec', () => {
        const spec = resolveLaunchSpec('claude-code');
        expect(spec?.command).toBe('npx');
        expect(spec?.args).toContain('@zed-industries/claude-code-acp');
    });

    it('config overrides built-ins and unknown agents return null', () => {
        const configured = { 'claude-code': { command: 'foo', args: ['bar'] } };
        expect(resolveLaunchSpec('claude-code', configured)?.command).toBe('foo');
        expect(resolveLaunchSpec('nope', configured)).toBeNull();
        expect(knownAgents(configured)).toContain('claude-code');
    });
});

describe('normalizeAcpConfig', () => {
    it('fills defaults (disabled by default)', () => {
        const c = normalizeAcpConfig(undefined);
        expect(c.enabled).toBe(false);
        expect(c.cwdRoot).toBe('work/code');
        expect(c.permissionMode).toBe('auto-allow-in-cwd');
        expect(c.timeoutMs).toBeGreaterThan(0);
        expect(c.agents).toEqual({});
    });

    it('honors provided values', () => {
        const c = normalizeAcpConfig({ enabled: true, cwdRoot: 'x', permissionMode: 'deny-all', timeoutMs: 5000 });
        expect(c.enabled).toBe(true);
        expect(c.cwdRoot).toBe('x');
        expect(c.permissionMode).toBe('deny-all');
        expect(c.timeoutMs).toBe(5000);
    });
});

describe('runAcpAgent (integration with the SDK example agent)', () => {
    const require = createRequire(import.meta.url);
    let agentPath: string | null = null;
    try {
        agentPath = require.resolve('@agentclientprotocol/sdk/dist/examples/agent.js');
    } catch {
        agentPath = null;
    }

    it.runIf(agentPath)(
        'drives a session, accumulates transcript, and blocks an out-of-cwd edit',
        async () => {
            const cwd = mkdtempSync(join(tmpdir(), 'acp-test-'));
            const result = await runAcpAgent({
                spec: { command: process.execPath, args: [agentPath!] },
                task: 'Improve the project.',
                cwd,
                permissionMode: 'auto-allow-in-cwd',
                timeoutMs: 25_000,
            });

            expect(result.stopReason).toBe('end_turn');
            expect(result.transcript).toContain("I'll help you with that");
            // The example agent's permission request targets /home/user/project/config.json,
            // outside the tmp cwd → our policy denies → agent takes the "skip" branch.
            expect(result.deniedPaths).toContain('/home/user/project/config.json');
            expect(result.transcript.toLowerCase()).toContain('skip the configuration update');
            expect(result.toolCalls.join(' ')).toContain('Reading project files');
        },
        30_000,
    );
});
