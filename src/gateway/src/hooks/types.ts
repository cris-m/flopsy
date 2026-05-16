import { z } from 'zod';

export const HookConfigSchema = z.object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    enabled: z.boolean().optional().default(true),
    events: z.array(z.string().min(3)).min(1),
    handler: z.string().optional(),
    script: z.string().optional(),
}).strict();

export type HookConfig = z.infer<typeof HookConfigSchema>;

/**
 * The context blob each handler receives. The exact shape depends on the
 * event, but every context carries `eventType` (for handlers that subscribe
 * to multiple events) and `firedAt` (ms epoch).
 *
 * Handlers should narrow `context` by event type internally rather than
 * relying on the type system — TypeScript's discriminated unions don't play
 * nicely with dynamically-loaded modules.
 */
export interface HookContext extends Record<string, unknown> {
    eventType: string;
    firedAt: number;
}

/** Handler signature loaded from `handler.ts`. Must be named `handle`. */
export type HookHandler = (
    eventType: string,
    context: HookContext,
) => void | Promise<void>;

/** What the loader records about each registered hook. */
export interface RegisteredHook {
    readonly id: string;             // Directory name, doubles as unique id
    readonly config: HookConfig;
    readonly absDir: string;          // Absolute path on disk
    readonly kind: 'ts' | 'script';
    readonly handler?: HookHandler;   // Loaded module's `handle` export (TS only)
    readonly scriptPath?: string;     // Absolute path (shell only)
}
