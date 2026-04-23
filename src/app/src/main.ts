/**
 * FlopsyBot entry point — `npm start`.
 *
 * The only executable package. Loads env + config, sets up logging, then
 * hands off to @flopsy/team's `startFlopsyBot` which wires the harness-
 * enabled team into the gateway.
 */

import { resolve, dirname } from 'path';
import { createRequire } from 'module';
import { config as dotenv } from 'dotenv';
import { Agent as UndiciAgent, setGlobalDispatcher } from 'undici';
import {
    loadConfig,
    setLogConfig,
    createLogger,
    installWarningFilter,
    primeFlopsyHome,
} from '@flopsy/shared';

// Node 18+'s global `fetch` is powered by undici. Defaults are:
//   bodyTimeout:    5 min (between chunks — OK to tighten for SSE stalls)
//   headersTimeout: 5 min (time to first response byte — must stay generous)
// Leave headersTimeout at the default 5-minute value. GPT-4o + Claude can
// legitimately take 45-90s to return headers under load on long prompts
// (first regression: set it to 30s, which killed valid in-flight calls).
// The 300s `bodyTimeout` is our wall-clock backstop; the per-chunk idle
// timer in `wrapStreamWithIdleTimeout` catches stream stalls separately.
// Per-model tighter limits come from `modelCallTimeoutMs` in llm-call-node.
setGlobalDispatcher(
    new UndiciAgent({
        bodyTimeout: 300_000,
    }),
);

const _require = createRequire(import.meta.url);
const projectRoot = dirname(_require.resolve('../../../package.json'));

dotenv({ path: resolve(projectRoot, '.env') });
// Anchor relative FLOPSY_HOME to projectRoot. Single source of truth;
// CLI's config-reader calls the same helper with its own configDir.
primeFlopsyHome(projectRoot);

// MCP_ROOT is referenced as ${MCP_ROOT} in flopsy.json5 for MCP server
// paths. If relative, anchor to projectRoot — otherwise it resolves
// against whatever cwd `npm start` happened to use (e.g. src/app/).
if (process.env.MCP_ROOT && !/^([~/]|[A-Za-z]:)/.test(process.env.MCP_ROOT)) {
    process.env.MCP_ROOT = resolve(projectRoot, process.env.MCP_ROOT);
}

const config = loadConfig(resolve(projectRoot, 'flopsy.json5'));
setLogConfig(config.logging);

const log = createLogger('flopsybot');

async function main(): Promise<void> {
    installWarningFilter();

    // Dynamic imports so createLogger() calls in submodules pick up the log
    // config set above.
    const { FlopsyGateway } = await import('@flopsy/gateway');
    const { startFlopsyBot } = await import('@flopsy/team');

    const gateway = new FlopsyGateway(config);
    const teardown = await startFlopsyBot(gateway, config);

    let shuttingDown = false;
    const shutdown = async (signal: string): Promise<void> => {
        if (shuttingDown) return;
        shuttingDown = true;
        log.info({ signal }, 'shutting down');

        try {
            // Order matters:
            //   1) stop the gateway → drains channel workers, aborts active turns
            //   2) tear down the handler → flushes per-thread harness state
            //   3) close shared SQLite → last so no in-flight write races it
            await gateway.stop();
            await teardown();
            process.exit(0);
        } catch (err) {
            log.error({ err }, 'shutdown error');
            process.exit(1);
        }
    };

    process.on('SIGINT', () => {
        void shutdown('SIGINT');
    });
    process.on('SIGTERM', () => {
        void shutdown('SIGTERM');
    });
}

main().catch((err) => {
    log.fatal({ err }, 'failed to start FlopsyBot');
    process.exit(1);
});
