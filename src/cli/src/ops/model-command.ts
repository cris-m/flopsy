/**
 * `flopsy model ...` — list and switch the LLM model used per agent.
 *
 * Backed by flopsy.json5 `agents[].model`. This is a thin convenience
 * wrapper over `flopsy config set agents.<i>.model <value>` so users
 * don't have to know the array index or the dotted-path syntax.
 *
 *   flopsy model                      — list every agent + current model
 *   flopsy model list                 — same
 *   flopsy model use <agent> <model>  — switch one agent to a new model
 *
 * `<model>` is whatever FlopsyBot's provider resolver accepts, e.g.
 *   ollama:glm-4.6:cloud
 *   ollama:qwen3-coder:480b-cloud
 *   anthropic:claude-sonnet-4
 */

import { renameSync, writeFileSync } from 'node:fs';
import { Command } from 'commander';
import { bad, dim, ok, section, table } from '../ui/pretty';
import { tint } from '../ui/theme';
import { readFlopsyConfig } from './config-reader';

export function registerModelCommand(root: Command): void {
    const model = root
        .command('model')
        .description('List or switch the LLM model per agent');

    model.command('list')
        .description('Show every agent with its configured model')
        .action(() => renderList());

    model.command('use')
        .description('Set the model for one agent')
        .argument('<agent>', 'Agent name (see `flopsy team`)')
        .argument('<model>', 'Model id, e.g. ollama:glm-4.6:cloud')
        .action((agentName: string, modelId: string) => {
            const { path: file, config } = readFlopsyConfig();
            const agents = (config.agents ?? []) as Array<{ name: string; model?: string }>;
            const idx = agents.findIndex((a) => a.name === agentName);
            if (idx < 0) {
                console.log(bad(`No agent named "${agentName}" in flopsy.json5`));
                console.log(dim('Run `flopsy team list` to see configured agents.'));
                process.exit(1);
            }
            agents[idx].model = modelId;
            atomicWriteJson(file, config);
            console.log(ok(`${agentName} → ${modelId}`));
            console.log(dim(`wrote ${file}`));
        });

    // Default: `flopsy model` with no subcommand → list
    model.action(() => renderList());
}

/** Extended agent shape — reads optional provider-tier fields that aren't
 *  in the canonical RawAgent type (fallback, fast, budget, temperature, …).
 *  We read them loosely because the schema evolves faster than the Zod
 *  definition and `flopsy model list` should surface whatever is set. */
interface ModelAgentView {
    readonly name: string;
    readonly enabled?: boolean;
    readonly role?: string;
    readonly type?: string;
    readonly model?: string;
    readonly fallback?: string;
    readonly fast?: string;
    readonly budget?: string | number;
    readonly temperature?: number;
}

function renderList(): void {
    const { config } = readFlopsyConfig();
    const agents = (config.agents ?? []) as ReadonlyArray<ModelAgentView>;
    console.log(section('Models'));
    if (agents.length === 0) {
        console.log(dim('  no agents configured'));
        return;
    }

    // Header row when ANY agent has extra tiers, so columns are self-describing.
    const anyFallback = agents.some((a) => a.fallback);
    const anyFast = agents.some((a) => a.fast);
    const anyBudget = agents.some((a) => a.budget !== undefined);

    const rows: string[][] = agents.map((a) => {
        const enabled = a.enabled !== false;
        const dot = enabled ? tint.team('●') : dim('○');
        const name = enabled ? a.name : dim(a.name);
        const role = a.role ?? a.type ?? dim('(no role)');
        const primary = a.model ? dim(a.model) : dim('(inherits default)');
        const cells: string[] = [dot, name, role, primary];
        if (anyFallback) cells.push(a.fallback ? dim('↳ ' + a.fallback) : dim('·'));
        if (anyFast) cells.push(a.fast ? dim('⚡ ' + a.fast) : dim('·'));
        if (anyBudget) cells.push(a.budget !== undefined ? dim('budget=' + a.budget) : dim('·'));
        return cells;
    });
    console.log(table(rows));

    // Legend — only when any tier appeared, so simple configs stay clean.
    if (anyFallback || anyFast || anyBudget) {
        console.log('');
        const legend: string[] = [];
        if (anyFallback) legend.push(`${dim('↳')} fallback`);
        if (anyFast) legend.push(`${dim('⚡')} fast tier`);
        if (anyBudget) legend.push(`${dim('budget=')} per-turn token cap`);
        console.log('  ' + legend.join('   '));
    }
}

function atomicWriteJson(file: string, value: unknown): void {
    const body = JSON.stringify(value, null, 2) + '\n';
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, body, 'utf-8');
    renameSync(tmp, file);
}
