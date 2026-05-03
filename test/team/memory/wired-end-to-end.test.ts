/**
 * End-to-end wiring test — proves the FlopsyBot main agent (gandalf-shaped)
 * receives the new MemoryProvider-backed `memory_search` + `memory` tools
 * when constructed via the team factory, and that the data path works
 * through the SqliteMemoryStore that handler.ts:308 now uses.
 *
 * Without this test, the question "is the new memory system actually live
 * in FlopsyBot, or did it stop at flopsygraph?" has no green-button answer.
 * With it, every commit re-asserts: pass a MemoryProvider through factory
 * → tools auto-inject → write hits the SQLite file → search returns it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqliteMemoryStore } from 'flopsygraph';
import { createTeamMember } from '@flopsy/team/factory';
import { LearningStore } from '@flopsy/team/harness';
import type { AgentDefinition } from '@flopsy/shared';
import type { BaseChatModel } from 'flopsygraph';

// Minimal main-agent definition that mirrors gandalf's shape — enough
// surface for createTeamMember to build a worker; not enough to actually
// LLM-invoke. We're testing wiring, not inference.
const GANDALF_LIKE: AgentDefinition = {
    name: 'gandalf',
    role: 'main',
    type: 'main',
    domain: 'general',
    description: 'main orchestrator (test stub)',
    model: 'openai:gpt-5.4-mini',
    toolsets: [],
};

// Stub model — never actually invoked in this test. createReactAgent only
// reads `.invoke` lazily; we just need the type to satisfy the factory.
const stubModel = {
    invoke: async () => ({ content: '', toolCalls: [] }),
} as unknown as BaseChatModel;

describe('FlopsyBot main agent wiring — MemoryProvider end-to-end', () => {
    let tmpDir: string;
    let dbPath: string;
    let store: LearningStore;
    let memoryStore: SqliteMemoryStore;

    beforeEach(async () => {
        tmpDir = mkdtempSync(join(tmpdir(), 'flopsy-wired-'));
        // LearningStore enforces a workspace-root path-safety check —
        // override FLOPSY_HOME so the test's temp dir IS the workspace
        // root and the SQLite files are accepted.
        process.env.FLOPSY_HOME = tmpDir;
        dbPath = join(tmpDir, 'memory.db');

        // Same shape as handler.ts:308 builds for gandalf in production:
        // a SqliteMemoryStore over a workspace-resolved SQLite path,
        // optional embedder. Here we run without an embedder — the agent
        // tool surface should still wire identically; only semantic
        // ranking is degraded.
        memoryStore = new SqliteMemoryStore({ path: dbPath });

        // LearningStore is unrelated to the MemoryProvider but the team
        // factory needs one — typed surfaces (profile/notes/directives)
        // still live there, separate from the pluggable opaque store.
        store = new LearningStore(join(tmpDir, 'state.db'));
    });

    afterEach(() => {
        delete process.env.FLOPSY_HOME;
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    // The afterEach above deletes the tmp dir; the env-var clear lives
    // in its own afterEach so cleanup order is deterministic regardless
    // of vitest's hook scheduling.

    it('createTeamMember(main) injects memory_search + memory tools when memoryStore is a MemoryProvider', () => {
        const member = createTeamMember(GANDALF_LIKE, {
            model: stubModel,
            userId: 'test-user',
            store,
            memoryStore,
            checkpointer: undefined as unknown as never,  // not exercised here
        });

        // member.tools holds the EXPLICIT tool list passed into the
        // factory (control tools + toolsets). Memory tools are auto-
        // injected by createReactAgent inside the compiled graph — surfaced
        // via the ReactAgentHandle.getTools() method on member.agent.
        const allTools = (member.agent as unknown as { getTools(): readonly { name: string }[] }).getTools();
        const tools = allTools.map((t) => t.name);
        // The new pair must be present.
        expect(tools).toContain('memory_search');
        expect(tools).toContain('memory');
        // Legacy tool names must be gone — the agent surface is unified.
        expect(tools).not.toContain('manage_memory');
        expect(tools).not.toContain('search_memory');
    });

    it('the MemoryProvider passed to the factory is the one tools route to', async () => {
        // Plant a value directly via the provider; the agent's
        // memory_search tool, when invoked, should retrieve it.
        const written = await memoryStore.add({
            namespace: 'opaque:test-user',
            content: 'the user prefers french responses',
            metadata: { confidence: 0.95 },
        });
        expect(written.id).toBeTruthy();

        // Construct the agent and look up the bound `memory_search` tool.
        const member = createTeamMember(GANDALF_LIKE, {
            model: stubModel,
            userId: 'test-user',
            store,
            memoryStore,
            checkpointer: undefined as unknown as never,
        });
        const allTools = (member.agent as unknown as { getTools(): readonly Array<{ name: string; execute: (args: unknown, ctx: unknown) => Promise<unknown> }> }).getTools();
        const searchTool = allTools.find((t) => t.name === 'memory_search');
        expect(searchTool).toBeDefined();

        // Invoke the tool's execute path directly — same path the LLM
        // takes when it emits a memory_search call.
        const result = await searchTool!.execute(
            { namespace: 'opaque:test-user', limit: 5 },
            // ToolRunContext stub — runtime not exercised
            {} as never,
        );
        const text = typeof result === 'string' ? result : JSON.stringify(result);
        expect(text).toContain('french');
    });

    it('the data path persists across provider instances on the same SQLite file', async () => {
        // Write through provider A, read through provider B pointed at the
        // same file. Proves the SqliteMemoryStore's underlying SqliteMemoryStore
        // is the byte-identical persistence we promised.
        const providerA = new SqliteMemoryStore({ path: dbPath });
        const { id } = await providerA.add({
            namespace: 'cross-instance',
            content: 'persistent fact',
        });
        expect(id).toBeTruthy();

        const providerB = new SqliteMemoryStore({ path: dbPath });
        const results = await providerB.search({ namespace: 'cross-instance' });
        expect(results.length).toBeGreaterThanOrEqual(1);
        expect(results.some((r) => r.content === 'persistent fact')).toBe(true);
    });

    it('memory_write (action=add) via the agent tool persists through the provider', async () => {
        const member = createTeamMember(GANDALF_LIKE, {
            model: stubModel,
            userId: 'test-user',
            store,
            memoryStore,
            checkpointer: undefined as unknown as never,
        });
        const allTools2 = (member.agent as unknown as { getTools(): readonly Array<{ name: string; execute: (args: unknown, ctx: unknown) => Promise<unknown> }> }).getTools();
        const writeTool = allTools2.find((t) => t.name === 'memory');
        expect(writeTool).toBeDefined();

        // The Hermes-style three actions: add / replace / remove.
        const addResult = await writeTool!.execute(
            {
                action: 'add',
                namespace: 'opaque:test-user',
                content: 'user is in eastern timezone',
            },
            {} as never,
        );
        const addText = typeof addResult === 'string' ? addResult : JSON.stringify(addResult);
        expect(addText).toContain('added');

        // Verify the write went all the way to the SQLite file by reading
        // through the same provider directly.
        const direct = await memoryStore.search({ namespace: 'opaque:test-user' });
        expect(direct.some((r) => String(r.content).includes('eastern timezone'))).toBe(true);
    });
});
