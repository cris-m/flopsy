/**
 * `flopsy pairing` CLI — end-to-end via Commander.
 *
 * We point FLOPSY_HOME at a tmp dir so each test starts with a fresh
 * `state.db` and never touches the developer's real one. The CLI module
 * is dynamically imported AFTER setting the env var so its store opens
 * against the tmp DB.
 *
 * stdout is captured by stubbing `console.log`. process.exit calls are
 * intercepted so a CLI failure path doesn't kill the test runner.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PairingStore, getSharedPairingStore, closeSharedPairingStore } from '@flopsy/team';
import { registerPairingCommands } from '@flopsy/cli/ops/pairing-command';

let homeDir: string;
let logs: string[];
let restoreLog: () => void;
let exitCalls: number[];
let restoreExit: () => void;

beforeEach(() => {
    // realpath through any symlinks (macOS /tmp → /private/var/folders/...)
    // so LearningStore's allowed-roots check sees a matching canonical path.
    homeDir = realpathSync(mkdtempSync(join(tmpdir(), 'flopsy-pairing-test-')));
    process.env['FLOPSY_HOME'] = homeDir;

    logs = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
        logs.push(args.map((a) => String(a)).join(' '));
    };
    restoreLog = () => {
        console.log = origLog;
    };

    exitCalls = [];
    const origExit = process.exit;
    // Intercept exit so CLI failure paths don't kill vitest.
    (process as { exit: (code?: number) => never }).exit = ((code?: number) => {
        exitCalls.push(code ?? 0);
        throw new Error(`__exit_${code ?? 0}__`);
    }) as never;
    restoreExit = () => {
        (process as { exit: (code?: number) => never }).exit = origExit;
    };
});

afterEach(() => {
    closeSharedPairingStore();
    restoreLog();
    restoreExit();
    delete process.env['FLOPSY_HOME'];
    rmSync(homeDir, { recursive: true, force: true });
});

function buildProgram(): Command {
    const program = new Command();
    program.exitOverride();  // throw on argument parse errors instead of process.exit
    registerPairingCommands(program);
    return program;
}

async function run(...argv: string[]): Promise<void> {
    const program = buildProgram();
    try {
        await program.parseAsync(['node', 'flopsy', ...argv]);
    } catch (err) {
        // Re-throw anything that isn't our exit-stub or a Commander help/version exit.
        if (err instanceof Error && err.message.startsWith('__exit_')) return;
        if ((err as { code?: string }).code === 'commander.helpDisplayed') return;
        throw err;
    }
}

function output(): string {
    return logs.join('\n');
}

function seedStore(seed: (s: PairingStore) => void): void {
    const s = getSharedPairingStore();
    seed(s);
}

describe('flopsy pairing', () => {
    describe('list', () => {
        it('prints the empty-state message when nothing is stored', async () => {
            await run('pairing', 'list');
            expect(output()).toMatch(/No pending or approved pairings/);
        });

        it('shows pending and approved sections when populated', async () => {
            seedStore((s) => {
                s.requestCode('telegram', '5257796557', 'Alice');
                s.approveBySenderId('telegram', '999111', 'Bob');
            });

            await run('pairing', 'list');
            const out = output();
            expect(out).toMatch(/Pending \(1\)/);
            expect(out).toMatch(/5257796557/);
            expect(out).toContain('Alice');
            expect(out).toMatch(/Approved \(1\)/);
            expect(out).toContain('999111');
            expect(out).toContain('Bob');
        });

        it('--channel filters to just that channel', async () => {
            seedStore((s) => {
                s.requestCode('telegram', 't_user');
                s.requestCode('discord', 'd_user');
            });

            await run('pairing', 'list', '--channel', 'telegram');
            const out = output();
            expect(out).toContain('t_user');
            expect(out).not.toContain('d_user');
        });
    });

    describe('approve', () => {
        it('moves a sender from pending to approved', async () => {
            const r = (() => {
                const s = getSharedPairingStore();
                return s.requestCode('telegram', 'sender_a', 'Alice');
            })();
            expect(r).not.toBeNull();

            await run('pairing', 'approve', 'telegram', r!.code);
            expect(output()).toMatch(/Approved/);

            const store = getSharedPairingStore();
            expect(store.isApproved('telegram', 'sender_a')).toBe(true);
            expect(store.listPending('telegram')).toHaveLength(0);
        });

        it('exits with non-zero on an unknown code', async () => {
            await run('pairing', 'approve', 'telegram', 'NOSUCH00');
            expect(exitCalls).toContain(1);
            expect(output()).toMatch(/No pending code/);
        });
    });

    describe('revoke', () => {
        it('removes an approved sender', async () => {
            seedStore((s) => s.approveBySenderId('telegram', 'sender_a'));

            await run('pairing', 'revoke', 'telegram', 'sender_a');
            expect(output()).toMatch(/Revoked/);
            expect(getSharedPairingStore().isApproved('telegram', 'sender_a')).toBe(false);
        });

        it('exits with non-zero when sender was never approved', async () => {
            await run('pairing', 'revoke', 'telegram', 'never_seen');
            expect(exitCalls).toContain(1);
            expect(output()).toMatch(/wasn't approved/);
        });
    });

    describe('clear-pending', () => {
        it('default mode — counts what would have expired (none here, all fresh)', async () => {
            seedStore((s) => {
                s.requestCode('telegram', 'a');
                s.requestCode('telegram', 'b');
            });

            await run('pairing', 'clear-pending');
            expect(output()).toMatch(/Cleared 0 pending codes/);
            // Fresh rows preserved.
            expect(getSharedPairingStore().listPending('telegram')).toHaveLength(2);
        });

        it('--all drops every pending row', async () => {
            seedStore((s) => {
                s.requestCode('telegram', 'a');
                s.requestCode('telegram', 'b');
                s.requestCode('discord', 'c');
            });

            await run('pairing', 'clear-pending', '--all');
            expect(output()).toMatch(/Cleared 3 pending codes/);
            expect(getSharedPairingStore().listPending()).toHaveLength(0);
        });

        it('--all --channel scopes the wipe', async () => {
            seedStore((s) => {
                s.requestCode('telegram', 'a');
                s.requestCode('discord', 'b');
            });

            await run('pairing', 'clear-pending', '--all', '--channel', 'telegram');
            expect(output()).toMatch(/Cleared 1 pending code/);
            const store = getSharedPairingStore();
            expect(store.listPending('telegram')).toHaveLength(0);
            expect(store.listPending('discord')).toHaveLength(1);
        });
    });
});
