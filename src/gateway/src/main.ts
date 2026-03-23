import { loadConfig, setLogConfig, createLogger } from '@flopsy/shared';
import { FlopsyGateway } from './gateway';

const config = loadConfig();
setLogConfig(config.logging);

const log = createLogger('main');

async function main(): Promise<void> {
    const gateway = new FlopsyGateway(config);

    const shutdown = async (signal: string) => {
        log.info({ signal }, 'shutting down');
        await gateway.stop();
        process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    await gateway.start();
}

main().catch((err) => {
    log.fatal({ err }, 'failed to start');
    process.exit(1);
});
