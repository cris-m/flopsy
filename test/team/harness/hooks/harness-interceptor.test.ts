/**
 * HarnessInterceptor — verify the system-prompt injection produced by
 * `onAgentStart` + `beforeModelCall`.
 *
 * Per-peer agent memory (profile / notes / directives) moved to the
 * unified BaseStore (memory.db) and is no longer rendered by this
 * interceptor. Surviving sections: <last_session>, <presence>.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type {
    ChatMessage,
    InterceptorContext,
    InterceptorModelContext,
    ModelCallIntercept,
} from 'flopsygraph';
import { LearningStore } from '@flopsy/team';
import { HarnessInterceptor } from '@flopsy/team/harness';

const PEER = 'telegram:dm:5257796557';

let tmpDir: string;
let store: LearningStore;
let interceptor: HarnessInterceptor;
let originalFlopsyHome: string | undefined;

function fakeCtx(): InterceptorContext {
    return {
        runId: 'run-1',
        threadId: `${PEER}#s-test`,
        configurable: {},
        store: new Map(),
    } as InterceptorContext;
}

function fakeModelCtx(messages: ChatMessage[]): InterceptorModelContext {
    return {
        ...fakeCtx(),
        messages,
        state: {},
        tools: [],
        model: 'test-model',
        provider: 'test',
    } as InterceptorModelContext;
}

async function injectedText(): Promise<string | null> {
    await interceptor.onAgentStart(fakeCtx());
    const intercept = interceptor.beforeModelCall(
        fakeModelCtx([{ role: 'user', content: 'hi' }]),
    ) as ModelCallIntercept | void;
    if (!intercept || !intercept.messages) return null;
    const sys = intercept.messages.find((m) => m.role === 'system');
    if (!sys) return null;
    return typeof sys.content === 'string' ? sys.content : '';
}

beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'flopsy-harness-int-'));
    originalFlopsyHome = process.env.FLOPSY_HOME;
    process.env.FLOPSY_HOME = tmpDir;
    store = new LearningStore(join(tmpDir, 'state.db'));
    interceptor = new HarnessInterceptor({ userId: PEER, store });
});

afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
    if (originalFlopsyHome === undefined) delete process.env.FLOPSY_HOME;
    else process.env.FLOPSY_HOME = originalFlopsyHome;
});

describe('beforeModelCall — empty store', () => {
    it('does NOT inject anything when there is no last session and no silence signal', async () => {
        const text = await injectedText();
        expect(text).toBeNull();
    });
});

describe('beforeModelCall — <last_session>', () => {
    it('renders <last_session> only when a closed session has a non-empty summary', async () => {
        store.upsertPeer({
            peerId: PEER, channel: 'telegram', scope: 'dm',
            peerNativeId: '5257796557',
        });
        const session = store.openSession({ peerId: PEER, source: 'user' });
        store.closeSession(session.sessionId, 'user');

        let text = await injectedText();
        expect(text).toBeNull();

        store.setSessionSummary(session.sessionId, 'we debugged the scraper');
        interceptor = new HarnessInterceptor({ userId: PEER, store });
        text = await injectedText();
        expect(text).toContain('<last_session');
        expect(text).toContain('we debugged the scraper');
        expect(text).toContain('</last_session>');
    });
});

describe('beforeModelCall — <presence> block', () => {
    it('does NOT render <presence> when silence is below the 7-day threshold', async () => {
        store.upsertPeer({
            peerId: PEER, channel: 'telegram', scope: 'dm',
            peerNativeId: '5257796557',
        });
        const session = store.openSession({ peerId: PEER, source: 'user' });
        store.recordMessage({
            userId: PEER,
            threadId: `${PEER}#${session.sessionId}`,
            role: 'user',
            content: 'hi',
        });
        store.touchSession(session.sessionId, 'user');
        const text = await injectedText();
        expect(text ?? '').not.toContain('<presence');
    });

    it('renders <presence> when silence is at least 7 days', async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date('2026-04-20T12:00:00Z'));
            store.upsertPeer({
                peerId: PEER, channel: 'telegram', scope: 'dm',
                peerNativeId: '5257796557',
            });
            const session = store.openSession({ peerId: PEER, source: 'user' });
            store.recordMessage({
                userId: PEER,
                threadId: `${PEER}#${session.sessionId}`,
                role: 'user',
                content: 'old message',
            });
            store.touchSession(session.sessionId, 'user');
            store.closeSession(session.sessionId, 'user');
            store.setSessionSummary(session.sessionId, 'old chat');

            vi.setSystemTime(new Date('2026-04-28T12:00:00Z'));
            interceptor = new HarnessInterceptor({ userId: PEER, store });
            const text = await injectedText();
            expect(text).toContain('<presence');
            expect(text).toMatch(/silent_for:\s*\d+d ago/);
            expect(text).toContain('</presence>');
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('beforeModelCall — wrapper', () => {
    beforeEach(() => {
        store.upsertPeer({
            peerId: PEER, channel: 'telegram', scope: 'dm',
            peerNativeId: '5257796557',
        });
        const session = store.openSession({ peerId: PEER, source: 'user' });
        store.closeSession(session.sessionId, 'user');
        store.setSessionSummary(session.sessionId, 'simple');
    });

    it('opens with <flopsy:harness> and closes with </flopsy:harness>', async () => {
        const text = (await injectedText())!;
        expect(text.startsWith('<flopsy:harness')).toBe(true);
        expect(text.endsWith('</flopsy:harness>')).toBe(true);
    });

    it('includes the recalled-memory disclaimer header', async () => {
        const text = (await injectedText())!;
        expect(text).toContain('recalled memory context');
        expect(text).toContain('NOT new user input');
    });
});

describe('beforeModelCall — idempotent injection', () => {
    beforeEach(() => {
        store.upsertPeer({
            peerId: PEER, channel: 'telegram', scope: 'dm',
            peerNativeId: '5257796557',
        });
        const session = store.openSession({ peerId: PEER, source: 'user' });
        store.closeSession(session.sessionId, 'user');
        store.setSessionSummary(session.sessionId, 'simple');
    });

    it('does not double-inject when the harness marker is already in messages', async () => {
        await interceptor.onAgentStart(fakeCtx());
        const existing: ChatMessage = {
            role: 'system',
            content: '<flopsy:harness>... already injected ...</flopsy:harness>',
        };
        const intercept = interceptor.beforeModelCall(
            fakeModelCtx([existing, { role: 'user', content: 'hi' }]),
        );
        expect(intercept).toBeUndefined();
    });

    it('preserves message ordering: original system messages stay before the injection', async () => {
        await interceptor.onAgentStart(fakeCtx());
        const sys1: ChatMessage = { role: 'system', content: 'agent baseline' };
        const usr: ChatMessage = { role: 'user', content: 'hello' };
        const intercept = interceptor.beforeModelCall(fakeModelCtx([sys1, usr]));
        expect(intercept).toBeTruthy();
        const msgs = intercept!.messages!;
        expect(msgs[0]!.content).toBe('agent baseline');
        expect(msgs[1]!.role).toBe('system');
        expect(typeof msgs[1]!.content === 'string'
            ? msgs[1]!.content
            : '').toContain('<flopsy:harness');
        expect(msgs[2]!.content).toBe('hello');
    });
});

describe('afterToolCall — tool-failure capture', () => {
    function toolCtx(toolName: string): InterceptorModelContext & {
        toolName: string;
        toolArgs: unknown;
        toolCallId: string;
    } {
        return {
            ...fakeModelCtx([]),
            toolName,
            toolArgs: {},
            toolCallId: 'tc-1',
        } as InterceptorModelContext & {
            toolName: string;
            toolArgs: unknown;
            toolCallId: string;
        };
    }

    it('records a normalized failure on isError=true', async () => {
        await interceptor.afterToolCall(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            toolCtx('web_search') as any,
            'HTTP 429: rate limited',
            true,
        );
        const rows = store.listRecentToolFailures(PEER);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.toolName).toBe('web_search');
        expect(rows[0]!.errorPattern).toContain('429');
    });

    it('does NOT record on isError=false', async () => {
        await interceptor.afterToolCall(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            toolCtx('web_search') as any,
            'success: results below',
            false,
        );
        expect(store.listRecentToolFailures(PEER)).toHaveLength(0);
    });

    it('skips recording when the error normalizes to an empty pattern', async () => {
        await interceptor.afterToolCall(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            toolCtx('x') as any,
            '   ',
            true,
        );
        expect(store.listRecentToolFailures(PEER)).toHaveLength(0);
    });
});
