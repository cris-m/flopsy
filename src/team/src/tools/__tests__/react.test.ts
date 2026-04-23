import { describe, it, expect } from 'vitest';
import type { ToolRunContext } from 'flopsygraph';
import { reactTool, type ReactConfigurable } from '../react';

function makeCtx(overrides: Partial<ReactConfigurable> = {}) {
    const reactions: Array<{ emoji: string; messageId?: string }> = [];
    const cfg: ReactConfigurable = {
        reactToUserMessage: async (emoji, messageId) => {
            reactions.push({ emoji, messageId });
        },
        ...overrides,
    };
    return {
        ctx: { configurable: cfg as unknown as Record<string, unknown> } as ToolRunContext,
        reactions,
    };
}

describe('reactTool / name + schema', () => {
    it('has the expected tool name', () => {
        expect(reactTool.name).toBe('react');
    });

    it('rejects missing emoji', async () => {
        const h = makeCtx();
        const result = await reactTool.run({}, 'c', h.ctx);
        expect(result.isError).toBe(true);
    });

    it('rejects empty emoji', async () => {
        const h = makeCtx();
        const result = await reactTool.run({ emoji: '' }, 'c', h.ctx);
        expect(result.isError).toBe(true);
    });
});

describe('reactTool / happy path', () => {
    it('calls the callback and confirms via output', async () => {
        const h = makeCtx();
        const result = await reactTool.run({ emoji: '🔥' }, 'c', h.ctx);
        expect(result.isError).toBe(false);
        expect(result.output).toBe('reacted 🔥');
        expect(h.reactions).toEqual([{ emoji: '🔥', messageId: undefined }]);
    });

    it('supports multi-character emojis (👀, 🫡, combined glyphs)', async () => {
        const h = makeCtx();
        await reactTool.run({ emoji: '👀' }, 'c1', h.ctx);
        await reactTool.run({ emoji: '🫡' }, 'c2', h.ctx);
        await reactTool.run({ emoji: '🤷‍♂️' }, 'c3', h.ctx);
        expect(h.reactions.map(r => r.emoji)).toEqual(['👀', '🫡', '🤷‍♂️']);
    });
});

describe('reactTool / degraded wiring', () => {
    it('no callback: returns safe diagnostic, never throws', async () => {
        const ctx: ToolRunContext = { configurable: {} };
        const result = await reactTool.run({ emoji: '👀' }, 'c', ctx);
        expect(result.isError).toBe(false);
        expect(result.output).toMatch(/no reaction callback/i);
    });

    it('callback that throws: returns diagnostic, never crashes turn', async () => {
        const ctx: ToolRunContext = {
            configurable: {
                reactToUserMessage: () => {
                    throw new Error('platform rejected');
                },
            },
        };
        const result = await reactTool.run({ emoji: '👀' }, 'c', ctx);
        expect(result.isError).toBe(false);
        expect(result.output).toMatch(/failed.*platform rejected/);
    });
});
