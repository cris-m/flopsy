import { createLogger } from '@flopsy/shared';
import type { CommandContext, CommandDef, CommandResult } from './types';
import type { ParsedCommand } from './parser';
import { COMMANDS, buildAllCommands, buildLookup } from './registry';
import { resolveWorkspacePath } from '@flopsy/shared';

const log = createLogger('commands');

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

let sharedDispatcher: CommandDispatcher | undefined;

export function getSharedDispatcher(): CommandDispatcher {
    if (!sharedDispatcher) {
        // Built-ins + one command per discovered skill. Discovery happens
        // once at first access; restart to pick up new skills.
        const skillsRoot = resolveWorkspacePath('skills');
        const allCommands = buildAllCommands(skillsRoot);
        log.info(
            {
                builtin: COMMANDS.length,
                skills: allCommands.length - COMMANDS.length,
                total: allCommands.length,
            },
            'command dispatcher initialized',
        );
        sharedDispatcher = new CommandDispatcher(allCommands);
    }
    return sharedDispatcher;
}
