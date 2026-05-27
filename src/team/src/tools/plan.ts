// Persists a thread-scoped plan across ReAct iterations: without it, multi-step tasks re-derive
// their plan every turn. The factory's runtime block re-injects the file as a <plan> block.

import { z } from 'zod';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defineTool } from 'flopsygraph';
import { workspace } from '@flopsy/shared';

const STATUS = z.enum(['todo', 'doing', 'done', 'blocked']);
const MAX_BODY_BYTES = 4096;
const MAX_STEPS = 30;
const STEP_LINE_RE = /^- \[(\w+)\] \[(todo|doing|done|blocked)\]\s+(.*)$/i;

function sanitizeThreadId(raw: string | undefined): string | null {
    if (!raw) return null;
    const safe = raw.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
    return safe.length > 0 ? safe.slice(0, 200) : null;
}

function planPath(threadId: string): string {
    return join(workspace.work('plans'), `${threadId}.md`);
}

function readPlan(threadId: string): string | null {
    const path = planPath(threadId);
    if (!existsSync(path)) return null;
    try {
        return readFileSync(path, 'utf-8');
    } catch {
        return null;
    }
}

function writePlan(threadId: string, body: string): void {
    const path = planPath(threadId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body, 'utf-8');
}

function countSteps(body: string): number {
    let n = 0;
    for (const line of body.split('\n')) if (STEP_LINE_RE.test(line.trim())) n++;
    return n;
}

export const planTool = defineTool({
    name: 'plan',
    description: [
        'Persist a step-by-step plan for THIS thread. The plan survives across turns so you don\'t re-derive it every iteration. Use early for any task with 3+ steps; check off as you go.',
        '',
        'Actions:',
        '  set         — replace the entire plan. Provide `body` as markdown. Use a `# <goal>` headline + a `## Steps` list of `- [s1] [todo] description` lines.',
        '  view        — print current plan (or "no plan" if none).',
        '  update_step — change one step\'s status (and optionally its text). Provide `step_id` (e.g. "s2") and `status` (`todo`|`doing`|`done`|`blocked`); pass `body` to also rewrite that step\'s text.',
        '  clear       — delete the plan file (use after the task is fully done).',
        '',
        'Step line format (matched exactly): `- [s1] [todo] description here`. Status enum: todo / doing / done / blocked. Use blocked only when stuck on an external dependency — explain in the text.',
        '',
        'The plan auto-injects into your system prompt next turn as a `<plan>` block — you don\'t need to re-read it via view; just look at the block. Use view when you need to confirm a step rewrite landed.',
    ].join('\n'),
    schema: z.object({
        action: z
            .enum(['set', 'view', 'update_step', 'clear'])
            .describe('What to do with the plan.'),
        body: z
            .string()
            .max(MAX_BODY_BYTES)
            .optional()
            .describe('For action=set: full plan markdown. For action=update_step: optional new text for that step.'),
        step_id: z
            .string()
            .regex(/^s\d+$/, 'must look like s1, s2, s12')
            .optional()
            .describe('For action=update_step: which step to modify (e.g. "s3").'),
        status: STATUS.optional().describe('For action=update_step: new status.'),
    }),
    execute: async ({ action, body, step_id, status }, ctx) => {
        const threadId = sanitizeThreadId(ctx.threadId);
        if (!threadId) return 'plan: no threadId in context — cannot persist plan.';

        if (action === 'view') {
            const existing = readPlan(threadId);
            return existing ? existing : 'no plan set for this thread';
        }

        if (action === 'clear') {
            const path = planPath(threadId);
            if (!existsSync(path)) return 'plan: nothing to clear';
            try {
                unlinkSync(path);
                return 'plan cleared';
            } catch (err) {
                return `plan: clear failed: ${err instanceof Error ? err.message : String(err)}`;
            }
        }

        if (action === 'set') {
            if (typeof body !== 'string' || body.trim().length === 0) {
                return 'plan: set requires a non-empty `body`';
            }
            const trimmed = body.trim();
            if (Buffer.byteLength(trimmed, 'utf-8') > MAX_BODY_BYTES) {
                return `plan: body too large (limit ${MAX_BODY_BYTES} bytes)`;
            }
            if (countSteps(trimmed) > MAX_STEPS) {
                return `plan: too many steps (limit ${MAX_STEPS})`;
            }
            writePlan(threadId, trimmed + '\n');
            return `plan set (${countSteps(trimmed)} step${countSteps(trimmed) === 1 ? '' : 's'})`;
        }

        if (action === 'update_step') {
            if (!step_id) return 'plan: update_step requires `step_id`';
            if (!status) return 'plan: update_step requires `status`';
            const existing = readPlan(threadId);
            if (!existing) return 'plan: no plan yet — use action=set first';
            const lines = existing.split('\n');
            let matched = false;
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i] ?? '';
                const m = line.trim().match(STEP_LINE_RE);
                if (!m) continue;
                if (m[1].toLowerCase() !== step_id.toLowerCase()) continue;
                const newText = typeof body === 'string' && body.trim().length > 0 ? body.trim() : m[3];
                lines[i] = `- [${m[1]}] [${status}] ${newText}`;
                matched = true;
                break;
            }
            if (!matched) return `plan: no step "${step_id}" found`;
            writePlan(threadId, lines.join('\n'));
            return `plan: ${step_id} → ${status}`;
        }

        return 'plan: unknown action';
    },
});

export function loadPlanForThread(threadId: string | undefined): string | null {
    const safe = sanitizeThreadId(threadId);
    if (!safe) return null;
    return readPlan(safe);
}

export function clearPlanForThread(threadId: string | undefined): boolean {
    const safe = sanitizeThreadId(threadId);
    if (!safe) return false;
    const path = planPath(safe);
    if (!existsSync(path)) return false;
    try {
        unlinkSync(path);
        return true;
    } catch {
        return false;
    }
}
