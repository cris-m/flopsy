// MCP Home Assistant Server
// Smart home control: lights, switches, sensors, climate, automations.
// Env vars (HOME_ASSISTANT_URL, HOME_ASSISTANT_TOKEN) are injected by
// the gateway MCP loader — no local .env loading needed.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

interface HomeAssistantConfig {
    baseUrl: string;
    token: string;
}

function getConfig(): HomeAssistantConfig {
    const baseUrl = process.env.HOME_ASSISTANT_URL;
    const token = process.env.HOME_ASSISTANT_TOKEN;

    if (!baseUrl || !token) {
        throw new Error(
            'Home Assistant not configured.\n\n' +
                'Required environment variables:\n' +
                '  HOME_ASSISTANT_URL=http://homeassistant.local:8123\n' +
                '  HOME_ASSISTANT_TOKEN=your_long_lived_access_token\n\n' +
                'Get token from: Home Assistant → Profile → Long-Lived Access Tokens',
        );
    }

    return { baseUrl, token };
}

class HomeAssistantClient {
    constructor(private config: HomeAssistantConfig) {}

    private async request(endpoint: string, method = 'GET', body?: any) {
        const url = `${this.config.baseUrl}/api${endpoint}`;
        const response = await fetch(url, {
            method,
            headers: {
                Authorization: `Bearer ${this.config.token}`,
                'Content-Type': 'application/json',
            },
            body: body ? JSON.stringify(body) : null,
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Home Assistant API error: ${response.status} ${text}`);
        }

        return response.json();
    }

    async getStates() {
        return this.request('/states');
    }

    async getState(entityId: string) {
        return this.request(`/states/${entityId}`);
    }

    async callService(domain: string, service: string, data?: any) {
        return this.request(`/services/${domain}/${service}`, 'POST', data);
    }

    async getServices() {
        return this.request('/services');
    }

    async getHistory(entityId: string, startTime?: string, endTime?: string) {
        let url = `/history/period`;
        if (startTime) url += `/${startTime}`;
        if (entityId) url += `?filter_entity_id=${entityId}`;
        if (endTime) url += `&end_time=${endTime}`;
        return this.request(url);
    }
}

async function createHomeAssistantMcpServer() {
    const config = getConfig();
    const ha = new HomeAssistantClient(config);

    const server = new McpServer({
        name: 'home-assistant-server',
        version: '1.0.0',
    });

    server.tool(
        'ha_list_entities',
        'List all entities (devices) in Home Assistant',
        {
            domain: z
                .string()
                .optional()
                .describe('Filter by domain (light, switch, sensor, climate, etc.)'),
        },
        async ({ domain }) => {
            const states = await ha.getStates();

            let filtered = states;
            if (domain) {
                filtered = states.filter((s: any) => s.entity_id.startsWith(`${domain}.`));
            }

            const entities = filtered.map((s: any) => ({
                entity_id: s.entity_id,
                state: s.state,
                friendly_name: s.attributes?.friendly_name,
                last_changed: s.last_changed,
                attributes: s.attributes,
            }));

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(entities, null, 2),
                    },
                ],
            };
        },
    );

    server.tool(
        'ha_get_state',
        'Get the current state of a specific entity',
        {
            entityId: z.string().describe('Entity ID (e.g., light.living_room)'),
        },
        async ({ entityId }) => {
            const state = await ha.getState(entityId);

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(
                            {
                                entity_id: state.entity_id,
                                state: state.state,
                                attributes: state.attributes,
                                last_changed: state.last_changed,
                                last_updated: state.last_updated,
                            },
                            null,
                            2,
                        ),
                    },
                ],
            };
        },
    );

    server.tool(
        'ha_turn_on',
        'Turn on a device (light, switch, etc.)',
        {
            entityId: z.string().describe('Entity ID to turn on'),
            brightness: z
                .number()
                .min(0)
                .max(255)
                .optional()
                .describe('Brightness for lights (0-255)'),
            color: z.string().optional().describe('Color name or hex code for lights'),
        },
        async ({ entityId, brightness, color }) => {
            const domain = entityId.split('.')[0] ?? entityId;
            const data: any = { entity_id: entityId };

            if (brightness !== undefined) {
                data.brightness = brightness;
            }

            if (color) {
                data.color_name = color;
            }

            await ha.callService(domain, 'turn_on', data);

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(
                            {
                                success: true,
                                entity_id: entityId,
                                action: 'turned_on',
                                params: data,
                            },
                            null,
                            2,
                        ),
                    },
                ],
            };
        },
    );

    server.tool(
        'ha_turn_off',
        'Turn off a device (light, switch, etc.)',
        {
            entityId: z.string().describe('Entity ID to turn off'),
        },
        async ({ entityId }) => {
            const domain = entityId.split('.')[0] ?? entityId;
            await ha.callService(domain, 'turn_off', {
                entity_id: entityId,
            });

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(
                            {
                                success: true,
                                entity_id: entityId,
                                action: 'turned_off',
                            },
                            null,
                            2,
                        ),
                    },
                ],
            };
        },
    );

    server.tool(
        'ha_toggle',
        'Toggle a device on/off',
        {
            entityId: z.string().describe('Entity ID to toggle'),
        },
        async ({ entityId }) => {
            const domain = entityId.split('.')[0] ?? entityId;
            await ha.callService(domain, 'toggle', {
                entity_id: entityId,
            });

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(
                            {
                                success: true,
                                entity_id: entityId,
                                action: 'toggled',
                            },
                            null,
                            2,
                        ),
                    },
                ],
            };
        },
    );

    server.tool(
        'ha_set_climate',
        'Control climate/thermostat settings',
        {
            entityId: z.string().describe('Climate entity ID'),
            temperature: z.number().optional().describe('Target temperature'),
            mode: z
                .enum(['auto', 'heat', 'cool', 'off', 'dry', 'fan_only'])
                .optional()
                .describe('HVAC mode'),
        },
        async ({ entityId, temperature, mode }) => {
            const data: any = { entity_id: entityId };

            if (temperature !== undefined) {
                data.temperature = temperature;
            }

            if (mode) {
                await ha.callService('climate', 'set_hvac_mode', {
                    entity_id: entityId,
                    hvac_mode: mode,
                });
            }

            if (temperature !== undefined) {
                await ha.callService('climate', 'set_temperature', data);
            }

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(
                            {
                                success: true,
                                entity_id: entityId,
                                temperature,
                                mode,
                            },
                            null,
                            2,
                        ),
                    },
                ],
            };
        },
    );

    server.tool(
        'ha_call_service',
        'Call any Home Assistant service (advanced)',
        {
            domain: z.string().describe('Service domain (e.g., light, switch)'),
            service: z.string().describe('Service name (e.g., turn_on, turn_off)'),
            data: z.record(z.string(), z.any()).optional().describe('Service data as JSON object'),
        },
        async ({ domain, service, data }) => {
            const result = await ha.callService(domain, service, data);

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(
                            {
                                success: true,
                                domain,
                                service,
                                data,
                                result,
                            },
                            null,
                            2,
                        ),
                    },
                ],
            };
        },
    );

    server.tool(
        'ha_get_history',
        'Get historical state data for an entity',
        {
            entityId: z.string().describe('Entity ID to get history for'),
            startTime: z.string().optional().describe('ISO 8601 start time'),
            endTime: z.string().optional().describe('ISO 8601 end time'),
        },
        async ({ entityId, startTime, endTime }) => {
            const history = await ha.getHistory(entityId, startTime, endTime);

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(history, null, 2),
                    },
                ],
            };
        },
    );

    server.tool(
        'ha_list_services',
        'List all available Home Assistant services',
        {
            domain: z.string().optional().describe('Filter by domain'),
        },
        async ({ domain }) => {
            const services = await ha.getServices();

            let filtered = services;
            if (domain) {
                filtered = { [domain]: services[domain] };
            }

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(filtered, null, 2),
                    },
                ],
            };
        },
    );

    return server;
}

async function main() {
    try {
        const server = await createHomeAssistantMcpServer();
        const transport = new StdioServerTransport();
        await server.connect(transport);
        console.error('[MCP] Home Assistant started');
    } catch (error) {
        console.error('[MCP] Home Assistant failed:', error);
        process.exit(1);
    }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
    main();
}

export { createHomeAssistantMcpServer };
