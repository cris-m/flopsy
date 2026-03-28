import type { Channel } from './channel';
import type { RateLimitConfig } from '../core/security';

export type Platform = 'whatsapp' | 'telegram' | 'discord' | 'line' | 'signal' | (string & {});

export interface GatewayConfig {
    port?: number;
    host?: string;
    token?: string;
    deduplicationTtlMs?: number;
    maxDeduplicationEntries?: number;
    rateLimit?: Partial<RateLimitConfig>;
}

export interface Gateway {
    readonly channels: ReadonlyMap<string, Channel>;

    register(channel: Channel): void;
    unregister(name: string): void;
    getChannel(name: string): Channel | undefined;

    start(): Promise<void>;
    stop(): Promise<void>;
}
