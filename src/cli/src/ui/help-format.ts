/**
 * Custom commander help formatter — colorizes the default layout so
 * `flopsy --help` (and every `flopsy <cmd> --help`) is scannable:
 *
 *   - Command names        → brand purple, bold
 *   - Subcommand aliases   → dim (e.g. `run|gateway` → run bold + |gateway dim)
 *   - Options              → option yellow (palette.auth token)
 *   - Section headings     → brand purple, bold ("Usage:", "Options:", "Commands:")
 *   - Descriptions         → default foreground (left untouched for contrast)
 *
 * No-color terminals (NO_COLOR / non-TTY) fall back to the default
 * formatter automatically via chalk's own detection — we only paint
 * strings if chalk has a colour level > 0.
 *
 * Apply with:
 *   program.configureHelp(createHelpConfig());
 * and propagate to subcommands via:
 *   program.commands.forEach(c => c.configureHelp(createHelpConfig()));
 * ...or recurse once at startup (see attachHelpFormatter in index.ts).
 */

import chalk from 'chalk';
import type { Command, Help } from 'commander';
import { palette } from './theme';

const paintCommand = chalk.bold.hex(palette.brand);
const paintOption = chalk.hex(palette.auth);
const paintHeading = chalk.bold.hex(palette.brand);
const paintDim = chalk.dim;

export function createHelpConfig(): Partial<Help> {
    return {
        // Command term (e.g. "status [options]" or "run|gateway")
        subcommandTerm(cmd: Command): string {
            const name = cmd.name();
            const alias = cmd.aliases()[0];
            // Visible argument list, e.g. [options] or <path>
            const args = cmd.registeredArguments
                .map((a) => (a.required ? `<${a.name()}>` : `[${a.name()}]`))
                .join(' ');
            const hasOptions = cmd.options.length > 0;
            const suffix = [hasOptions ? '[options]' : '', args].filter(Boolean).join(' ');
            const head = alias
                ? `${paintCommand(name)}${paintDim('|' + alias)}`
                : paintCommand(name);
            return suffix ? `${head} ${paintDim(suffix)}` : head;
        },

        // Option term (e.g. "-V, --version" or "--json")
        optionTerm(opt): string {
            return paintOption(opt.flags);
        },

        // Called by commander to render the final help string. Override
        // so we can colorize section labels ("Usage:" etc.) — these
        // aren't exposed through narrow hooks.
        formatHelp(cmd: Command, helper: Help): string {
            const termWidth = helper.padWidth(cmd, helper);
            const helpWidth = helper.helpWidth || 80;
            const itemIndentWidth = 2;
            const itemSeparatorWidth = 2;

            const formatItem = (term: string, description: string): string => {
                if (description) {
                    const fullText = `${term.padEnd(termWidth + itemSeparatorWidth)}${description}`;
                    return helper.wrap(fullText, helpWidth - itemIndentWidth, termWidth + itemSeparatorWidth);
                }
                return term;
            };

            const formatList = (textArray: string[]): string =>
                textArray.join('\n').replace(/^/gm, ' '.repeat(itemIndentWidth));

            // ---- USAGE ----
            let output: string[] = [`${paintHeading('Usage:')} ${helper.commandUsage(cmd)}`, ''];

            // ---- DESCRIPTION ----
            const desc = helper.commandDescription(cmd);
            if (desc.length > 0) {
                output = output.concat([helper.wrap(desc, helpWidth, 0), '']);
            }

            // ---- ARGUMENTS ----
            const argumentList = helper.visibleArguments(cmd).map((arg) =>
                formatItem(paintOption(arg.name()), helper.argumentDescription(arg)),
            );
            if (argumentList.length > 0) {
                output = output.concat([paintHeading('Arguments:'), formatList(argumentList), '']);
            }

            // ---- OPTIONS ----
            const optionList = helper.visibleOptions(cmd).map((opt) =>
                formatItem(helper.optionTerm(opt), helper.optionDescription(opt)),
            );
            if (optionList.length > 0) {
                output = output.concat([paintHeading('Options:'), formatList(optionList), '']);
            }

            // ---- COMMANDS ----
            const commandList = helper.visibleCommands(cmd).map((sub) =>
                formatItem(helper.subcommandTerm(sub), helper.subcommandDescription(sub)),
            );
            if (commandList.length > 0) {
                output = output.concat([paintHeading('Commands:'), formatList(commandList), '']);
            }

            return output.join('\n');
        },
    };
}

/**
 * Apply the formatter to a root command + every subcommand it registers,
 * recursively. Commander doesn't inherit `configureHelp` — each command
 * has its own slot — so `flopsy --help` and `flopsy config --help` both
 * need it set explicitly.
 */
export function attachHelpFormatter(root: Command): void {
    const config = createHelpConfig();
    const visit = (cmd: Command): void => {
        cmd.configureHelp(config);
        for (const sub of cmd.commands) visit(sub);
    };
    visit(root);
}
