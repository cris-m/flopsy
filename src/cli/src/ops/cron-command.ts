/**
 * `flopsy cron` — full CRUD over runtime cron jobs in proactive.db.
 *
 * Same data model as heartbeats: stored in `~/.flopsy/state/proactive.db`,
 * writes go through the gateway's management HTTP endpoint. Three flavours of
 * schedule: `--at <epoch-ms>` (fires once), `--every <ms>` (fixed interval),
 * or `--cron "<expr>" --tz <IANA>` (5-field cron expression).
 */

import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { Command } from 'commander';
import { truncate } from '@flopsy/shared';
import { bad, detail, dim } from '../ui/pretty';
import { mergeSkills, readPromptFrontmatter } from './prompt-frontmatter';
import {
    managementCreate,
    managementDisable,
    managementEnable,
    managementRemove,
    managementTick,
    managementTrigger,
} from './schedule-client';
import { editSkills, skillAdd, skillClear, skillList, skillRemove } from './skill-edit-ops';

// Commander's `--option <val>` repeatable pattern: every occurrence calls the
// collector with (newValue, accumulator). The default empty array seeds the
// accumulator so a single occurrence still works.
function collectSkill(value: string, previous: string[]): string[] {
    const trimmed = value.trim();
    if (!trimmed) return previous;
    return previous.includes(trimmed) ? previous : [...previous, trimmed];
}
import {
    loadLastFireDetail,
    renderFires,
    renderLastFireDetail,
    renderScheduleList,
    renderScheduleShow,
    renderStats,
} from './schedule-stats-render';

export function registerCronCommands(root: Command): void {
    const cron = root.command('cron').description('Manage runtime cron jobs');

    cron.command('list')
        .description('List every cron job + enabled state')
        .action(() => renderList());

    cron.command('show')
        .description('Show full detail for one cron job')
        .argument('<id>', 'Cron job id')
        .action((id: string) => renderOne(id));

    cron.command('add')
        .description('Create a cron job (at | every | cron expression)')
        .option('--id <id>', 'Stable id (defaults to runtime-cron-<ts>-<rand>)')
        .option('--name <name>', 'Human-readable label')
        .option('--at <epoch-ms>', 'Fire ONCE at absolute epoch ms')
        .option('--every <ms>', 'Fire every N ms (min 60000)')
        .option('--cron <expr>', '5-field cron expression (e.g. "0 9 * * MON")')
        .option('--tz <tz>', 'IANA timezone for cron expressions')
        .option('--message <text>', 'Inline prompt the agent receives')
        .option('--prompt-file <path>', 'Path to a prompt file (copied into workspace)')
        .option('--delivery-mode <mode>', 'always | conditional | silent', 'always')
        .option('--oneshot', 'Fire once then auto-disable', false)
        .option('--thread-id <id>', 'Reuse a thread for agent memory across fires')
        .option(
            '--no-agent',
            'Skip the LLM entirely — run --script and deliver its stdout. Use --script with this.',
            false,
        )
        .option(
            '--script <path>',
            'Path under <FLOPSY_HOME>/scripts/. For --no-agent fires the stdout becomes the delivered message.',
        )
        .option(
            '--pre-check-script <path>',
            'Path under <FLOPSY_HOME>/scripts/. Runs before the agent; can output {"wakeAgent": false} to suppress the fire.',
        )
        .option(
            '--skill <name>',
            'Bind a skill to this cron — its SKILL.md is injected on every fire. Repeatable.',
            collectSkill,
            [],
        )
        .action(async (opts) => {
            const schedule = buildCronSchedule(opts);
            if (typeof schedule === 'string') {
                console.log(bad(schedule));
                process.exit(1);
            }
            if (opts.noAgent && !opts.script) {
                console.log(bad('--no-agent requires --script <path>'));
                process.exit(1);
            }
            // Resolve --prompt-file to absolute against the user's CWD before
            // sending to the daemon. The daemon runs in its own cwd (workspace
            // root) so a relative path like `./prompts/...` would otherwise be
            // resolved server-side against the WRONG directory and ENOENT.
            // We also fail-fast here with a friendly message if the file is
            // missing — better UX than the daemon's bare copyfile ENOENT.
            let absPromptFile: string | undefined;
            let frontmatterSkills: string[] | undefined;
            if (opts.promptFile) {
                absPromptFile = resolvePath(opts.promptFile);
                if (!existsSync(absPromptFile)) {
                    console.log(bad(`prompt-file not found: ${absPromptFile}`));
                    process.exit(1);
                }
                // Read `skills:` from the file's YAML header so the user can
                // declare intrinsic skills in the prompt itself (matching the
                // pattern used by .flopsy/content/prompts/*/*.md frontmatter).
                // Any --skill flags are merged on top — file-declared skills
                // run first, CLI flags add to the union.
                frontmatterSkills = readPromptFrontmatter(absPromptFile).skills;
            }
            const skills = mergeSkills(frontmatterSkills, opts.skill);
            const scheduleId: string =
                opts.id ??
                `runtime-cron-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            await managementCreate({
                kind: 'cron',
                id: scheduleId,
                name: opts.name,
                schedule,
                message: opts.message,
                promptFile: absPromptFile,
                deliveryMode: opts.deliveryMode,
                oneshot: opts.oneshot,
                threadId: opts.threadId,
                noAgent: !!opts.noAgent,
                script: opts.script,
                preCheckScript: opts.preCheckScript,
                ...(skills.length > 0 ? { skills } : {}),
            });
        });

    cron.command('disable')
        .description('Disable a cron job by id')
        .argument('<id>', 'Cron job id')
        .action((id: string) => void managementDisable(id));

    cron.command('enable')
        .description('Re-enable a cron job by id')
        .argument('<id>', 'Cron job id')
        .action((id: string) => void managementEnable(id));

    cron.command('remove')
        .alias('rm')
        .description('Delete a cron job by id')
        .argument('<id>', 'Cron job id')
        .action((id: string) => void managementRemove(id));

    cron.command('stats')
        .description('Runs / delivered / suppressed counters; pass id for detail')
        .argument('[id]', 'Optional cron id for per-schedule detail')
        .action((id?: string) => void renderStats('cron', id));

    cron.command('fires')
        .description('Recent delivery history for one cron job')
        .argument('<id>', 'Cron job id')
        .option('--limit <n>', 'Max rows (default 20, max 500)', '20')
        .action((id: string, opts: { limit?: string }) =>
            void renderFires(id, Number(opts.limit ?? 20)),
        );

    cron.command('trigger')
        .description('Force-fire a cron job now (bypasses schedule)')
        .argument('<id>', 'Cron job id')
        .action((id: string) => void managementTrigger(id));

    cron.command('tick')
        .description('Force-fire every enabled cron job NOW (sweep)')
        .action(() => void managementTick('cron'));

    cron.command('edit')
        .description('Mutate a cron job: skills only for now (replace / add / remove / clear).')
        .argument('<id>', 'Cron job id')
        .option('--skill <name>', 'Replace skills with this list (repeatable)', collectSkill, [])
        .option('--add-skill <name>', 'Append a skill (repeatable, idempotent)', collectSkill, [])
        .option('--remove-skill <name>', 'Drop a skill (repeatable)', collectSkill, [])
        .option('--clear-skills', 'Reset skills to empty before --add', false)
        .action(async (id: string, opts: {
            skill: string[];
            addSkill: string[];
            removeSkill: string[];
            clearSkills: boolean;
        }) => {
            const noOps =
                opts.skill.length === 0 &&
                opts.addSkill.length === 0 &&
                opts.removeSkill.length === 0 &&
                !opts.clearSkills;
            if (noOps) {
                console.log(bad('flopsy cron edit: no mutations supplied'));
                console.log(dim('  Use --skill / --add-skill / --remove-skill / --clear-skills'));
                process.exit(1);
            }
            await editSkills('cron', id, {
                replace: opts.skill.length > 0 ? opts.skill : undefined,
                addSkills: opts.addSkill,
                removeSkills: opts.removeSkill,
                clearAll: opts.clearSkills,
            });
        });

    cron.command('why')
        .description(
            'Why did the last fire of this cron job behave the way it did? Shows result + reason + 7d suppression breakdown.',
        )
        .argument('<id>', 'Cron job id')
        .action((id: string) => {
            // Named `fireDetail` rather than `detail` because `detail` is
            // already imported from `../ui/pretty` as a row renderer.
            const fireDetail = loadLastFireDetail(id);
            if (!fireDetail) {
                console.log(bad(`No fire history for "${id}" yet.`));
                console.log(dim('  This cron has never fired, or proactive_decisions table is empty.'));
                return;
            }
            renderLastFireDetail(id, fireDetail);
        });

    const skill = cron.command('skill').description('Manage skills bound to a cron job');
    skill.command('list')
        .description('Show skills bound to a cron job')
        .argument('<id>', 'Cron job id')
        .action((id: string) => void skillList('cron', id));
    skill.command('add')
        .description('Bind a skill to a cron job (idempotent — duplicates skipped)')
        .argument('<id>', 'Cron job id')
        .argument('<name>', 'Skill name (must exist under .flopsy/content/skills/)')
        .action((id: string, name: string) => void skillAdd('cron', id, name));
    skill.command('remove')
        .alias('rm')
        .description('Unbind a skill from a cron job')
        .argument('<id>', 'Cron job id')
        .argument('<name>', 'Skill name')
        .action((id: string, name: string) => void skillRemove('cron', id, name));
    skill.command('clear')
        .description('Unbind all skills from a cron job')
        .argument('<id>', 'Cron job id')
        .action((id: string) => void skillClear('cron', id));
    skill.action((_opts: unknown, cmd: { outputHelp(): void }) => cmd.outputHelp());

    cron.action((_opts: unknown, cmd: { outputHelp(): void }) => cmd.outputHelp());
}

function renderList(): void {
    renderScheduleList('cron', {
        title: 'Cron jobs',
        emptyLabel: 'cron',
        addHint: 'flopsy cron add --help',
        middleCells: (r, cfg) => {
            const name = (cfg['name'] as string | undefined) ?? r.id;
            return [name, dim(describeSchedule(cfg)), dim(r.id)];
        },
    });
}

function renderOne(id: string): void {
    renderScheduleShow('cron', id, {
        label: 'cron job',
        listCmd: 'flopsy cron list',
        nameOf: (r, cfg) => (cfg['name'] as string | undefined) ?? r.id,
        renderDetails: (_r, cfg) => {
            console.log(detail('schedule', describeSchedule(cfg)));
            const payload = (cfg['payload'] ?? {}) as Record<string, unknown>;
            if (payload['deliveryMode'])
                console.log(detail('deliveryMode', String(payload['deliveryMode'])));
            if (payload['oneshot']) console.log(detail('oneshot', 'yes'));
            if (payload['promptFile'])
                console.log(detail('promptFile', String(payload['promptFile'])));
            if (typeof payload['message'] === 'string')
                console.log(detail('message', truncate(payload['message'] as string, 200)));
            if (payload['threadId']) console.log(detail('threadId', String(payload['threadId'])));
        },
    });
}

function describeSchedule(cfg: Record<string, unknown>): string {
    const s = cfg['schedule'] as
        | { kind?: string; expr?: string; tz?: string; everyMs?: number; atMs?: number }
        | undefined;
    if (!s) return '(no schedule)';
    if (s.kind === 'at' && s.atMs) return `at ${new Date(s.atMs).toISOString()}`;
    if (s.kind === 'every' && s.everyMs) return `every ${s.everyMs}ms`;
    if (s.kind === 'cron' && s.expr) return `cron "${s.expr}"${s.tz ? ` (${s.tz})` : ''}`;
    return '(unknown schedule kind)';
}

function buildCronSchedule(opts: {
    at?: string;
    every?: string;
    cron?: string;
    tz?: string;
}):
    | { kind: 'at'; atMs: number }
    | { kind: 'every'; everyMs: number }
    | { kind: 'cron'; expr: string; tz?: string }
    | string {
    const set = [opts.at, opts.every, opts.cron].filter(Boolean).length;
    if (set === 0) return 'Specify one of --at | --every | --cron';
    if (set > 1) return 'Specify exactly one of --at | --every | --cron';
    if (opts.at !== undefined) {
        const atMs = Number(opts.at);
        if (!Number.isFinite(atMs)) return '--at must be an epoch millisecond number';
        if (atMs <= Date.now()) return '--at must be in the future';
        return { kind: 'at', atMs };
    }
    if (opts.every !== undefined) {
        const everyMs = Number(opts.every);
        if (!Number.isFinite(everyMs) || everyMs < 60_000)
            return '--every must be >= 60000 (60 seconds)';
        return { kind: 'every', everyMs };
    }
    if (opts.cron !== undefined) {
        return { kind: 'cron', expr: opts.cron, ...(opts.tz ? { tz: opts.tz } : {}) };
    }
    return 'Unreachable';
}
