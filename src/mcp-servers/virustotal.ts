// MCP VirusTotal Server
// Security analysis: file hashes, URLs, IPs, domains via VirusTotal API v3
// https://docs.virustotal.com/reference/overview

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const VT_API = 'https://www.virustotal.com/api/v3';

const API_KEY = process.env.VIRUSTOTAL_API_KEY;
if (!API_KEY) {
    console.error('[MCP] Missing VIRUSTOTAL_API_KEY');
    process.exit(1);
}

// ── Types ────────────────────────────────────────────────────────────────────

interface VtResult<T = unknown> {
    success: boolean;
    data?: T;
    error?: string;
}

interface AnalysisStats {
    malicious: number;
    suspicious: number;
    harmless: number;
    undetected: number;
    timeout?: number;
}

interface VtSummary {
    id: string;
    type: 'file' | 'url' | 'ip_address' | 'domain';
    stats: AnalysisStats;
    reputation: number;
    tags: string[];
    lastAnalysisDate: string;
    names?: string[] | undefined;
    size?: number | undefined;
    typeDescription?: string | undefined;
    country?: string | undefined;
    asOwner?: string | undefined;
    detections?: Array<{ engine: string; result: string }> | undefined;
}

// ── API helpers ──────────────────────────────────────────────────────────────

async function fetchApi<T>(path: string, options?: RequestInit): Promise<VtResult<T>> {
    try {
        const url = path.startsWith('http') ? path : `${VT_API}${path}`;
        const response = await fetch(url, {
            ...options,
            headers: {
                'x-apikey': API_KEY!,
                'User-Agent': 'Flopsy-VirusTotal-MCP/1.0',
                ...options?.headers,
            },
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

function formatResult<T>(result: VtResult<T>): {
    content: Array<{ type: 'text'; text: string }>;
} {
    if (!result.success) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: result.error }) }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
}

// ── Response summarizers ─────────────────────────────────────────────────────

function extractDetections(
    lastAnalysisResults: Record<string, { category: string; result: string | null }> | undefined,
    limit = 10,
): Array<{ engine: string; result: string }> {
    if (!lastAnalysisResults) return [];
    return Object.entries(lastAnalysisResults)
        .filter(([, v]) => v.category === 'malicious' || v.category === 'suspicious')
        .slice(0, limit)
        .map(([engine, v]) => ({ engine, result: v.result ?? v.category }));
}

interface VtApiObject {
    id: string;
    type: string;
    attributes: Record<string, unknown>;
}

function summarizeObject(obj: VtApiObject): VtSummary {
    const attrs = obj.attributes;
    const stats = (attrs.last_analysis_stats as AnalysisStats | undefined) ?? {
        malicious: 0,
        suspicious: 0,
        harmless: 0,
        undetected: 0,
    };
    const analysisDate = attrs.last_analysis_date as number | undefined;

    const summary: VtSummary = {
        id: obj.id,
        type: obj.type as VtSummary['type'],
        stats,
        reputation: (attrs.reputation as number | undefined) ?? 0,
        tags: (attrs.tags as string[] | undefined) ?? [],
        lastAnalysisDate: analysisDate ? new Date(analysisDate * 1000).toISOString() : 'unknown',
        detections: extractDetections(
            attrs.last_analysis_results as
                | Record<string, { category: string; result: string | null }>
                | undefined,
        ),
    };

    // File-specific fields
    if (obj.type === 'file') {
        summary.names = (attrs.names as string[] | undefined)?.slice(0, 5);
        summary.size = attrs.size as number | undefined;
        summary.typeDescription = attrs.type_description as string | undefined;
    }

    // IP/domain fields
    if (obj.type === 'ip_address' || obj.type === 'domain') {
        summary.country = attrs.country as string | undefined;
        summary.asOwner = attrs.as_owner as string | undefined;
    }

    return summary;
}

// ── Server ───────────────────────────────────────────────────────────────────

export function createVirusTotalMcpServer() {
    const server = new McpServer({
        name: 'virustotal-server',
        version: '1.0.0',
    });

    // ── File report ──────────────────────────────────────────────────────────

    server.registerTool(
        'vt_file_report',
        {
            title: 'File Report',
            description:
                'Look up a file by its MD5, SHA-1, or SHA-256 hash. Returns detection stats, file type, and which engines flagged it.',
            inputSchema: {
                hash: z.string().describe('MD5, SHA-1, or SHA-256 hash of the file'),
            },
        },
        async ({ hash }) => {
            const result = await fetchApi<{ data: VtApiObject }>(`/files/${hash}`);
            if (!result.success) return formatResult(result);
            return formatResult({ success: true, data: summarizeObject(result.data!.data) });
        },
    );

    // ── URL report (with automatic submission + polling) ─────────────────────
    //
    // Single atomic operation: checks for an existing report, submits the URL
    // for scanning if none exists, polls until analysis completes, then returns
    // the full VtSummary. The LLM never needs to manage a two-step submit/fetch
    // flow — give a URL, always get a complete report back.

    server.registerTool(
        'vt_url_report',
        {
            title: 'URL Security Report',
            description:
                'Get a complete VirusTotal security report for a URL. Returns detection stats, ' +
                'verdict, tags, and engine findings. Automatically submits for scanning if no ' +
                'existing report is found.',
            inputSchema: {
                url: z.string().describe('URL to analyse'),
            },
        },
        async ({ url }) => {
            // VT v3 identifies URLs by their base64url-encoded form (no padding)
            const urlId = Buffer.from(url).toString('base64url');

            // Step 1: Try to fetch an existing cached report first (fast path)
            const existing = await fetchApi<{ data: VtApiObject }>(`/urls/${urlId}`);
            if (existing.success && existing.data?.data) {
                return formatResult({ success: true, data: summarizeObject(existing.data.data) });
            }

            // Step 2: No cached report — submit the URL for scanning
            const submitted = await fetchApi<{ data: { id: string } }>('/urls', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: `url=${encodeURIComponent(url)}`,
            });
            if (!submitted.success) return formatResult(submitted);

            // Step 3: Poll the analysis endpoint until the scan completes or we time out.
            // VT typically finishes URL scans within 5-15 seconds.
            const analysisId = submitted.data!.data.id;
            const POLL_INTERVAL_MS = 3_000;
            const MAX_ATTEMPTS = 6; // up to ~18 seconds total

            for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
                await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

                const analysis = await fetchApi<{
                    data: { attributes: { status: string }; type: string; id: string };
                }>(`/analyses/${analysisId}`);

                if (analysis.success && analysis.data?.data?.attributes?.status === 'completed') {
                    // Scan finished — fetch the canonical URL report which has the full stats
                    const report = await fetchApi<{ data: VtApiObject }>(`/urls/${urlId}`);
                    if (report.success && report.data?.data) {
                        return formatResult({
                            success: true,
                            data: summarizeObject(report.data.data),
                        });
                    }
                }
            }

            // Scan submitted but didn't complete within the polling window.
            // Return a partial result rather than an opaque analysis ID.
            return formatResult({
                success: false,
                error: `URL submitted to VirusTotal (analysis ${analysisId}) but the scan did not ` +
                    `complete within the polling window. The URL may be queued — try again in a minute.`,
            });
        },
    );

    // ── IP report ────────────────────────────────────────────────────────────

    server.registerTool(
        'vt_ip_report',
        {
            title: 'IP Address Report',
            description:
                'Check IP address reputation — detection stats, country, ASN owner, and which engines flag it.',
            inputSchema: {
                ip: z.string().describe('IPv4 or IPv6 address'),
            },
        },
        async ({ ip }) => {
            const result = await fetchApi<{ data: VtApiObject }>(`/ip_addresses/${ip}`);
            if (!result.success) return formatResult(result);
            return formatResult({ success: true, data: summarizeObject(result.data!.data) });
        },
    );

    // ── Domain report ────────────────────────────────────────────────────────

    server.registerTool(
        'vt_domain_report',
        {
            title: 'Domain Report',
            description:
                'Check domain reputation — detection stats, registrar info, and which engines flag it.',
            inputSchema: {
                domain: z.string().describe('Domain name (e.g., example.com)'),
            },
        },
        async ({ domain }) => {
            const result = await fetchApi<{ data: VtApiObject }>(`/domains/${domain}`);
            if (!result.success) return formatResult(result);
            return formatResult({ success: true, data: summarizeObject(result.data!.data) });
        },
    );

    // ── Search ───────────────────────────────────────────────────────────────

    server.registerTool(
        'vt_search',
        {
            title: 'VirusTotal Intelligence Search',
            description:
                'Search VirusTotal intelligence. Examples: "type:peexe p:5+", "engines:emotet", "tag:exploit". Requires VT Premium API key for most queries.',
            inputSchema: {
                query: z.string().describe('VT intelligence search query'),
                limit: z.number().default(10).describe('Max results to return (default: 10)'),
            },
        },
        async ({ query, limit }) => {
            const result = await fetchApi<{ data: VtApiObject[] }>(
                `/search?query=${encodeURIComponent(query)}&limit=${limit}`,
            );
            if (!result.success) return formatResult(result);
            const summaries = result.data!.data.map(summarizeObject);
            return formatResult({
                success: true,
                data: { count: summaries.length, results: summaries },
            });
        },
    );

    return server;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    const server = createVirusTotalMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('[MCP] VirusTotal started');
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
    main().catch((error) => {
        console.error('[MCP VirusTotal Server] Fatal error:', error);
        process.exit(1);
    });
}
