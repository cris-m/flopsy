import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SKILLS_DIR = join(__dirname, '..', '..', 'src', 'team', 'templates', 'skills');

interface SkillFile {
    name: string;
    path: string;
    body: string;
}

function loadSkills(): readonly SkillFile[] {
    return readdirSync(SKILLS_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => {
            const path = join(SKILLS_DIR, d.name, 'SKILL.md');
            return { name: d.name, path, body: tryRead(path) };
        })
        .filter((s): s is SkillFile => s.body !== null);
}

function tryRead(p: string): string | null {
    try { return readFileSync(p, 'utf-8'); } catch { return null; }
}

/** Strip ``` fenced code blocks and inline `code` spans before scanning prose.
 *  Frontmatter and prose are scanned; code-block contents are excluded so the
 *  patterns can still be referenced when explaining what NOT to use. */
function stripCodeBlocks(body: string): string {
    return body
        .replace(/```[\s\S]*?```/g, '')
        .replace(/`[^`\n]*`/g, '');
}

/** Patterns that should never appear in skill prose. Each is a non-existent
 *  tool name imported from a different framework or a renamed-and-removed
 *  flopsybot tool. */
const DEAD_PATTERNS: ReadonlyArray<{ name: string; re: RegExp; reason: string }> = [
    {
        name: 'task("swarm")',
        re: /\btask\s*\(\s*["']swarm["']/,
        reason: 'no `task()` tool — use `delegate_task({ worker, task })`',
    },
    {
        name: 'subagent_type',
        re: /\bsubagent_type\s*[:=]/,
        reason: 'no `subagent_type` arg — use `worker` on `delegate_task`',
    },
    {
        name: 'schedule_bot_message',
        re: /\bschedule_bot_message\b/,
        reason: 'no such tool — use `manage_schedule({ operation: "create", ... })`',
    },
    {
        name: 'list_bot_scheduled_jobs',
        re: /\blist_bot_scheduled_jobs\b/,
        reason: 'no such tool — use `manage_schedule({ operation: "list" })`',
    },
    {
        name: 'disable_bot_scheduled_job',
        re: /\bdisable_bot_scheduled_job\b/,
        reason: 'no such tool — use `manage_schedule({ operation: "disable", id })`',
    },
    {
        name: 'enable_bot_scheduled_job',
        re: /\benable_bot_scheduled_job\b/,
        reason: 'no such tool — use `manage_schedule({ operation: "enable", id })`',
    },
    {
        name: 'delete_bot_scheduled_job',
        re: /\bdelete_bot_scheduled_job\b/,
        reason: 'no such tool — use `manage_schedule({ operation: "delete", id })`',
    },
    {
        name: 'list_heartbeats',
        re: /\blist_heartbeats\s*\(/,
        reason: 'no such tool — use `manage_schedule({ operation: "list" })`',
    },
    {
        name: 'trigger_heartbeat',
        re: /\btrigger_heartbeat\b/,
        reason: 'no such tool — use mgmt API or `flopsy heartbeat trigger`',
    },
    {
        name: 'arxiv_search',
        re: /\barxiv_search\b/,
        reason: 'one tool `arxiv` with operation arg — three names removed',
    },
    {
        name: 'arxiv_get',
        re: /\barxiv_get\b/,
        reason: 'one tool `arxiv` with operation arg',
    },
    {
        name: 'arxiv_list',
        re: /\barxiv_list\b/,
        reason: 'one tool `arxiv` with operation arg',
    },
];

/** When skills do show a code example, these patterns flag wrong arg shapes. */
const CODE_BLOCK_PATTERNS: ReadonlyArray<{ name: string; re: RegExp; reason: string }> = [
    {
        name: 'send_message channel/peer args',
        re: /send_message\s*\(\s*\{[^}]*\bchannel\s*:\s*["']/,
        reason: 'channel/peer come from runtime context — not args to send_message',
    },
    {
        name: 'send_poll channel/peer args',
        re: /send_poll\s*\(\s*\{[^}]*\bchannel\s*:\s*["']/,
        reason: 'channel/peer come from runtime context — not args to send_poll',
    },
    {
        name: 'send_message components shape',
        re: /send_message\s*\(\s*\{[^}]*\bcomponents\s*:\s*\[/,
        reason: 'use top-level `buttons` array, not nested `components`',
    },
];

describe('shipped skills do not reference dead tool names in prose', () => {
    const skills = loadSkills();

    it('finds at least 50 skills in the shipped catalog', () => {
        expect(skills.length).toBeGreaterThan(50);
    });

    for (const { name, body, path } of skills) {
        const prose = stripCodeBlocks(body);
        for (const pattern of DEAD_PATTERNS) {
            it(`${name}: no ${pattern.name}`, () => {
                if (pattern.re.test(prose)) {
                    throw new Error(
                        `${path}: matches dead pattern "${pattern.name}" — ${pattern.reason}`,
                    );
                }
            });
        }
    }
});

describe('shipped skills use correct tool-call shapes in code blocks', () => {
    const skills = loadSkills();

    for (const { name, body, path } of skills) {
        for (const pattern of CODE_BLOCK_PATTERNS) {
            it(`${name}: ${pattern.name} not present`, () => {
                if (pattern.re.test(body)) {
                    throw new Error(
                        `${path}: matches wrong arg shape "${pattern.name}" — ${pattern.reason}`,
                    );
                }
            });
        }
    }
});
