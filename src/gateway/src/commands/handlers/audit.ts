import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { workspace, panel, row, STATE, type PanelSection } from '@flopsy/shared';
import type { CommandDef } from '../types';

type Severity = 'ok' | 'info' | 'warn' | 'fail';

interface Finding {
    readonly severity: Severity;
    readonly check: string;
    readonly detail: string;
}

const SECRETLIKE_KEYS = /(api_?key|secret|token|password|bearer)/i;

export const auditCommand: CommandDef = {
    name: 'audit',
    description: 'Static security scan of the local setup (no LLM).',
    handler: async () => {
        const findings: Finding[] = [];
        findings.push(...checkEnvFile());
        findings.push(...checkWorkspacePerms());
        findings.push(...checkCredentialFiles());
        findings.push(...checkConfigForPlaintext());
        findings.push(...checkGatewayBinding());
        findings.push(...checkGitignore());
        return { text: renderReport(findings) };
    },
};

function checkEnvFile(): Finding[] {
    const repoRoot = findRepoRoot();
    const envPath = repoRoot ? join(repoRoot, '.env') : null;
    if (!envPath || !existsSync(envPath)) {
        return [{ severity: 'info', check: '.env file', detail: 'not present (ok if using shell env)' }];
    }
    const mode = statSync(envPath).mode & 0o777;
    if (mode > 0o600) {
        return [{
            severity: 'fail',
            check: '.env permissions',
            detail: `${modeStr(mode)} — should be 0600. Run: chmod 600 ${envPath}`,
        }];
    }
    return [{ severity: 'ok', check: '.env permissions', detail: modeStr(mode) }];
}

function checkWorkspacePerms(): Finding[] {
    const root = workspace.root();
    if (!existsSync(root)) {
        return [{ severity: 'info', check: 'workspace dir', detail: `${root} not created yet` }];
    }
    const mode = statSync(root).mode & 0o777;
    if (mode > 0o700) {
        return [{
            severity: 'warn',
            check: 'workspace permissions',
            detail: `${root} is ${modeStr(mode)} — recommended 0700. Run: chmod 700 ${root}`,
        }];
    }
    return [{ severity: 'ok', check: 'workspace permissions', detail: `${root} → ${modeStr(mode)}` }];
}

function checkCredentialFiles(): Finding[] {
    const authDir = join(workspace.root(), 'auth');
    if (!existsSync(authDir)) {
        return [{ severity: 'info', check: 'stored credentials', detail: 'none yet (no providers authorized)' }];
    }
    const findings: Finding[] = [];
    try {
        const entries = readdirSync(authDir).filter((f) => f.endsWith('.json'));
        if (entries.length === 0) {
            return [{ severity: 'info', check: 'stored credentials', detail: 'auth dir empty' }];
        }
        for (const name of entries) {
            const full = join(authDir, name);
            const mode = statSync(full).mode & 0o777;
            if (mode > 0o600) {
                findings.push({
                    severity: 'fail',
                    check: `credential ${name}`,
                    detail: `${modeStr(mode)} exposes tokens. Run: chmod 600 ${full}`,
                });
            } else {
                findings.push({
                    severity: 'ok',
                    check: `credential ${name}`,
                    detail: modeStr(mode),
                });
            }
        }
    } catch (err) {
        findings.push({
            severity: 'warn',
            check: 'credentials scan',
            detail: `could not read auth dir: ${(err as Error).message}`,
        });
    }
    return findings;
}

function checkConfigForPlaintext(): Finding[] {
    const repoRoot = findRepoRoot();
    if (!repoRoot) return [];
    const configPath = join(repoRoot, 'flopsy.json5');
    if (!existsSync(configPath)) return [];
    const raw = readFileSync(configPath, 'utf-8');
    const hits: string[] = [];
    const lineRe = /["']([a-zA-Z_][a-zA-Z0-9_]*)["']\s*:\s*["']([^"']+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = lineRe.exec(raw)) !== null) {
        const [, key, value] = m;
        if (!SECRETLIKE_KEYS.test(key)) continue;
        if (value.startsWith('${') || value.length < 8) continue;
        if (/^(changeme|xxx+|your[-_]?(key|token|secret))/i.test(value)) continue;
        hits.push(`${key} = "${value.slice(0, 12)}…"`);
    }
    if (hits.length > 0) {
        return [{
            severity: 'fail',
            check: 'flopsy.json5 plaintext secrets',
            detail: `${hits.length} potential secret(s): ${hits.slice(0, 3).join(', ')}${hits.length > 3 ? ', …' : ''}. Move to .env + reference as \${NAME}`,
        }];
    }
    return [{ severity: 'ok', check: 'flopsy.json5 plaintext secrets', detail: 'none detected' }];
}

function checkGatewayBinding(): Finding[] {
    const repoRoot = findRepoRoot();
    if (!repoRoot) return [];
    const configPath = join(repoRoot, 'flopsy.json5');
    if (!existsSync(configPath)) return [];
    const raw = readFileSync(configPath, 'utf-8');
    const m = /"host"\s*:\s*"([^"]+)"/.exec(raw);
    if (!m) {
        return [{ severity: 'info', check: 'gateway binding', detail: 'host not set (defaults to 127.0.0.1)' }];
    }
    const host = m[1]!;
    if (host === '127.0.0.1' || host === 'localhost' || host === '::1') {
        return [{ severity: 'ok', check: 'gateway binding', detail: `${host} (loopback only)` }];
    }
    if (host === '0.0.0.0' || host === '::') {
        return [{
            severity: 'fail',
            check: 'gateway binding',
            detail: `${host} exposes the gateway to the LAN. Set gateway.host = "127.0.0.1" unless intentional.`,
        }];
    }
    return [{ severity: 'warn', check: 'gateway binding', detail: `${host} — verify this is intentional` }];
}

function checkGitignore(): Finding[] {
    const repoRoot = findRepoRoot();
    if (!repoRoot) return [];
    const gi = join(repoRoot, '.gitignore');
    if (!existsSync(gi)) {
        return [{
            severity: 'warn',
            check: '.gitignore',
            detail: 'missing — .env or .flopsy/ could be committed',
        }];
    }
    const raw = readFileSync(gi, 'utf-8');
    const missing: string[] = [];
    if (!/^\.env\s*$/m.test(raw)) missing.push('.env');
    if (!/\.flopsy/.test(raw)) missing.push('.flopsy/');
    if (missing.length > 0) {
        return [{
            severity: 'warn',
            check: '.gitignore',
            detail: `does not cover: ${missing.join(', ')} — risk of committing secrets`,
        }];
    }
    return [{ severity: 'ok', check: '.gitignore', detail: 'covers .env + .flopsy/' }];
}

function renderReport(findings: readonly Finding[]): string {
    const counts = { ok: 0, info: 0, warn: 0, fail: 0 };
    for (const f of findings) counts[f.severity]++;

    const headerBits: string[] = ['SECURITY AUDIT'];
    if (counts.fail > 0) headerBits.push(`${counts.fail} fail`);
    if (counts.warn > 0) headerBits.push(`${counts.warn} warn`);
    if (counts.ok > 0) headerBits.push(`${counts.ok} ok`);
    if (counts.info > 0) headerBits.push(`${counts.info} info`);

    const order: Severity[] = ['fail', 'warn', 'ok', 'info'];
    const sections: PanelSection[] = [];
    for (const sev of order) {
        const group = findings.filter((f) => f.severity === sev);
        if (group.length === 0) continue;
        sections.push({
            title: severityTitle(sev),
            lines: group.map((f) => row(f.check, `${glyphFor(f.severity)}  ${f.detail}`, 28)),
        });
    }

    return panel(sections, {
        header: headerBits.join(' · '),
        footer: 'Static scan only — for a threat-intel audit, ask aragorn in chat.',
    });
}

function glyphFor(s: Severity): string {
    switch (s) {
        case 'ok':   return STATE.ok;
        case 'info': return STATE.bullet;
        case 'warn': return STATE.warn;
        case 'fail': return STATE.fail;
    }
}

function severityTitle(s: Severity): string {
    switch (s) {
        case 'ok':   return 'ok';
        case 'info': return 'info';
        case 'warn': return 'warnings';
        case 'fail': return 'failures';
    }
}

function modeStr(mode: number): string {
    return '0' + mode.toString(8).padStart(3, '0');
}

function findRepoRoot(): string | null {
    let dir = process.cwd();
    for (;;) {
        if (existsSync(join(dir, 'flopsy.json5'))) return dir;
        const parent = dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}
