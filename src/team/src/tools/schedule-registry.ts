/**
 * Bridge between the agent's `manage_schedule` tool and the gateway's
 * ProactiveEngine. Populated by the gateway at boot; read by the tool
 * at invoke-time. Keeping this as a module-level singleton avoids
 * threading the engine reference through every TeamHandler.invoke call.
 *
 * The scheduler facade interface is structurally typed so `@flopsy/team`
 * doesn't import `@flopsy/gateway` (which would create a cycle).
 */

import type { HeartbeatDefinitionConfig, JobDefinitionConfig } from '@flopsy/shared';

export interface ScheduleFacade {
    addRuntimeHeartbeat(
        hb: HeartbeatDefinitionConfig,
        createdBy?: { threadId?: string; agentName?: string },
    ): boolean;
    addRuntimeCronJob(
        job: JobDefinitionConfig,
        createdBy?: { threadId?: string; agentName?: string },
    ): boolean;
    /**
     * Register an inbound webhook endpoint at runtime. Registers the HTTP
     * route on the gateway's WebhookServer AND persists to proactive.db
     * with `kind: 'webhook'`. Reusable across CLI + manage_schedule tool.
     */
    addRuntimeWebhook(
        cfg: {
            name: string;
            path: string;
            targetChannel: string;
            secret?: string;
            eventTypeHeader?: string;
        },
        createdBy?: { threadId?: string; agentName?: string },
    ): boolean;
    removeRuntimeSchedule(id: string): boolean;
    setRuntimeScheduleEnabled(id: string, enabled: boolean): boolean;
    /**
     * Replace a runtime schedule's config in place. Preserves enabled flag,
     * created_at, and run stats — unlike delete+create which wipes them.
     * Returns false if id is unknown or kind would change.
     */
    replaceRuntimeSchedule(
        id: string,
        newConfig: HeartbeatDefinitionConfig | JobDefinitionConfig,
    ): boolean;
    listSchedules(): Array<{
        id: string;
        kind: 'heartbeat' | 'cron' | 'webhook';
        configJson: string;
        enabled: boolean;
        createdAt: number;
        createdByThread: string | null;
        createdByAgent: string | null;
    }>;
}

let facade: ScheduleFacade | null = null;

export function setScheduleFacade(f: ScheduleFacade | null): void {
    facade = f;
}

export function getScheduleFacade(): ScheduleFacade | null {
    return facade;
}
