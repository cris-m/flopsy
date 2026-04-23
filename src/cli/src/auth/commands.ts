/**
 * `flopsy auth ...` — CLI surface for credential management.
 *
 * Commands:
 *   flopsy auth list              — supported providers + connection status
 *   flopsy auth status [provider] — details for one or all connected providers
 *   flopsy auth <provider>        — run OAuth (or re-auth) for a provider
 *   flopsy auth refresh <provider>— force refresh the access token
 *   flopsy auth revoke <provider> — revoke remotely + delete local credential
 *
 * Exit codes:
 *   0 — success
 *   1 — bad input / config (missing env, unknown provider, ...)
 *   2 — network / provider error
 */

import { Command } from 'commander';
import {
    deleteCredential,
    listCredentialProviders,
    loadCredential,
} from './credential-store';
import { getProvider, providerNames, PROVIDERS } from './providers/registry';

function fail(message: string, code = 1): never {
    process.stderr.write(`error: ${message}\n`);
    process.exit(code);
}

function formatExpiresAt(ms: number): string {
    const delta = ms - Date.now();
    if (delta <= 0) return 'EXPIRED';
    const mins = Math.floor(delta / 60_000);
    if (mins < 60) return `expires in ${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `expires in ${hours}h ${mins % 60}m`;
    const days = Math.floor(hours / 24);
    return `expires in ${days}d ${hours % 24}h`;
}

export function registerAuthCommands(root: Command): void {
    const auth = root.command('auth').description('Manage service credentials');

    auth.command('list')
        .description('List supported providers and connection status')
        .action(() => {
            const connected = new Set(listCredentialProviders());
            if (PROVIDERS.length === 0) {
                console.log('No providers registered.');
                return;
            }
            console.log('Supported providers:\n');
            for (const p of PROVIDERS) {
                const marker = connected.has(p.name) ? '✓ connected' : '  not connected';
                console.log(`  ${p.name.padEnd(14)} ${marker}  — ${p.displayName}`);
            }
            if (connected.size > 0) {
                console.log('\nRun `flopsy auth status` for expiry + scopes.');
            } else {
                console.log('\nRun `flopsy auth <provider>` to connect one.');
            }
        });

    auth.command('status')
        .description('Show details for connected providers')
        .argument('[provider]', 'Provider name (omit to show all)')
        .action((providerArg: string | undefined) => {
            const names = providerArg
                ? [providerArg.toLowerCase()]
                : listCredentialProviders();
            if (names.length === 0) {
                console.log('No connected providers yet.');
                console.log('Run `flopsy auth <provider>` to connect one.');
                return;
            }
            for (const name of names) {
                const cred = loadCredential(name);
                if (!cred) {
                    console.log(`${name}: not connected`);
                    continue;
                }
                console.log(`${name}`);
                console.log(`  identity:  ${cred.email ?? cred.displayName ?? '(unknown)'}`);
                console.log(`  status:    ${formatExpiresAt(cred.expiresAt)}`);
                console.log(`  scopes:    ${cred.scopes.join(', ') || '(none listed)'}`);
                console.log(
                    `  authorized: ${new Date(cred.authorizedAt).toISOString().slice(0, 16).replace('T', ' ')}`,
                );
            }
        });

    auth.command('refresh')
        .description('Force-refresh the access token for a provider')
        .argument('<provider>', 'Provider name')
        .action(async (name: string) => {
            const provider = getProvider(name);
            if (!provider) {
                fail(`Unknown provider "${name}". Available: ${providerNames().join(', ')}`);
            }
            const current = loadCredential(provider.name);
            if (!current) {
                fail(`No credential for "${provider.name}". Run \`flopsy auth ${provider.name}\` first.`);
            }
            try {
                const refreshed = await provider.refresh(current);
                console.log(`✓ Refreshed ${provider.name}. ${formatExpiresAt(refreshed.expiresAt)}.`);
            } catch (err) {
                fail(err instanceof Error ? err.message : String(err), 2);
            }
        });

    auth.command('revoke')
        .description('Revoke credentials remotely + delete locally')
        .argument('<provider>', 'Provider name')
        .option('--local-only', 'Skip remote revoke, just delete the local file')
        .action(async (name: string, opts: { localOnly?: boolean }) => {
            const provider = getProvider(name);
            if (!provider) {
                fail(`Unknown provider "${name}". Available: ${providerNames().join(', ')}`);
            }
            const current = loadCredential(provider.name);
            if (!current) {
                console.log(`${provider.name}: no credential to revoke.`);
                return;
            }
            if (!opts.localOnly && provider.revoke) {
                try {
                    await provider.revoke(current);
                } catch (err) {
                    console.warn(
                        `warning: remote revoke failed (${err instanceof Error ? err.message : String(err)}). Deleting local credential anyway.`,
                    );
                }
            }
            const removed = deleteCredential(provider.name);
            console.log(
                removed
                    ? `✓ ${provider.name} credential removed.`
                    : `${provider.name}: nothing to remove locally.`,
            );
        });

    // Catch-all provider commands — `flopsy auth google`, `flopsy auth notion`, …
    //
    // commander.js doesn't have a "rest-positional-as-subcommand" pattern,
    // so we register one subcommand per provider explicitly. This also
    // gives us per-provider --scopes / --port flags without argument
    // conflicts.
    for (const p of PROVIDERS) {
        auth.command(p.name)
            .description(`Authorize ${p.displayName}`)
            .option('-s, --scopes <list>', 'Extra scopes (comma-separated)')
            .option('-p, --port <number>', 'Local callback port (default: random)', (v) =>
                Number.parseInt(v, 10),
            )
            .option('--no-open', 'Do not auto-open the browser')
            .action(
                async (opts: {
                    scopes?: string;
                    port?: number;
                    open?: boolean;
                }) => {
                    const extraScopes = opts.scopes
                        ? opts.scopes
                              .split(',')
                              .map((s) => s.trim())
                              .filter(Boolean)
                        : [];
                    try {
                        const cred = await p.authorize({
                            scopes: extraScopes,
                            callbackPort: opts.port,
                            noOpen: opts.open === false,
                        });
                        console.log(
                            `\n✓ Authorized ${p.name}${cred.email ? ` as ${cred.email}` : ''}.`,
                        );
                        console.log(`  ${formatExpiresAt(cred.expiresAt)}`);
                    } catch (err) {
                        fail(err instanceof Error ? err.message : String(err), 2);
                    }
                },
            );
    }
}
