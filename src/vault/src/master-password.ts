import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';

export interface ResolvedMasterPassword {
    value: string;
    source: 'keychain' | 'file' | 'env' | 'none';
}

export function resolveMasterPassword(): ResolvedMasterPassword {
    if (process.platform === 'darwin') {
        try {
            const out = execFileSync('security', [
                'find-generic-password', '-s', 'flopsy-vault', '-a', 'vault', '-w',
            ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
            const trimmed = out.trim();
            if (trimmed.length > 0) return { value: trimmed, source: 'keychain' };
        } catch {
            /* */
        }
    }

    const filePath = process.env['FLOPSY_VAULT_MASTER_PASSWORD_FILE'];
    if (filePath && existsSync(filePath)) {
        const mode = statSync(filePath).mode & 0o777;
        if ((mode & 0o077) === 0) {
            const content = readFileSync(filePath, 'utf8').trim();
            if (content.length > 0) return { value: content, source: 'file' };
        }
    }

    const env = process.env['FLOPSY_VAULT_MASTER_PASSWORD'];
    if (env && env.length > 0) {
        delete process.env['FLOPSY_VAULT_MASTER_PASSWORD'];
        return { value: env, source: 'env' };
    }

    return { value: '', source: 'none' };
}
