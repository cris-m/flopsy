/**
 * `flopsy heartbeat` — full CRUD over runtime heartbeats in proactive.db.
 *
 * Reads work offline (direct DB access); writes go through the gateway's
 * management HTTP endpoint so the live engine hot-registers the change without
 * a restart.
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

// Mirror of cron-command's collectSkill — local copy keeps the file
// import-side-effect free for the test runner.
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

export function registerHeartbeatCommands(root: Command): void {
    const hb = root
        .command('heartbeat')
        .alias('hb')
        .description('Manage runtime heartbeats (periodic agent pings)');

    hb.command('list')
        .description('List every heartbeat + enabled state')
        .action(() => renderList());

    hb.command('show')
        .description('Show full detail for one heartbeat')
        .argument('<id>', 'Heartbeat id (from `flopsy heartbeat list`)')
        .action((id: string) => renderOne(id));

    hb.command('add')
        .description('Create a heartbeat (fires on a fixed interval)')
        .requiredOption('--name <name>', 'Heartbeat name')
        .requiredOption('--interval <duration>', '"30s" | "5m" | "1h" | "1d"')
        .option('--prompt <text>', 'Inline prompt the agent receives')
        .option('--prompt-file <path>', 'Path to a prompt file (copied into workspace)')
        .option('--delivery-mode <mode>', 'always | conditional | silent', 'always')
        .option('--oneshot', 'Fire once then auto-disable', false)
        .option('--id <id>', 'Stable id (defaults to runtime-hb-<name>)')
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
            'Bind a skill to this heartbeat — its SKILL.md is injected on every fire. Repeatable.',
            collectSkill,
            [],
        )
        .action(async (opts) => {
            // Resolve --prompt-file to absolute against the user's CWD —
            // the daemon runs in a different cwd and would otherwise hit
            // ENOENT when it tries to copy the file into the workspace.
            let absPromptFile: string | undefined;
            let frontmatterSkills: string[] | undefined;
            if (opts.promptFile) {
                absPromptFile = resolvePath(opts.promptFile);
                if (!existsSync(absPromptFile)) {
                    console.log(bad(`prompt-file not found: ${absPromptFile}`));
                    process.exit(1);
                }
                frontmatterSkills = readPromptFrontmatter(absPromptFile).skills;
            }
            // --no-agent requires --script and forbids agent-prompt-only flags.
            if (opts.noAgent && !opts.script) {
                console.log(bad('--no-agent requires --script <path>'));
                process.exit(1);
            }
            const skills = mergeSkills(frontmatterSkills, opts.skill);
            const scheduleId: string = opts.id ?? `runtime-hb-${opts.name as string}`;
            await managementCreate({
                kind: 'heartbeat',
                id: scheduleId,
                name: opts.name,
                interval: opts.interval,
                prompt: opts.prompt,
                promptFile: absPromptFile,
                deliveryMode: opts.deliveryMode,
                oneshot: opts.oneshot,
                noAgent: !!opts.noAgent,
                script: opts.script,
                preCheckScript: opts.preCheckScript,
                ...(skills.length > 0 ? { skills } : {}),
            });
        });

    hb.command('disable')
        .description('Disable a heartbeat by id')
        .argument('<id>', 'Heartbeat id')
        .action((id: string) => void managementDisable(id));

    hb.command('enable')
        .description('Re-enable a heartbeat by id')
        .argument('<id>', 'Heartbeat id')
        .action((id: string) => void managementEnable(id));

    hb.command('remove')
        .alias('rm')
        .description('Delete a heartbeat by id')
        .argument('<id>', 'Heartbeat id')
        .action((id: string) => void managementRemove(id));

    hb.command('stats')
        .description('Runs / delivered / suppressed counters; pass id for detail')
        .argument('[id]', 'Optional heartbeat id for per-schedule detail')
        .action((id?: string) => void renderStats('heartbeat', id));

    hb.command('fires')
        .description('Recent delivery history for one heartbeat')
        .argument('<id>', 'Heartbeat id')
        .option('--limit <n>', 'Max rows (default 20, max 500)', '20')
        .action((id: string, opts: { limit?: string }) =>
            void renderFires(id, Number(opts.limit ?? 20)),
        );

    hb.command('trigger')
        .description('Force-fire a heartbeat now (bypasses interval and activeHours)')
        .argument('<id>', 'Heartbeat id')
        .action((id: string) => void managementTrigger(id));

    hb.command('tick')
        .description('Force-fire every enabled heartbeat NOW (sweep)')
        .action(() => void managementTick('heartbeat'));

    hb.command('edit')
        .description('Mutate a heartbeat: skills only for now (replace / add / remove / clear).')
        .argument('<id>', 'Heartbeat id')
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
                console.log(bad('flopsy heartbeat edit: no mutations supplied'));
                console.log(dim('  Use --skill / --add-skill / --remove-skill / --clear-skills'));
                process.exit(1);
            }
            await editSkills('heartbeat', id, {
                replace: opts.skill.length > 0 ? opts.skill : undefined,
                addSkills: opts.addSkill,
                removeSkills: opts.removeSkill,
                clearAll: opts.clearSkills,
            });
        });

    hb.command('why')
        .description(
            'Why did the last fire of this heartbeat behave the way it did? Shows result + reason + 7d suppression breakdown.',
        )
        .argument('<id>', 'Heartbeat id')
        .action((id: string) => {
            // Named `fireDetail` rather than `detail` because `detail` is
            // already imported from `../ui/pretty` as a row renderer.
            const fireDetail = loadLastFireDetail(id);
            if (!fireDetail) {
                console.log(bad(`No fire history for "${id}" yet.`));
                console.log(dim('  This heartbeat has never fired, or proactive_decisions table is empty.'));
                return;
            }
            renderLastFireDetail(id, fireDetail);
        });

    const skill = hb.command('skill').description('Manage skills bound to a heartbeat');
    skill.command('list')
        .description('Show skills bound to a heartbeat')
        .argument('<id>', 'Heartbeat id')
        .action((id: string) => void skillList('heartbeat', id));
    skill.command('add')
        .description('Bind a skill to a heartbeat (idempotent — duplicates skipped)')
        .argument('<id>', 'Heartbeat id')
        .argument('<name>', 'Skill name (must exist under .flopsy/content/skills/)')
        .action((id: string, name: string) => void skillAdd('heartbeat', id, name));
    skill.command('remove')
        .alias('rm')
        .description('Unbind a skill from a heartbeat')
        .argument('<id>', 'Heartbeat id')
        .argument('<name>', 'Skill name')
        .action((id: string, name: string) => void skillRemove('heartbeat', id, name));
    skill.command('clear')
        .description('Unbind all skills from a heartbeat')
        .argument('<id>', 'Heartbeat id')
        .action((id: string) => void skillClear('heartbeat', id));
    skill.action((_opts: unknown, cmd: { outputHelp(): void }) => cmd.outputHelp());

    hb.action((_opts: unknown, cmd: { outputHelp(): void }) => cmd.outputHelp());
}

function renderList(): void {
    renderScheduleList('heartbeat', {
        title: 'Heartbeats',
        emptyLabel: 'heartbeats',
        addHint: 'flopsy heartbeat add --help',
        middleCells: (r, cfg) => {
            const name = (cfg['name'] as string | undefined) ?? '(no name)';
            const interval = (cfg['interval'] as string | undefined) ?? '—';
            return [name, dim(interval), dim(r.id)];
        },
    });
}

function renderOne(id: string): void {
    renderScheduleShow('heartbeat', id, {
        label: 'heartbeat',
        listCmd: 'flopsy heartbeat list',
        nameOf: (_r, cfg) => (cfg['name'] as string | undefined) ?? '(no name)',
        renderDetails: (_r, cfg) => {
            if (cfg['interval']) console.log(detail('interval', String(cfg['interval'])));
            if (cfg['deliveryMode']) console.log(detail('deliveryMode', String(cfg['deliveryMode'])));
            if (cfg['oneshot']) console.log(detail('oneshot', 'yes'));
            if (cfg['promptFile']) console.log(detail('promptFile', String(cfg['promptFile'])));
            if (cfg['prompt']) console.log(detail('prompt', truncate(String(cfg['prompt']), 200)));
        },
    });
}
