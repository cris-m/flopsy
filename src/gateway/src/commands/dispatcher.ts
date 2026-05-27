import { createLogger, loadConfig } from '@flopsy/shared';
import type { CommandContext, CommandDef, CommandResult } from './types';
import type { ParsedCommand } from './parser';
import { COMMANDS, buildAllCommands, buildLookup } from './registry';
import { workspace } from '@flopsy/shared';
import { sanitizeErrorHint } from '../core/security';
import { emitHook } from '../hooks';

const log = createLogger('commands');

/**
 * Is the caller of this slash command considered the operator/admin?
 *
 * Trust model:
 *   - The `chat` channel is the local WebSocket the operator uses via
 *     `flopsy chat`. It already requires the mgmt token to connect (see
 *     management/chat-handler.ts), so anyone who can reach `chat` already
 *     has operator-equivalent access.
 *   - For external channels (telegram / discord / line / signal / whatsapp
 *     / imessage), the peer is only admin if it matches the
 *     `FLOPSY_OPERATOR_PEERS` env var (comma-sep `<channel>:<peerId>` keys
 *     like `telegram:123456789`).
 *
 * Without this gate, a paired Telegram user can run `/cron remove` /
 * `/dnd 999d` / `/audit` etc. — see Phase-1 review finding P1-C17.
 *
 * Returns true conservatively for `chat` regardless of env config — that's
 * the intended single-operator default. Returns false for empty/missing
 * allowlist on external channels (closed by default).
 */
function isAdminContext(ctx: CommandContext): boolean {
    if (ctx.channelName === 'chat') return true;
    const raw = process.env['FLOPSY_OPERATOR_PEERS'] ?? '';
    if (raw.trim().length === 0) return false;
    const allowlist = raw.split(',').map((s) => s.trim()).filter(Boolean);
    const key = `${ctx.channelName}:${ctx.peer.id}`;
    return allowlist.includes(key);
}

export class CommandDispatcher {
    private readonly lookup: Map<string, CommandDef>;

    constructor(commands: readonly CommandDef[] = COMMANDS) {
        this.lookup = buildLookup(commands);
    }

    /** Exposed for `/help`. */
    listCommands(): readonly CommandDef[] {
        const seen = new Set<CommandDef>();
        const out: CommandDef[] = [];
        for (const def of this.lookup.values()) {
            if (!seen.has(def)) {
                seen.add(def);
                out.push(def);
            }
        }
        return out;
    }

    resolve(name: string): CommandDef | undefined {
        return this.lookup.get(name.toLowerCase());
    }

    async dispatch(
        cmd: ParsedCommand,
        ctx: Omit<CommandContext, 'args' | 'rawArgs'>,
    ): Promise<CommandResult | null> {
        const def = this.resolve(cmd.name);
        if (!def) {
            log.debug({ name: cmd.name }, 'unknown command, falling through');
            return null;
        }

        const fullCtx: CommandContext = {
            ...ctx,
            args: cmd.args,
            rawArgs: cmd.rawArgs,
        };

        // Admin gate: commands marked `scope: 'admin'` only run for the
        // operator. Returns a polite refusal rather than logging — the
        // refusal is observable to the user but doesn't leak that the
        // command exists vs. doesn't (it does, that's in /help; what
        // matters is that the destructive action didn't happen).
        if (def.scope === 'admin' && !isAdminContext(fullCtx)) {
            log.info(
                { command: def.name, channel: ctx.channelName, peer: ctx.peer.id },
                'admin command refused (non-operator caller)',
            );
            return { text: `/${def.name}: admin-only — operator-equivalent access required.` };
        }

        try {
            const result = await def.handler(fullCtx);
            log.info(
                {
                    command: def.name,
                    channel: ctx.channelName,
                    threadId: ctx.threadId,
                    peer: ctx.peer.id,
                    hasReply: !!result,
                    replyPreview: result?.text
                        ? result.text.slice(0, 120) + (result.text.length > 120 ? '…' : '')
                        : undefined,
                },
                'command dispatched',
            );
            // Hook fan-out: emit `command.<name>` (e.g. `command.cron`) so
            // operators can write a HOOK.yaml subscribed to `command.*` and
            // observe every slash command. Fire-and-forget — observers
            // can't block the reply path.
            //
            // Field names: `channel` = the messaging channel the command
            // came from (chat / telegram / discord / line). `platform` is
            // intentionally NOT used here for the channel — it means OS in
            // gateway-level events. Handlers that need messaging-channel
            // routing use `channel`; OS-aware handlers read `platform`
            // from `gateway.startup` or fall back to `process.platform`.
            emitHook(`command.${def.name}`, {
                command: def.name,
                args: cmd.args,
                rawArgs: cmd.rawArgs,
                channel: ctx.channelName,
                peerId: ctx.peer.id,
                peerType: ctx.peer.type,
                senderName: ctx.sender?.name,
                threadId: ctx.threadId,
                messageId: ctx.messageId,
                hasReply: !!result,
                replyPreview: result?.text
                    ? result.text.slice(0, 200) + (result.text.length > 200 ? '…' : '')
                    : undefined,
            });
            return result;
        } catch (err) {
            log.error(
                { command: def.name, err, channel: ctx.channelName, threadId: ctx.threadId },
                'command handler threw',
            );
            // Sanitize err.message: handler exceptions can carry
            // filesystem paths, bearer tokens, OAuth refresh tokens,
            // or sk-* / ya29.* secrets in their .message. Send the
            // redacted hint to the channel (visible to whoever ran
            // the slash) and keep the raw error in our own log.
            const rawMsg = err instanceof Error ? err.message : String(err);
            const hint = sanitizeErrorHint(rawMsg);
            return {
                text: hint
                    ? `/${def.name} failed: ${hint}`
                    : `/${def.name} failed. Run /doctor for diagnostics.`,
            };
        }
    }
}

let sharedDispatcher: CommandDispatcher | undefined;

export function getSharedDispatcher(): CommandDispatcher {
    if (!sharedDispatcher) {
        // Built-ins + one command per discovered skill. Discovery happens
        // once at first access; restart to pick up new skills.
        const skillsRoot = workspace.skills();
        const mainAgentName = resolveMainAgentName();
        const allCommands = buildAllCommands(skillsRoot, mainAgentName);
        log.info(
            {
                builtin: COMMANDS.length,
                skills: allCommands.length - COMMANDS.length,
                total: allCommands.length,
                mainAgent: mainAgentName ?? '(none configured)',
            },
            'command dispatcher initialized',
        );
        sharedDispatcher = new CommandDispatcher(allCommands);
    }
    return sharedDispatcher;
}

/**
 * Resolve the main-agent name from flopsy.json5 so slash-command routing
 * works for any configured main, not just "gandalf". Returns undefined
 * when config is unreadable or no agent is marked `role: 'main'` — callers
 * fall back to the "always delegate" path which is correct (just slower
 * by one hop).
 */
function resolveMainAgentName(): string | undefined {
    try {
        const cfg = loadConfig();
        const main = cfg.agents.find((a) => a.role === 'main' && a.enabled !== false);
        return main?.name;
    } catch {
        return undefined;
    }
}
