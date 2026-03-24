import type { Channel } from './channel';

export type Platform = 'whatsapp' | 'telegram' | 'discord' | 'line' | 'signal' | (string & {});

export interface GatewayConfig {
    port?: number;
    host?: string;
    token?: string;
    deduplicationTtlMs?: number;
    maxDeduplicationEntries?: number;
    rateLimit?: {
        windowMs?: number;
        maxRequests?: number;
        maxConnectionsPerIp?: number;
    };
}

export interface Gateway {
    readonly channels: ReadonlyMap<string, Channel>;

    register(channel: Channel): void;
    unregister(name: string): void;
    getChannel(name: string): Channel | undefined;

    start(): Promise<void>;
    stop(): Promise<void>;
}
