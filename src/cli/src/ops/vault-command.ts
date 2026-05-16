import { confirm, password as promptPassword } from '@inquirer/prompts';
import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { workspace } from '@flopsy/shared';
import {
    closeVaultDb,
    changeMasterPassword,
    deleteSecret,
    getSecret,
    initVault,
    isVaultInitialised,
    listSecrets,
    openVaultDb,
    putSecret,
    unsealVault,
    VaultSealError,
    wipe,
} from '@flopsy/vault';
import { bad, info, ok, section } from '../ui/pretty';

async function readMasterPassword(reason: string, confirm = false): Promise<string> {
    const fromEnv = process.env['FLOPSY_VAULT_MASTER_PASSWORD'];
    if (fromEnv && fromEnv.length > 0) {
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

const SECRET_KEY_PATTERN = /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|PASSPHRASE/i;

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

export function registerVaultCommands(root: Command): void {
    const v = root.command('vault').description('Encrypted credential store (AES-256-GCM + Argon2id)');

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
        .option('--yes', 'Skip confirmation prompt', false)
        .action(async (pathArg: string | undefined, opts: { file?: string; all?: boolean; overwrite?: boolean; yes?: boolean }) => {
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
            console.log(info('source .env was NOT modified; remove keys from .env once you wire the daemon to read from the vault'));
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
