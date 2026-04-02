import { describe, it, expect, vi, afterEach } from 'vitest';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmdirSync, existsSync } from 'fs';
import {
    resolveFlopsyHome,
    resolveWorkspacePath,
    ensureDir,
    createWorkspace,
    workspace,
} from '../src/utils/workspace';

// ---------------------------------------------------------------------------
// resolveFlopsyHome
// ---------------------------------------------------------------------------

describe('resolveFlopsyHome', () => {
    it('returns ~/.flopsy by default', () => {
        expect(resolveFlopsyHome({})).toBe(join(homedir(), '.flopsy'));
    });

    it('respects FLOPSY_HOME absolute path', () => {
        expect(resolveFlopsyHome({ FLOPSY_HOME: '/custom/path' })).toBe('/custom/path');
    });

    it('expands ~ in FLOPSY_HOME', () => {
        expect(resolveFlopsyHome({ FLOPSY_HOME: '~/.my-flopsy' })).toBe(
            join(homedir(), '.my-flopsy'),
        );
    });

    it('resolves relative FLOPSY_HOME against CWD', () => {
        const result = resolveFlopsyHome({ FLOPSY_HOME: 'relative/path' });
        expect(result).toMatch(/relative\/path$/);
    });

    it('trims whitespace from FLOPSY_HOME', () => {
        expect(resolveFlopsyHome({ FLOPSY_HOME: '  /trimmed  ' })).toBe('/trimmed');
    });

    it('uses FLOPSY_PROFILE to build path', () => {
        expect(resolveFlopsyHome({ FLOPSY_PROFILE: 'work' })).toBe(join(homedir(), '.flopsy-work'));
    });

    it('ignores FLOPSY_PROFILE when value is "default"', () => {
        expect(resolveFlopsyHome({ FLOPSY_PROFILE: 'default' })).toBe(join(homedir(), '.flopsy'));
    });

    it('throws for invalid FLOPSY_PROFILE characters', () => {
        expect(() => resolveFlopsyHome({ FLOPSY_PROFILE: 'bad/profile' })).toThrow(
            /Invalid FLOPSY_PROFILE/,
        );
        expect(() => resolveFlopsyHome({ FLOPSY_PROFILE: 'bad profile' })).toThrow(
            /Invalid FLOPSY_PROFILE/,
        );
        expect(() => resolveFlopsyHome({ FLOPSY_PROFILE: '../escape' })).toThrow(
            /Invalid FLOPSY_PROFILE/,
        );
    });

    it('FLOPSY_HOME takes precedence over FLOPSY_PROFILE', () => {
        expect(resolveFlopsyHome({ FLOPSY_HOME: '/explicit', FLOPSY_PROFILE: 'work' })).toBe(
            '/explicit',
        );
    });
});

// ---------------------------------------------------------------------------
// resolveWorkspacePath
// ---------------------------------------------------------------------------

describe('resolveWorkspacePath', () => {
    it('appends parts to default home', () => {
        const expected = join(homedir(), '.flopsy', 'state', 'foo.json');
        expect(resolveWorkspacePath('state', 'foo.json')).toBe(expected);
    });
});

// ---------------------------------------------------------------------------
// ensureDir
// ---------------------------------------------------------------------------

describe('ensureDir', () => {
    let tmp: string;

    afterEach(() => {
        try {
            rmdirSync(tmp, { recursive: true } as never);
        } catch {
            /* ok */
        }
    });

    it('creates a missing directory and returns its path', () => {
        tmp = join(tmpdir(), `flopsy-test-${Date.now()}`);
        expect(existsSync(tmp)).toBe(false);
        const result = ensureDir(tmp);
        expect(result).toBe(tmp);
        expect(existsSync(tmp)).toBe(true);
    });

    it('is idempotent — does not throw if directory exists', () => {
        tmp = mkdtempSync(join(tmpdir(), 'flopsy-test-'));
        expect(() => ensureDir(tmp)).not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// createWorkspace factory
// ---------------------------------------------------------------------------

describe('createWorkspace', () => {
    it('binds all paths to the provided FLOPSY_HOME', () => {
        const ws = createWorkspace({ FLOPSY_HOME: '/my/home' });

        expect(ws.root()).toBe('/my/home');
        expect(ws.state()).toBe('/my/home/state');
        expect(ws.state('proactive.json')).toBe('/my/home/state/proactive.json');
        expect(ws.sessions()).toBe('/my/home/sessions');
        expect(ws.sessions('telegram')).toBe('/my/home/sessions/telegram');
        expect(ws.prompts()).toBe('/my/home/prompts');
        expect(ws.credentials()).toBe('/my/home/credentials');
        expect(ws.credentials('key.pem')).toBe('/my/home/credentials/key.pem');
        expect(ws.logs()).toBe('/my/home/logs');
        expect(ws.memory()).toBe('/my/home/memory');
        expect(ws.checkpoints()).toBe('/my/home/checkpoints');
        expect(ws.cache()).toBe('/my/home/cache');
        expect(ws.cache('thumb.png')).toBe('/my/home/cache/thumb.png');
        expect(ws.agents()).toBe('/my/home/agents');
        expect(ws.skills()).toBe('/my/home/skills');
        expect(ws.learning()).toBe('/my/home/learning');
        expect(ws.data()).toBe('/my/home/data');
        expect(ws.data('agent', 'state.json')).toBe('/my/home/data/agent/state.json');
        expect(ws.dataAgent()).toBe('/my/home/data/agent');
        expect(ws.dataCheckpoints()).toBe('/my/home/data/checkpoints');
        expect(ws.config()).toBe('/my/home/config.json5');
        expect(ws.storeDb()).toBe('/my/home/store.db');
        expect(ws.checkpointsDb()).toBe('/my/home/checkpoints.db');
        expect(ws.pidFile()).toBe('/my/home/gateway.pid');
    });

    it('scratch always points to os.tmpdir()', () => {
        const ws = createWorkspace({ FLOPSY_HOME: '/irrelevant' });
        expect(ws.scratch()).toBe(join(tmpdir(), 'flopsy-scratch'));
    });

    it('two instances with different envs are independent', () => {
        const a = createWorkspace({ FLOPSY_HOME: '/home-a' });
        const b = createWorkspace({ FLOPSY_HOME: '/home-b' });

        expect(a.root()).toBe('/home-a');
        expect(b.root()).toBe('/home-b');
        expect(a.state()).not.toBe(b.state());
    });

    it('default export workspace uses process.env', () => {
        // workspace is bound to process.env at module load time — just verify
        // it returns a non-empty string without throwing.
        expect(typeof workspace.root()).toBe('string');
        expect(workspace.root().length).toBeGreaterThan(0);
    });
});
