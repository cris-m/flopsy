/**
 * `flopsy doctor` — pre-flight health scan.
 *
 * Ten checks that cover ~95% of "why isn't this working" support loops.
 * Each check is independent and reports one of:
 *   ✔ ok      — everything fine
 *   ✖ fail    — blocking problem; gateway WILL NOT start or will misbehave
 *   ⚠ warn    — non-blocking but worth fixing
 *   ℹ info    — informational (e.g. "1247 messages indexed")
 *
 * Exit code = count of failures, so scripts can gate on `flopsy doctor`.
 */

import { accessSync, constants, statSync } from 'node:fs';
import { Command } from 'commander';
import { loadCredential, listCredentialProviders } from '../auth/credential-store';
import { workspace } from '@flopsy/shared';
import chalk from 'chalk';
import { bad, dim, info, ok, warn } from '../ui/pretty';
import { readFlopsyConfig } from './config-reader';
import { probeGatewayState } from './gateway-state';

interface CheckResult {
    readonly name: string;
    readonly status: 'ok' | 'fail' | 'warn' | 'info';
    readonly message: string;
    /** Optional list of sub-items (e.g. missing env var names). Rendered
     *  as `·`-bullets indented under the check row. */
    readonly details?: readonly string[];
    /** Optional actionable fix hint. */
    readonly fix?: string;
}

export function registerDoctorCommand(root: Command): void {
    root.command('doctor')
        .description('Run pre-flight health checks on config, env, auth, and state')
        .option('--json', 'Emit structured JSON instead of pretty output')
        .action(async (opts: { json?: boolean }) => {
            const results = await runAllChecks();
            if (opts.json) {
                console.log(JSON.stringify(results, null, 2));
            } else {
                render(results);
            }
            const failures = results.filter((r) => r.status === 'fail').length;
            process.exit(failures > 0 ? 1 : 0);
        });
}

async function runAllChecks(): Promise<CheckResult[]> {
    const results: CheckResult[] = [];
    results.push(checkNodeVersion());

    let config: ReturnType<typeof readFlopsyConfig> | null = null;
    try {
        config = readFlopsyConfig();
        results.push({ name: 'flopsy.json5', status: 'ok', message: `parses (${config.path})` });
    } catch (err) {
        results.push({
            name: 'flopsy.json5',
            status: 'fail',
            message: err instanceof Error ? err.message : String(err),
            fix: 'Fix JSON5 syntax errors or set FLOPSY_CONFIG to an explicit path',
        });
        return results;
    }

    results.push(checkMainAgent(config.config));
    results.push(...checkAgentModels(config.config));
    results.push(...checkEnvPlaceholders(config.config));
    results.push(await checkOllama(config.config));
    results.push(...checkAuthCredentials());
    results.push(await checkGateway(config.config));
    results.push(...checkMcpServers(config.config));
    results.push(...checkStateDirs());
    return results;
}

function checkNodeVersion(): CheckResult {
    const [major] = process.versions.node.split('.').map(Number);
    if (major >= 22) {
        return { name: 'node', status: 'ok', message: `v${process.versions.node}` };
    }
    return {
        name: 'node',
        status: 'fail',
        message: `v${process.versions.node} — need >= v22`,
        fix: 'Install Node 22+ (e.g. `nvm install 22`)',
    };
}

function checkMainAgent(cfg: { agents?: ReadonlyArray<{ name: string; role?: string; type?: string; enabled?: boolean }> }): CheckResult {
    const agents = cfg.agents ?? [];
    const mains = agents.filter(
        (a) => (a.role === 'main' || a.type === 'main') && a.enabled !== false,
    );
    if (mains.length === 0) {
        return {
            name: 'main agent',
            status: 'fail',
            message: 'no enabled agent with role=main',
            fix: 'Enable or add a `role: "main"` agent in `agents[]`',
        };
    }
    if (mains.length > 1) {
        return {
            name: 'main agent',
            status: 'fail',
            message: `${mains.length} main agents (${mains.map((a) => a.name).join(', ')}) — exactly one required`,
            fix: 'Disable all but one by setting `enabled: false`',
        };
    }
    return { name: 'main agent', status: 'ok', message: mains[0].name };
}

/**
 * Every enabled agent must have either a primary `model` field or a routing-tier
 * fallback — otherwise the gateway boots but the agent crashes at first turn
 * with an opaque ModelLoader error. The bootstrap also throws on this; doctor
 * catches it BEFORE you try `npm start`, with a more directed message.
 */
function checkAgentModels(cfg: {
    agents?: ReadonlyArray<{
        name: string;
        enabled?: boolean;
        model?: string;
        routing?: { tiers?: { fast?: { name?: string }; balanced?: { name?: string }; powerful?: { name?: string } } };
        promptPath?: string;
    }>;
}): CheckResult[] {
    const enabled = (cfg.agents ?? []).filter((a) => a.enabled !== false);
    const missingModel: string[] = [];
    for (const a of enabled) {
        const hasModel = !!a.model;
        const hasRouting =
            !!a.routing?.tiers?.fast?.name ||
            !!a.routing?.tiers?.balanced?.name ||
            !!a.routing?.tiers?.powerful?.name;
        if (!hasModel && !hasRouting) missingModel.push(a.name);
    }
    if (missingModel.length === 0) {
        return [{ name: 'agent models', status: 'ok', message: `${enabled.length} enabled agent${enabled.length === 1 ? '' : 's'} have a model or routing fallback` }];
    }
    return [
        {
            name: 'agent models',
            status: 'fail',
            message: `${missingModel.length} enabled agent${missingModel.length === 1 ? '' : 's'} missing both \`model\` and routing fallback`,
            details: missingModel,
            fix: 'Add `model: "provider:name"` to each, or set `enabled: false`',
        },
    ];
}

function checkEnvPlaceholders(cfg: Record<string, unknown>): CheckResult[] {
    // Walk the config looking for `${VAR}` strings and collect any that
    // aren't satisfied by process.env. Placeholders with `:-default` are
    // OK (the default will resolve).
    const missing: string[] = [];
    const walk = (obj: unknown): void => {
        if (typeof obj === 'string') {
            const matches = obj.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g);
            for (const m of matches) {
                const varName = m[1];
                const hasDefault = m[0].includes(':-');
                if (!process.env[varName] && !hasDefault) {
                    missing.push(varName);
                }
            }
        } else if (Array.isArray(obj)) {
            obj.forEach(walk);
        } else if (obj && typeof obj === 'object') {
            Object.values(obj).forEach(walk);
        }
    };
    walk(cfg);

    const unique = [...new Set(missing)].sort();
    if (unique.length === 0) {
        return [{ name: 'env placeholders', status: 'ok', message: 'all resolved' }];
    }
    return [
        {
            name: 'env placeholders',
            status: 'fail',
            message: `${unique.length} unset`,
            details: unique,
            fix: 'Set in `.env` at the repo root, or adjust config to use defaults',
        },
    ];
}

async function checkOllama(cfg: { memory?: { enabled?: boolean; embedder?: { provider?: string; baseUrl?: string } } }): Promise<CheckResult> {
    // Ollama only matters when memory has an embedder configured. A
    // memory-disabled or embedder-less deploy (keyword-only memory) doesn't
    // need it, so probing localhost and blocking-failing on a healthy system
    // was a false negative. Treat unreachable as a non-blocking warn — the
    // gateway still starts; only embeddings are unavailable.
    if (cfg.memory?.enabled === false) {
        return { name: 'ollama', status: 'info', message: 'memory disabled — embedder check skipped' };
    }
    const embedder = cfg.memory?.embedder;
    if (!embedder) {
        return { name: 'ollama', status: 'info', message: 'no embedder configured (keyword-only memory)' };
    }
    const baseUrl = embedder.baseUrl ?? 'http://localhost:11434';
    try {
        const res = await fetch(`${baseUrl}/api/tags`, {
            signal: AbortSignal.timeout(2000),
        });
        if (!res.ok) {
            return {
                name: 'ollama',
                status: 'warn',
                message: `reachable but returned ${res.status}`,
                fix: `Check Ollama logs; try \`curl ${baseUrl}/api/tags\``,
            };
        }
        return { name: 'ollama', status: 'ok', message: baseUrl };
    } catch {
        return {
            name: 'ollama',
            status: 'warn',
            message: `unreachable at ${baseUrl} — embeddings unavailable (memory still works as keyword-only)`,
            fix: 'Start Ollama: `ollama serve` (or `brew services start ollama`)',
        };
    }
}

function checkAuthCredentials(): CheckResult[] {
    const providers = listCredentialProviders();
    if (providers.length === 0) {
        return [
            {
                name: 'auth',
                status: 'info',
                message: 'no credentials stored',
                fix: 'Run `flopsy auth <provider>` to connect (optional)',
            },
        ];
    }
    return providers.map((p) => {
        const cred = loadCredential(p);
        if (!cred) return { name: `auth: ${p}`, status: 'warn', message: 'file unreadable' };
        const remainingMs = cred.expiresAt - Date.now();
        if (remainingMs < 0) {
            return {
                name: `auth: ${p}`,
                status: 'fail',
                message: `expired${cred.email ? ` (${cred.email})` : ''}`,
                fix: `Run \`flopsy auth ${p}\` to re-authorize`,
            };
        }
        const mins = Math.round(remainingMs / 60_000);
        if (mins < 30) {
            return {
                name: `auth: ${p}`,
                status: 'warn',
                message: `${cred.email ?? p} · expires in ${mins}m`,
                fix: `Run \`flopsy auth refresh ${p}\``,
            };
        }
        return {
            name: `auth: ${p}`,
            status: 'ok',
            message: `${cred.email ?? p} · ${mins}m left`,
        };
    });
}

async function checkGateway(cfg: { gateway?: { port?: number } }): Promise<CheckResult> {
    const port = cfg.gateway?.port ?? 18789;
    const state = await probeGatewayState(port);
    if (state.running) {
        return {
            name: 'gateway',
            status: 'ok',
            message: `running · pid ${state.pid} · up ${state.uptime?.trim() ?? '?'}`,
        };
    }
    return {
        name: 'gateway',
        status: 'info',
        message: `not running on :${port}`,
        fix: 'Run `flopsy run start` to start the daemon',
    };
}

function checkMcpServers(cfg: {
    mcp?: { servers?: Record<string, { enabled?: boolean; requires?: readonly string[]; requiresAuth?: readonly string[] }> };
}): CheckResult[] {
    const servers = cfg.mcp?.servers ?? {};
    const results: CheckResult[] = [];
    for (const [name, entry] of Object.entries(servers)) {
        if (entry?.enabled === false) continue;
        const missingEnv = (entry?.requires ?? []).filter((v) => !process.env[v]);
        const missingAuth = (entry?.requiresAuth ?? []).filter(
            (p) => !listCredentialProviders().includes(p),
        );
        if (missingEnv.length > 0) {
            results.push({
                name: `mcp: ${name}`,
                status: 'fail',
                message: `missing env: ${missingEnv.join(', ')}`,
                fix: `Set the env vars or disable the server: \`flopsy mcp disable ${name}\``,
            });
        } else if (missingAuth.length > 0) {
            results.push({
                name: `mcp: ${name}`,
                status: 'fail',
                message: `missing auth: ${missingAuth.join(', ')}`,
                fix: `Run \`flopsy auth ${missingAuth[0]}\``,
            });
        } else {
            results.push({ name: `mcp: ${name}`, status: 'ok', message: 'ready to spawn' });
        }
    }
    if (results.length === 0) {
        results.push({ name: 'mcp', status: 'info', message: 'no servers configured' });
    }
    return results;
}

function checkStateDirs(): CheckResult[] {
    // Single source of truth: the shared `workspace.*` accessors.
    // FLOPSY_HOME pre-resolution happens upstream in the config-reader
    // (right after dotenv load), so by the time we get here the
    // workspace helpers produce the same absolute paths the gateway
    // sees at boot — regardless of where the user ran `flopsy` from.
    const home = workspace.root();
    const state = workspace.state();
    const auth = workspace.auth();
    const results: CheckResult[] = [];
    for (const [label, path] of [
        ['.flopsy/',       home],
        ['.flopsy/state/', state],
        ['.flopsy/auth/',  auth],
    ] as const) {
        try {
            const s = statSync(path);
            if (!s.isDirectory()) throw new Error('not a directory');
            accessSync(path, constants.W_OK);
            results.push({ name: label, status: 'ok', message: 'writable' });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const status = /ENOENT/.test(message) ? 'info' : 'fail';
            results.push({
                name: label,
                status,
                message: status === 'info' ? 'does not exist yet (will be created on first run)' : message,
                fix: status === 'fail' ? 'Check directory permissions' : undefined,
            });
        }
    }
    return results;
}

/**
 * Sectioned layout — bold section headers, └-tree sub-items, conditional
 * "issues to fix" block at the top so problems are visible without scrolling.
 *
 *     ⚠ 2 issues need attention
 *     ✖ env placeholders — 5 unset
 *       └ fix: Set in `.env` or adjust config to use defaults
 *     ⚠ auth: gmail — expires in 12m
 *       └ fix: flopsy auth refresh gmail
 *     ─────────────────────────────────────────────
 *
 *     Runtime
 *     │  ● node    v25.9.0
 *     │  ● ollama  http://localhost:11434
 *
 *     Config
 *     │  ● flopsy.json5     parses (/…/flopsy.json5)
 *     │  ● main agent       gandalf
 *     │  ● env placeholders 5 unset
 *     │    └ GOOGLE_CHAT_VERIFICATION_TOKEN
 *     │    └ SLACK_APP_TOKEN
 *     │    └ fix: Set in `.env` at the repo root
 *
 *     ─────────────────────────────────────────────
 *     ● 23 ok · ● 7 failing
 */
function render(results: readonly CheckResult[]): void {
    const termWidth = process.stdout.columns ?? 80;
    const rule = dim('─'.repeat(Math.max(40, Math.min(termWidth, 120))));
    const indent = '  ';
    const bar = dim('│');
    const tree = dim('└');

    console.log('');

    // Top-of-output triage block — only renders when something needs action.
    // Lets the user see the action list without scrolling past 30 OK rows.
    const failed = results.filter((r) => r.status === 'fail');
    const warned = results.filter((r) => r.status === 'warn');
    const issueCount = failed.length + warned.length;
    if (issueCount > 0) {
        const headerGlyph = failed.length > 0 ? chalk.red('✖') : chalk.yellow('⚠');
        const issueWord = issueCount === 1 ? 'issue needs' : 'issues need';
        console.log(`${indent}${headerGlyph} ${chalk.bold(`${issueCount} ${issueWord} attention`)}`);
        for (const r of [...failed, ...warned]) {
            const glyph = r.status === 'fail' ? chalk.red('✖') : chalk.yellow('⚠');
            console.log(`${indent}${glyph} ${r.name} ${dim('—')} ${r.message}`);
            if (r.fix) {
                console.log(`${indent}  ${tree} ${dim(`fix: ${r.fix}`)}`);
            }
        }
        console.log('');
        console.log(`${indent}${rule}`);
        console.log('');
    }

    const bySection = groupBySection(results);
    for (let i = 0; i < bySection.length; i++) {
        const [section, entries] = bySection[i];
        console.log(`${indent}${chalk.bold(section)}`);

        const labelWidth = Math.max(
            ...entries.map((r) => r.name.replace(/^[^:]+: /, '').length),
            10,
        );

        for (const r of entries) {
            const dot = statusDot(r.status);
            const displayName = r.name.replace(/^[^:]+: /, '');
            const paddedLabel = displayName + ' '.repeat(labelWidth - displayName.length);
            console.log(`${indent}${bar}  ${dot} ${paddedLabel}  ${r.message}`);

            if (r.details?.length) {
                for (const d of r.details) {
                    console.log(`${indent}${bar}    ${tree} ${d}`);
                }
            }
            if (r.fix && r.status !== 'ok' && r.status !== 'info') {
                console.log(`${indent}${bar}    ${tree} ${dim(`fix: ${r.fix}`)}`);
            }
        }

        if (i < bySection.length - 1) console.log('');
    }

    console.log('');
    console.log(rule);
    console.log('');
    console.log(`${indent}${summarize(results)}`);
    console.log('');
}

/**
 * Single-column status glyph — filled dot `●` for ok/fail/warn (colour
 * tells the specific state), hollow `○` for info/disabled. Matches the
 * visual vocabulary of `flopsy channel list` and `flopsy team`.
 */
function statusDot(s: CheckResult['status']): string {
    switch (s) {
        case 'ok':
            return chalk.green('●');
        case 'fail':
            return chalk.red('●');
        case 'warn':
            return chalk.yellow('●');
        case 'info':
            return chalk.dim('○');
    }
}

function summarize(results: readonly CheckResult[]): string {
    const counts = { ok: 0, fail: 0, warn: 0, info: 0 };
    for (const r of results) counts[r.status]++;
    const parts: string[] = [];
    if (counts.fail > 0) parts.push(bad(`${counts.fail} failing`));
    if (counts.warn > 0) parts.push(warn(`${counts.warn} warnings`));
    if (counts.ok > 0) parts.push(ok(`${counts.ok} ok`));
    if (counts.info > 0) parts.push(info(`${counts.info} info`));
    return parts.join(' · ');
}

// Explicit name → section map; ordered top-to-bottom for the final layout.
// Adding a new check? Drop its `name` into the right section here.
const SECTION_ORDER = ['Runtime', 'Config', 'State', 'Gateway', 'Auth', 'MCP'] as const;
const SECTION_BY_NAME: Record<string, (typeof SECTION_ORDER)[number]> = {
    'node': 'Runtime',
    'ollama': 'Runtime',
    'flopsy.json5': 'Config',
    'main agent': 'Config',
    'env placeholders': 'Config',
    '.flopsy/': 'State',
    '.flopsy/state/': 'State',
    '.flopsy/auth/': 'State',
    'gateway': 'Gateway',
};

function sectionFor(name: string): (typeof SECTION_ORDER)[number] {
    if (SECTION_BY_NAME[name]) return SECTION_BY_NAME[name];
    if (name.startsWith('auth:') || name.startsWith('auth ')) return 'Auth';
    if (name.startsWith('mcp:') || name.startsWith('mcp ')) return 'MCP';
    return 'Runtime';
}

/** Group checks under named sections in a fixed semantic order. */
function groupBySection(
    results: readonly CheckResult[],
): ReadonlyArray<[string, CheckResult[]]> {
    const groups = new Map<string, CheckResult[]>();
    for (const r of results) {
        const key = sectionFor(r.name);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(r);
    }
    return SECTION_ORDER
        .filter((s) => groups.has(s))
        .map((s) => [s, groups.get(s)!] as [string, CheckResult[]]);
}

