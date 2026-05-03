import { createSign, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import type {
    Peer,
    OutboundMessage,
    ReactionOptions,
    Message,
    WebhookChannel,
    InteractiveCapability,
} from '@gateway/types';
import { BaseChannel, toError } from '@gateway/core/base-channel';
import type { GoogleChatChannelConfig, ServiceAccountKey, GoogleChatEvent } from './types';

const CHAT_API = 'https://chat.googleapis.com/v1';
const TOKEN_URI = 'https://oauth2.googleapis.com/token';
// chat.bot covers send/receive; chat.messages.reactions is for reactions
// (2023+). Missing reaction scope only fails react() calls, not auth.
const SCOPE = 'https://www.googleapis.com/auth/chat.bot https://www.googleapis.com/auth/chat.messages.reactions';
const TOKEN_REFRESH_MARGIN_MS = 60_000;

interface CachedToken {
    accessToken: string;
    expiresAt: number;
}

export class GoogleChatChannel extends BaseChannel implements WebhookChannel {
    readonly name = 'googlechat';
    readonly authType = 'token';
    readonly webhookPath: string;

    readonly capabilities: readonly InteractiveCapability[] = ['reactions'];

    private readonly channelConfig: GoogleChatChannelConfig;
    private credentials: ServiceAccountKey | null = null;
    private cachedToken: CachedToken | null = null;

    constructor(config: GoogleChatChannelConfig) {
        super(config);
        this.channelConfig = config;
        this.webhookPath = config.webhookPath ?? '/webhook/googlechat';
    }

    verifyWebhook(_req: IncomingMessage, body: string): boolean {
        const expected = this.channelConfig.verificationToken;
        if (!expected) return true;
        try {
            const parsed = JSON.parse(body) as { token?: string };
            const provided = parsed.token ?? '';
            if (provided.length !== expected.length) return false;
            const { timingSafeEqual } = require('node:crypto') as typeof import('node:crypto');
            return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
        } catch {
            return false;
        }
    }

    extractEvents(parsed: unknown): unknown[] {
        if (!parsed || typeof parsed !== 'object') return [];
        return [parsed];
    }

    async connect(): Promise<void> {
        this.setStatus('connecting');

        try {
            this.credentials = await this.resolveCredentials();
            await this.getAccessToken();
            this.setStatus('connected');
            this.emit('onAuthUpdate', 'authenticated');
        } catch (err) {
            this.setStatus('error');
            this.emitError(toError(err));
        }
    }

    async disconnect(): Promise<void> {
        this.credentials = null;
        this.cachedToken = null;
        this.setStatus('disconnected');
    }

    async handleWebhookEvent(event: GoogleChatEvent): Promise<void> {
        if (event.type !== 'MESSAGE') return;

        const msg = event.message;
        if (!msg?.text) return;

        const space = event.space;
        const sender = event.user;
        const isDm = space?.type === 'DM';
        const peerType = isDm ? ('user' as const) : ('group' as const);
        const senderId = sender?.name ?? '';
        const peerId = space?.name ?? '';

        if (!this.isAllowed(isDm ? senderId : peerId, peerType)) return;

        if (!isDm && this.channelConfig.groupActivation === 'mention') {
            const hasAnnotation = msg.annotations?.some(
                (a: { type: string }) => a.type === 'USER_MENTION',
            );
            if (!hasAnnotation && !msg.argumentText) return;
        }

        const body = msg.argumentText?.trim() || msg.text;

        const normalized: Message = {
            id: msg.name ?? randomUUID(),
            channelName: this.name,
            peer: { id: peerId, type: peerType, name: space?.displayName },
            sender: { id: senderId, name: sender?.displayName },
            body,
            timestamp: msg.createTime ?? new Date().toISOString(),
        };

        await this.emit('onMessage', normalized);
    }

    async send(message: OutboundMessage): Promise<string> {
        const spaceName = message.peer.id;
        const token = await this.getAccessToken();

        const body: Record<string, unknown> = { text: message.body ?? '' };
        if (message.replyTo) {
            body.thread = { name: message.replyTo };
        }

        const res = await fetch(`${CHAT_API}/${spaceName}/messages`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });

        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`Google Chat API ${res.status}: ${text.slice(0, 300)}`);
        }

        const result = (await res.json()) as { name?: string };
        return result.name ?? '';
    }

    async sendTyping(_peer: Peer): Promise<void> {
        // No typing indicator API.
    }

    async react(options: ReactionOptions): Promise<void> {
        // POST /v1/{message}/reactions; DELETE per-reaction subresource.
        // remove: list-and-delete by emoji match (we don't track resource names).
        if (!options.messageId) return;
        const token = await this.getAccessToken();
        const baseUrl = `${CHAT_API}/${options.messageId}/reactions`;

        if (options.remove) {
            try {
                const listUrl = `${baseUrl}?filter=${encodeURIComponent(`emoji.unicode = "${options.emoji}"`)}`;
                const listRes = await fetch(listUrl, {
                    headers: { Authorization: `Bearer ${token}` },
                });
                if (!listRes.ok) return;
                const data = (await listRes.json()) as {
                    reactions?: Array<{ name?: string }>;
                };
                for (const r of data.reactions ?? []) {
                    if (!r.name) continue;
                    await fetch(`${CHAT_API}/${r.name}`, {
                        method: 'DELETE',
                        headers: { Authorization: `Bearer ${token}` },
                    });
                }
            } catch { /* benign — ⏳ may linger alongside ✅ */ }
            return;
        }

        try {
            const res = await fetch(baseUrl, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    emoji: { unicode: options.emoji },
                }),
            });
            if (!res.ok) return;
        } catch { /* network failure — silent */ }
    }

    private async resolveCredentials(): Promise<ServiceAccountKey> {
        if (this.channelConfig.serviceAccountKey) {
            return this.channelConfig.serviceAccountKey;
        }
        if (this.channelConfig.serviceAccountKeyPath) {
            const raw = await readFile(this.channelConfig.serviceAccountKeyPath, 'utf-8');
            return JSON.parse(raw) as ServiceAccountKey;
        }
        throw new Error('Google Chat requires serviceAccountKey or serviceAccountKeyPath');
    }

    private async getAccessToken(): Promise<string> {
        if (this.cachedToken && Date.now() < this.cachedToken.expiresAt - TOKEN_REFRESH_MARGIN_MS) {
            return this.cachedToken.accessToken;
        }

        if (!this.credentials) throw new Error('No credentials available');

        const jwt = this.createJwt(this.credentials);
        const tokenUri = this.credentials.token_uri ?? TOKEN_URI;

        const res = await fetch(tokenUri, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                assertion: jwt,
            }),
        });

        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`Token exchange failed ${res.status}: ${text.slice(0, 300)}`);
        }

        const data = (await res.json()) as { access_token: string; expires_in: number };
        this.cachedToken = {
            accessToken: data.access_token,
            expiresAt: Date.now() + data.expires_in * 1000,
        };

        return this.cachedToken.accessToken;
    }

    private createJwt(creds: ServiceAccountKey): string {
        const now = Math.floor(Date.now() / 1000);
        const header = { alg: 'RS256', typ: 'JWT' };
        const payload = {
            iss: creds.client_email,
            scope: SCOPE,
            aud: creds.token_uri ?? TOKEN_URI,
            iat: now,
            exp: now + 3600,
        };

        const segments = [base64url(JSON.stringify(header)), base64url(JSON.stringify(payload))];

        const signingInput = segments.join('.');
        const sign = createSign('RSA-SHA256');
        sign.update(signingInput);
        const signature = sign.sign(creds.private_key, 'base64url');

        return `${signingInput}.${signature}`;
    }
}

function base64url(str: string): string {
    return Buffer.from(str).toString('base64url');
}
