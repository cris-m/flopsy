import pino from 'pino';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';

const VALID_LEVELS = new Set<string>(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']);

let configLevel: LogLevel | undefined;
let configPretty: boolean | undefined;
let configFile: string | undefined;

export function setLogConfig(opts: { level?: string; pretty?: boolean; file?: string }): void {
    if (opts.level && VALID_LEVELS.has(opts.level)) configLevel = opts.level as LogLevel;
    if (opts.pretty !== undefined) configPretty = opts.pretty;
    if (opts.file) configFile = opts.file;
}

function resolveLevel(): LogLevel {
    const explicit = process.env.LOG_LEVEL?.toLowerCase();
    if (explicit && VALID_LEVELS.has(explicit)) return explicit as LogLevel;
    if (process.env.LOG_DEBUG === 'true') return 'debug';
    if (configLevel) return configLevel;
    return 'info';
}

function resolvePretty(): boolean {
    if (process.env.LOG_PRETTY === 'true' || process.env.LOG_DEBUG === 'true') return true;
    if (configPretty !== undefined) return configPretty;
    return false;
}

function resolveFile(): { enabled: boolean; path: string } {
    if (process.env.LOG_TO_FILE === 'true') {
        return { enabled: true, path: process.env.LOG_FILE_PATH ?? './app.log' };
    }
    if (configFile) return { enabled: true, path: configFile };
    return { enabled: false, path: '' };
}

const REDACT_PATHS = [
    'password', 'token', 'secret', 'apiKey', 'api_key', 'accessToken', 'refreshToken',
    'authorization', 'jwt', 'bearer', 'apiSecret', 'access_token', 'refresh_token',
    'creditCard', 'cardNumber', 'cvv', 'ssn', 'bankAccount', 'routingNumber',
    'email', 'phone', 'address', 'dateOfBirth', 'dob', 'passport', 'driverId',
    '*.token', '*.secret', '*.password', '*.apiKey', '*.api_key',
    '*.accessToken', '*.refreshToken', '*.access_token', '*.refresh_token',
    'headers.authorization', '*.headers.authorization',
    'auth.*', 'payment.*', 'secrets.*',
];

const PII_PATTERNS: Array<{ regex: RegExp; label: string }> = [
    { regex: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, label: '[CARD]' },
    { regex: /\b\d{3}-?\d{2}-?\d{4}\b/g, label: '[SSN]' },
    { regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, label: '[EMAIL]' },
    { regex: /(\+?1[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}\b/g, label: '[PHONE]' },
    { regex: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, label: '[JWT]' },
    { regex: /AKIA[0-9A-Z]{16}/g, label: '[AWS_KEY]' },
    { regex: /(sk|pk)_(test|live)_[a-zA-Z0-9]{24,}/g, label: '[STRIPE_KEY]' },
];

export function scrubPii(text: string): string {
    let result = text;
    for (const { regex, label } of PII_PATTERNS) {
        result = result.replace(regex, label);
    }
    return result;
}

export interface LoggerOptions {
    level?: LogLevel;
    bindings?: Record<string, unknown>;
    redact?: boolean;
}

export function createLogger(service: string, options?: LoggerOptions): pino.Logger {
    const level = options?.level ?? resolveLevel();
    const enableRedact = options?.redact ?? true;
    const pretty = resolvePretty();
    const file = resolveFile();

    const targets: pino.TransportTargetOptions[] = [
        {
            target: pretty ? 'pino-pretty' : 'pino/file',
            options: pretty
                ? { colorize: true, translateTime: 'SYS:standard' }
                : { destination: 2 },
            level,
        },
    ];

    if (file.enabled) {
        targets.push({
            target: 'pino/file',
            options: { destination: file.path, mkdir: true },
            level,
        });
    }

    return pino(
        {
            level,
            name: service,
            base: { pid: undefined, hostname: undefined, ...options?.bindings },
            ...(enableRedact && {
                redact: {
                    paths: REDACT_PATHS,
                    censor: '[REDACTED]',
                },
            }),
        },
        pino.transport({ targets }),
    );
}
