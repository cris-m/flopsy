import { createLogger, type LogLevel } from '@flopsy/shared';
import type pino from 'pino';

export const logger: pino.Logger = createLogger('agent');

export function createModuleLogger(module: string): pino.Logger {
    return logger.child({ module });
}

export type { LogLevel };
