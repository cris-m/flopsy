import { createLogger } from '@flopsy/shared';
import type { HeartbeatTrigger } from './heartbeat';

const log = createLogger('webhook-trigger');

export interface WebhookTriggerConfig {
    enabled: boolean;
    port?: number;
    path?: string;
}

export class WebhookTrigger {
    private heartbeat: HeartbeatTrigger | null = null;
    private running = false;

    async start(config: WebhookTriggerConfig): Promise<void> {
        if (this.running || !config.enabled) return;
        this.running = true;
        log.info('Webhook trigger started');
    }

    async stop(): Promise<void> {
        this.running = false;
        log.info('Webhook trigger stopped');
    }

    setHeartbeatTrigger(heartbeat: HeartbeatTrigger): void {
        this.heartbeat = heartbeat;
    }

    async handleIncoming(name: string, payload: Record<string, unknown>): Promise<void> {
        if (this.heartbeat) {
            await this.heartbeat.triggerNow(name, payload);
        }
    }
}
