// `flopsy personality` — discover + change voice overlays.
//
// Subcommands:
//   flopsy personality list                — table of name + description
//   flopsy personality show <name>         — print the full body
//   flopsy personality default <name>      — set defaultPersonality on every agent
//   flopsy personality default --clear     — remove defaultPersonality from every agent
//
// Source of truth: <HOME>/config/personalities.yaml (read-only here — edit by hand).
// Defaults are written into flopsy.json5 via the same atomic-rename pattern as
// `flopsy config set`. JSON5 comments on the file are dropped on write — same
// trade-off as the existing config writes.

import { renameSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { Command } from 'commander';
import * as yaml from 'js-yaml';
import { workspace } from '@flopsy/shared';
import { bad, dim, ok, section, table } from '../ui/pretty';
import { readFlopsyConfig } from './config-reader';

interface PersonalityEntry {
    name: string;
    description: string;
    body: string;
}

const NAME_RE = /^[a-z][a-z0-9_]*$/;

function loadFromYaml(): PersonalityEntry[] {
    const path = workspace.config('personalities.yaml');
    if (!existsSync(path)) {
        console.log(bad(`personalities.yaml not found at ${path}`));
        console.log(dim('  Run `flopsy onboard` to seed the workspace, or create the file by hand.'));
        process.exit(1);
    }
    let parsed: unknown;
    try {
        parsed = yaml.load(readFileSync(path, 'utf-8'));
    } catch (err) {
        console.log(bad(`Invalid YAML in ${path}: ${(err as Error).message}`));
        process.exit(1);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        console.log(bad(`personalities.yaml top-level must be a map`));
        process.exit(1);
    }
    const out: PersonalityEntry[] = [];
    for (const [name, entry] of Object.entries(parsed as Record<string, unknown>)) {
        if (!NAME_RE.test(name)) continue;
        if (entry === null || typeof entry !== 'object') continue;
        const e = entry as { description?: unknown; body?: unknown };
        if (typeof e.description !== 'string' || typeof e.body !== 'string') continue;
        const description = e.description.trim();
        const body = e.body.trim();
        if (!description || !body) continue;
        out.push({ name, description, body });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
}

function activeDefaults(): Map<string, string | null> {
    const { config } = readFlopsyConfig();
    const result = new Map<string, string | null>();
    const agents = (config as { agents?: ReadonlyArray<{ name?: string; defaultPersonality?: string }> }).agents ?? [];
    for (const a of agents) {
        if (typeof a.name === 'string') {
            result.set(a.name, a.defaultPersonality ?? null);
        }
    }
    return result;
}

function atomicWrite(file: string, value: unknown): void {
    const body = JSON.stringify(value, null, 2) + '\n';
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, body, 'utf-8');
    renameSync(tmp, file);
}

export function registerPersonalityCommands(root: Command): void {
    const cmd = root
        .command('personality')
        .description('List, preview, and set the default voice overlay');

    cmd.command('list', { isDefault: true })
        .description('List available personalities (name + one-line description)')
        .action(() => {
            const items = loadFromYaml();
            if (items.length === 0) {
                console.log(section('Personalities'));
                console.log(dim('  (none — personalities.yaml is empty or invalid)'));
                return;
            }
            const defaults = activeDefaults();
            const distinctDefaults = new Set(
                [...defaults.values()].filter((v): v is string => v !== null),
            );
            const rows: string[][] = [['name', 'description', 'default for']];
            for (const p of items) {
                const owners: string[] = [];
                for (const [agent, def] of defaults) {
                    if (def === p.name) owners.push(agent);
                }
                rows.push([p.name, p.description, owners.length ? owners.join(', ') : '']);
            }
            console.log(section(`Personalities (${items.length})`));
            console.log(table(rows));
            console.log();
            if (distinctDefaults.size > 1) {
                console.log(
                    dim(`  Agents have diverging defaults — use \`flopsy personality default <name>\` to align them.`),
                );
            }
            console.log(
                dim('  flopsy personality show <name>  /  default <name>  /  default --clear'),
            );
        });

    cmd.command('show')
        .description('Print the full body of a personality overlay')
        .argument('<name>', 'Personality name (e.g. concise, technical, tutor, playful, savage)')
        .action((name: string) => {
            const items = loadFromYaml();
            const match = items.find((p) => p.name === name);
            if (!match) {
                console.log(bad(`No personality named "${name}". Try \`flopsy personality list\`.`));
                process.exit(1);
            }
            console.log(section(`${match.name} — ${match.description}`));
            console.log();
            console.log(match.body);
        });

    cmd.command('default')
        .description('Set the defaultPersonality on every agent in flopsy.json5 (use --clear to remove)')
        .argument('[name]', 'Personality name to set as default')
        .option('--clear', 'Remove defaultPersonality from every agent', false)
        .action((name: string | undefined, opts: { clear?: boolean }) => {
            if (opts.clear && name) {
                console.log(bad('Pass either <name> or --clear, not both.'));
                process.exit(1);
            }
            if (!opts.clear && !name) {
                console.log(bad('Specify a personality name or pass --clear.'));
                console.log(dim('  flopsy personality default <name>  |  flopsy personality default --clear'));
                process.exit(1);
            }

            const items = loadFromYaml();
            if (name && !items.some((p) => p.name === name)) {
                console.log(bad(`No personality named "${name}".`));
                console.log(dim(`  Available: ${items.map((p) => p.name).join(', ') || '(none)'}`));
                process.exit(1);
            }

            const { path: file, config } = readFlopsyConfig();
            const agents = (config as { agents?: Array<{ name?: string; defaultPersonality?: string }> }).agents;
            if (!Array.isArray(agents) || agents.length === 0) {
                console.log(bad('No agents defined in flopsy.json5 — nothing to update.'));
                process.exit(1);
            }

            const changes: Array<{ agent: string; before: string | null; after: string | null }> = [];
            for (const agent of agents) {
                if (typeof agent.name !== 'string') continue;
                const before = agent.defaultPersonality ?? null;
                if (opts.clear) {
                    if (before !== null) {
                        delete agent.defaultPersonality;
                        changes.push({ agent: agent.name, before, after: null });
                    }
                } else if (name) {
                    if (before !== name) {
                        agent.defaultPersonality = name;
                        changes.push({ agent: agent.name, before, after: name });
                    }
                }
            }

            if (changes.length === 0) {
                console.log(ok(opts.clear ? 'No agent had a defaultPersonality set — nothing to do.' : `Every agent already had defaultPersonality = ${name}.`));
                return;
            }

            atomicWrite(file, config);
            const verb = opts.clear ? 'cleared' : `set defaultPersonality = ${name}`;
            console.log(ok(`${verb} for ${changes.length} agent${changes.length === 1 ? '' : 's'}`));
            for (const c of changes) {
                const from = c.before ?? '(unset)';
                const to = c.after ?? '(unset)';
                console.log(dim(`  ${c.agent}:  ${from} → ${to}`));
            }
            console.log(dim(`wrote ${file}`));
            console.log(dim('  Restart the gateway for the change to take effect on new sessions.'));
        });
}
