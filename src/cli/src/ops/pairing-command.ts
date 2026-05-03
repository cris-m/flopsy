import { Command } from 'commander';
import {
    PairingStore,
    LearningStore,
    PAIRING_PENDING_TTL_MS,
} from '@flopsy/team';
import { bad, detail, ok, section, warn } from '../ui/pretty';

function openStore(): { store: PairingStore; close: () => void } {
    const learning = new LearningStore();
    const store = new PairingStore(learning.getDatabase());
    return { store, close: () => learning.close() };
}

function fmtAge(createdAtMs: number): string {
    const ageMs = Date.now() - createdAtMs;
    const minutes = Math.floor(ageMs / 60_000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m ago`;
}

function isExpired(createdAtMs: number): boolean {
    return Date.now() - createdAtMs >= PAIRING_PENDING_TTL_MS;
}

export function registerPairingCommands(root: Command): void {
    const pair = root
        .command('pairing')
        .description('Inspect and approve channel pairing requests');

    pair.command('list', { isDefault: true })
        .description('Show pending codes + approved senders')
        .option('--channel <name>', 'Filter to a single channel')
        .action((opts: { channel?: string }) => {
            const { store, close } = openStore();
            try {
                const pending = store.listPending(opts.channel);
                const approved = store.listApproved(opts.channel);

                if (pending.length === 0 && approved.length === 0) {
                    console.log(ok('No pending or approved pairings.'));
                    if (opts.channel) {
                        console.log(detail('channel', opts.channel));
                    }
                    return;
                }

                if (pending.length > 0) {
                    console.log(section(`Pending (${pending.length})`));
                    for (const p of pending) {
                        const expired = isExpired(p.createdAt);
                        const status = expired ? warn('EXPIRED') : detail('age', fmtAge(p.createdAt));
                        console.log(`  ${p.channel}  ${p.code}  ${p.senderId}${p.senderName ? ` (${p.senderName})` : ''}  ${status}`);
                    }
                    console.log('');
                }

                if (approved.length > 0) {
                    console.log(section(`Approved (${approved.length})`));
                    for (const a of approved) {
                        console.log(`  ${a.channel}  ${a.senderId}${a.senderName ? ` (${a.senderName})` : ''}  ${detail('approved', fmtAge(a.approvedAt))}`);
                    }
                }
            } finally {
                close();
            }
        });

    pair.command('approve <channel> <code>')
        .description('Approve a pending code, granting that sender access')
        .action((channel: string, code: string) => {
            const { store, close } = openStore();
            try {
                const result = store.approveByCode(channel, code);
                if (!result) {
                    console.log(bad(`No pending code "${code}" for channel "${channel}" (or expired).`));
                    process.exit(1);
                }
                console.log(ok(`Approved.`));
                console.log(detail('channel', channel));
                console.log(detail('sender', `${result.senderId}${result.senderName ? ` (${result.senderName})` : ''}`));
            } finally {
                close();
            }
        });

    pair.command('revoke <channel> <senderId>')
        .description('Remove a sender from the approved list')
        .action((channel: string, senderId: string) => {
            const { store, close } = openStore();
            try {
                const removed = store.revoke(channel, senderId);
                if (!removed) {
                    console.log(warn(`Sender "${senderId}" wasn't approved on channel "${channel}".`));
                    process.exit(1);
                }
                console.log(ok(`Revoked.`));
                console.log(detail('channel', channel));
                console.log(detail('sender', senderId));
            } finally {
                close();
            }
        });

    pair.command('clear-pending')
        .description('Drop pending codes (expired only by default)')
        .option('--channel <name>', 'Filter to a single channel')
        .option('--all', 'Drop ALL pending codes, not just expired ones')
        .action((opts: { channel?: string; all?: boolean }) => {
            const { store, close } = openStore();
            try {
                const removed = opts.all
                    ? store.clearAllPending(opts.channel)
                    : store.clearExpired(opts.channel);
                console.log(ok(`Cleared ${removed} pending code${removed === 1 ? '' : 's'}.`));
                if (opts.channel) console.log(detail('channel', opts.channel));
                console.log(detail('mode', opts.all ? 'all pending' : 'expired only'));
            } finally {
                close();
            }
        });
}
