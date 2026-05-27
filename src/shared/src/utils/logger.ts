import pino from 'pino';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';

const VALID_LEVELS = new Set<string>([
    'trace',
    'debug',
    'info',
    'warn',
    'error',
    'fatal',
    'silent',
]);

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
    'password',
    'token',
    'secret',
    'apiKey',
    'api_key',
    'accessToken',
    'refreshToken',
    'authorization',
    'jwt',
    'bearer',
    'apiSecret',
    'access_token',
    'refresh_token',
    'creditCard',
    'cardNumber',
    'cvv',
    'ssn',
    'bankAccount',
    'routingNumber',
    'email',
    'phone',
    'address',
    'dateOfBirth',
    'dob',
    'passport',
    'driverId',
    '*.token',
    '*.secret',
    '*.password',
    '*.apiKey',
    '*.api_key',
    '*.accessToken',
    '*.refreshToken',
    '*.access_token',
    '*.refresh_token',
    'headers.authorization',
    '*.headers.authorization',
    'auth.*',
    'payment.*',
    'secrets.*',
];

const SENSITIVE_QUERY_PARAMS = new Set([
    'api_key', 'apikey', 'access_token', 'auth_token', 'session_token',
    'token', 'bearer', 'password', 'passwd', 'secret', 'private_key',
    'client_secret', 'refresh_token', 'id_token', 'authorization',
    'aws_secret_access_key', 'aws_session_token', 'signature', 'x-api-key',
]);

const PII_PATTERNS: Array<{ regex: RegExp; label: string }> = [
    { regex: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, label: '[CARD]' },
    { regex: /\b\d{3}-?\d{2}-?\d{4}\b/g, label: '[SSN]' },
    { regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, label: '[EMAIL]' },
    { regex: /(\+?1[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}\b/g, label: '[PHONE]' },
    { regex: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, label: '[JWT]' },
    { regex: /AKIA[0-9A-Z]{16}/g, label: '[AWS_KEY]' },
    { regex: /(sk|pk)_(test|live)_[a-zA-Z0-9]{24,}/g, label: '[STRIPE_KEY]' },
    { regex: /sk-ant-[a-zA-Z0-9_-]{20,}/g, label: '[ANTHROPIC_KEY]' },
    { regex: /sk-proj-[a-zA-Z0-9_-]{20,}/g, label: '[OPENAI_KEY]' },
    { regex: /\bsk-[A-Za-z0-9]{32,}\b/g, label: '[OPENAI_LEGACY_KEY]' },
    { regex: /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g, label: '[TELEGRAM_TOKEN]' },

    { regex: /\bxai-[A-Za-z0-9]{40,}\b/g, label: '[XAI_KEY]' },
    { regex: /\bhf_[A-Za-z0-9]{20,}\b/g, label: '[HUGGINGFACE_TOKEN]' },
    { regex: /\br8_[A-Za-z0-9]{30,}\b/g, label: '[REPLICATE_TOKEN]' },
    { regex: /\bfc-[A-Za-z0-9]{20,}\b/g, label: '[FIRECRAWL_KEY]' },
    { regex: /\btvly-[A-Za-z0-9_-]{20,}\b/g, label: '[TAVILY_KEY]' },
    { regex: /\bexa_[A-Za-z0-9-]{20,}\b/g, label: '[EXA_KEY]' },
    { regex: /\bgsk_[A-Za-z0-9]{30,}\b/g, label: '[GROQ_KEY]' },
    { regex: /\bam_[A-Za-z0-9]{30,}\b/g, label: '[AGENTMAIL_KEY]' },
    { regex: /\bpypi-AgEIc[A-Za-z0-9_-]{40,}\b/g, label: '[PYPI_TOKEN]' },
    { regex: /\bnpm_[A-Za-z0-9]{30,}\b/g, label: '[NPM_TOKEN]' },
    { regex: /\bdop_v1_[a-f0-9]{40,}\b/g, label: '[DIGITALOCEAN_TOKEN]' },
    { regex: /\bpplx-[A-Za-z0-9]{30,}\b/g, label: '[PERPLEXITY_KEY]' },
    { regex: /\bSG\.[A-Za-z0-9_-]{16,32}\.[A-Za-z0-9_-]{16,64}\b/g, label: '[SENDGRID_KEY]' },
    { regex: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{80,})\b/g, label: '[GITHUB_TOKEN]' },
    { regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, label: '[SLACK_TOKEN]' },
    { regex: /\bAIza[0-9A-Za-z_-]{35}\b/g, label: '[GOOGLE_API_KEY]' },
    { regex: /\b(?:hvs|hvb)\.[A-Za-z0-9._-]{20,}\b/g, label: '[VAULT_TOKEN]' },
];

const URL_QUERY_PARAM_RE = /([?&])([a-zA-Z_][a-zA-Z0-9_-]*)=([^&\s#]+)/g;

function redactUrlQueryParams(text: string): string {
    return text.replace(URL_QUERY_PARAM_RE, (match, sep, key, value) => {
        if (SENSITIVE_QUERY_PARAMS.has(String(key).toLowerCase())) {
            const tail = String(value).slice(-4);
            return `${sep}${key}=[REDACTED…${tail}]`;
        }
        return match;
    });
}

export function scrubPii(text: string): string {
    let result = redactUrlQueryParams(text);
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

/**
 * Cache transports per (pretty,file) to avoid pino's per-call worker
 * threads (Node warns past 10 `exit` listeners). Level filtering happens
 * on the pino instance; transports accept everything at `trace`.
 */
let cachedTransport: ReturnType<typeof pino.transport> | undefined;
let cachedTransportKey: string | undefined;

function getTransport(): ReturnType<typeof pino.transport> {
    const pretty = resolvePretty();
    const file = resolveFile();
    const key = `pretty=${pretty}|file=${file.enabled ? file.path : ''}`;

    if (cachedTransport && cachedTransportKey === key) return cachedTransport;

    const targets: pino.TransportTargetOptions[] = [
        {
            target: pretty ? 'pino-pretty' : 'pino/file',
            options: pretty
                ? { colorize: true, translateTime: 'SYS:standard' }
                : { destination: 2 },
            level: 'trace',
        },
    ];

    if (file.enabled) {
        targets.push({
            target: 'pino/file',
            options: { destination: file.path, mkdir: true },
            level: 'trace',
        });
    }

    cachedTransport = pino.transport({ targets });
    cachedTransportKey = key;
    return cachedTransport;
}

export function createLogger(service: string, options?: LoggerOptions): pino.Logger {
    const level = options?.level ?? resolveLevel();
    const enableRedact = options?.redact ?? true;

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
        getTransport(),
    );
}
