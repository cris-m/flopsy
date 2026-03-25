import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config as dotenv } from 'dotenv';
import { loadConfig, setLogConfig, createLogger } from '@flopsy/shared';
import { FlopsyGateway } from './gateway';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
dotenv({ path: resolve(projectRoot, '.env') });

const config = loadConfig(resolve(projectRoot, 'flopsy.json5'));
setLogConfig(config.logging);

const log = createLogger('main');

async function main(): Promise<void> {
    const gateway = new FlopsyGateway(config);

    const shutdown = async (signal: string) => {
        log.info({ signal }, 'shutting down');
        await gateway.stop();
        process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT').catch((err) => { log.error({ err }, 'shutdown error'); process.exit(1); }));
    process.on('SIGTERM', () => shutdown('SIGTERM').catch((err) => { log.error({ err }, 'shutdown error'); process.exit(1); }));

    await gateway.start();
}

main().catch((err) => {
    log.fatal({ err }, 'failed to start');
    process.exit(1);
});
