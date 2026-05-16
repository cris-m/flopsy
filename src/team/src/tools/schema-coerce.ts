/**
 * Coercion helpers for tool input schemas.
 *
 * Small models (qwen3.5:9b, glm-4.7-flash, gemma) consistently misformat
 * structured tool arguments — they pass `"web_search"` where the schema
 * wants `["web_search"]`, or `"600000"` where it wants `600000`. Strict
 * Zod validation rejects the call, the model retries, gets it wrong
 * again, loops in `<think>` blocks, and the user waits for nothing.
 *
 * These helpers absorb the most common mistakes via `union + transform`,
 * silently coercing the value into the canonical shape before
 * validation runs. Net effect: tool calls succeed on attempt 1.
 *
 * Trade-off: the model never sees the validation error so it never
 * learns to type correctly. For small models that's the right call —
 * one robust round-trip beats four lossy ones.
 *
 * Why `union + transform` instead of `z.preprocess`: preprocess loses
 * TypeScript's inferred type for the field (becomes `unknown`), which
 * breaks downstream `z.infer<typeof schema>` consumers. Union-then-
 * transform preserves the output type cleanly.
 */

import { z } from 'zod';

/**
 * Accept either a number or a numeric-looking string. Output is always
 * `number | undefined`. Empty strings → undefined (treated as absent
 * for `.optional()` use).
 *
 * @example
 *   timeoutMs: numberLooseOptional()
 *     .pipe(z.number().int().positive().max(MAX))
 *
 *   schema.parse({ timeoutMs: 600000 })       // 600000
 *   schema.parse({ timeoutMs: "600000" })     // 600000
 *   schema.parse({ timeoutMs: "" })           // undefined
 *   schema.parse({})                           // undefined
 */
export function numberLooseOptional() {
    // .transform() inside .optional() so the output type collapses to the
    // transform's return type (number | undefined), not the union of input
    // and output that nesting the other way produces.
    return z
        .union([z.number(), z.string()])
        .transform((val): number => {
            if (typeof val === 'number') return val;
            const trimmed = val.trim();
            if (trimmed === '') return Number.NaN;  // rejected by inner constraints downstream
            const n = Number(trimmed);
            return Number.isFinite(n) ? n : Number.NaN;
        })
        .optional();
}

/**
 * Accept any of:
 *   ["a", "b"]                 — canonical
 *   "a"                         — bare string (auto-wrapped)
 *   '["a","b"]'                 — JSON-array string
 *   "a, b, c"                   — CSV string
 *
 * Output: `string[] | undefined`. Empty/null inputs become undefined.
 *
 * @example
 *   tools: stringArrayLooseOptional()
 *
 *   schema.parse({ tools: ["a"] })             // ["a"]
 *   schema.parse({ tools: "a" })               // ["a"]
 *   schema.parse({ tools: '["a","b"]' })       // ["a","b"]
 *   schema.parse({ tools: "a, b" })            // ["a","b"]
 */
export function stringArrayLooseOptional() {
    return z
        .union([z.array(z.string()), z.string()])
        .transform((val): string[] => {
            if (Array.isArray(val)) return val;
            const trimmed = val.trim();
            if (trimmed === '') return [];
            // JSON-array string form: '["a","b"]'
            if (trimmed.startsWith('[')) {
                try {
                    const parsed = JSON.parse(trimmed);
                    if (Array.isArray(parsed)) {
                        return parsed.filter((x): x is string => typeof x === 'string');
                    }
                } catch { /* fall through */ }
            }
            // CSV form: "a, b, c"
            if (trimmed.includes(',')) {
                return trimmed.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
            }
            // Bare single name → wrap in array
            return [trimmed];
        })
        .optional();
}
