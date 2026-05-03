import type { Interceptor } from 'flopsygraph';
import { createLogger } from '@flopsy/shared';

const log = createLogger('tool-loop-dedup');

const STORE_KEY = 'flopsy:tool-loop-dedup:recent';

interface DedupEntry {
    hash: string;
    ts: number;
}

interface DedupOptions {
    threshold?: number;
    window?: number;
}

// Sort keys so `{a:1,b:2}` and `{b:2,a:1}` hash identically.
function canonicalHash(name: string, args: unknown): string {
    if (args == null || typeof args !== 'object' || Array.isArray(args)) {
        try {
            return `${name}::${JSON.stringify(args)}`;
        } catch {
            return `${name}::<unhashable>`;
        }
    }
    const obj = args as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const sorted: Record<string, unknown> = {};
    for (const k of keys) sorted[k] = obj[k];
    try {
        return `${name}::${JSON.stringify(sorted)}`;
    } catch {
        return `${name}::<unhashable>`;
    }
}

export function toolLoopDedup(options: DedupOptions = {}): Interceptor {
    const threshold = Math.max(2, options.threshold ?? 3);
    const window = Math.max(threshold, options.window ?? 10);

    return {
        name: 'tool-loop-dedup',
        beforeToolCall(ctx) {
            // DCL meta-tools: catalog discovery is iterative by design.
            if (ctx.toolName.startsWith('__')) return;

            const recent = (ctx.store.get(STORE_KEY) as DedupEntry[] | undefined) ?? [];
            const hash = canonicalHash(ctx.toolName, ctx.toolArgs);

            let consecutive = 1;
            for (let i = recent.length - 1; i >= 0; i--) {
                if (recent[i]!.hash === hash) consecutive++;
                else break;
            }

            const updated = [...recent, { hash, ts: Date.now() }].slice(-window);
            ctx.store.set(STORE_KEY, updated);

            if (consecutive >= threshold) {
                log.warn(
                    {
                        runId: ctx.runId,
                        threadId: ctx.threadId,
                        toolName: ctx.toolName,
                        consecutive,
                    },
                    'tool-loop-dedup blocking repeated call',
                );
                return {
                    block: {
                        reason: `tool-loop-dedup: ${ctx.toolName} called ${consecutive}x in a row with identical args`,
                        output:
                            `[blocked: tool-loop-dedup] You called \`${ctx.toolName}\` ${consecutive} times in a row with the same arguments. ` +
                            `The result will be the same. Pick one: ` +
                            `(a) call it with different arguments, ` +
                            `(b) try a different tool, or ` +
                            `(c) stop and answer the user with what you already have.`,
                    },
                };
            }
        },
    };
}
