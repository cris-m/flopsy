/**
 * Command dispatcher — given a parsed command and base context, looks up the
 * handler, invokes it, and returns the result (or `null` if the command is
 * unknown, so the caller can fall through to normal agent dispatch).
 */

import { createLogger } from '@flopsy/shared';
import type { CommandContext, CommandDef, CommandResult } from './types';
import type { ParsedCommand } from './parser';
import { COMMANDS, buildLookup } from './registry';

const log = createLogger('commands');

export class CommandDispatcher {
    private readonly lookup: Map<string, CommandDef>;

    constructor(commands: readonly CommandDef[] = COMMANDS) {
        this.lookup = buildLookup(commands);
    }

    /** Exposed for `/help` so handlers can enumerate commands without circular imports. */
    listCommands(): readonly CommandDef[] {
        // Dedup aliases: each def appears once regardless of how many keys alias to it.
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

    /**
     * Find the handler for this command name. Returns null when unknown so the
     * ChannelWorker can decide whether to fall through to the agent or reply
     * with a "command not found" message (we fall through — unknown slashes
     * may be meaningful to the agent, e.g. "/summarise this document please").
     */
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

        try {
            const result = await def.handler(fullCtx);
            log.info(
                {
                    command: def.name,
                    channel: ctx.channelName,
                    threadId: ctx.threadId,
                    peer: ctx.peer.id,
                    hasReply: !!result,
                    // Truncated so the log line stays scannable but operators
                    // can audit what the user saw without replaying the turn.
                    replyPreview: result?.text
                        ? result.text.slice(0, 120) + (result.text.length > 120 ? '…' : '')
                        : undefined,
                },
                'command dispatched',
            );
            return result;
        } catch (err) {
            log.error(
                { command: def.name, err, channel: ctx.channelName, threadId: ctx.threadId },
                'command handler threw',
            );
            return { text: `/${def.name} failed: ${err instanceof Error ? err.message : String(err)}` };
        }
    }
}

// Shared singleton — all channel workers use the same instance.
let sharedDispatcher: CommandDispatcher | undefined;

export function getSharedDispatcher(): CommandDispatcher {
    if (!sharedDispatcher) sharedDispatcher = new CommandDispatcher();
    return sharedDispatcher;
}
