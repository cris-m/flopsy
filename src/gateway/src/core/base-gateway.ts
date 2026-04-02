import { randomUUID } from 'crypto';
import { createLogger } from '@flopsy/shared';
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Gateway, GatewayConfig, Channel, Message } from '@gateway/types';
import {
    sanitizeInbound,
    sanitize,
    isSafeIdentifier,
    RateLimiter,
    validateToken,
    extractToken,
    isLoopbackIp,
} from './security';

const DEFAULT_DEDUP_TTL_MS = 30_000;
const DEFAULT_MAX_DEDUP_ENTRIES = 10_000;
const DEDUP_SWEEP_INTERVAL_MS = 60_000;
const MAX_PAYLOAD = 1 * 1024 * 1024;

export type EventType =
    | 'message.inbound'
    | 'message.outbound'
    | 'channel.status'
    | 'channel.error'
    | 'channel.qr';

export interface WsRequest {
    type: 'req';
    id: string;
    method: string;
    params?: Record<string, unknown>;
}

export interface WsClient {
    id: string;
    ws: WebSocket;
    ip: string;
    subscriptions: Set<EventType>;
    connectedAt: number;
}

export abstract class BaseGateway implements Gateway {
    protected readonly log = createLogger('gateway');
    protected readonly config: Required<GatewayConfig>;
    protected readonly rateLimiter: RateLimiter;

    private wss: WebSocketServer | null = null;
    private readonly clients = new Map<string, WsClient>();
    private readonly _channels = new Map<string, Channel>();
    private readonly dedup = new Map<string, number>();
    private dedupSweep: ReturnType<typeof setInterval> | null = null;
    private readonly handlers = new Map<
        string,
        (client: WsClient, params?: Record<string, unknown>) => Promise<unknown>
    >();

    constructor(config: GatewayConfig = {}) {
        this.config = {
            port: config.port ?? 18789,
            host: config.host ?? '127.0.0.1',
            token: config.token ?? '',
            deduplicationTtlMs: config.deduplicationTtlMs ?? DEFAULT_DEDUP_TTL_MS,
            maxDeduplicationEntries: config.maxDeduplicationEntries ?? DEFAULT_MAX_DEDUP_ENTRIES,
            rateLimit: config.rateLimit ?? {},
        };
        this.rateLimiter = new RateLimiter(config.rateLimit);
        this.registerBuiltinHandlers();
    }

    get channels(): ReadonlyMap<string, Channel> {
        return this._channels;
    }

    private readonly channelHandlers = new Map<
        string,
        {
            onMessage: (msg: Message) => Promise<void>;
            onStatusChange: (status: string) => void;
            onError: (err: Error) => void;
            onQR: (qr: string) => void;
        }
    >();

    register(channel: Channel): void {
        if (this._channels.has(channel.name)) {
            throw new Error(`Channel "${channel.name}" is already registered`);
        }
        this._channels.set(channel.name, channel);

        const handlers = {
            onMessage: (msg: Message) => this.handleInbound(msg),
            onStatusChange: (status: string) =>
                this.broadcast('channel.status', { channel: channel.name, status }),
            onError: (err: Error) => {
                this.log.error({ channel: channel.name, err }, 'channel error');
                this.broadcast('channel.error', { channel: channel.name, error: err.message });
            },
            onQR: (qr: string) => this.broadcast('channel.qr', { channel: channel.name, qr }),
        };
        this.channelHandlers.set(channel.name, handlers);

        channel.on('onMessage', handlers.onMessage);
        channel.on('onStatusChange', handlers.onStatusChange);
        channel.on('onError', handlers.onError);
        channel.on('onQR', handlers.onQR);
        this.log.info(
            `channel registered - ${channel.name} (auth=${channel.authType}, dm=${channel.dmPolicy})`,
        );
    }

    unregister(name: string): void {
        const channel = this._channels.get(name);
        if (!channel) return;
        const handlers = this.channelHandlers.get(name);
        if (handlers) {
            channel.off('onMessage', handlers.onMessage);
            channel.off('onStatusChange', handlers.onStatusChange);
            channel.off('onError', handlers.onError);
            channel.off('onQR', handlers.onQR);
            this.channelHandlers.delete(name);
        }
        this._channels.delete(name);
        this.log.info({ channel: name }, 'channel unregistered');
    }

    getChannel(name: string): Channel | undefined {
        return this._channels.get(name);
    }

    registerHandler(
        method: string,
        handler: (client: WsClient, params?: Record<string, unknown>) => Promise<unknown>,
    ): void {
        this.handlers.set(method, handler);
    }

    async start(): Promise<void> {
        if (this.wss) return;
        this.dedupSweep = setInterval(() => this.sweepDedup(), DEDUP_SWEEP_INTERVAL_MS);
        this.dedupSweep.unref();

        const { port, host } = this.config;
        this.wss = new WebSocketServer({
            port,
            host,
            maxPayload: MAX_PAYLOAD,
            verifyClient: (info, cb) => this.verifyClient(info, cb),
        });

        this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));
        this.wss.on('error', (err) => this.log.error({ err }, 'websocket server error'));

        for (const channel of this._channels.values()) {
            if (!channel.enabled) continue;
            try {
                await channel.connect();
                this.log.debug({ channel: channel.name }, 'channel connected');
            } catch (err) {
                this.log.error({ channel: channel.name, err }, 'channel failed to connect');
            }
        }

        await this.onStart();
        this.log.info({ port, host }, 'gateway started');
    }

    async stop(): Promise<void> {
        if (this.dedupSweep) {
            clearInterval(this.dedupSweep);
            this.dedupSweep = null;
        }
        this.dedup.clear();

        for (const client of this.clients.values()) {
            client.ws.close(1001, 'server shutting down');
        }
        this.clients.clear();

        if (this.wss) {
            await new Promise<void>((resolve) => {
                this.wss!.close(() => resolve());
            });
            this.wss = null;
        }

        this.rateLimiter.stop();

        for (const channel of this._channels.values()) {
            try {
                await channel.disconnect();
            } catch (err) {
                this.log.error({ channel: channel.name, err }, 'channel failed to disconnect');
            }
        }

        await this.onStop();
        this.log.info('gateway stopped');
    }

    protected broadcast(event: EventType, payload: unknown): void {
        const msg = JSON.stringify({
            type: 'event',
            event,
            payload,
            timestamp: new Date().toISOString(),
        });

        for (const client of this.clients.values()) {
            if (!client.subscriptions.has(event)) continue;
            if (client.ws.readyState === WebSocket.OPEN) {
                client.ws.send(msg);
            }
        }
    }

    private verifyClient(
        info: { origin: string; secure: boolean; req: IncomingMessage },
        callback: (result: boolean, code?: number, message?: string) => void,
    ): void {
        const { req } = info;
        const clientIp = req.socket.remoteAddress ?? 'unknown';
        const isLoopback = isLoopbackIp(clientIp);

        if (!this.rateLimiter.checkConnection(clientIp)) {
            this.log.warn({ ip: clientIp }, 'connection limit exceeded');
            callback(false, 429, 'Too many connections');
            return;
        }

        if (!this.config.token) {
            if (!isLoopback) {
                this.log.warn({ ip: clientIp }, 'rejected non-loopback (no token configured)');
                callback(false, 403, 'Non-loopback requires authentication');
                return;
            }
            callback(true);
            return;
        }

        const allowedOrigins = process.env.GATEWAY_ALLOWED_ORIGINS;
        if (allowedOrigins && info.origin) {
            const origins = allowedOrigins.split(',').map((o) => o.trim());
            if (!origins.includes(info.origin)) {
                this.log.warn({ origin: info.origin }, 'rejected disallowed origin');
                callback(false, 403, 'Forbidden');
                return;
            }
        }

        const token = extractToken(req.headers as Record<string, string | string[] | undefined>);

        if (!validateToken(this.config.token, token)) {
            this.log.warn({ ip: clientIp }, 'authentication failed');
            callback(false, 401, 'Invalid token');
            return;
        }

        callback(true);
    }

    private handleConnection(ws: WebSocket, req: IncomingMessage): void {
        const clientId = randomUUID();
        const clientIp = req.socket.remoteAddress ?? 'unknown';

        const client: WsClient = {
            id: clientId,
            ws,
            ip: clientIp,
            subscriptions: new Set(),
            connectedAt: Date.now(),
        };

        this.clients.set(clientId, client);
        this.rateLimiter.registerConnection(clientId, clientIp);
        this.log.debug({ clientId, ip: clientIp }, 'client connected');

        ws.on('message', (data: Buffer) => {
            this.handleMessage(client, data.toString()).catch((err) => {
                this.log.error({ err, clientId }, 'message handler error');
            });
        });

        ws.on('close', () => {
            this.clients.delete(clientId);
            this.rateLimiter.unregisterConnection(clientId, clientIp);
            this.log.debug({ clientId }, 'client disconnected');
        });

        ws.on('error', (err) => {
            this.log.error({ err, clientId }, 'client error');
            this.clients.delete(clientId);
            this.rateLimiter.unregisterConnection(clientId, clientIp);
            try {
                ws.close();
            } catch {
                /* */
            }
        });
    }

    private async handleMessage(client: WsClient, raw: string): Promise<void> {
        const rateCheck = this.rateLimiter.checkRequest(client.id);
        if (!rateCheck.allowed) {
            this.sendError(
                client,
                'unknown',
                'RATE_LIMITED',
                `Retry after ${Math.ceil((rateCheck.retryAfterMs ?? 0) / 1000)}s`,
            );
            return;
        }

        let request: WsRequest;
        try {
            request = JSON.parse(raw);
        } catch {
            this.sendError(client, 'unknown', 'PARSE_ERROR', 'Invalid JSON');
            return;
        }

        if (request.type !== 'req' || !request.id || !request.method) {
            this.sendError(
                client,
                request.id ?? 'unknown',
                'INVALID_REQUEST',
                'Missing type, id, or method',
            );
            return;
        }

        const handler = this.handlers.get(request.method);
        if (!handler) {
            this.sendError(
                client,
                request.id,
                'UNKNOWN_METHOD',
                `Unknown method: ${request.method}`,
            );
            return;
        }

        try {
            const result = await handler(client, request.params);
            this.sendOk(client, request.id, result);
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Unknown error';
            this.log.error({ err, method: request.method }, 'handler error');
            this.sendError(client, request.id, 'HANDLER_ERROR', message);
        }
    }

    private sendOk(client: WsClient, id: string, payload: unknown): void {
        if (client.ws.readyState !== WebSocket.OPEN) return;
        client.ws.send(JSON.stringify({ type: 'res', id, ok: true, payload }));
    }

    private sendError(client: WsClient, id: string, code: string, message: string): void {
        if (client.ws.readyState !== WebSocket.OPEN) return;
        client.ws.send(JSON.stringify({ type: 'res', id, ok: false, error: { code, message } }));
    }

    private static readonly VALID_EVENTS = new Set<EventType>([
        'message.inbound',
        'message.outbound',
        'channel.status',
        'channel.error',
        'channel.qr',
    ]);

    private requireChannel(name: string | undefined): Channel {
        if (!name) throw new Error('channel required');
        const ch = this._channels.get(name);
        if (!ch) throw new Error(`channel "${name}" not found`);
        return ch;
    }

    private healthCache: { data: unknown; ts: number } | null = null;
    private readonly HEALTH_CACHE_TTL_MS = 5_000;

    private buildChannelSnapshot(name: string, ch: Channel) {
        return {
            name,
            status: ch.status,
            enabled: ch.enabled,
            authType: ch.authType,
            dmPolicy: ch.dmPolicy,
            groupPolicy: ch.groupPolicy,
            streaming: ch.streaming ?? null,
            capabilities: ch.capabilities ?? [],
        };
    }

    private buildHealthSnapshot(probe = false) {
        const now = Date.now();
        if (!probe && this.healthCache && now - this.healthCache.ts < this.HEALTH_CACHE_TTL_MS) {
            return this.healthCache.data;
        }

        const channels = [...this._channels.entries()].map(([name, ch]) =>
            this.buildChannelSnapshot(name, ch),
        );

        let enabled = 0,
            connected = 0,
            disconnected = 0,
            errored = 0;
        for (const c of channels) {
            if (c.enabled) enabled++;
            if (c.status === 'connected') connected++;
            else if (c.status === 'disconnected') disconnected++;
            else if (c.status === 'error') errored++;
        }

        const snapshot = {
            healthy: enabled > 0 && connected === enabled,
            uptime: process.uptime(),
            timestamp: new Date().toISOString(),
            channels,
            summary: { total: channels.length, enabled, connected, disconnected, error: errored },
            clients: this.clients.size,
            proactive: this.getProactiveHealth(),
        };

        this.healthCache = { data: snapshot, ts: now };
        return snapshot;
    }

    private registerBuiltinHandlers(): void {
        this.handlers.set('ping', async () => ({ pong: Date.now() }));

        this.handlers.set('health', async (_client, params) => {
            const probe = params?.probe === true;
            return this.buildHealthSnapshot(probe);
        });

        this.handlers.set('status', async () => this.buildHealthSnapshot());

        this.handlers.set('channels.list', async () =>
            [...this._channels.entries()].map(([name, ch]) => this.buildChannelSnapshot(name, ch)),
        );

        this.handlers.set('subscribe', async (client, params) => {
            const events = params?.events as string[] | undefined;
            if (!Array.isArray(events)) return { error: 'events array required' };
            for (const e of events) {
                if (BaseGateway.VALID_EVENTS.has(e as EventType))
                    client.subscriptions.add(e as EventType);
            }
            return { subscribed: [...client.subscriptions] };
        });

        this.handlers.set('unsubscribe', async (client, params) => {
            const events = params?.events as string[] | undefined;
            if (!Array.isArray(events)) return { error: 'events array required' };
            for (const e of events) client.subscriptions.delete(e as EventType);
            return { subscribed: [...client.subscriptions] };
        });

        const VALID_PEER_TYPES = new Set(['user', 'group', 'channel']);

        this.handlers.set('send', async (_client, params) => {
            const channelName = params?.channel as string;
            const peerId = params?.peerId as string;
            const body = params?.body as string | undefined;
            if (!channelName || !peerId) return { error: 'channel and peerId required' };

            if (!isSafeIdentifier(peerId)) return { error: 'invalid peerId' };

            const rawPeerType = (params?.peerType as string) ?? 'user';
            if (!VALID_PEER_TYPES.has(rawPeerType)) return { error: 'invalid peerType' };
            const peerType = rawPeerType as 'user' | 'group' | 'channel';

            const sanitizedBody = body ? sanitize(body, 50_000) : undefined;

            const channel = this._channels.get(channelName);
            if (!channel) return { error: `channel "${channelName}" not found` };

            const messageId = await channel.send({
                peer: { id: peerId, type: peerType },
                body: sanitizedBody,
            });

            this.broadcast('message.outbound', {
                channel: channelName,
                peerId,
                body: sanitizedBody,
                messageId,
            });
            return { messageId };
        });

        this.handlers.set('channel.auth.status', async (_client, params) => {
            const name = params?.channel as string;
            const ch = this.requireChannel(name);
            return {
                channel: name,
                status: ch.status,
                authType: ch.authType,
                needsAuth: ch.status !== 'connected',
            };
        });

        const authStartCooldowns = new Map<string, number>();
        this.handlers.set('channel.auth.start', async (_client, params) => {
            const name = params?.channel as string;
            const ch = this.requireChannel(name);

            const lastStart = authStartCooldowns.get(name) ?? 0;
            if (Date.now() - lastStart < 60_000) {
                throw new Error(`channel "${name}" auth was started recently, wait 60s`);
            }
            authStartCooldowns.set(name, Date.now());

            await ch.disconnect();
            if (ch.clearSession) await ch.clearSession();
            await ch.connect();
            return { started: true, channel: name };
        });

        this.handlers.set('channel.auth.disconnect', async (_client, params) => {
            const name = params?.channel as string;
            const ch = this.requireChannel(name);
            await ch.disconnect();
            return { disconnected: true, channel: name };
        });
    }

    private async handleInbound(message: Message): Promise<void> {
        const clean = sanitizeInbound(message);

        if (!isSafeIdentifier(clean.id, 256)) {
            this.log.debug({ messageId: clean.id }, 'invalid message id rejected');
            return;
        }

        if (this.isDuplicate(clean.id)) return;

        const sanitized: Message = { ...message, ...clean };

        this.broadcast('message.inbound', {
            channel: sanitized.channelName,
            peer: sanitized.peer,
            sender: sanitized.sender,
            body: sanitized.body,
            messageId: sanitized.id,
        });

        await this.route(sanitized);
    }

    private isDuplicate(messageId: string): boolean {
        const now = Date.now();

        if (this.dedup.has(messageId)) {
            this.log.debug({ messageId }, 'duplicate dropped');
            return true;
        }

        if (this.dedup.size >= this.config.maxDeduplicationEntries) {
            const oldest = this.dedup.keys().next().value;
            if (oldest !== undefined) this.dedup.delete(oldest);
        }

        this.dedup.set(messageId, now);
        return false;
    }

    private sweepDedup(): void {
        const cutoff = Date.now() - this.config.deduplicationTtlMs;
        for (const [id, ts] of this.dedup) {
            if (ts < cutoff) this.dedup.delete(id);
        }
    }

    protected abstract route(message: Message): Promise<void>;
    protected async onStart(): Promise<void> {}
    protected async onStop(): Promise<void> {}
    protected getProactiveHealth(): Record<string, unknown> {
        return {};
    }
}
