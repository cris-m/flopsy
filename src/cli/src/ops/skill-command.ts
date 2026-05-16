/**
 * `flopsy skill` — manage installed + optional skills.
 *
 * Two-tier skill layout:
 *   <HOME>/content/skills/           — ACTIVE skills (scanned by the catalog)
 *   <HOME>/content/skills-optional/  — INACTIVE skills (bundled but unscanned)
 *
 * Install = copy a skill into active. The agent only sees what's active on
 * the next gateway start. Uninstall = move active → optional (so the user
 * can re-install later without losing it).
 *
 * Install sources (auto-detected from the argument):
 *   - bare name:       copy from local optional/  (the default behaviour)
 *   - filesystem path: copy a directory (must contain SKILL.md) or a single
 *                      SKILL.md file (wrapped into a skill dir by name)
 *   - github URL:      fetch the directory contents via the GitHub API
 *                      (https://github.com/<owner>/<repo>/tree/<ref>/<path>)
 *   - raw URL:         fetch a single SKILL.md file
 *
 * Every non-local install runs a safety scan against the source contents
 * before writing to the active dir. Use --force to bypass the prompt.
 *
 * Subcommands:
 *   flopsy skill list                 — list active skills
 *   flopsy skill list --optional      — list optional (not-yet-installed)
 *   flopsy skill list --all           — both
 *   flopsy skill install <source>     — install from name | path | github | raw URL
 *   flopsy skill uninstall <name>     — move active → optional
 *   flopsy skill show <name>          — print SKILL.md
 */

import { Command } from 'commander';
import {
    cpSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { workspace } from '@flopsy/shared';
import { bad, dim, info, ok, section, warn as warnLine } from '../ui/pretty';
import { createInterface } from 'node:readline';

interface SkillSummary {
    name: string;
    description: string;
    location: 'active' | 'optional';
}

// ── Install-source detection ─────────────────────────────────────────────
//
// `flopsy skill install <arg>` accepts four kinds of source. The dispatcher
// below resolves each kind to a staging directory under tmpdir containing a
// validated SKILL.md (and any sibling files), then a common copy step
// promotes that dir into <HOME>/content/skills/<name>/. Keeping the kinds
// behind one detector means the safety scan + name extraction happen in one
// place regardless of where the bytes came from.

type InstallSource =
    | { kind: 'name'; name: string }
    | { kind: 'path-dir'; absDir: string }
    | { kind: 'path-file'; absFile: string }
    | {
          kind: 'github-url';
          owner: string;
          repo: string;
          ref: string;
          path: string;
      }
    | { kind: 'raw-url'; url: string };

/** Best-effort classification of the install argument. */
function detectSource(arg: string): InstallSource {
    // GitHub tree/blob URLs first — most specific.
    const gh = arg.match(
        /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/(?:tree|blob)\/([^/\s]+)\/(.+?)\/?$/,
    );
    if (gh) {
        return {
            kind: 'github-url',
            owner: gh[1]!,
            repo: gh[2]!,
            ref: gh[3]!,
            path: gh[4]!,
        };
    }
    // Any other http(s) — treat as raw file.
    if (/^https?:\/\//.test(arg)) return { kind: 'raw-url', url: arg };

    // Filesystem path: contains a slash, starts with . / ~, or is an absolute path.
    // We deliberately do NOT fall back to bare-name when the path doesn't
    // exist — that produces a "no optional skill named ./foo" message which
    // hides the real issue. Treat path-like args as paths, period.
    const looksLikePath = arg.includes('/') || arg.startsWith('.') || arg.startsWith('~');
    if (looksLikePath) {
        const expanded = arg.startsWith('~')
            ? join(process.env.HOME ?? '', arg.slice(1))
            : arg;
        const abs = isAbsolute(expanded) ? expanded : resolvePath(process.cwd(), expanded);
        if (!existsSync(abs)) {
            // Return a path-dir source pointing at the (missing) target —
            // prepareFromPathDir() emits a precise "SKILL.md not found at X"
            // error, which is much more useful than the bare-name fallback.
            return { kind: 'path-dir', absDir: abs };
        }
        const st = statSync(abs);
        if (st.isDirectory()) return { kind: 'path-dir', absDir: abs };
        if (st.isFile()) return { kind: 'path-file', absFile: abs };
    }
    return { kind: 'name', name: arg };
}

// ── Safety scan ──────────────────────────────────────────────────────────
//
// Cheap pattern-based scanner that flags obvious malicious primitives in a
// SKILL.md (or any text we're about to write to the skills dir). It isn't a
// security guarantee — a determined attacker can obfuscate — but it catches
// the long-tail of accidental-or-careless dangerous patterns and forces an
// extra confirmation step. Scoped to a regex list — doesn't pretend to
// be anything fancier than a first line of defence.

interface SafetyFinding {
    severity: 'low' | 'med' | 'high';
    label: string;
    snippet: string;
}

const SAFETY_PATTERNS: ReadonlyArray<{
    re: RegExp;
    severity: SafetyFinding['severity'];
    label: string;
}> = [
    { re: /\brm\s+-rf\s+(\/|~|\$HOME)\b/, severity: 'high', label: 'rm -rf on system root or home' },
    { re: /\b(curl|wget)\s[^\n]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/, severity: 'high', label: 'pipe network fetch into shell' },
    { re: /\bbase64\s+(-d|--decode)\b/, severity: 'med', label: 'base64 decode (obfuscation)' },
    { re: /\beval\s*\(?\s*[`$"]/, severity: 'med', label: 'eval on dynamic input' },
    { re: /\b(printenv|env)\b[^\n]*\|\s*(curl|wget|nc)\b/, severity: 'high', label: 'env exfiltration to network' },
    { re: /~\/\.ssh\/(id_rsa|id_ed25519|id_ecdsa)\b/, severity: 'high', label: 'SSH private-key access' },
    { re: /\bchmod\s+\+s\b/, severity: 'high', label: 'setuid bit' },
    { re: /\bsudo\s+/, severity: 'low', label: 'sudo invocation' },
    { re: /\bnpm\s+i(nstall)?\s+(-g|--global)\s/, severity: 'low', label: 'global npm install' },
    { re: /AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID|OPENAI_API_KEY|ANTHROPIC_API_KEY/, severity: 'med', label: 'credential env-var reference' },
];

function safetyScan(text: string): SafetyFinding[] {
    const findings: SafetyFinding[] = [];
    const lines = text.split('\n');
    for (const { re, severity, label } of SAFETY_PATTERNS) {
        for (let i = 0; i < lines.length; i++) {
            const m = lines[i]!.match(re);
            if (!m) continue;
            findings.push({
                severity,
                label,
                snippet: `L${i + 1}: ${lines[i]!.trim().slice(0, 140)}`,
            });
            break; // one hit per pattern is enough for the report
        }
    }
    return findings;
}

function printSafetyReport(findings: SafetyFinding[]): void {
    if (findings.length === 0) {
        console.log(dim('  ✓ safety scan: no obvious red flags'));
        return;
    }
    console.log(section('safety scan'));
    for (const f of findings) {
        const tag =
            f.severity === 'high' ? bad('HIGH ') : f.severity === 'med' ? warnLine('MED  ') : dim('LOW  ');
        console.log(`  ${tag} ${f.label}`);
        console.log(dim(`        ${f.snippet}`));
    }
}

async function confirmInstall(promptText: string): Promise<boolean> {
    if (!process.stdin.isTTY) return false; // refuse in non-interactive without --force
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((res) => {
        rl.question(`${promptText} [y/N] `, (answer) => {
            rl.close();
            res(/^y(es)?$/i.test(answer.trim()));
        });
    });
}

// ── Source fetchers — each writes a complete skill dir to a staging tmpdir ──
// Common contract: returns { stagingDir, skillName, scanText }
//   stagingDir — temp dir with SKILL.md and any sibling files, ready to copy
//   skillName  — kebab-case name derived from frontmatter or path
//   scanText   — concatenated text used for the safety scan
// All fetchers throw on validation failure with a user-friendly message.

interface PreparedSkill {
    stagingDir: string;
    skillName: string;
    scanText: string;
}

function extractSkillName(skillMd: string, fallback: string): string {
    // Cheap frontmatter parse — we only want the `name:` line.
    if (skillMd.startsWith('---')) {
        const end = skillMd.indexOf('\n---', 3);
        const fm = skillMd.slice(3, end > 0 ? end : 400);
        const match = fm.match(/^name:\s*([A-Za-z0-9_-]+)\s*$/m);
        if (match?.[1]) return match[1].toLowerCase();
    }
    return fallback.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
}

async function prepareFromName(name: string): Promise<PreparedSkill> {
    // Direct copy from skills-optional — no scan, no staging, but we still
    // surface the path through the same interface for a unified install path.
    const src = join(workspace.skillsOptional(), name);
    if (!existsSync(src)) {
        throw new Error(`No optional skill named "${name}" at ${src}`);
    }
    const skillMdPath = join(src, 'SKILL.md');
    if (!existsSync(skillMdPath)) {
        throw new Error(`"${name}" has no SKILL.md — not a valid skill directory`);
    }
    return {
        stagingDir: src, // copy direct
        skillName: name,
        scanText: readFileSync(skillMdPath, 'utf-8'),
    };
}

async function prepareFromPathDir(absDir: string): Promise<PreparedSkill> {
    const skillMdPath = join(absDir, 'SKILL.md');
    if (!existsSync(skillMdPath)) {
        throw new Error(`${absDir} has no SKILL.md — not a valid skill directory`);
    }
    const body = readFileSync(skillMdPath, 'utf-8');
    return {
        stagingDir: absDir,
        skillName: extractSkillName(body, basename(absDir)),
        scanText: body,
    };
}

async function prepareFromPathFile(absFile: string): Promise<PreparedSkill> {
    const body = readFileSync(absFile, 'utf-8');
    if (!/^---\n[\s\S]*?\nname:/m.test(body)) {
        throw new Error(
            `${absFile} doesn't look like a SKILL.md (missing "name:" in frontmatter)`,
        );
    }
    const name = extractSkillName(body, basename(absFile, '.md'));
    const staging = mkdtempSync(join(tmpdir(), 'flopsy-skill-install-'));
    writeFileSync(join(staging, 'SKILL.md'), body, 'utf-8');
    return { stagingDir: staging, skillName: name, scanText: body };
}

const FETCH_TIMEOUT_MS = 30_000;
const MAX_BYTES = 1_048_576; // 1 MB cap per file

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    try {
        return await fetch(url, { ...init, signal: ctl.signal });
    } finally {
        clearTimeout(t);
    }
}

async function prepareFromRawUrl(url: string): Promise<PreparedSkill> {
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
    const ct = res.headers.get('content-type') ?? '';
    if (ct && !/text\/(plain|markdown|x-markdown)|application\/octet-stream/.test(ct)) {
        throw new Error(`unexpected content-type "${ct}" for SKILL.md fetch`);
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) {
        throw new Error(`SKILL.md too large (${buf.byteLength}B, max ${MAX_BYTES}B)`);
    }
    const body = new TextDecoder().decode(buf);
    if (!/^---\n[\s\S]*?\nname:/m.test(body)) {
        throw new Error(`URL didn't return a SKILL.md (no "name:" in frontmatter)`);
    }
    const name = extractSkillName(body, basename(new URL(url).pathname, '.md'));
    const staging = mkdtempSync(join(tmpdir(), 'flopsy-skill-install-'));
    writeFileSync(join(staging, 'SKILL.md'), body, 'utf-8');
    return { stagingDir: staging, skillName: name, scanText: body };
}

interface GhContentEntry {
    type: 'file' | 'dir' | 'symlink' | 'submodule';
    name: string;
    path: string;
    download_url: string | null;
}

async function ghContents(
    owner: string,
    repo: string,
    path: string,
    ref: string,
): Promise<GhContentEntry[]> {
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`;
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
    const token = process.env.GITHUB_TOKEN;
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetchWithTimeout(url, { headers });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`GitHub API ${res.status} for ${owner}/${repo}/${path}: ${detail.slice(0, 200)}`);
    }
    const json = (await res.json()) as GhContentEntry | GhContentEntry[];
    return Array.isArray(json) ? json : [json];
}

async function prepareFromGithub(src: Extract<InstallSource, { kind: 'github-url' }>): Promise<PreparedSkill> {
    const { owner, repo, ref, path } = src;
    // Walk the tree, writing every file to staging. Hard cap at 50 files /
    // 5MB cumulative to keep the fetch bounded.
    const FILE_CAP = 50;
    const TOTAL_BYTES_CAP = 5 * MAX_BYTES;
    const staging = mkdtempSync(join(tmpdir(), 'flopsy-skill-install-'));
    let fileCount = 0;
    let totalBytes = 0;
    let scanText = '';
    let skillMdBody: string | null = null;

    async function walk(currentPath: string, rel: string): Promise<void> {
        const entries = await ghContents(owner, repo, currentPath, ref);
        for (const entry of entries) {
            if (fileCount >= FILE_CAP) throw new Error(`file count exceeds cap of ${FILE_CAP}`);
            if (entry.type === 'dir') {
                const subRel = rel ? `${rel}/${entry.name}` : entry.name;
                mkdirSync(join(staging, subRel), { recursive: true });
                await walk(entry.path, subRel);
                continue;
            }
            if (entry.type !== 'file' || !entry.download_url) continue;
            const fres = await fetchWithTimeout(entry.download_url);
            if (!fres.ok) throw new Error(`fetch ${entry.download_url} → ${fres.status}`);
            const buf = await fres.arrayBuffer();
            if (buf.byteLength > MAX_BYTES) {
                throw new Error(`${entry.path} is ${buf.byteLength}B (max ${MAX_BYTES}B per file)`);
            }
            totalBytes += buf.byteLength;
            if (totalBytes > TOTAL_BYTES_CAP) {
                throw new Error(`total fetched bytes exceeded ${TOTAL_BYTES_CAP}`);
            }
            const writePath = join(staging, rel, entry.name);
            mkdirSync(join(staging, rel), { recursive: true });
            const bodyBuf = Buffer.from(buf);
            writeFileSync(writePath, bodyBuf);
            fileCount++;
            if (entry.name === 'SKILL.md' && rel === '') {
                skillMdBody = bodyBuf.toString('utf-8');
            }
            // Scan everything that looks like text (cheap heuristic: <1MB
            // and starts with UTF-8 printables in the first 64 bytes).
            const probe = bodyBuf.slice(0, 64).toString('utf-8');
            if (/^[\x09\x0A\x0D\x20-\x7E]+$/.test(probe)) {
                scanText += `\n# ${entry.path}\n${bodyBuf.toString('utf-8')}`;
            }
        }
    }

    await walk(path, '');

    if (!skillMdBody) {
        throw new Error(`no SKILL.md found at root of ${owner}/${repo}/${path}@${ref}`);
    }
    const name = extractSkillName(skillMdBody, basename(path));
    return { stagingDir: staging, skillName: name, scanText };
}

async function prepareSkill(source: InstallSource): Promise<PreparedSkill> {
    switch (source.kind) {
        case 'name':
            return prepareFromName(source.name);
        case 'path-dir':
            return prepareFromPathDir(source.absDir);
        case 'path-file':
            return prepareFromPathFile(source.absFile);
        case 'raw-url':
            return prepareFromRawUrl(source.url);
        case 'github-url':
            return prepareFromGithub(source);
    }
}

/**
 * Promote a prepared skill from its staging dir to the active dir.
 * Refuses to overwrite an existing active skill — uninstall first or use
 * a different name. Returns the final destination path.
 */
function promoteToActive(prepared: PreparedSkill): string {
    const dest = join(workspace.skills(), prepared.skillName);
    if (existsSync(dest)) {
        throw new Error(
            `"${prepared.skillName}" is already active. Uninstall it first to replace.`,
        );
    }
    mkdirSync(workspace.skills(), { recursive: true });
    cpSync(prepared.stagingDir, dest, { recursive: true });
    return dest;
}

function readSkillSummary(dir: string, name: string): SkillSummary | null {
    const skillMd = join(dir, name, 'SKILL.md');
    if (!existsSync(skillMd)) return null;
    try {
        const raw = readFileSync(skillMd, 'utf-8');
        // Cheap frontmatter parse — just for the description line.
        let description = '(no description)';
        if (raw.startsWith('---')) {
            const end = raw.indexOf('\n---', 3);
            const fm = raw.slice(3, end > 0 ? end : 200);
            const match = fm.match(/^description:\s*(.+)$/m);
            if (match?.[1]) description = match[1].trim();
        }
        return {
            name,
            description,
            location: dir.endsWith('skills-optional') ? 'optional' : 'active',
        };
    } catch {
        return null;
    }
}

function listSkillsIn(dir: string): SkillSummary[] {
    if (!existsSync(dir)) return [];
    const entries = readdirSync(dir);
    const out: SkillSummary[] = [];
    for (const entry of entries) {
        try {
            if (!statSync(join(dir, entry)).isDirectory()) continue;
        } catch {
            continue;
        }
        const summary = readSkillSummary(dir, entry);
        if (summary) out.push(summary);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
}

function renderList(skills: SkillSummary[], header: string): void {
    console.log(section(header));
    if (skills.length === 0) {
        console.log(dim('  (none)'));
        return;
    }
    const nameWidth = Math.max(...skills.map((s) => s.name.length));
    for (const sk of skills) {
        const marker = sk.location === 'active' ? '●' : '○';
        const trunc = sk.description.length > 80
            ? sk.description.slice(0, 79) + '…'
            : sk.description;
        console.log(`  ${marker} ${sk.name.padEnd(nameWidth)}  ${dim(trunc)}`);
    }
}

export function registerSkillCommands(root: Command): void {
    const skill = root
        .command('skill')
        .description('Manage active + optional skills (two-tier install)');

    skill
        .command('list')
        .description('List skills (default: active only)')
        .option('--optional', 'Only show optional (not-installed) skills', false)
        .option('--all', 'Show both active and optional', false)
        .action((opts: { optional?: boolean; all?: boolean }) => {
            const showActive = opts.all || !opts.optional;
            const showOptional = opts.all || opts.optional;

            if (showActive) {
                renderList(listSkillsIn(workspace.skills()), 'Active skills');
            }
            if (showOptional) {
                if (showActive) console.log();
                renderList(listSkillsIn(workspace.skillsOptional()), 'Optional skills');
            }
            console.log();
            // Legend reflects only what was rendered.
            if (showActive && showOptional) {
                console.log(
                    dim(
                        `  ● = active (visible to agent)   ○ = optional (run "flopsy skill install <source>" to activate)`,
                    ),
                );
            } else if (showActive) {
                console.log(
                    dim(
                        `  ● = active. Run "flopsy skill list --optional" to see what else is installable.`,
                    ),
                );
            } else {
                console.log(
                    dim(
                        `  ○ = optional. Run "flopsy skill install <name>" (or path / URL — see install --help).`,
                    ),
                );
            }
        });

    skill
        .command('install')
        .description(
            'Install a skill — from optional (by name), a local path, a GitHub URL, or a raw SKILL.md URL.',
        )
        .argument(
            '<source>',
            'Skill source: bare name | ./path/to/skill | https://github.com/owner/repo/tree/ref/path | https://example.com/SKILL.md',
        )
        .option('--force', 'Skip the safety-scan confirmation prompt', false)
        .addHelpText(
            'after',
            [
                '',
                'Examples:',
                '  flopsy skill install web-research                # from bundled optional/',
                '  flopsy skill install ./my-skill                  # local directory',
                '  flopsy skill install ./scratchpad/SKILL.md       # single file',
                '  flopsy skill install https://github.com/foo/bar/tree/main/skills/calendar',
                '  flopsy skill install https://example.com/skill.md',
                '',
                'For private GitHub repos: set GITHUB_TOKEN.',
                'Restart the gateway after install for the agent to pick the skill up.',
            ].join('\n'),
        )
        .action(async (source: string, opts: { force?: boolean }) => {
            const detected = detectSource(source);

            let prepared: PreparedSkill;
            try {
                prepared = await prepareSkill(detected);
            } catch (err) {
                console.log(bad(`Install failed: ${(err as Error).message}`));
                if (detected.kind === 'name') {
                    console.log(
                        dim(
                            `  Hint: run "flopsy skill list --optional" to see what's installable by name.`,
                        ),
                    );
                }
                process.exit(1);
            }

            // Safety scan — skipped for local optional sources (trusted by
            // virtue of shipping bundled). Anything from disk-path or URL
            // gets scanned.
            if (detected.kind !== 'name') {
                const findings = safetyScan(prepared.scanText);
                printSafetyReport(findings);
                const hasHigh = findings.some((f) => f.severity === 'high');
                if (hasHigh && !opts.force) {
                    const confirmed = await confirmInstall(
                        `${bad('HIGH-severity findings detected.')} Proceed anyway?`,
                    );
                    if (!confirmed) {
                        console.log(info('Install cancelled.'));
                        process.exit(2);
                    }
                } else if (findings.some((f) => f.severity === 'med') && !opts.force) {
                    const confirmed = await confirmInstall('Medium-severity findings. Proceed?');
                    if (!confirmed) {
                        console.log(info('Install cancelled.'));
                        process.exit(2);
                    }
                }
            }

            try {
                const dest = promoteToActive(prepared);
                console.log(ok(`Installed "${prepared.skillName}" → ${dest}`));
                console.log(dim('  Restart the gateway for the agent to pick it up.'));
            } catch (err) {
                console.log(bad(`Install failed: ${(err as Error).message}`));
                process.exit(1);
            }
        });

    skill
        .command('uninstall')
        .description(
            'Move an active skill back to optional (re-installable later). Restart the gateway.',
        )
        .argument('<name>', 'Skill name')
        .option('--purge', 'Delete the skill entirely instead of moving to optional', false)
        .action((name: string, opts: { purge?: boolean }) => {
            const active = join(workspace.skills(), name);
            const optional = join(workspace.skillsOptional(), name);

            if (!existsSync(active)) {
                console.log(bad(`No active skill named "${name}"`));
                process.exit(1);
            }

            try {
                if (opts.purge) {
                    rmSync(active, { recursive: true, force: true });
                    console.log(ok(`Purged "${name}" (no recovery — re-author or re-fetch).`));
                    return;
                }
                if (existsSync(optional)) {
                    // Avoid clobbering an existing optional copy — purge the
                    // active one (it's the same content) instead of moving.
                    rmSync(active, { recursive: true, force: true });
                    console.log(
                        ok(`Removed "${name}" from active (a copy already exists in optional).`),
                    );
                } else {
                    mkdirSync(workspace.skillsOptional(), { recursive: true });
                    renameSync(active, optional);
                    console.log(ok(`Uninstalled "${name}" → moved to optional.`));
                }
                console.log(dim('  Restart the gateway to refresh the catalog.'));
            } catch (err) {
                console.log(bad(`Uninstall failed: ${(err as Error).message}`));
                process.exit(1);
            }
        });

    skill
        .command('show')
        .description('Print a skill\'s SKILL.md (works for both active and optional)')
        .argument('<name>', 'Skill name')
        .action((name: string) => {
            const candidates = [
                join(workspace.skills(), name, 'SKILL.md'),
                join(workspace.skillsOptional(), name, 'SKILL.md'),
            ];
            const found = candidates.find((p) => existsSync(p));
            if (!found) {
                console.log(bad(`No skill named "${name}" (active or optional).`));
                process.exit(1);
            }
            console.log(readFileSync(found, 'utf-8'));
        });

    // Default — show help if no subcommand provided.
    skill.action((_opts: unknown, cmd: { outputHelp(): void }) => cmd.outputHelp());
}
