#!/usr/bin/env -S npx tsx
/**
 * FlopsyBot CLI entry.
 *
 * Subcommands:
 *   flopsy auth ...    — manage service credentials (Google, etc.)
 *   flopsy mcp ...     — MCP server registry
 *
 * Each subcommand module registers itself on the root Command here.
 * Running `flopsy` with no subcommand prints the mascot banner + help.
 */

import { Command } from 'commander';
import { bootstrapCli } from './ops/config-reader';
// Load .env + prime FLOPSY_HOME before any command reads process.env.
bootstrapCli();
import { registerAuthCommands } from './auth/commands';
import { registerMcpCommands } from './mcp/commands';
import { registerChannelCommands } from './ops/channel-command';
import { registerConfigCommand } from './ops/config-command';
import { registerCronCommands } from './ops/cron-command';
import { registerDndCommand } from './ops/dnd-command';
import { registerDoctorCommand } from './ops/doctor-command';
import { registerEnvCommands } from './ops/env-command';
import { registerMemoryCommands } from './ops/memory-command';
import { registerHeartbeatCommands } from './ops/heartbeat-command';
import { registerMgmtCommands } from './ops/mgmt-command';
import { registerModelCommand } from './ops/model-command';
import { registerOnboardCommand } from './ops/onboard-command';
import { registerRunCommands } from './ops/run-command';
import { registerStatusCommand } from './ops/status-command';
import { registerTasksCommand } from './ops/tasks-command';
import { registerTeamCommands } from './ops/team-command';
import { registerWebhookCommands } from './ops/webhook-command';
import { formatBannerLine, printBanner } from './ui/banner';
import { attachHelpFormatter } from './ui/help-format';

const VERSION = '1.0.0';

const program = new Command();
program
    .name('flopsy')
    .description('FlopsyBot CLI — credential management, MCP wiring, diagnostics')
    // Override commander's default --version formatter so `flopsy --version`
    // shows the banner one-liner instead of just the raw number.
    .version(formatBannerLine({ version: VERSION }), '-V, --version', 'Show version')
    // Called when no subcommand is given — print the full banner + help.
    .action(() => {
        printBanner({ version: VERSION });
        program.outputHelp();
    });

registerAuthCommands(program);
registerMcpCommands(program);
registerStatusCommand(program);
registerDoctorCommand(program);
registerDndCommand(program);
registerOnboardCommand(program);
registerMgmtCommands(program);
registerRunCommands(program);
registerTeamCommands(program);
registerChannelCommands(program);
registerCronCommands(program);
registerHeartbeatCommands(program);
registerTasksCommand(program);
registerWebhookCommands(program);
registerConfigCommand(program);
registerModelCommand(program);
registerEnvCommands(program);
registerMemoryCommands(program);

// Colorize help output for every command + subcommand. Must run AFTER
// all register*() calls so the formatter sees the fully-built tree.
attachHelpFormatter(program);

program.parseAsync(process.argv).catch((err: unknown) => {
    process.stderr.write(
        `error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
});
