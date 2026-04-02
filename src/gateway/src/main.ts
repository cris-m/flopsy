import { resolve, dirname, isAbsolute } from 'path';
import { createRequire } from 'module';
import { config as dotenv } from 'dotenv';
import { loadConfig, setLogConfig, createLogger, installWarningFilter } from '@flopsy/shared';

// Locate the workspace root by resolving the root package.json — works
// regardless of where this file lives within the monorepo.
const _require = createRequire(import.meta.url);
const projectRoot = dirname(_require.resolve('../../../package.json'));

dotenv({ path: resolve(projectRoot, '.env') });

// Resolve relative FLOPSY_HOME against project root so the workspace location
// is stable regardless of which directory npm runs this script from.
const fhEnv = process.env.FLOPSY_HOME?.trim();
if (fhEnv && !isAbsolute(fhEnv) && !fhEnv.startsWith('~')) {
    process.env.FLOPSY_HOME = resolve(projectRoot, fhEnv);
}

const config = loadConfig(resolve(projectRoot, 'flopsy.json5'));
setLogConfig(config.logging);

const log = createLogger('main');

async function main(): Promise<void> {
    installWarningFilter();

    // Dynamic import defers evaluation of all gateway submodules (and their
    // module-level createLogger() calls) until after setLogConfig() has run
    // above — so every logger picks up the correct pretty/level config.
    const { FlopsyGateway } = await import('./gateway');
    const gateway = new FlopsyGateway(config);

    let shuttingDown = false;
    function shutdown(signal: string): void {
        if (shuttingDown) return;
        shuttingDown = true;
        log.info({ signal }, 'shutting down');
        gateway.stop().then(
            () => process.exit(0),
            (err) => {
                log.error({ err }, 'shutdown error');
                process.exit(1);
            },
        );
    }

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    await gateway.start();
}

main().catch((err) => {
    log.fatal({ err }, 'failed to start');
    process.exit(1);
});
