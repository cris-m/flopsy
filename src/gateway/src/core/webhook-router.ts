import type { IncomingMessage } from 'node:http';
import { createLogger } from '@flopsy/shared';
import { verifyWebhookSignature, sanitize, isSafeIdentifier } from './security';
import type { WebhookServer } from './base-webhook';
import type { MessageRouter } from './message-router';
import type { WebhookSignatureConfig } from './security';

const MAX_EVENT_BODY_LENGTH = 50_000;

/**
 * Configuration for an external webhook endpoint (GitHub, Stripe, etc.).
 * Each endpoint gets its own route on the webhook server and pushes
 * events into the agent via the channel worker's EventQueue.
 */
export interface ExternalWebhookConfig {
    /** Unique name for this webhook (used as taskId prefix). */
    name: string;
    /** Route path on the webhook server (e.g. '/webhook/github'). */
    path: string;
    /** Which channel's worker should receive the event. */
    targetChannel: string;
    /** Secret for HMAC signature verification. If unset, requests are accepted unsigned. */
    secret?: string;
    /** Signature config (header name, algorithm, format). */
    signature?: {
        header: string;
        algorithm?: 'sha1' | 'sha256' | 'sha512';
        format?: 'hex' | 'base64';
        prefix?: string;
    };
    /** Header name containing the event type (e.g. 'x-github-event'). */
    eventTypeHeader?: string;
    /** Optional: extract a summary from the payload for the agent. */
    transform?: (body: unknown) => string;
}

/**
 * Routes external service webhooks (GitHub, Stripe, etc.) into the agent
 * system via ChannelWorker event queues. Not a messaging channel — these
 * are one-way notifications that the agent can act on.
 */
export class WebhookRouter {
    private readonly log = createLogger('webhook-router');
    private readonly configs: ExternalWebhookConfig[];

    constructor(configs: ExternalWebhookConfig[]) {
        this.configs = configs;
    }

    register(webhookServer: WebhookServer, messageRouter: MessageRouter): void {
        for (const cfg of this.configs) {
            this.registerEndpoint(webhookServer, messageRouter, cfg);
        }
    }

    private registerEndpoint(
        webhookServer: WebhookServer,
        messageRouter: MessageRouter,
        cfg: ExternalWebhookConfig,
    ): void {
        webhookServer.registerRoute(cfg.path, async (req, body, res) => {
            if (!this.verify(req, body, cfg)) {
                webhookServer.respond(res, 401, { error: `Invalid ${cfg.name} webhook signature` });
                return;
            }

            const parsed = webhookServer.parseJson(body);
            if (!parsed || typeof parsed !== 'object') {
                webhookServer.respond(res, 400, { error: 'Invalid JSON' });
                return;
            }

            webhookServer.respond(res, 200, { status: 'ok' });

            const worker = messageRouter.getWorker(cfg.targetChannel);
            if (!worker) {
                this.log.warn({ webhook: cfg.name, target: cfg.targetChannel }, 'target channel worker not found');
                return;
            }

            const summary = cfg.transform
                ? cfg.transform(parsed)
                : sanitize(JSON.stringify(parsed, null, 2), MAX_EVENT_BODY_LENGTH);

            const eventType = extractEventType(req, cfg);
            const taskId = `${cfg.name}-${eventType}-${Date.now()}`;

            if (!isSafeIdentifier(taskId)) {
                this.log.warn({ taskId }, 'generated unsafe taskId — dropped');
                return;
            }

            worker.injectEvent({
                type: 'task_complete',
                taskId,
                result: `[${cfg.name}] ${eventType}\n${summary}`,
                completedAt: Date.now(),
            });

            this.log.info({ webhook: cfg.name, event: eventType, target: cfg.targetChannel }, 'webhook event routed');
        });

        this.log.debug({ webhook: cfg.name, path: cfg.path, target: cfg.targetChannel }, 'external webhook registered');
    }

    private verify(req: IncomingMessage, body: string, cfg: ExternalWebhookConfig): boolean {
        if (!cfg.secret || !cfg.signature) return true;

        const sig = req.headers[cfg.signature.header.toLowerCase()] as string | undefined;
        if (!sig) return false;

        const sigConfig: WebhookSignatureConfig = {
            algorithm: cfg.signature.algorithm ?? 'sha256',
            format: cfg.signature.format ?? 'hex',
            prefix: cfg.signature.prefix,
        };

        return verifyWebhookSignature(cfg.secret, body, sig, sigConfig);
    }
}

function extractEventType(req: IncomingMessage, cfg: ExternalWebhookConfig): string {
    if (cfg.eventTypeHeader) {
        const value = req.headers[cfg.eventTypeHeader.toLowerCase()] as string | undefined;
        if (value) return value;
    }
    return cfg.name;
}
