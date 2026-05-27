import { confirm, password as promptPassword } from '@inquirer/prompts';
import { Command } from 'commander';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspace } from '@flopsy/shared';
import {
    addRule,
    closeVaultDb,
    changeMasterPassword,
    deleteSecret,
    getRootCertPem,
    getSecret,
    initVault,
    isVaultInitialised,
    listAudit,
    listRules,
    listSecrets,
    listTokens,
    loadOrCreateRootCA,
    mintToken,
    openVaultDb,
    putSecret,
    removeRule,
    revokeToken,
    startVaultServer,
    unsealVault,
    VaultSealError,
    wipe,
} from '@flopsy/vault';
import { bad, info, ok, section, warn } from '../ui/pretty';

const KC_SVC = 'flopsy-vault';
const KC_ACC_MASTER = 'vault';
const KC_ACC_DAEMON_TOKEN = 'daemon-token';

function sanitizeDaemonEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
    const out: Record<string, string | undefined> = { ...env };
    for (const k of [
        'HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy',
        'ALL_PROXY', 'all_proxy',
        'GLOBAL_AGENT_HTTPS_PROXY', 'GLOBAL_AGENT_HTTP_PROXY', 'GLOBAL_AGENT_NO_PROXY',
        'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED',
        'FLOPSY_VAULT_MASTER_PASSWORD', 'FLOPSY_VAULT_MASTER_PASSWORD_FILE',
    ]) {
        delete out[k];
    }
    const nodeOpts = out.NODE_OPTIONS;
    if (typeof nodeOpts === 'string' && nodeOpts.length > 0) {
        const filtered = nodeOpts
            .split(/\s+/)
            .filter((tok) => !tok.includes('ca-hook'))
            .join(' ')
            .trim();
        if (filtered) out.NODE_OPTIONS = filtered;
        else delete out.NODE_OPTIONS;
    }
    return out;
}

function tryKeychain(): string | undefined {
    if (process.platform !== 'darwin') return undefined;
    try {
        const out = execFileSync('security', [
            'find-generic-password', '-s', KC_SVC, '-a', KC_ACC_MASTER, '-w',
        ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const trimmed = out.trim();
        return trimmed.length > 0 ? trimmed : undefined;
    } catch {
        return undefined;
    }
}

function tokenFilePath(): string {
    return resolvePath(workspace.state(), 'daemon.token');
}

function setKeychainToken(value: string): boolean {
    if (process.platform !== 'darwin') return false;
    try {
        execFileSync('security', [
            'add-generic-password', '-U', '-s', KC_SVC, '-a', KC_ACC_DAEMON_TOKEN, '-w', value,
        ], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

function getKeychainToken(): string | undefined {
    if (process.platform !== 'darwin') return undefined;
    try {
        const out = execFileSync('security', [
            'find-generic-password', '-s', KC_SVC, '-a', KC_ACC_DAEMON_TOKEN, '-w',
        ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const trimmed = out.trim();
        return trimmed.length > 0 ? trimmed : undefined;
    } catch {
        return undefined;
    }
}

function setStoredToken(value: string): { source: 'keychain' | 'file'; path?: string } {
    if (setKeychainToken(value)) return { source: 'keychain' };
    const p = tokenFilePath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, value, { mode: 0o600 });
    try { chmodSync(p, 0o600); } catch { /* */ }
    return { source: 'file', path: p };
}

function getStoredToken(): string | undefined {
    const kc = getKeychainToken();
    if (kc) return kc;
    const p = tokenFilePath();
    if (!existsSync(p)) return undefined;
    const mode = statSync(p).mode & 0o777;
    if ((mode & 0o077) !== 0) {
        console.log(bad(`refusing to read ${p}: permissions are 0${mode.toString(8)} — chmod 0600`));
        return undefined;
    }
    return readFileSync(p, 'utf8').trim();
}

function tryPasswordFile(): string | undefined {
    const path = process.env['FLOPSY_VAULT_MASTER_PASSWORD_FILE'];
    if (!path) return undefined;
    if (!existsSync(path)) {
        console.log(bad(`FLOPSY_VAULT_MASTER_PASSWORD_FILE points to a nonexistent path: ${path}`));
        process.exit(1);
    }
    const mode = statSync(path).mode & 0o777;
    if ((mode & 0o077) !== 0) {
        console.log(bad(`refusing to read ${path}: permissions are 0${mode.toString(8)} — chmod 0600`));
        process.exit(1);
    }
    return readFileSync(path, 'utf8').trim();
}

async function readPasswordFromStdin(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const onData = (c: Buffer): void => { chunks.push(c); };
        const onEnd = (): void => {
            process.stdin.removeListener('data', onData);
            process.stdin.removeListener('error', onError);
            const text = Buffer.concat(chunks).toString('utf8');
            const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
            resolve(firstLine);
        };
        const onError = (err: Error): void => {
            process.stdin.removeListener('data', onData);
            process.stdin.removeListener('end', onEnd);
            reject(err);
        };
        process.stdin.on('data', onData);
        process.stdin.once('end', onEnd);
        process.stdin.once('error', onError);
    });
}

async function readMasterPassword(reason: string, confirm = false): Promise<string> {
    const kc = tryKeychain();
    if (kc) return kc;

    const file = tryPasswordFile();
    if (file && file.length > 0) return file;

    const fromEnv = process.env['FLOPSY_VAULT_MASTER_PASSWORD'];
    if (fromEnv && fromEnv.length > 0) {
        process.stderr.write('[vault] warning: FLOPSY_VAULT_MASTER_PASSWORD is visible to other processes (ps, /proc). Prefer macOS Keychain or FLOPSY_VAULT_MASTER_PASSWORD_FILE.\n');
        delete process.env['FLOPSY_VAULT_MASTER_PASSWORD'];
        return fromEnv;
    }

    const pw = await promptPassword({ message: reason, mask: '*' });
    if (confirm) {
        const again = await promptPassword({ message: 'Confirm:', mask: '*' });
        if (pw !== again) {
            throw new Error('passwords do not match');
        }
    }
    return pw;
}

const SECRET_KEY_PATTERN = /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|PASSPHRASE|CLIENT_ID|PAT|BEARER|JWT/i;

function placeholderFor(name: string): string {
    return `__${name.toLowerCase()}__`;
}

function emitPlaceholderEnv(sourcePath: string, outPath: string, replacements: Map<string, string>): { emitted: number } {
    const original = readFileSync(sourcePath, 'utf-8');
    const lines = original.split('\n');
    let emitted = 0;
    const out = lines.map((line) => {
        const trimmed = line.trimStart();
        if (!trimmed || trimmed.startsWith('#')) return line;
        const eq = line.indexOf('=');
        if (eq < 0) return line;
        const key = line.slice(0, eq).trim();
        if (!replacements.has(key)) return line;
        emitted++;
        const prefix = line.slice(0, line.indexOf(key));
        return `${prefix}${key}=${replacements.get(key)!}`;
    });
    const tmp = `${outPath}.vault-emit.tmp`;
    writeFileSync(tmp, out.join('\n'), { mode: 0o600 });
    try {
        chmodSync(tmp, 0o600);
    } catch {
        /* */
    }
    renameSync(tmp, outPath);
    return { emitted };
}

function parseDotEnv(path: string): Record<string, string> {
    const out: Record<string, string> = {};
    const text = readFileSync(path, 'utf-8');
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim();
        let val = line.slice(eq + 1).trim();
        if (
            (val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))
        ) {
            val = val.slice(1, -1);
        }
        if (key && val) out[key] = val;
    }
    return out;
}

function findDotEnv(): string | undefined {
    const candidates: string[] = [];
    const fromEnv = process.env['FLOPSY_DOTENV'];
    if (fromEnv) candidates.push(resolvePath(fromEnv));
    const home = process.env['FLOPSY_HOME'];
    if (home) candidates.push(resolvePath(home, '..', '.env'));
    candidates.push(resolvePath(process.cwd(), '.env'));
    for (const c of candidates) {
        if (existsSync(c)) return c;
    }
    return undefined;
}

function parseDuration(s: string): number | undefined {
    const m = s.match(/^(\d+)\s*(s|m|h|d)$/);
    if (!m) return undefined;
    const value = parseInt(m[1]!, 10);
    switch (m[2]) {
        case 's': return value * 1_000;
        case 'm': return value * 60_000;
        case 'h': return value * 3_600_000;
        case 'd': return value * 86_400_000;
        default:  return undefined;
    }
}

function readStdin(): Promise<string> {
    return new Promise((resolve, reject) => {
        if (process.stdin.isTTY) {
            resolve('');
            return;
        }
        const chunks: Buffer[] = [];
        process.stdin.on('data', (c) => chunks.push(c as Buffer));
        process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').trim()));
        process.stdin.on('error', reject);
    });
}

type DaemonStartResult =
    | { ok: true; pid: number; host: string; mgmtPort: number; proxyPort: number }
    | { ok: false; error: string };

async function spawnVaultServerDaemon(opts: { host?: string; mgmtPort?: number; proxyPort?: number } = {}): Promise<DaemonStartResult> {
    const host = opts.host ?? '127.0.0.1';
    const mgmtPort = opts.mgmtPort ?? 18800;
    const proxyPort = opts.proxyPort ?? 18801;
    const pidFile = workspace.vaultPidFile();
    if (existsSync(pidFile)) {
        const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
        if (Number.isInteger(pid) && pid > 0) {
            try { process.kill(pid, 0); return { ok: false, error: `already running (pid ${pid})` }; }
            catch { try { unlinkSync(pidFile); } catch { /* */ } }
        }
    }
    const pw = await readMasterPassword('Master password:');
    const logFile = workspace.vaultLogFile();
    mkdirSync(dirname(logFile), { recursive: true });
    const out = openSync(logFile, 'a');
    const err = openSync(logFile, 'a');
    const childEnv = sanitizeDaemonEnv({ ...process.env, FLOPSY_VAULT_DAEMON_CHILD: '1' });
    delete childEnv.FLOPSY_VAULT_MASTER_PASSWORD;
    const child = spawn('flopsy', [
        'vault', 'server', 'start',
        '--host', host,
        '--mgmt-port', String(mgmtPort),
        '--proxy-port', String(proxyPort),
        '--foreground',
    ], {
        detached: true,
        stdio: ['pipe', out, err],
        env: childEnv,
    });
    if (child.stdin) {
        child.stdin.write(pw + '\n');
        child.stdin.end();
    }
    child.unref();
    for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 200));
        if (existsSync(pidFile)) break;
    }
    if (!existsSync(pidFile)) return { ok: false, error: `did not start — see ${logFile}` };
    return {
        ok: true,
        pid: parseInt(readFileSync(pidFile, 'utf-8').trim(), 10),
        host,
        mgmtPort,
        proxyPort,
    };
}

export function registerVaultCommands(root: Command): void {
    const v = root.command('vault').description('Encrypted credential store (AES-256-GCM + Argon2id)');

    v.command('setup')
        .description('One-shot wizard: init → import .env → CA export → mint daemon token → start server')
        .option('--env <path>', 'Path to .env (auto-detects if omitted)')
        .option('--label <name>', 'Daemon token label', 'flopsy-daemon')
        .option('--no-server', 'Skip starting the proxy server (you can run `flopsy vault server start` later)')
        .option('--no-keychain', 'On macOS, skip the offer to store the master password in Keychain')
        .action(async (opts: { env?: string; label: string; server: boolean; keychain: boolean }) => {
            const path = workspace.vaultDb();
            const isMac = process.platform === 'darwin';
            console.log(section('flopsy vault setup'));

            if (existsSync(path)) {
                const db = openVaultDb({ path });
                try {
                    if (isVaultInitialised(db)) {
                        console.log(info(`vault.db already initialised at ${path}`));
                    }
                } finally {
                    closeVaultDb(db);
                }
            } else {
                console.log('');
                console.log(info('step 1/5: initialise vault.db'));
                const pw = await readMasterPassword('Set master password:', true);
                const db = openVaultDb({ path });
                try {
                    initVault(db, pw);
                } finally {
                    closeVaultDb(db);
                }
                console.log(ok(`vault.db created at ${path}`));

                if (isMac && opts.keychain) {
                    const store = await confirm({
                        message: 'Store master password in macOS Keychain so subsequent commands don\'t prompt?',
                        default: true,
                    });
                    if (store) {
                        try {
                            execFileSync('security', [
                                'add-generic-password', '-U', '-s', 'flopsy-vault', '-a', 'vault', '-w', pw,
                            ], { stdio: 'ignore' });
                            console.log(ok('master password stored in Keychain'));
                        } catch (err) {
                            console.log(bad(`keychain add failed: ${err instanceof Error ? err.message : String(err)}`));
                        }
                    }
                }
            }

            console.log('');
            console.log(info('step 2/5: import secrets from .env'));
            const envFile = opts.env ? resolvePath(opts.env) : findDotEnv();
            if (!envFile || !existsSync(envFile)) {
                console.log(info(`no .env found; skipping import (you can run \`flopsy vault import-env <path> --emit\` later)`));
            } else {
                const parsed = parseDotEnv(envFile);
                const candidates = Object.entries(parsed).filter(([k]) => SECRET_KEY_PATTERN.test(k));
                if (candidates.length === 0) {
                    console.log(info(`no secret-looking keys in ${envFile}`));
                } else {
                    const pw = await readMasterPassword('Master password:');
                    const db = openVaultDb({ path });
                    let dek: Buffer | undefined;
                    let added = 0, skipped = 0, rulesAdded = 0;
                    try {
                        dek = unsealVault(db, pw);
                        const existing = new Set(listSecrets(db).map((r) => r.name));
                        const existingRules = new Set(listRules(db).map((r) => `${r.hostPattern}|${r.placeholder}`));
                        for (const [k, val] of candidates) {
                            if (existing.has(k)) { skipped++; }
                            else { putSecret(db, dek, k, val); added++; }
                            const placeholder = placeholderFor(k);
                            if (!existingRules.has(`*|${placeholder}`)) {
                                try {
                                    addRule(db, { hostPattern: '*', placeholder, secretName: k, injectInto: 'any' });
                                    addRule(db, { hostPattern: '*', placeholder, secretName: k, injectInto: 'any-query' });
                                    rulesAdded += 2;
                                } catch { /* */ }
                            }
                        }
                        const replacements = new Map(candidates.map(([k]) => [k, placeholderFor(k)]));
                        const outPath = resolvePath(dirname(envFile), 'vault.env');
                        const { emitted } = emitPlaceholderEnv(envFile, outPath, replacements);
                        console.log(ok(`imported ${added}, skipped ${skipped}, wrote ${emitted} placeholders to ${outPath}`));
                        console.log(ok(`added ${rulesAdded} substitution rule${rulesAdded === 1 ? '' : 's'}`));
                    } finally {
                        if (dek) wipe(dek);
                        closeVaultDb(db);
                    }
                }
            }

            console.log('');
            console.log(info('step 3/5: export root CA cert'));
            const caPath = resolvePath(workspace.state(), 'vault-ca.pem');
            const pw3 = await readMasterPassword('Master password:');
            const db3 = openVaultDb({ path });
            let dek3: Buffer | undefined;
            try {
                dek3 = unsealVault(db3, pw3);
                let certPem = getRootCertPem(db3, dek3);
                if (!certPem) certPem = loadOrCreateRootCA(db3, dek3).certPem;
                writeFileSync(caPath, certPem, { mode: 0o644 });
                console.log(ok(`wrote root CA to ${caPath}`));
            } finally {
                if (dek3) wipe(dek3);
                closeVaultDb(db3);
            }

            console.log('');
            console.log(info(`step 4/5: mint daemon token (label=${opts.label})`));
            const db4 = openVaultDb({ path });
            let tokenInfo: { rawToken: string; label: string } | undefined;
            try {
                const existing = listTokens(db4).find((t) => t.label === opts.label && !t.revoked);
                if (existing) {
                    console.log(info(`token "${opts.label}" already exists. Use \`flopsy vault token revoke ${opts.label}\` then re-run setup to rotate.`));
                } else {
                    const rules = listRules(db4);
                    const hostPatterns = Array.from(new Set(rules.map((r) => r.hostPattern))).filter((h) => h && h.length > 0);
                    const secretNames = Array.from(new Set(rules.map((r) => r.secretName))).filter((s) => s && s.length > 0);
                    const allowHosts = hostPatterns.length > 0 ? hostPatterns : ['*'];
                    const allowSecrets = secretNames.length > 0 ? secretNames : ['*'];
                    tokenInfo = mintToken(db4, {
                        label: opts.label,
                        allowHosts,
                        allowSecrets,
                    });
                    const stored = setStoredToken(tokenInfo.rawToken);
                    console.log(ok(`minted ${tokenInfo.label}`));
                    console.log(info(`scope: ${allowHosts.length} host${allowHosts.length === 1 ? '' : 's'}, ${allowSecrets.length} secret${allowSecrets.length === 1 ? '' : 's'}`));
                    if (stored.source === 'keychain') {
                        console.log(ok(`stored in macOS Keychain (service=${KC_SVC} account=${KC_ACC_DAEMON_TOKEN})`));
                    } else {
                        console.log(ok(`stored at ${stored.path} (0600)`));
                    }
                }
            } finally {
                closeVaultDb(db4);
            }

            console.log('');
            console.log(info('step 5/5: start the proxy server'));
            let serverStarted: DaemonStartResult | undefined;
            if (!opts.server) {
                console.log(info('skipped (--no-server). Run `flopsy vault server start` when ready.'));
            } else if (existsSync(workspace.vaultStateFile())) {
                console.log(info('server already running'));
            } else {
                serverStarted = await spawnVaultServerDaemon();
                if (serverStarted.ok) {
                    console.log(ok(`server started (pid ${serverStarted.pid}) — mgmt :${serverStarted.mgmtPort}  proxy :${serverStarted.proxyPort}`));
                } else {
                    console.log(bad(`failed to auto-start: ${serverStarted.error}`));
                    console.log(info('start manually with `flopsy vault server start`'));
                }
            }

            console.log('');
            console.log(section('done'));
            console.log(`  ${ok('vault.db')}   ${path}`);
            console.log(`  ${ok('vault.env')}  ${envFile ? resolvePath(dirname(envFile), 'vault.env') : '(none — no .env imported)'}`);
            console.log(`  ${ok('CA cert')}   ${caPath}`);
            if (tokenInfo) console.log(`  ${ok('token')}     ${tokenInfo.label} (stored — no copy-paste needed)`);
            console.log('');
            console.log('next:');
            console.log('  flopsy vault run -- npm start');
            console.log('  flopsy vault add <NAME>       # add one more credential later');
        });

    v.command('doctor')
        .description('Run a battery of vault health checks (db, server, token, ca, rules)')
        .action(async () => {
            const path = workspace.vaultDb();
            let pass = 0, warnCount = 0, fail = 0;
            const line = (status: 'ok' | 'warn' | 'fail', label: string, detail?: string) => {
                const text = `${label.padEnd(18)}${detail ? '  ' + detail : ''}`;
                const out = status === 'ok' ? ok(text) : status === 'warn' ? warn(text) : bad(text);
                console.log(`  ${out}`);
                if (status === 'ok') pass++; else if (status === 'warn') warnCount++; else fail++;
            };

            console.log(section('flopsy vault doctor'));

            if (!existsSync(path)) {
                line('fail', 'vault.db', `not found — run \`flopsy vault setup\``);
                console.log('');
                console.log(`  ${pass} ok, ${warnCount} warn, ${fail} fail`);
                process.exit(1);
            }
            let initialised = false;
            try {
                const db = openVaultDb({ path, readOnly: true });
                initialised = isVaultInitialised(db);
                closeVaultDb(db);
            } catch (err) {
                line('fail', 'vault.db', err instanceof Error ? err.message : String(err));
                console.log('');
                console.log(`  ${pass} ok, ${warnCount} warn, ${fail} fail`);
                process.exit(1);
            }
            if (!initialised) {
                line('fail', 'vault.db', 'exists but not initialised');
                console.log('');
                console.log(`  ${pass} ok, ${warnCount} warn, ${fail} fail`);
                process.exit(1);
            }
            line('ok', 'vault.db', path);

            let serverState: { host: string; mgmtPort: number; proxyPort: number; pid: number } | undefined;
            const stateFile = workspace.vaultStateFile();
            if (!existsSync(stateFile)) {
                line('warn', 'vault server', 'not running — `flopsy vault server start`');
            } else {
                try {
                    const raw = JSON.parse(readFileSync(stateFile, 'utf8')) as { host?: string; mgmtPort?: number; proxyPort?: number; pid?: number };
                    if (raw.host && Number.isInteger(raw.mgmtPort) && Number.isInteger(raw.proxyPort) && Number.isInteger(raw.pid)) {
                        serverState = { host: raw.host, mgmtPort: raw.mgmtPort!, proxyPort: raw.proxyPort!, pid: raw.pid! };
                        try {
                            process.kill(serverState.pid, 0);
                            line('ok', 'vault server', `pid ${serverState.pid}  mgmt :${serverState.mgmtPort}  proxy :${serverState.proxyPort}`);
                        } catch {
                            line('fail', 'vault server', `stale state file (pid ${serverState.pid} not alive)`);
                            serverState = undefined;
                        }
                    } else {
                        line('fail', 'vault server', 'state file malformed');
                    }
                } catch {
                    line('fail', 'vault server', 'state file unreadable');
                }
            }

            if (serverState) {
                const url = `http://${serverState.host}:${serverState.mgmtPort}/health`;
                try {
                    const ac = new AbortController();
                    const tid = setTimeout(() => ac.abort(), 2000);
                    const res = await fetch(url, { signal: ac.signal });
                    clearTimeout(tid);
                    if (res.ok) line('ok', 'mgmt /health', url);
                    else line('fail', 'mgmt /health', `${url} returned ${res.status}`);
                } catch (err) {
                    line('fail', 'mgmt /health', `${url} unreachable: ${err instanceof Error ? err.message : String(err)}`);
                }
            }

            const token = getStoredToken();
            if (!token) {
                line('warn', 'daemon token', 'not stored — `flopsy vault setup` mints one');
            } else {
                line('ok', 'daemon token', `stored (${token.startsWith('fv_agt_') ? 'valid prefix' : 'unknown prefix'})`);
            }

            const caPath = resolvePath(workspace.state(), 'vault-ca.pem');
            if (!existsSync(caPath)) {
                line('warn', 'CA cert', `not exported — \`flopsy vault ca export --out ${caPath}\``);
            } else {
                line('ok', 'CA cert', caPath);
            }

            try {
                const db = openVaultDb({ path, readOnly: true });
                const secrets = listSecrets(db);
                const rules = listRules(db);
                closeVaultDb(db);
                const ruled = new Set(rules.map((r) => r.placeholder));
                const orphans = secrets.filter((s) => !ruled.has(placeholderFor(s.name)));
                if (secrets.length === 0) {
                    line('warn', 'rules coverage', 'no secrets stored yet');
                } else if (orphans.length === 0) {
                    line('ok', 'rules coverage', `${secrets.length} secret${secrets.length === 1 ? '' : 's'}, ${rules.length} rule${rules.length === 1 ? '' : 's'}`);
                } else {
                    const preview = orphans.slice(0, 3).map((s) => s.name).join(', ');
                    line('warn', 'rules coverage', `${orphans.length} secret${orphans.length === 1 ? '' : 's'} without a rule: ${preview}${orphans.length > 3 ? '…' : ''}`);
                }
            } catch (err) {
                line('warn', 'rules coverage', err instanceof Error ? err.message : String(err));
            }

            console.log('');
            console.log(`  ${pass} ok, ${warnCount} warn, ${fail} fail`);
            if (fail > 0) process.exit(1);
        });

    v.command('init')
        .description('Create vault.db and set the master password')
        .action(async () => {
            const path = workspace.vaultDb();
            if (existsSync(path)) {
                const db = openVaultDb({ path });
                try {
                    if (isVaultInitialised(db)) {
                        console.log(bad(`vault already initialised at ${path}`));
                        console.log(info('use `flopsy vault change-password` to rotate the master password'));
                        process.exit(1);
                    }
                } finally {
                    closeVaultDb(db);
                }
            }
            const pw = await readMasterPassword('Set master password:', true);
            const db = openVaultDb({ path });
            try {
                initVault(db, pw);
            } finally {
                closeVaultDb(db);
            }
            console.log(section('flopsy vault'));
            console.log(ok(`initialised at ${path}`));
            console.log(info('keep the master password somewhere safe — there is no recovery'));
        });

    v.command('put <name>')
        .description('Store or update a secret (value from stdin or prompt)')
        .action(async (name: string) => {
            const path = workspace.vaultDb();
            if (!existsSync(path)) {
                console.log(bad('vault not initialised — run `flopsy vault init` first'));
                process.exit(1);
            }
            let value = '';
            if (!process.stdin.isTTY) {
                value = await readStdin();
            }
            if (!value) {
                value = await promptPassword({ message: `Value for ${name}:`, mask: '*' });
            }
            if (!value) {
                console.log(bad('empty value rejected'));
                process.exit(1);
            }
            const pw = await readMasterPassword('Master password:');
            const db = openVaultDb({ path });
            let dek: Buffer | undefined;
            try {
                dek = unsealVault(db, pw);
                putSecret(db, dek, name, value);
            } catch (err) {
                if (err instanceof VaultSealError) {
                    console.log(bad(err.message));
                    process.exit(1);
                }
                throw err;
            } finally {
                if (dek) wipe(dek);
                closeVaultDb(db);
            }
            console.log(ok(`stored ${name}`));
        });

    v.command('add <name>')
        .description('Add a secret + auto-create rule + append placeholder to vault.env (atomic)')
        .option('--host <pattern>', 'Host pattern for the rule', '*')
        .option('--into <target>', 'Injection target: any | header:<name> | body | query:<name>', 'any')
        .option('--placeholder <p>', 'Override placeholder (default: __name__)')
        .option('--no-rule', 'Skip creating the substitution rule')
        .option('--no-envfile', 'Skip appending placeholder to vault.env')
        .action(async (name: string, opts: { host: string; into: string; placeholder?: string; rule: boolean; envfile: boolean }) => {
            const path = workspace.vaultDb();
            if (!existsSync(path)) {
                console.log(bad('vault not initialised — run `flopsy vault setup` first'));
                process.exit(1);
            }
            let value = '';
            if (!process.stdin.isTTY) value = await readStdin();
            if (!value) value = await promptPassword({ message: `Value for ${name}:`, mask: '*' });
            if (!value) {
                console.log(bad('empty value rejected'));
                process.exit(1);
            }
            const pw = await readMasterPassword('Master password:');
            const placeholder = opts.placeholder ?? placeholderFor(name);
            const db = openVaultDb({ path });
            let dek: Buffer | undefined;
            let ruleAdded = false;
            try {
                dek = unsealVault(db, pw);
                putSecret(db, dek, name, value);
                if (opts.rule !== false) {
                    const existing = listRules(db);
                    const headerRule = existing.find((r) => r.hostPattern === opts.host && r.placeholder === placeholder && r.injectInto === (opts.into as string));
                    if (!headerRule) {
                        addRule(db, { hostPattern: opts.host, placeholder, secretName: name, injectInto: opts.into as never });
                        ruleAdded = true;
                    }
                    if (opts.into === 'any' || opts.into === 'any-header') {
                        const queryRule = existing.find((r) => r.hostPattern === opts.host && r.placeholder === placeholder && r.injectInto === 'any-query');
                        if (!queryRule) {
                            addRule(db, { hostPattern: opts.host, placeholder, secretName: name, injectInto: 'any-query' as never });
                            ruleAdded = true;
                        }
                    }
                }
            } catch (err) {
                if (err instanceof VaultSealError) {
                    console.log(bad(err.message));
                    process.exit(1);
                }
                throw err;
            } finally {
                if (dek) wipe(dek);
                closeVaultDb(db);
            }
            console.log(ok(`stored ${name}`));
            if (ruleAdded) console.log(ok(`added rule  ${opts.host} → ${placeholder} (into ${opts.into})`));

            if (opts.envfile !== false) {
                const dotenv = findDotEnv();
                const vaultEnvPath = dotenv ? resolvePath(dirname(dotenv), 'vault.env') : resolvePath(process.cwd(), 'vault.env');
                if (existsSync(vaultEnvPath)) {
                    const text = readFileSync(vaultEnvPath, 'utf8');
                    const present = text.split('\n').some((l) => l.trimStart().startsWith(`${name}=`));
                    if (!present) {
                        const newText = text.endsWith('\n') ? `${text}${name}=${placeholder}\n` : `${text}\n${name}=${placeholder}\n`;
                        writeFileSync(vaultEnvPath, newText, { mode: 0o600 });
                        console.log(ok(`appended ${name}=${placeholder} to ${vaultEnvPath}`));
                    } else {
                        console.log(info(`${name} already present in ${vaultEnvPath}`));
                    }
                } else {
                    console.log(info(`vault.env not found — skipping (run \`flopsy vault import-env --emit\` to bootstrap one)`));
                }
            }
        });

    v.command('list')
        .description('List secret names (values are never printed)')
        .action(() => {
            const path = workspace.vaultDb();
            if (!existsSync(path)) {
                console.log(bad('vault not initialised — run `flopsy vault init` first'));
                process.exit(1);
            }
            const db = openVaultDb({ path, readOnly: true });
            try {
                const rows = listSecrets(db);
                if (rows.length === 0) {
                    console.log(info('no secrets stored — `flopsy vault put <name>` to add one'));
                    return;
                }
                console.log(section(`flopsy vault — ${rows.length} secret${rows.length === 1 ? '' : 's'}`));
                for (const r of rows) {
                    const updated = new Date(r.updatedAt).toISOString();
                    console.log(`  ${r.name.padEnd(32)}  ${updated}`);
                }
            } finally {
                closeVaultDb(db);
            }
        });

    v.command('get <name>')
        .description('Print a secret value to stdout (use sparingly)')
        .action(async (name: string) => {
            const path = workspace.vaultDb();
            if (!existsSync(path)) {
                console.log(bad('vault not initialised — run `flopsy vault init` first'));
                process.exit(1);
            }
            const pw = await readMasterPassword('Master password:');
            const db = openVaultDb({ path, readOnly: true });
            let dek: Buffer | undefined;
            try {
                dek = unsealVault(db, pw);
                const value = getSecret(db, dek, name);
                if (value === undefined) {
                    console.log(bad(`no such secret: ${name}`));
                    process.exit(1);
                }
                process.stdout.write(value);
                if (process.stdout.isTTY) process.stdout.write('\n');
            } catch (err) {
                if (err instanceof VaultSealError) {
                    console.log(bad(err.message));
                    process.exit(1);
                }
                throw err;
            } finally {
                if (dek) wipe(dek);
                closeVaultDb(db);
            }
        });

    v.command('rm <name>')
        .description('Delete a secret')
        .action((name: string) => {
            const path = workspace.vaultDb();
            if (!existsSync(path)) {
                console.log(bad('vault not initialised — run `flopsy vault init` first'));
                process.exit(1);
            }
            const db = openVaultDb({ path });
            try {
                const removed = deleteSecret(db, name);
                if (!removed) {
                    console.log(bad(`no such secret: ${name}`));
                    process.exit(1);
                }
            } finally {
                closeVaultDb(db);
            }
            console.log(ok(`removed ${name}`));
        });

    v.command('import-env [path]')
        .description('Import all secret-looking keys from .env into the vault')
        .option('--file <path>', 'Path to .env (alternative to positional arg; defaults to FLOPSY_DOTENV / sibling of flopsy.json5 / cwd/.env)')
        .option('--all', 'Import every key, not just those matching KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL', false)
        .option('--overwrite', 'Replace existing vault entries with .env values', false)
        .option('--emit [path]', 'After import, also write a placeholder file (default: vault.env next to source .env)')
        .option('--yes', 'Skip confirmation prompt', false)
        .action(async (pathArg: string | undefined, opts: { file?: string; all?: boolean; overwrite?: boolean; emit?: string | boolean; yes?: boolean }) => {
            const path = workspace.vaultDb();
            if (!existsSync(path)) {
                console.log(bad('vault not initialised — run `flopsy vault init` first'));
                process.exit(1);
            }
            const explicit = pathArg ?? opts.file;
            const envFile = explicit ? resolvePath(explicit) : findDotEnv();
            if (!envFile || !existsSync(envFile)) {
                console.log(bad(`.env not found${opts.file ? ` at ${opts.file}` : ''} — pass --file <path>`));
                process.exit(1);
            }
            const parsed = parseDotEnv(envFile);
            const candidates = Object.entries(parsed).filter(([k]) => opts.all || SECRET_KEY_PATTERN.test(k));
            if (candidates.length === 0) {
                console.log(info(`no secret-looking keys found in ${envFile} (try --all)`));
                return;
            }
            console.log(section(`flopsy vault — import from ${envFile}`));
            for (const [k] of candidates) {
                console.log(`  ${k}`);
            }
            console.log('');
            if (!opts.yes) {
                const proceed = await confirm({
                    message: `import ${candidates.length} key${candidates.length === 1 ? '' : 's'}${opts.overwrite ? ' (overwriting existing)' : ' (skipping existing)'}?`,
                    default: true,
                });
                if (!proceed) {
                    console.log(info('aborted'));
                    return;
                }
            }
            const pw = await readMasterPassword('Master password:');
            const db = openVaultDb({ path });
            let dek: Buffer | undefined;
            let added = 0;
            let skipped = 0;
            try {
                dek = unsealVault(db, pw);
                const existing = new Set(listSecrets(db).map((r) => r.name));
                for (const [k, v] of candidates) {
                    if (existing.has(k) && !opts.overwrite) {
                        skipped++;
                        continue;
                    }
                    putSecret(db, dek, k, v);
                    added++;
                }
            } catch (err) {
                if (err instanceof VaultSealError) {
                    console.log(bad(err.message));
                    process.exit(1);
                }
                throw err;
            } finally {
                if (dek) wipe(dek);
                closeVaultDb(db);
            }
            console.log(ok(`imported ${added}, skipped ${skipped} (already present — use --overwrite to replace)`));
            if (opts.emit !== undefined) {
                const outPath = typeof opts.emit === 'string'
                    ? resolvePath(opts.emit)
                    : resolvePath(dirname(envFile), 'vault.env');
                const replacements = new Map<string, string>();
                for (const [k] of candidates) {
                    replacements.set(k, placeholderFor(k));
                }
                const { emitted } = emitPlaceholderEnv(envFile, outPath, replacements);
                console.log(ok(`wrote ${emitted} placeholder${emitted === 1 ? '' : 's'} to ${outPath}`));

                const ruleDb = openVaultDb({ path });
                let rulesAdded = 0;
                try {
                    const existing = new Set(listRules(ruleDb).map((r) => `${r.hostPattern}|${r.placeholder}|${r.injectInto}`));
                    for (const [k] of candidates) {
                        const placeholder = placeholderFor(k);
                        for (const into of ['any', 'any-query'] as const) {
                            const key = `*|${placeholder}|${into}`;
                            if (existing.has(key)) continue;
                            try {
                                addRule(ruleDb, {
                                    hostPattern: '*',
                                    placeholder,
                                    secretName: k,
                                    injectInto: into,
                                });
                                rulesAdded++;
                            } catch { /* invalid name etc */ }
                        }
                    }
                } finally {
                    closeVaultDb(ruleDb);
                }
                if (rulesAdded > 0) {
                    console.log(ok(`auto-added ${rulesAdded} substitution rule${rulesAdded === 1 ? '' : 's'} (host=*, into=any+any-query)`));
                }
                console.log(info('source .env is untouched. Point your agent at the new file (e.g. `dotenv -e vault.env <cmd>`)'));
            } else {
                console.log(info('source .env was NOT modified; pass --emit to also write a vault.env placeholder file'));
            }
        });

    v.command('stats')
        .description('Aggregated activity stats from the audit log (last 24h by default)')
        .option('--since <duration>', 'Window (e.g. 24h, 7d); default 24h', '24h')
        .action((opts: { since?: string }) => {
            const path = workspace.vaultDb();
            if (!existsSync(path)) {
                console.log(bad('vault not initialised — run `flopsy vault init` first'));
                process.exit(1);
            }
            const sinceMs = opts.since ? parseDuration(opts.since) : 24 * 3_600_000;
            const cutoff = sinceMs ? Date.now() - sinceMs : 0;
            const db = openVaultDb({ path, readOnly: true });
            try {
                const rows = listAudit(db, { sinceMs: cutoff, limit: 1000 });
                if (rows.length === 0) {
                    console.log(info(`no audit events in the last ${opts.since}`));
                    return;
                }
                const byAction = new Map<string, number>();
                const byOutcome = new Map<string, number>();
                const byActor = new Map<string, number>();
                const byResource = new Map<string, number>();
                for (const r of rows) {
                    byAction.set(r.action, (byAction.get(r.action) ?? 0) + 1);
                    byOutcome.set(r.outcome, (byOutcome.get(r.outcome) ?? 0) + 1);
                    byActor.set(r.actorToken, (byActor.get(r.actorToken) ?? 0) + 1);
                    if (r.resource) byResource.set(r.resource, (byResource.get(r.resource) ?? 0) + 1);
                }
                const printGroup = (title: string, m: Map<string, number>, max = 10) => {
                    if (m.size === 0) return;
                    console.log('');
                    console.log(`  ${title}`);
                    const sorted = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, max);
                    for (const [k, v] of sorted) {
                        const tag = k === 'success' ? ok(k) : k.startsWith('denied') || k.startsWith('error') ? bad(k) : k;
                        console.log(`    ${String(v).padStart(5)}  ${tag}`);
                    }
                };
                console.log(section(`flopsy vault stats — last ${opts.since}  (${rows.length} event${rows.length === 1 ? '' : 's'})`));
                printGroup('by action', byAction);
                printGroup('by outcome', byOutcome);
                printGroup('by actor (top 10)', byActor);
                printGroup('by resource (top 10)', byResource);
            } finally {
                closeVaultDb(db);
            }
        });

    v.command('audit')
        .description('Show the tamper-evident audit log of credential access')
        .option('--since <duration>', 'Limit to events since N (e.g. 24h, 7d, 30m); default = all')
        .option('--limit <n>', 'Max rows', (s) => parseInt(s, 10), 50)
        .option('--actor <token>', 'Filter by actor (who)')
        .option('--action <name>', 'Filter by action (e.g. credential.read)')
        .action((opts: { since?: string; limit?: number; actor?: string; action?: string }) => {
            const path = workspace.vaultDb();
            if (!existsSync(path)) {
                console.log(bad('vault not initialised — run `flopsy vault init` first'));
                process.exit(1);
            }
            const sinceMs = opts.since ? parseDuration(opts.since) : undefined;
            const db = openVaultDb({ path, readOnly: true });
            try {
                const rows = listAudit(db, {
                    sinceMs: sinceMs ? Date.now() - sinceMs : undefined,
                    limit: opts.limit ?? 50,
                    actorToken: opts.actor,
                    action: opts.action,
                });
                if (rows.length === 0) {
                    console.log(info('no audit events match'));
                    return;
                }
                console.log(section(`flopsy vault audit — ${rows.length} event${rows.length === 1 ? '' : 's'}`));
                for (const r of rows) {
                    const ts = new Date(r.tsMs).toISOString().replace('T', ' ').slice(0, 19);
                    const out = r.outcome === 'success' ? ok(r.outcome) : bad(r.outcome);
                    const res = r.resource ?? '';
                    console.log(`  ${ts}  ${r.action.padEnd(18)}  ${res.padEnd(28)}  ${out}  ${r.actorToken}`);
                }
            } finally {
                closeVaultDb(db);
            }
        });

    const tok = v.command('token').description('Manage scoped tokens for external agents');

    tok.command('mint')
        .description('Mint a new scoped token for an external agent')
        .requiredOption('--label <name>', 'Token label (e.g. my-agent)')
        .option('--ttl <duration>', 'TTL (e.g. 30d, 24h); default = no expiry')
        .option('--allow-hosts <list>', 'Comma-separated host patterns (e.g. api.anthropic.com,*.github.com)')
        .option('--allow-secrets <list>', 'Comma-separated secret name patterns (e.g. ANTHROPIC_API_KEY)')
        .action((opts: { label: string; ttl?: string; allowHosts?: string; allowSecrets?: string }) => {
            const path = workspace.vaultDb();
            if (!existsSync(path)) {
                console.log(bad('vault not initialised — run `flopsy vault init` first'));
                process.exit(1);
            }
            const ttlMs = opts.ttl ? parseDuration(opts.ttl) : undefined;
            if (opts.ttl && ttlMs === undefined) {
                console.log(bad(`invalid TTL: ${opts.ttl}`));
                process.exit(1);
            }
            const db = openVaultDb({ path });
            try {
                const result = mintToken(db, {
                    label: opts.label,
                    ttlMs,
                    allowHosts: opts.allowHosts?.split(',').map((s) => s.trim()).filter(Boolean) ?? [],
                    allowSecrets: opts.allowSecrets?.split(',').map((s) => s.trim()).filter(Boolean) ?? [],
                });
                console.log(section('flopsy vault token'));
                console.log(ok(`minted ${result.label}${result.expiresAt ? ` (expires ${new Date(result.expiresAt).toISOString()})` : ''}`));
                console.log('');
                console.log(`  ${result.rawToken}`);
                console.log('');
                console.log(info('this token is shown ONCE. Store it somewhere safe — it cannot be recovered.'));
            } finally {
                closeVaultDb(db);
            }
        });

    tok.command('list')
        .description('List all tokens (raw token values are never stored)')
        .action(() => {
            const path = workspace.vaultDb();
            if (!existsSync(path)) {
                console.log(bad('vault not initialised — run `flopsy vault init` first'));
                process.exit(1);
            }
            const db = openVaultDb({ path, readOnly: true });
            try {
                const rows = listTokens(db);
                if (rows.length === 0) {
                    console.log(info('no tokens minted — `flopsy vault token mint --label <name>` to create one'));
                    return;
                }
                console.log(section(`flopsy vault tokens — ${rows.length}`));
                for (const r of rows) {
                    const status = r.revoked ? bad('revoked') : r.expiresAt && r.expiresAt < Date.now() ? bad('expired') : ok('active');
                    const exp = r.expiresAt ? new Date(r.expiresAt).toISOString().slice(0, 19).replace('T', ' ') : 'no expiry';
                    console.log(`  ${r.label.padEnd(24)}  ${status.padEnd(20)}  ${exp}`);
                }
            } finally {
                closeVaultDb(db);
            }
        });

    tok.command('revoke <label>')
        .description('Revoke a token by label (becomes unusable; remains in audit trail)')
        .action((label: string) => {
            const path = workspace.vaultDb();
            if (!existsSync(path)) {
                console.log(bad('vault not initialised — run `flopsy vault init` first'));
                process.exit(1);
            }
            const db = openVaultDb({ path });
            try {
                if (!revokeToken(db, label)) {
                    console.log(bad(`no such active token: ${label}`));
                    process.exit(1);
                }
            } finally {
                closeVaultDb(db);
            }
            console.log(ok(`revoked ${label}`));
        });

    const rule = v.command('rule').description('Manage service rules (host → credential substitution)');

    rule.command('add')
        .description('Add a service rule for the MITM proxy')
        .requiredOption('--host <pattern>', 'Host pattern (e.g. api.anthropic.com, *.openai.com, * for any)')
        .requiredOption('--placeholder <text>', 'Placeholder string the agent will use (e.g. __anthropic_api_key__)')
        .requiredOption('--secret <name>', 'Vault secret name to substitute (e.g. ANTHROPIC_API_KEY)')
        .option('--into <target>', 'Where to inject: any | header:<name> | body | query:<name> (default: any)', 'any')
        .action((opts: { host: string; placeholder: string; secret: string; into: string }) => {
            const path = workspace.vaultDb();
            if (!existsSync(path)) {
                console.log(bad('vault not initialised — run `flopsy vault init` first'));
                process.exit(1);
            }
            const db = openVaultDb({ path });
            try {
                const id = addRule(db, {
                    hostPattern: opts.host,
                    placeholder: opts.placeholder,
                    secretName: opts.secret,
                    injectInto: opts.into,
                });
                console.log(ok(`rule added: ${id} (${opts.host} -> ${opts.secret} via ${opts.into})`));
            } catch (err) {
                console.log(bad(err instanceof Error ? err.message : String(err)));
                process.exit(1);
            } finally {
                closeVaultDb(db);
            }
        });

    rule.command('list')
        .description('List all service rules')
        .action(() => {
            const path = workspace.vaultDb();
            if (!existsSync(path)) {
                console.log(bad('vault not initialised — run `flopsy vault init` first'));
                process.exit(1);
            }
            const db = openVaultDb({ path, readOnly: true });
            try {
                const rows = listRules(db);
                if (rows.length === 0) {
                    console.log(info('no rules — `flopsy vault rule add` to create one'));
                    return;
                }
                console.log(section(`flopsy vault rules — ${rows.length}`));
                for (const r of rows) {
                    console.log(`  ${r.id}  ${r.hostPattern.padEnd(28)}  ${r.placeholder.padEnd(28)}  ${r.secretName.padEnd(24)}  ${r.injectInto}`);
                }
            } finally {
                closeVaultDb(db);
            }
        });

    rule.command('rm <id>')
        .description('Remove a service rule by id (shown in `vault rule list`)')
        .action((id: string) => {
            const path = workspace.vaultDb();
            if (!existsSync(path)) {
                console.log(bad('vault not initialised — run `flopsy vault init` first'));
                process.exit(1);
            }
            const db = openVaultDb({ path });
            try {
                if (!removeRule(db, id)) {
                    console.log(bad(`no such rule: ${id}`));
                    process.exit(1);
                }
            } finally {
                closeVaultDb(db);
            }
            console.log(ok(`removed rule ${id}`));
        });

    const srv = v.command('server').description('Vault proxy server (defaults: mgmt 18800, proxy 18801; daemonised by default)');

    srv.command('start', { isDefault: true })
        .description('Start the vault server as a background daemon (logs to .flopsy/logs/vault.log)')
        .option('--host <addr>', 'Bind address', '127.0.0.1')
        .option('--mgmt-port <n>', 'Mgmt HTTP port', (s) => parseInt(s, 10), 18800)
        .option('--proxy-port <n>', 'CONNECT proxy port', (s) => parseInt(s, 10), 18801)
        .option('--foreground', 'Run in the foreground (do not daemonise)', false)
        .action(async (opts: { host: string; mgmtPort: number; proxyPort: number; foreground?: boolean }) => {
            const path = workspace.vaultDb();
            if (!existsSync(path)) {
                console.log(bad('vault not initialised — run `flopsy vault init` first'));
                process.exit(1);
            }
            const pidFile = workspace.vaultPidFile();
            if (existsSync(pidFile)) {
                const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
                if (Number.isInteger(pid) && pid > 0) {
                    try {
                        process.kill(pid, 0);
                        console.log(bad(`vault server already running (pid ${pid}) — stop it with \`flopsy vault server stop\``));
                        process.exit(1);
                    } catch {
                        unlinkSync(pidFile);
                    }
                }
            }

            if (opts.foreground || process.env.FLOPSY_VAULT_DAEMON_CHILD === '1') {
                for (const k of [
                    'HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy',
                    'ALL_PROXY', 'all_proxy',
                    'GLOBAL_AGENT_HTTPS_PROXY', 'GLOBAL_AGENT_HTTP_PROXY', 'GLOBAL_AGENT_NO_PROXY',
                ]) {
                    delete process.env[k];
                }
                process.on('uncaughtException', (err) => {
                    process.stderr.write(`[vault-server] uncaughtException: ${err.stack ?? err}\n`);
                    try { unlinkSync(workspace.vaultPidFile()); } catch {}
                    try { unlinkSync(workspace.vaultStateFile()); } catch {}
                    process.exit(1);
                });
                process.on('unhandledRejection', (reason) => {
                    process.stderr.write(`[vault-server] unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}\n`);
                });
                process.on('exit', (code) => {
                    process.stderr.write(`[vault-server] exit code=${code}\n`);
                });
                if (process.env.FLOPSY_VAULT_DAEMON_CHILD === '1') {
                    process.on('SIGHUP', () => {
                        process.stderr.write('[vault-server] SIGHUP ignored (daemonised)\n');
                    });
                    process.on('SIGPIPE', () => {
                        process.stderr.write('[vault-server] SIGPIPE ignored\n');
                    });
                    const keepAlive = setInterval(() => {}, 60_000);
                    keepAlive.ref?.();
                }
                const pw = process.env.FLOPSY_VAULT_DAEMON_CHILD === '1'
                    ? await readPasswordFromStdin()
                    : await readMasterPassword('Master password:');
                let handle;
                try {
                    handle = await startVaultServer({
                        vaultDbPath: path,
                        masterPassword: pw,
                        host: opts.host,
                        mgmtPort: opts.mgmtPort,
                        proxyPort: opts.proxyPort,
                    });
                } catch (err) {
                    if (err instanceof VaultSealError) {
                        console.log(bad(err.message));
                        process.exit(1);
                    }
                    throw err;
                }
                try { unlinkSync(pidFile); } catch { /* */ }
                writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
                try { chmodSync(pidFile, 0o600); } catch { /* */ }
                const stateFile = workspace.vaultStateFile();
                try { unlinkSync(stateFile); } catch { /* */ }
                writeFileSync(stateFile, JSON.stringify({
                    pid: process.pid,
                    host: opts.host,
                    mgmtPort: opts.mgmtPort,
                    proxyPort: opts.proxyPort,
                    startedAt: Date.now(),
                }), { mode: 0o600 });
                try { chmodSync(stateFile, 0o600); } catch { /* */ }
                console.log(section('flopsy vault server'));
                console.log(ok(`mgmt   http://${handle.mgmt.address()}`));
                console.log(ok(`proxy  https://${handle.proxy.address()}  (HTTPS_PROXY target, TLS-wrapped)`));
                console.log(info(opts.foreground ? 'CTRL+C to stop' : 'daemonised'));
                const shutdown = async (signal: string) => {
                    try { unlinkSync(pidFile); } catch { /* */ }
                    try { unlinkSync(workspace.vaultStateFile()); } catch { /* */ }
                    await handle.stop();
                    process.exit(0);
                };
                process.on('SIGINT', () => void shutdown('SIGINT'));
                process.on('SIGTERM', () => void shutdown('SIGTERM'));
                await new Promise(() => { /* hold */ });
                return;
            }

            const pw = await readMasterPassword('Master password:');
            const logFile = workspace.vaultLogFile();
            mkdirSync(dirname(logFile), { recursive: true });
            const out = openSync(logFile, 'a');
            const err = openSync(logFile, 'a');
            const childEnv = sanitizeDaemonEnv({ ...process.env, FLOPSY_VAULT_DAEMON_CHILD: '1' });
            delete childEnv.FLOPSY_VAULT_MASTER_PASSWORD;
            const child = spawn('flopsy', [
                'vault', 'server', 'start',
                '--host', opts.host,
                '--mgmt-port', String(opts.mgmtPort),
                '--proxy-port', String(opts.proxyPort),
                '--foreground',
            ], {
                detached: true,
                stdio: ['pipe', out, err],
                env: childEnv,
            });
            if (child.stdin) {
                child.stdin.write(pw + '\n');
                child.stdin.end();
            }
            child.unref();
            for (let i = 0; i < 30; i++) {
                await new Promise((resolve) => setTimeout(resolve, 200));
                if (existsSync(pidFile)) break;
            }
            if (!existsSync(pidFile)) {
                console.log(bad(`vault server did not start — see ${logFile}`));
                process.exit(1);
            }
            console.log(section('flopsy vault server'));
            console.log(ok(`started pid ${readFileSync(pidFile, 'utf-8').trim()}`));
            console.log(`  mgmt   http://${opts.host}:${opts.mgmtPort}`);
            console.log(`  proxy  https://${opts.host}:${opts.proxyPort}`);
            console.log(`  logs   ${logFile}`);
            console.log(info('stop with `flopsy vault server stop`'));
        });

    srv.command('stop')
        .description('Stop a running vault server (via pidfile)')
        .action(() => {
            const pidFile = workspace.vaultPidFile();
            if (!existsSync(pidFile)) {
                console.log(info('vault server not running (no pidfile)'));
                return;
            }
            const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
            if (!Number.isInteger(pid) || pid <= 0) {
                console.log(bad('stale pidfile — removing'));
                try { unlinkSync(pidFile); } catch { /* */ }
                return;
            }
            try {
                process.kill(pid, 'SIGTERM');
                console.log(ok(`sent SIGTERM to pid ${pid}`));
            } catch (err) {
                const code = (err as NodeJS.ErrnoException).code;
                if (code === 'ESRCH') {
                    console.log(info(`pid ${pid} already gone — cleaning stale pidfile`));
                    try { unlinkSync(pidFile); } catch { /* */ }
                    try { unlinkSync(workspace.vaultStateFile()); } catch { /* */ }
                    return;
                }
                console.log(bad(`failed to signal pid ${pid}: ${err instanceof Error ? err.message : String(err)}`));
                try { unlinkSync(pidFile); } catch { /* */ }
                try { unlinkSync(workspace.vaultStateFile()); } catch { /* */ }
                process.exit(1);
            }
        });

    srv.command('status')
        .description('Show running vault server status')
        .action(() => {
            const pidFile = workspace.vaultPidFile();
            if (!existsSync(pidFile)) {
                console.log(info('vault server not running'));
                return;
            }
            const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
            try {
                process.kill(pid, 0);
                console.log(ok(`running (pid ${pid})`));
            } catch {
                console.log(bad(`stale pidfile (pid ${pid} not alive) — removing`));
                try { unlinkSync(pidFile); } catch { /* */ }
            }
        });

    v.command('run')
        .description('Exec a command with vault-managed env (mints a per-run token by default; auto-sets HTTPS_PROXY, CA, vault.env)')
        .option('--no-server', 'Do not auto-start the vault server if it is not running')
        .option('--no-envfile', 'Do not auto-source vault.env placeholder values')
        .option('--envfile <path>', 'Path to a vault.env-style placeholder file')
        .option('--ttl <duration>', 'TTL for the per-run token (e.g. 1h, 30m, 5m); default = 1h')
        .option('--hosts <list>', 'Comma-separated allow-hosts scope for the per-run token (default: *)')
        .option('--secrets <list>', 'Comma-separated allow-secrets scope for the per-run token (default: *)')
        .option('--reuse-token', 'Reuse the long-lived daemon token instead of minting per-run (less secure)')
        .argument('<command...>', 'Command and args to exec (use `--` to pass flags through)')
        .allowUnknownOption()
        .action(async (cmdArgs: string[], opts: { server: boolean; envfile: string | boolean | undefined; ttl?: string; hosts?: string; secrets?: string; reuseToken?: boolean }) => {
            if (!cmdArgs || cmdArgs.length === 0) {
                console.log(bad('usage: flopsy vault run -- <cmd> [args...]'));
                process.exit(1);
            }
            const path = workspace.vaultDb();
            if (!existsSync(path)) {
                console.log(bad('vault not initialised — run `flopsy vault setup` first'));
                process.exit(1);
            }

            const stateFile = workspace.vaultStateFile();
            let serverState: { host: string; mgmtPort: number; proxyPort: number } | undefined;
            if (existsSync(stateFile)) {
                try {
                    const raw = JSON.parse(readFileSync(stateFile, 'utf8')) as { host?: string; mgmtPort?: number; proxyPort?: number };
                    if (raw.host && Number.isInteger(raw.mgmtPort) && Number.isInteger(raw.proxyPort)) {
                        serverState = { host: raw.host, mgmtPort: raw.mgmtPort!, proxyPort: raw.proxyPort! };
                    }
                } catch { /* */ }
            }
            if (!serverState && opts.server !== false) {
                console.log(info('vault server not running — starting…'));
                const started = await spawnVaultServerDaemon();
                if (!started.ok) {
                    console.log(bad(`failed to auto-start vault server: ${started.error}`));
                    console.log(info('start manually with `flopsy vault server start`'));
                    process.exit(1);
                }
                serverState = { host: started.host, mgmtPort: started.mgmtPort, proxyPort: started.proxyPort };
            }
            if (!serverState) {
                console.log(bad('vault server not running and --no-server passed; nothing to proxy through'));
                process.exit(1);
            }

            let token: string;
            let runTokenLabel: string | undefined;
            if (opts.reuseToken) {
                const stored = getStoredToken();
                if (!stored) {
                    console.log(bad('no daemon token stored — re-run `flopsy vault setup` to mint one'));
                    process.exit(1);
                }
                token = stored;
            } else {
                const ttlMs = opts.ttl ? parseDuration(opts.ttl) : 60 * 60_000;
                if (opts.ttl && ttlMs === undefined) {
                    console.log(bad(`invalid --ttl: ${opts.ttl}`));
                    process.exit(1);
                }
                const scopeDb = openVaultDb({ path, readOnly: true });
                let derivedHosts: string[] = [];
                let derivedSecrets: string[] = [];
                try {
                    const rules = listRules(scopeDb);
                    derivedHosts = Array.from(new Set(rules.map((r) => r.hostPattern))).filter((h) => h && h.length > 0);
                    derivedSecrets = Array.from(new Set(rules.map((r) => r.secretName))).filter((s) => s && s.length > 0);
                } finally {
                    closeVaultDb(scopeDb);
                }
                const hosts = opts.hosts
                    ? opts.hosts.split(',').map((s) => s.trim()).filter(Boolean)
                    : (derivedHosts.length > 0 ? derivedHosts : ['*']);
                const secrets = opts.secrets
                    ? opts.secrets.split(',').map((s) => s.trim()).filter(Boolean)
                    : (derivedSecrets.length > 0 ? derivedSecrets : ['*']);
                const label = `run-${process.pid}-${Date.now()}`;
                const db = openVaultDb({ path });
                try {
                    const result = mintToken(db, { label, ttlMs, allowHosts: hosts, allowSecrets: secrets });
                    token = result.rawToken;
                    runTokenLabel = result.label;
                } finally {
                    closeVaultDb(db);
                }
            }

            const caPath = resolvePath(workspace.state(), 'vault-ca.pem');
            if (!existsSync(caPath)) {
                console.log(info('CA cert missing — exporting…'));
                const pw = await readMasterPassword('Master password:');
                const db = openVaultDb({ path });
                let dek: Buffer | undefined;
                try {
                    dek = unsealVault(db, pw);
                    let certPem = getRootCertPem(db, dek);
                    if (!certPem) certPem = loadOrCreateRootCA(db, dek).certPem;
                    writeFileSync(caPath, certPem, { mode: 0o644 });
                } finally {
                    if (dek) wipe(dek);
                    closeVaultDb(db);
                }
                console.log(ok(`exported CA to ${caPath}`));
            }

            const proxyUrlNoAuth = `https://${serverState.host}:${serverState.proxyPort}`;
            const proxyUrl = `https://${encodeURIComponent(token)}:vault@${serverState.host}:${serverState.proxyPort}`;
            const mgmtUrl = `http://${serverState.host}:${serverState.mgmtPort}`;
            const thisDir = dirname(fileURLToPath(import.meta.url));
            const caHookPath = resolvePath(thisDir, '..', '..', '..', 'vault', 'src', 'ca-hook.cjs');
            const existingNodeOptions = process.env.NODE_OPTIONS ?? '';
            const nodeOptions = existsSync(caHookPath)
                ? `${existingNodeOptions} --require=${caHookPath}`.trim()
                : existingNodeOptions;
            const childEnv: NodeJS.ProcessEnv = {
                ...process.env,
                HTTPS_PROXY: proxyUrl,
                HTTP_PROXY: proxyUrl,
                ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}),
                NO_PROXY: process.env.NO_PROXY ?? 'localhost,127.0.0.1,::1,api.telegram.org,discord.com,gateway.discord.gg,cdn.discordapp.com,api.line.me,gateway.line.me,signal.org,graph.facebook.com,api.whatsapp.com,web.whatsapp.com',
                NODE_EXTRA_CA_CERTS: caPath,
                SSL_CERT_FILE: caPath,
                REQUESTS_CA_BUNDLE: caPath,
                CURL_CA_BUNDLE: caPath,
                GIT_SSL_CAINFO: caPath,
                AGENT_VAULT_TOKEN: token,
                AGENT_VAULT_ADDR: mgmtUrl,
                AGENT_VAULT_PROXY: proxyUrlNoAuth,
            };

            let envfilePath: string | undefined;
            if (opts.envfile === false) {
                envfilePath = undefined;
            } else if (typeof opts.envfile === 'string') {
                envfilePath = resolvePath(opts.envfile);
            } else {
                const candidates = [
                    resolvePath(process.cwd(), 'vault.env'),
                    resolvePath(process.cwd(), '..', 'vault.env'),
                ];
                envfilePath = candidates.find((p) => existsSync(p));
            }
            if (envfilePath && existsSync(envfilePath)) {
                const parsed = parseDotEnv(envfilePath);
                for (const [k, val] of Object.entries(parsed)) {
                    childEnv[k] = val;
                }
            } else if (typeof opts.envfile === 'string') {
                console.log(bad(`envfile not found: ${opts.envfile}`));
                process.exit(1);
            }

            const [exe, ...args] = cmdArgs;
            if (!exe) {
                console.log(bad('missing command'));
                process.exit(1);
            }
            const envfileLabel = envfilePath ? `  envfile=${envfilePath}` : '';
            const tokenLabel = runTokenLabel ? `token=${runTokenLabel} (ttl ${opts.ttl ?? '1h'})` : 'token=(daemon, reused)';
            console.log(info(`HTTPS_PROXY=${proxyUrlNoAuth}  (URL-auth: token embedded)  CA=${caPath}  ${tokenLabel}${envfileLabel}`));

            const revokeRunToken = () => {
                if (!runTokenLabel) return;
                try {
                    const db = openVaultDb({ path });
                    try { revokeToken(db, runTokenLabel); } finally { closeVaultDb(db); }
                } catch { /* */ }
            };
            const child = spawn(exe, args, { stdio: 'inherit', env: childEnv });
            const forward = (sig: NodeJS.Signals) => { try { child.kill(sig); } catch { /* */ } };
            process.on('SIGINT', () => forward('SIGINT'));
            process.on('SIGTERM', () => forward('SIGTERM'));
            child.on('error', (err) => {
                revokeRunToken();
                console.log(bad(`failed to spawn ${exe}: ${err.message}`));
                process.exit(127);
            });
            child.on('exit', (code, signal) => {
                revokeRunToken();
                if (signal) process.kill(process.pid, signal);
                else process.exit(code ?? 0);
            });
        });

    const ca = v.command('ca').description('Manage the vault root CA (for agents that need to trust MITM certs)');

    ca.command('export')
        .description('Export the root CA cert in PEM (write to file with --out, else stdout)')
        .option('--out <path>', 'Write to this file instead of stdout')
        .action(async (opts: { out?: string }) => {
            const path = workspace.vaultDb();
            if (!existsSync(path)) {
                console.log(bad('vault not initialised — run `flopsy vault init` first'));
                process.exit(1);
            }
            const pw = await readMasterPassword('Master password:');
            const db = openVaultDb({ path });
            let dek: Buffer | undefined;
            try {
                dek = unsealVault(db, pw);
                let certPem = getRootCertPem(db, dek);
                if (!certPem) {
                    const created = loadOrCreateRootCA(db, dek);
                    certPem = created.certPem;
                }
                if (opts.out) {
                    const outPath = resolvePath(opts.out);
                    writeFileSync(outPath, certPem, { mode: 0o644 });
                    console.log(ok(`wrote root CA to ${outPath}`));
                    console.log(info('agents set NODE_EXTRA_CA_CERTS=' + outPath));
                } else {
                    process.stdout.write(certPem);
                }
            } catch (err) {
                if (err instanceof VaultSealError) {
                    console.log(bad(err.message));
                    process.exit(1);
                }
                throw err;
            } finally {
                if (dek) wipe(dek);
                closeVaultDb(db);
            }
        });

    v.command('keychain-set')
        .description('Store the master password in the macOS Keychain (avoids env-var exposure)')
        .action(async () => {
            if (process.platform !== 'darwin') {
                console.log(bad('keychain integration is macOS-only; use FLOPSY_VAULT_MASTER_PASSWORD_FILE on Linux'));
                process.exit(1);
            }
            const pw = await promptPassword({ message: 'Master password to store in Keychain:', mask: '*' });
            try {
                execFileSync('security', [
                    'add-generic-password', '-U', '-s', 'flopsy-vault', '-a', 'vault', '-w', pw,
                ], { stdio: 'ignore' });
                console.log(ok('stored in Keychain (service=flopsy-vault, account=vault)'));
                console.log(info('subsequent vault commands will read it automatically — unset FLOPSY_VAULT_MASTER_PASSWORD'));
            } catch (err) {
                console.log(bad(`keychain add failed: ${err instanceof Error ? err.message : String(err)}`));
                process.exit(1);
            }
        });

    v.command('keychain-clear')
        .description('Remove the master password from the macOS Keychain')
        .action(() => {
            if (process.platform !== 'darwin') {
                console.log(bad('keychain integration is macOS-only'));
                process.exit(1);
            }
            try {
                execFileSync('security', [
                    'delete-generic-password', '-s', 'flopsy-vault', '-a', 'vault',
                ], { stdio: 'ignore' });
                console.log(ok('removed from Keychain'));
            } catch {
                console.log(info('no entry to remove'));
            }
        });

    v.command('change-password')
        .description('Rotate the master password (re-wraps DEK; secrets untouched)')
        .action(async () => {
            const path = workspace.vaultDb();
            if (!existsSync(path)) {
                console.log(bad('vault not initialised — run `flopsy vault init` first'));
                process.exit(1);
            }
            const current = await readMasterPassword('Current master password:');
            const next = await promptPassword({ message: 'New master password:', mask: '*' });
            const again = await promptPassword({ message: 'Confirm new password:', mask: '*' });
            if (next !== again) {
                console.log(bad('passwords do not match'));
                process.exit(1);
            }
            const db = openVaultDb({ path });
            try {
                changeMasterPassword(db, current, next);
            } catch (err) {
                if (err instanceof VaultSealError) {
                    console.log(bad(err.message));
                    process.exit(1);
                }
                throw err;
            } finally {
                closeVaultDb(db);
            }
            console.log(ok('master password rotated — DEK re-wrapped, secrets untouched'));
        });
}
