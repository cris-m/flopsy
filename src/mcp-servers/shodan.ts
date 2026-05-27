// MCP Shodan Server
// Network intelligence: IP lookup, device search, DNS, vulnerability data
// https://developer.shodan.io/api

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const SHODAN_API = 'https://api.shodan.io';

const API_KEY = process.env.SHODAN_API_KEY;
if (!API_KEY) {
    console.error('[MCP] Missing SHODAN_API_KEY');
    process.exit(1);
}

// ── Types ────────────────────────────────────────────────────────────────────

interface ShodanResult<T = unknown> {
    success: boolean;
    data?: T;
    error?: string;
}

interface HostSummary {
    ip: string;
    hostnames: string[];
    country: string;
    city: string;
    org: string;
    isp: string;
    os: string | null;
    ports: number[];
    vulns: string[];
    services: Array<{
        port: number;
        transport: string;
        product: string;
        version: string;
    }>;
    lastUpdate: string;
}

interface ShodanBanner {
    port: number;
    transport: string;
    product?: string;
    version?: string;
    data?: string;
    timestamp?: string;
}

interface ShodanHostResponse {
    ip_str: string;
    hostnames: string[];
    country_name: string;
    city: string;
    org: string;
    isp: string;
    os: string | null;
    ports: number[];
    vulns?: string[];
    data: ShodanBanner[];
    last_update: string;
}

interface ShodanSearchResponse {
    matches: Array<{
        ip_str: string;
        hostnames: string[];
        port: number;
        transport: string;
        product?: string;
        version?: string;
        org: string;
        os: string | null;
        country_name: string;
        city: string;
        vulns?: string[];
        timestamp: string;
    }>;
    total: number;
}

// ── API helpers ──────────────────────────────────────────────────────────────

function withKey(path: string): string {
    const sep = path.includes('?') ? '&' : '?';
    return `${SHODAN_API}${path}${sep}key=${API_KEY}`;
}

async function fetchApi<T>(path: string): Promise<ShodanResult<T>> {
    try {
        const url = withKey(path);
        const response = await fetch(url, {
            headers: { 'User-Agent': 'Flopsy-Shodan-MCP/1.0' },
        });

        if (!response.ok) {
            const text = await response.text();
            return { success: false, error: `HTTP ${response.status}: ${text.slice(0, 200)}` };
        }

        const data = (await response.json()) as T;
        return { success: true, data };
    } catch (err) {
        return { success: false, error: (err as Error).message };
    }
}

function formatResult<T>(result: ShodanResult<T>): {
    content: Array<{ type: 'text'; text: string }>;
} {
    if (!result.success) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: result.error }) }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
}

// ── Response summarizers ─────────────────────────────────────────────────────

function summarizeHost(host: ShodanHostResponse): HostSummary {
    return {
        ip: host.ip_str,
        hostnames: host.hostnames ?? [],
        country: host.country_name ?? 'unknown',
        city: host.city ?? 'unknown',
        org: host.org ?? 'unknown',
        isp: host.isp ?? 'unknown',
        os: host.os,
        ports: host.ports ?? [],
        vulns: host.vulns ?? [],
        services: (host.data ?? []).map((svc) => ({
            port: svc.port,
            transport: svc.transport ?? 'tcp',
            product: svc.product ?? '',
            version: svc.version ?? '',
        })),
        lastUpdate: host.last_update ?? 'unknown',
    };
}

// ── Server ───────────────────────────────────────────────────────────────────

export function createShodanMcpServer() {
    const server = new McpServer({
        name: 'shodan-server',
        version: '1.0.0',
    });

    // ── Host lookup ──────────────────────────────────────────────────────────

    server.registerTool(
        'shodan_host',
        {
            title: 'Host Lookup',
            description:
                'Get all available information on an IP: open ports, running services, vulnerabilities, geolocation, and OS detection.',
            inputSchema: {
                ip: z.string().describe('IPv4 address to look up'),
            },
        },
        async ({ ip }) => {
            const result = await fetchApi<ShodanHostResponse>(`/shodan/host/${ip}`);
            if (!result.success) return formatResult(result);
            return formatResult({ success: true, data: summarizeHost(result.data!) });
        },
    );

    // ── Search ───────────────────────────────────────────────────────────────

    server.registerTool(
        'shodan_search',
        {
            title: 'Device Search (costs 1 query credit per call)',
            description:
                'Return individual host records (IP, port, banner, vulns, geo) for a Shodan query. Costs 1 query credit per call; narrow the result set with shodan_host_count (free) first.\n\n' +
                'Args:\n' +
                '  query — Shodan search syntax. Examples: "apache country:JP", "port:22 os:linux", "product:nginx city:Berlin".\n' +
                '  page  — results page, 100 records each. Defaults to 1.',
            inputSchema: {
                query: z.string().describe('Shodan search query'),
                page: z
                    .number()
                    .default(1)
                    .describe('Results page (default: 1, 100 results per page)'),
            },
        },
        async ({ query, page }) => {
            const result = await fetchApi<ShodanSearchResponse>(
                `/shodan/host/search?query=${encodeURIComponent(query)}&page=${page}`,
            );
            if (!result.success) return formatResult(result);

            const matches = result.data!.matches.map((m) => ({
                ip: m.ip_str,
                hostnames: m.hostnames ?? [],
                port: m.port,
                transport: m.transport ?? 'tcp',
                product: m.product ?? '',
                version: m.version ?? '',
                org: m.org ?? '',
                os: m.os,
                country: m.country_name ?? '',
                city: m.city ?? '',
                vulns: m.vulns ?? [],
                timestamp: m.timestamp,
            }));

            return formatResult({
                success: true,
                data: { total: result.data!.total, page, count: matches.length, matches },
            });
        },
    );

    // ── DNS resolve ──────────────────────────────────────────────────────────

    server.registerTool(
        'shodan_dns_resolve',
        {
            title: 'DNS Resolve',
            description: 'Resolve one or more hostnames to their IP addresses.',
            inputSchema: {
                hostnames: z
                    .string()
                    .describe(
                        'Comma-separated list of hostnames (e.g., "google.com,facebook.com")',
                    ),
            },
        },
        async ({ hostnames }) => {
            const result = await fetchApi<Record<string, string | null>>(
                `/dns/resolve?hostnames=${encodeURIComponent(hostnames)}`,
            );
            return formatResult(result);
        },
    );

    // ── DNS reverse ──────────────────────────────────────────────────────────

    server.registerTool(
        'shodan_dns_reverse',
        {
            title: 'Reverse DNS',
            description: 'Look up the hostnames associated with one or more IP addresses.',
            inputSchema: {
                ips: z.string().describe('Comma-separated list of IPs (e.g., "8.8.8.8,1.1.1.1")'),
            },
        },
        async ({ ips }) => {
            const result = await fetchApi<Record<string, string[]>>(
                `/dns/reverse?ips=${encodeURIComponent(ips)}`,
            );
            return formatResult(result);
        },
    );

    // ── Host count ───────────────────────────────────────────────────────────

    server.registerTool(
        'shodan_host_count',
        {
            title: 'Host Count (free reconnaissance)',
            description:
                'Count devices matching a query, optionally aggregated by facet. Costs zero query credits — use before any paid shodan_search.\n\n' +
                'Args:\n' +
                '  query  — Shodan search syntax (e.g. "apache country:JP", "product:nginx").\n' +
                '  facets — optional comma list. Each facet returns top-N values + counts. Examples: "port", "country", "org", "product", "http.title", "ssl.cert.issuer". Append ":N" for a custom limit ("port:10,country:5").\n\n' +
                'Methodology lives in /skills/security/recon-discipline/SKILL.md and /skills/security/shodan/SKILL.md.',
            inputSchema: {
                query: z.string().describe('Shodan search query (e.g., "apache", "product:nginx country:JP")'),
                facets: z
                    .string()
                    .optional()
                    .describe(
                        'Comma-separated facet list (e.g., "port,country" or "port:10,country:5" with per-facet result limits). Each facet returns top-N values + counts. Free, no credit cost.',
                    ),
            },
        },
        async ({ query, facets }) => {
            const params = new URLSearchParams({ query });
            if (facets) params.set('facets', facets);
            const result = await fetchApi<{ total: number; facets?: Record<string, unknown> }>(
                `/shodan/host/count?${params.toString()}`,
            );
            return formatResult(result);
        },
    );

    // ── API info ─────────────────────────────────────────────────────────────

    server.registerTool(
        'shodan_info',
        {
            title: 'API Info',
            description: 'Check your Shodan API plan, remaining query credits, and scan credits.',
            inputSchema: {},
        },
        async () => {
            const result = await fetchApi<{
                plan: string;
                query_credits: number;
                scan_credits: number;
                monitored_ips: number | null;
            }>('/api-info');
            return formatResult(result);
        },
    );

    return server;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    const server = createShodanMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('[MCP] Shodan started');
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
    main().catch((error) => {
        console.error('[MCP Shodan Server] Fatal error:', error);
        process.exit(1);
    });
}
