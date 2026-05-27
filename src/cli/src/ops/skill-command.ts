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
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { workspace } from '@flopsy/shared';
import { bad, dim, info, ok, section, warn as warnLine } from '../ui/pretty';
import { createInterface } from 'node:readline';
import { readFlopsyConfig } from './config-reader';

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
 * Promote a prepared skill from its staging dir to the active dir, respecting
 * the `category:` frontmatter so the install lands at
 * `<HOME>/content/skills/<category>/<name>/SKILL.md`. Falls back to a flat
 * layout when no category is declared. Refuses to overwrite an existing
 * active skill anywhere in the tree (flat OR grouped) — uninstall first.
 */
function promoteToActive(prepared: PreparedSkill): string {
    const category = readSkillCategory(prepared.stagingDir);
    const activeBase = workspace.skills();
    const existing = findSkillPath(activeBase, prepared.skillName);
    if (existing) {
        throw new Error(
            `"${prepared.skillName}" is already active at ${existing.replace(/\/SKILL\.md$/, '')}. Uninstall it first to replace.`,
        );
    }
    const dest = category
        ? join(activeBase, category, prepared.skillName)
        : join(activeBase, prepared.skillName);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(prepared.stagingDir, dest, { recursive: true });
    return dest;
}

function readSkillCategory(skillDir: string): string | null {
    const skillMd = join(skillDir, 'SKILL.md');
    if (!existsSync(skillMd)) return null;
    try {
        const raw = readFileSync(skillMd, 'utf-8');
        const m = raw.match(/^category:\s*([a-zA-Z0-9_-]+)/m);
        return m?.[1] ?? null;
    } catch {
        return null;
    }
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
        const entryPath = join(dir, entry);
        try {
            if (!statSync(entryPath).isDirectory()) continue;
        } catch {
            continue;
        }
        // Flat: dir/<entry>/SKILL.md
        if (existsSync(join(entryPath, 'SKILL.md'))) {
            const summary = readSkillSummary(dir, entry);
            if (summary) out.push(summary);
            continue;
        }
        // Grouped: dir/<group>/<sub>/SKILL.md — scan one level deeper.
        let subEntries: string[];
        try {
            subEntries = readdirSync(entryPath);
        } catch {
            continue;
        }
        for (const sub of subEntries) {
            const subPath = join(entryPath, sub);
            try {
                if (!statSync(subPath).isDirectory()) continue;
            } catch {
                continue;
            }
            if (!existsSync(join(subPath, 'SKILL.md'))) continue;
            const summary = readSkillSummary(entryPath, sub);
            if (summary) out.push(summary);
        }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Resolve a skill name → its actual SKILL.md path, walking both layouts:
 *   1. Flat:    <root>/<name>/SKILL.md
 *   2. Grouped: <root>/<group>/<name>/SKILL.md
 * Returns the full SKILL.md path or null when not found.
 */
function findSkillPath(root: string, name: string): string | null {
    const flat = join(root, name, 'SKILL.md');
    if (existsSync(flat)) return flat;
    if (!existsSync(root)) return null;
    let groups: string[];
    try {
        groups = readdirSync(root);
    } catch {
        return null;
    }
    for (const group of groups) {
        const candidate = join(root, group, name, 'SKILL.md');
        try {
            if (existsSync(candidate) && statSync(join(root, group)).isDirectory()) {
                return candidate;
            }
        } catch {
            continue;
        }
    }
    return null;
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
                const reloaded = await reloadSkillCatalog().catch(() => false);
                if (reloaded) {
                    console.log(dim('  Catalog hot-reloaded — next agent turn picks it up. No restart needed.'));
                } else {
                    console.log(dim('  Restart the gateway for the agent to pick it up (gateway not running or reload endpoint unreachable).'));
                }
            } catch (err) {
                console.log(bad(`Install failed: ${(err as Error).message}`));
                process.exit(1);
            }
        });

    skill
        .command('uninstall')
        .description(
            'Move an active skill back to optional (re-installable later). Mirrors the source category — skills/<cat>/<name>/ → skills-optional/<cat>/<name>/.',
        )
        .argument('<name>', 'Skill name')
        .option('--purge', 'Delete the skill entirely instead of moving to optional', false)
        .action(async (name: string, opts: { purge?: boolean }) => {
            // Resolve to the actual skill directory (parent of SKILL.md) —
            // walks both flat and grouped layouts so we can preserve the
            // category context when mirroring to optional/.
            const activeSkillMd = findSkillPath(workspace.skills(), name);
            if (!activeSkillMd) {
                console.log(bad(`No active skill named "${name}"`));
                process.exit(1);
            }
            const active = activeSkillMd.replace(/\/SKILL\.md$/, '');
            const category = readSkillCategory(active);
            const optionalBase = workspace.skillsOptional();
            const optional = category ? join(optionalBase, category, name) : join(optionalBase, name);

            try {
                if (opts.purge) {
                    rmSync(active, { recursive: true, force: true });
                    console.log(ok(`Purged "${name}" (no recovery — re-author or re-fetch).`));
                } else if (existsSync(optional)) {
                    // Avoid clobbering an existing optional copy — purge the
                    // active one (it's the same content) instead of moving.
                    rmSync(active, { recursive: true, force: true });
                    console.log(
                        ok(`Removed "${name}" from active (a copy already exists in optional at ${optional}).`),
                    );
                } else {
                    mkdirSync(dirname(optional), { recursive: true });
                    renameSync(active, optional);
                    console.log(ok(`Uninstalled "${name}" → ${optional}`));
                }
                const reloaded = await reloadSkillCatalog().catch(() => false);
                if (reloaded) {
                    console.log(dim('  Catalog hot-reloaded — next agent turn picks it up. No restart needed.'));
                } else {
                    console.log(dim('  Restart the gateway to refresh the catalog (gateway not running or reload endpoint unreachable).'));
                }
            } catch (err) {
                console.log(bad(`Uninstall failed: ${(err as Error).message}`));
                process.exit(1);
            }
        });

    skill
        .command('reload')
        .description('Force a live re-scan of the skills catalog across all running agents (no gateway restart needed)')
        .action(async () => {
            try {
                const reloaded = await reloadSkillCatalog();
                if (reloaded) {
                    console.log(ok('Skill catalog reload requested — next agent turn re-scans.'));
                } else {
                    console.log(bad('Reload endpoint did not confirm — gateway may not be running.'));
                    process.exit(1);
                }
            } catch (err) {
                console.log(bad(`Reload failed: ${(err as Error).message}`));
                process.exit(1);
            }
        });

    skill
        .command('show')
        .description('Print a skill\'s SKILL.md (works for both active and optional)')
        .argument('<name>', 'Skill name')
        .action((name: string) => {
            const found =
                findSkillPath(workspace.skills(), name) ??
                findSkillPath(workspace.skillsOptional(), name);
            if (!found) {
                console.log(bad(`No skill named "${name}" (active or optional).`));
                process.exit(1);
            }
            console.log(readFileSync(found, 'utf-8'));
        });

    const proposed = skill
        .command('proposed')
        .description('Inspect / accept / reject agent-proposed skills awaiting review');

    proposed
        .command('list', { isDefault: true })
        .description('List skills in proposed/ (agent-authored, not yet active)')
        .action(() => {
            const dir = workspace.skillsProposed();
            const items = listSkillsIn(dir);
            if (items.length === 0) {
                console.log(section('Proposed skills'));
                console.log(dim('  (none — the agent has not authored any new skills yet)'));
                return;
            }
            renderList(items, 'Proposed skills');
            console.log();
            console.log(dim(`  ${items.length} awaiting review.  flopsy skill proposed show <name>  /  accept <name>  /  reject <name>`));
        });

    proposed
        .command('show <name>')
        .description('Print a proposed skill\'s SKILL.md')
        .action((name: string) => {
            const file = join(workspace.skillsProposed(), name, 'SKILL.md');
            if (!existsSync(file)) {
                console.log(bad(`No proposed skill "${name}"`));
                process.exit(1);
            }
            console.log(readFileSync(file, 'utf-8'));
        });

    proposed
        .command('accept <name>')
        .description('Promote a proposed skill to active. Respects `category:` frontmatter — lands at skills/<category>/<name>/.')
        .action(async (name: string) => {
            const src = join(workspace.skillsProposed(), name);
            if (!existsSync(join(src, 'SKILL.md'))) {
                console.log(bad(`No proposed skill "${name}"`));
                process.exit(1);
            }
            const category = readSkillCategory(src);
            const activeBase = workspace.skills();
            const existing = findSkillPath(activeBase, name);
            if (existing) {
                console.log(bad(`Active skill "${name}" already exists at ${existing.replace(/\/SKILL\.md$/, '')} — rename the proposed one or remove the active first.`));
                process.exit(1);
            }
            const dest = category ? join(activeBase, category, name) : join(activeBase, name);
            try {
                mkdirSync(dirname(dest), { recursive: true });
                renameSync(src, dest);
            } catch (err) {
                console.log(bad(`Promotion failed: ${(err as Error).message}`));
                process.exit(1);
            }
            console.log(ok(`Promoted "${name}" → ${dest}`));
            const reloaded = await reloadSkillCatalog().catch(() => false);
            if (reloaded) {
                console.log(dim('  Catalog hot-reloaded — next agent turn picks it up. No restart needed.'));
            } else {
                console.log(dim('  Restart the gateway for the agent to pick it up (gateway not running or reload endpoint unreachable).'));
            }
        });

    proposed
        .command('reject <name>')
        .description('Delete a proposed skill (removes proposed/<name>)')
        .action((name: string) => {
            const src = join(workspace.skillsProposed(), name);
            if (!existsSync(src)) {
                console.log(bad(`No proposed skill "${name}"`));
                process.exit(1);
            }
            try {
                rmSync(src, { recursive: true, force: true });
            } catch (err) {
                console.log(bad(`Reject failed: ${(err as Error).message}`));
                process.exit(1);
            }
            console.log(ok(`Rejected "${name}".`));
        });

    proposed
        .command('promote <name>')
        .description('Auto-promote a proposed skill via eval gate: runs evals/evals.json with and without the skill, promotes if pass-rate delta ≥ threshold')
        .option('--threshold <n>', 'Minimum (with - without) pass-rate delta to promote (0..1)', '0.30')
        .option('--timeout-ms <ms>', 'Per-eval timeout', '120000')
        .option('--dry-run', 'Run evals but do not promote even on success', false)
        .action(async (name: string, opts: { threshold?: string; timeoutMs?: string; dryRun?: boolean }) => {
            const threshold = Number(opts.threshold ?? '0.30');
            const timeoutMs = Number(opts.timeoutMs ?? '120000');
            if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
                console.log(bad('--threshold must be between 0 and 1'));
                process.exit(1);
            }
            await runPromoteEval(name, { threshold, timeoutMs, dryRun: !!opts.dryRun });
        });

    skill
        .command('eval <name>')
        .description('Run a skill\'s evals/evals.json against the current catalog (skill must already be active). Prints pass/fail per assertion; non-zero exit on any failure.')
        .option('--timeout-ms <ms>', 'Per-eval timeout', '120000')
        .action(async (name: string, opts: { timeoutMs?: string }) => {
            const timeoutMs = Number(opts.timeoutMs ?? '120000');
            const path = findSkillPath(workspace.skills(), name);
            if (!path) {
                console.log(bad(`No active skill "${name}". Use \`flopsy skill list\` to see what's installed.`));
                process.exit(1);
            }
            const evalsPath = join(path.replace(/\/SKILL\.md$/, ''), 'evals', 'evals.json');
            if (!existsSync(evalsPath)) {
                console.log(bad(`No evals file at ${evalsPath}. Add evals/evals.json with prompts + assertions to enable eval runs.`));
                process.exit(1);
            }
            const cases = readEvalsFile(evalsPath);
            console.log(section(`Eval — ${name} (${cases.length} cases)`));
            const results = await runEvalSet(cases, timeoutMs);
            const summary = summarizeEvalResults(results);
            printEvalSummary('with-skill', summary);
            if (summary.failedAssertions > 0 || summary.errors > 0) process.exit(1);
        });

    skill.action((_opts: unknown, cmd: { outputHelp(): void }) => cmd.outputHelp());
}

/**
 * Ask the running gateway to drop its cached skill catalog so the next
 * agent turn re-scans `.flopsy/content/skills/`. Returns false silently
 * when the gateway is not running or the endpoint isn't wired (older
 * builds). Called automatically by install / accept / uninstall.
 */
async function reloadSkillCatalog(): Promise<boolean> {
    try {
        const { managementUrl } = await import('./schedule-client');
        const { loadMgmtToken } = await import('@flopsy/shared');
        const token = loadMgmtToken();
        const res = await fetch(managementUrl('/management/skills/reload'), {
            method: 'POST',
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            signal: AbortSignal.timeout(2000),
        });
        if (!res.ok) return false;
        const body = (await res.json()) as { reloaded?: boolean };
        return body.reloaded === true;
    } catch {
        return false;
    }
}

// ── Eval framework ──────────────────────────────────────────────────────────
//
// Two consumers:
//   - `flopsy skill eval <name>`   → run-and-grade only (assumes skill active)
//   - `flopsy skill proposed promote <name>` → with/without comparison +
//      conditional promotion based on pass-rate delta.
//
// Both call /management/skill-eval-run for each prompt; the gateway builds a
// fresh stateless agent per call (fresh skills() closure → fresh catalog scan)
// so moving a skill in/out of the active dir between calls is enough to flip
// the with/without state without a gateway restart.

interface EvalCase {
    id: string | number;
    prompt: string;
    assertions: Array<string | Record<string, unknown>>;
}

interface AssertionResult {
    text: string;
    passed: boolean;
    evidence: string;
}

interface EvalCaseResult {
    id: string | number;
    prompt: string;
    reply: string;
    durationMs: number;
    error?: string;
    assertions: AssertionResult[];
}

interface EvalSummary {
    totalCases: number;
    errors: number;
    totalAssertions: number;
    passedAssertions: number;
    failedAssertions: number;
    passRate: number;
    totalDurationMs: number;
}

function readEvalsFile(path: string): EvalCase[] {
    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(path, 'utf-8'));
    } catch (err) {
        console.log(bad(`Failed to parse ${path}: ${(err as Error).message}`));
        process.exit(1);
    }
    const evals = (raw as { evals?: unknown })?.evals;
    if (!Array.isArray(evals)) {
        console.log(bad(`Eval file must have shape { "evals": [...] }`));
        process.exit(1);
    }
    const out: EvalCase[] = [];
    for (let i = 0; i < evals.length; i++) {
        const e = evals[i] as Record<string, unknown>;
        if (typeof e?.prompt !== 'string') {
            console.log(bad(`Eval #${i}: missing or non-string \`prompt\``));
            process.exit(1);
        }
        if (!Array.isArray(e?.assertions) || e.assertions.length === 0) {
            console.log(bad(`Eval #${i}: missing or empty \`assertions\` array`));
            process.exit(1);
        }
        out.push({
            id: (e.id as string | number | undefined) ?? i + 1,
            prompt: e.prompt,
            assertions: e.assertions as Array<string | Record<string, unknown>>,
        });
    }
    return out;
}

function gradeAssertion(reply: string, assertion: string | Record<string, unknown>): AssertionResult {
    if (typeof assertion === 'string') {
        const passed = reply.toLowerCase().includes(assertion.toLowerCase());
        return {
            text: assertion,
            passed,
            evidence: passed
                ? `Reply contains "${assertion}"`
                : `Reply does NOT contain "${assertion}"`,
        };
    }
    const text = (assertion['text'] as string) ?? JSON.stringify(assertion);
    if (typeof assertion['contains'] === 'string') {
        const needle = assertion['contains'];
        const passed = reply.toLowerCase().includes(needle.toLowerCase());
        return {
            text,
            passed,
            evidence: passed
                ? `Reply contains "${needle}"`
                : `Reply does NOT contain "${needle}"`,
        };
    }
    if (typeof assertion['regex'] === 'string') {
        const flags = (assertion['flags'] as string | undefined) ?? '';
        try {
            const re = new RegExp(assertion['regex'], flags);
            const m = reply.match(re);
            return {
                text,
                passed: !!m,
                evidence: m ? `matched: ${m[0].slice(0, 80)}` : `no match for /${assertion['regex']}/${flags}`,
            };
        } catch (err) {
            return { text, passed: false, evidence: `invalid regex: ${(err as Error).message}` };
        }
    }
    if (typeof assertion['file_exists'] === 'string') {
        const p = assertion['file_exists'];
        const passed = existsSync(p);
        return {
            text,
            passed,
            evidence: passed ? `${p} exists` : `${p} does NOT exist`,
        };
    }
    return {
        text,
        passed: false,
        evidence: 'unverifiable assertion shape — use string, {contains}, {regex}, or {file_exists}',
    };
}

async function runEvalCase(c: EvalCase, timeoutMs: number): Promise<EvalCaseResult> {
    const { managementUrl } = await import('./schedule-client');
    const { loadMgmtToken } = await import('@flopsy/shared');
    const token = loadMgmtToken();
    let reply = '';
    let durationMs = 0;
    let runErr: string | undefined;
    try {
        const res = await fetch(managementUrl('/management/skill-eval-run'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify({ prompt: c.prompt, timeoutMs }),
            signal: AbortSignal.timeout(timeoutMs + 5000),
        });
        if (!res.ok) {
            runErr = `mgmt endpoint returned ${res.status}`;
        } else {
            const body = (await res.json()) as { reply?: string; durationMs?: number; error?: string };
            reply = body.reply ?? '';
            durationMs = body.durationMs ?? 0;
            if (body.error) runErr = body.error;
        }
    } catch (err) {
        runErr = err instanceof Error ? err.message : String(err);
    }
    const assertions = c.assertions.map((a) => gradeAssertion(reply, a));
    return { id: c.id, prompt: c.prompt, reply, durationMs, ...(runErr ? { error: runErr } : {}), assertions };
}

async function runEvalSet(cases: EvalCase[], timeoutMs: number): Promise<EvalCaseResult[]> {
    const results: EvalCaseResult[] = [];
    for (const c of cases) {
        process.stdout.write(dim(`  running eval ${c.id}... `));
        const r = await runEvalCase(c, timeoutMs);
        const passed = r.assertions.filter((a) => a.passed).length;
        const total = r.assertions.length;
        const verdict = r.error ? bad('error') : passed === total ? ok(`${passed}/${total}`) : warnLine(`${passed}/${total}`);
        console.log(`${verdict} ${dim(`(${r.durationMs}ms)`)}`);
        if (r.error) console.log(dim(`    error: ${r.error}`));
        for (const a of r.assertions) {
            const marker = a.passed ? ok('✓') : bad('✗');
            console.log(`    ${marker} ${a.text} ${dim(`— ${a.evidence}`)}`);
        }
        results.push(r);
    }
    return results;
}

function summarizeEvalResults(results: EvalCaseResult[]): EvalSummary {
    let total = 0;
    let passed = 0;
    let errors = 0;
    let totalMs = 0;
    for (const r of results) {
        if (r.error) errors++;
        totalMs += r.durationMs;
        for (const a of r.assertions) {
            total++;
            if (a.passed) passed++;
        }
    }
    return {
        totalCases: results.length,
        errors,
        totalAssertions: total,
        passedAssertions: passed,
        failedAssertions: total - passed,
        passRate: total === 0 ? 0 : passed / total,
        totalDurationMs: totalMs,
    };
}

function printEvalSummary(label: string, s: EvalSummary): void {
    const rate = (s.passRate * 100).toFixed(0);
    console.log('');
    console.log(`  ${label}: ${s.passedAssertions}/${s.totalAssertions} assertions  ${dim(`(${rate}% pass, ${s.errors} run errors, ${s.totalDurationMs}ms total)`)}`);
}

async function runPromoteEval(
    name: string,
    opts: { threshold: number; timeoutMs: number; dryRun: boolean },
): Promise<void> {
    const proposedDir = join(workspace.skillsProposed(), name);
    if (!existsSync(join(proposedDir, 'SKILL.md'))) {
        console.log(bad(`No proposed skill "${name}" at ${proposedDir}`));
        process.exit(1);
    }
    const evalsPath = join(proposedDir, 'evals', 'evals.json');
    if (!existsSync(evalsPath)) {
        console.log(bad(`No evals at ${evalsPath}. Auto-promotion requires evals/evals.json — see skill-creator.`));
        process.exit(1);
    }
    const cases = readEvalsFile(evalsPath);
    if (cases.length < 3) {
        console.log(bad(`Auto-promotion needs ≥3 eval cases; found ${cases.length}.`));
        process.exit(1);
    }

    console.log(section(`Promote eval — ${name} (${cases.length} cases, threshold delta=${opts.threshold})`));

    console.log(dim('\n  Phase 1: baseline (skill still in proposed/, NOT in catalog)'));
    const baseline = await runEvalSet(cases, opts.timeoutMs);
    const baselineSummary = summarizeEvalResults(baseline);
    printEvalSummary('without-skill', baselineSummary);

    const skillMd = readFileSync(join(proposedDir, 'SKILL.md'), 'utf-8');
    const categoryMatch = skillMd.match(/^category:\s*([a-zA-Z0-9_-]+)/m);
    const category = categoryMatch?.[1];
    const activeBase = workspace.skills();
    const activeDir = category ? join(activeBase, category, name) : join(activeBase, name);

    if (existsSync(activeDir)) {
        console.log(bad(`Active skill already exists at ${activeDir} — cannot promote.`));
        process.exit(1);
    }

    console.log(dim('\n  Phase 2: temporarily promoting proposed/ → active/'));
    mkdirSync(dirname(activeDir), { recursive: true });
    renameSync(proposedDir, activeDir);

    let withResults: EvalCaseResult[] = [];
    let revertReason: string | null = null;
    try {
        console.log(dim('\n  Phase 3: with-skill run'));
        withResults = await runEvalSet(cases, opts.timeoutMs);
    } catch (err) {
        revertReason = `with-skill run threw: ${err instanceof Error ? err.message : String(err)}`;
    }

    const withSummary = summarizeEvalResults(withResults);
    printEvalSummary('with-skill', withSummary);

    const delta = withSummary.passRate - baselineSummary.passRate;
    console.log('');
    console.log(`  delta: ${(delta * 100).toFixed(1)} pp (with - without)`);

    let regressionCount = 0;
    for (let i = 0; i < cases.length; i++) {
        const b = baseline[i];
        const w = withResults[i];
        if (!b || !w) continue;
        for (let j = 0; j < b.assertions.length; j++) {
            const ba = b.assertions[j];
            const wa = w.assertions[j];
            if (ba?.passed && wa && !wa.passed) regressionCount++;
        }
    }
    console.log(`  regressions: ${regressionCount} assertion${regressionCount === 1 ? '' : 's'} that passed without the skill now fail with it`);

    const meetsThreshold = delta >= opts.threshold;
    const passes = meetsThreshold && regressionCount === 0 && revertReason === null;

    if (passes && !opts.dryRun) {
        console.log('');
        console.log(ok(`✔ Promoted "${name}" to ${activeDir}`));
        console.log(dim('  Restart the gateway for the catalog to pick up the new skill.'));
        return;
    }

    console.log('');
    if (revertReason) {
        console.log(bad(`Reverting: ${revertReason}`));
    } else if (!meetsThreshold) {
        console.log(bad(`Reverting: delta ${(delta * 100).toFixed(1)} pp < threshold ${(opts.threshold * 100).toFixed(0)} pp`));
    } else if (regressionCount > 0) {
        console.log(bad(`Reverting: ${regressionCount} regression${regressionCount === 1 ? '' : 's'}`));
    } else if (opts.dryRun) {
        console.log(info(`Dry run — reverting even though criteria pass`));
    }
    try {
        renameSync(activeDir, proposedDir);
        console.log(dim(`  Restored ${proposedDir}`));
    } catch (err) {
        console.log(bad(`FAILED to revert ${activeDir} → ${proposedDir}: ${(err as Error).message}`));
        console.log(bad(`  MANUAL ACTION REQUIRED: move the directory back yourself.`));
    }
    process.exit(passes ? 0 : 1);
}
