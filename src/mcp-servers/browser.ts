import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    chromium,
    firefox,
    webkit,
    type Browser,
    type BrowserContext,
    type Page,
    type ElementHandle,
} from 'playwright';
import { z } from 'zod';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

const DEFAULT_HEADLESS = process.env.BROWSER_HEADLESS === 'true';
const BROWSER_EXECUTABLE_PATH = process.env.BROWSER_EXECUTABLE_PATH?.trim() || undefined;
const MAX_SESSIONS = parseInt(process.env.BROWSER_MAX_SESSIONS || '5', 10);
const MAX_PAGES_PER_SESSION = parseInt(process.env.BROWSER_MAX_PAGES || '10', 10);
const MAX_MARKERS = parseInt(process.env.BROWSER_MAX_MARKERS || '100', 10);
const DEFAULT_TIMEOUT = parseInt(process.env.BROWSER_DEFAULT_TIMEOUT || '30000', 10);
const SCREENSHOT_DIR =
    process.env.BROWSER_SCREENSHOT_DIR || path.join(os.tmpdir(), 'browser-mcp-screenshots');

// Ensure screenshot directory exists
if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

// Security: URL Validation

const BLOCKED_PROTOCOLS = ['file:', 'javascript:', 'data:', 'vbscript:', 'about:'];
const BLOCKED_HOSTS = [
    'localhost',
    '127.0.0.1',
    '0.0.0.0',
    '::1',
    '169.254.169.254', // AWS metadata
    'metadata.google.internal', // GCP metadata
];

function isPrivateIP(hostname: string): boolean {
    // Check for private IP ranges
    const privatePatterns = [
        /^10\./,
        /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
        /^192\.168\./,
        /^fc00:/i,
        /^fd00:/i,
    ];
    return privatePatterns.some((p) => p.test(hostname));
}

function validateUrl(urlString: string): { valid: boolean; error?: string } {
    try {
        const url = new URL(urlString);

        // Block dangerous protocols
        if (BLOCKED_PROTOCOLS.includes(url.protocol)) {
            return { valid: false, error: `Blocked protocol: ${url.protocol}` };
        }

        // Block localhost and metadata endpoints
        const hostname = url.hostname.toLowerCase();
        if (BLOCKED_HOSTS.includes(hostname)) {
            return { valid: false, error: `Blocked host: ${hostname}` };
        }

        // Block private IP ranges
        if (isPrivateIP(hostname)) {
            return { valid: false, error: 'Private IP addresses are blocked' };
        }

        // Only allow http and https
        if (!['http:', 'https:'].includes(url.protocol)) {
            return { valid: false, error: `Only HTTP/HTTPS allowed, got: ${url.protocol}` };
        }

        return { valid: true };
    } catch {
        return { valid: false, error: 'Invalid URL format' };
    }
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
    ts: string;
    level: LogLevel;
    action: string;
    details?: Record<string, unknown>;
}

function log(level: LogLevel, action: string, details?: Record<string, unknown>): void {
    const entry: LogEntry = {
        ts: new Date().toISOString(),
        level,
        action,
    };
    if (details) entry.details = details;
    console.error(JSON.stringify(entry));
}

type ErrorCode =
    | 'SESSION_NOT_FOUND'
    | 'PAGE_NOT_FOUND'
    | 'MARKER_NOT_FOUND'
    | 'ELEMENT_NOT_FOUND'
    | 'TIMEOUT'
    | 'LIMIT_EXCEEDED'
    | 'SECURITY_VIOLATION'
    | 'INVALID_INPUT'
    | 'UNKNOWN';

class BrowserMcpError extends Error {
    constructor(
        public code: ErrorCode,
        message: string,
        public details?: Record<string, unknown>,
    ) {
        super(message);
        this.name = 'BrowserMcpError';
    }
}

interface ToolResult {
    [key: string]: unknown;
    content: Array<
        { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
    >;
    isError?: boolean;
}

interface ToolContext {
    sessionId: string;
    pageId: string;
    url: string;
    title: string;
    timestamp: number;
    lastAction?: string | undefined;
}

function successResult(
    data: Record<string, unknown>,
    suggestion?: string,
    context?: ToolContext,
): ToolResult {
    const result: Record<string, unknown> = { success: true, ...data };
    if (suggestion) {
        result.suggestion = suggestion;
    }
    if (context) {
        result.context = context;
    }
    return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
    };
}

/** Build context object for tool responses */
async function buildContext(
    sessionId: string,
    page: Page,
    pageId: string,
    lastAction?: string,
): Promise<ToolContext> {
    return {
        sessionId,
        pageId,
        url: page.url(),
        title: await page.title().catch(() => ''),
        timestamp: Date.now(),
        lastAction,
    };
}

/** Recovery suggestions for each error type */
const ERROR_RECOVERY_HINTS: Record<ErrorCode, string> = {
    SESSION_NOT_FOUND: 'Use browser_launch or browser_connect to create a session first.',
    PAGE_NOT_FOUND:
        'Use browser_new_page to create a page, or browser_list_pages to see available pages.',
    MARKER_NOT_FOUND:
        'Use browser_snapshot to get fresh ref IDs, or browser_mark to create a marker.',
    ELEMENT_NOT_FOUND:
        'Try browser_snapshot to find the correct element. The page may have changed - wait with browser_wait first.',
    TIMEOUT:
        'The page might be slow. Try: 1) browser_wait for longer, 2) check if element exists with browser_snapshot, 3) reload with browser_history.',
    LIMIT_EXCEEDED:
        'Close unused sessions with browser_close or pages with browser_close_page to free resources.',
    SECURITY_VIOLATION:
        'Only public HTTP/HTTPS URLs are allowed. No localhost, private IPs, or file:// URLs.',
    INVALID_INPUT:
        'Check the input parameters. Use browser_snapshot to find valid selectors or ref IDs.',
    UNKNOWN:
        'Try browser_snapshot to understand current page state, or browser_info to check the URL.',
};

function errorResult(error: unknown): ToolResult {
    let message = 'Unknown error';
    let code: ErrorCode = 'UNKNOWN';
    let details: Record<string, unknown> | undefined;

    if (error instanceof BrowserMcpError) {
        message = error.message;
        code = error.code;
        details = error.details;
    } else if (error instanceof Error) {
        message = error.message;
        // Map common Playwright errors
        if (message.includes('timeout')) code = 'TIMEOUT';
        else if (message.includes('not found')) code = 'ELEMENT_NOT_FOUND';
    }

    const suggestion = ERROR_RECOVERY_HINTS[code];

    log('error', 'tool_error', { code, message, details, suggestion });

    return {
        content: [
            {
                type: 'text',
                text: JSON.stringify({ success: false, error: message, code, details, suggestion }),
            },
        ],
        isError: true,
    };
}

const BROWSERS = { chromium, firefox, webkit } as const;
type BrowserType = keyof typeof BROWSERS;

interface NavigationEntry {
    url: string;
    title: string;
    timestamp: number;
    pageId: string;
}

interface ConsoleEntry {
    type: 'log' | 'warn' | 'error' | 'info' | 'debug';
    text: string;
    timestamp: number;
    pageId: string;
}

interface NetworkError {
    url: string;
    status?: number | undefined;
    statusText?: string | undefined;
    failure?: string | undefined;
    timestamp: number;
    pageId: string;
}

interface Session {
    browser: Browser;
    context: BrowserContext;
    pages: Map<string, Page>;
    activePageId: string | null;
    createdAt: number;
    history: NavigationEntry[];
    consoleLogs: ConsoleEntry[];
    networkErrors: NetworkError[];
    stealthEnabled: boolean;
    /** Absolute path to the HAR file — set only when launched with recordHar: true. */
    harPath?: string;
    /** Directory where video frames are written — set only when launched with recordVideo: true. */
    videoDir?: string;
}

/** Max console/network entries to keep per session */
const MAX_LOG_ENTRIES = 100;

interface Marker {
    element: ElementHandle<Element>;
    pageId: string;
    description?: string;
    createdAt: number;
}

class BrowserManager {
    private sessions: Map<string, Session> = new Map();
    private markers: Map<string, Marker> = new Map();
    private markerCounter = 0;
    private cleanupInterval?: NodeJS.Timeout;

    constructor() {
        // Periodic cleanup of stale markers (every 2 minutes)
        this.cleanupInterval = setInterval(() => this.cleanupStaleMarkers(), 120000);
    }

    /**
     * Connect to an existing Chrome instance via CDP.
     * Chrome must be started with: --remote-debugging-port=9222
     * This allows using YOUR actual browser with extensions, logins, cookies.
     */
    async connectOverCDP(
        sessionId: string,
        cdpUrl: string = 'http://localhost:9222',
    ): Promise<{ session: Session; reused: boolean }> {
        // Check for existing session
        const existing = this.sessions.get(sessionId);
        if (existing) {
            log('info', 'session_reused', { sessionId });
            return { session: existing, reused: true };
        }

        // Check session limit
        if (this.sessions.size >= MAX_SESSIONS) {
            throw new BrowserMcpError(
                'LIMIT_EXCEEDED',
                `Maximum ${MAX_SESSIONS} sessions allowed`,
                { current: this.sessions.size, max: MAX_SESSIONS },
            );
        }

        log('info', 'connecting_cdp', { sessionId, cdpUrl });

        try {
            const browser = await chromium.connectOverCDP(cdpUrl);

            // Get existing context (your profile) or create new
            const contexts = browser.contexts();
            const context: BrowserContext = contexts[0] ?? (await browser.newContext());

            // Import existing pages
            const pages = new Map<string, Page>();
            const existingPages = context.pages();

            if (existingPages.length > 0) {
                existingPages.forEach((page, index) => {
                    const id = `tab_${index}_${Date.now()}`;
                    pages.set(id, page);

                    // Remove stale listeners before re-adding (prevents leak on reconnect)
                    page.removeAllListeners('framenavigated');

                    // Auto-clear markers on navigation
                    page.on('framenavigated', (frame) => {
                        if (frame === page.mainFrame()) {
                            this.clearMarkersForPage(id);
                        }
                    });
                });
            }

            const session: Session = {
                browser,
                context,
                pages,
                activePageId: pages.keys().next().value || null,
                createdAt: Date.now(),
                history: [],
                consoleLogs: [],
                networkErrors: [],
                stealthEnabled: false,
            };

            // Set up log listeners for existing pages
            for (const [pageId, page] of pages.entries()) {
                this.setupPageListeners(session, pageId, page);
            }

            // Add initial pages to history
            for (const [pageId, page] of pages.entries()) {
                const url = page.url();
                if (url && url !== 'about:blank') {
                    session.history.push({
                        url,
                        title: await page.title().catch(() => ''),
                        timestamp: Date.now(),
                        pageId,
                    });
                }
            }

            this.sessions.set(sessionId, session);
            log('info', 'connected_cdp', {
                sessionId,
                cdpUrl,
                existingPages: existingPages.length,
                urls: existingPages.map((p) => p.url()).slice(0, 5),
            });

            return { session, reused: false };
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            throw new BrowserMcpError(
                'SESSION_NOT_FOUND',
                `Failed to connect to Chrome at ${cdpUrl}. Is Chrome running with --remote-debugging-port=9222?`,
                { error: message, hint: 'Start Chrome with: chrome --remote-debugging-port=9222' },
            );
        }
    }

    async launchSession(
        sessionId: string,
        browserType: BrowserType = 'chromium',
        headless = DEFAULT_HEADLESS,
        reuseExisting = true,
        recordHar = false,
        recordVideo = false,
    ): Promise<{ session: Session; reused: boolean }> {
        // Check for existing session
        const existing = this.sessions.get(sessionId);
        if (existing) {
            if (reuseExisting) {
                log('info', 'session_reused', { sessionId });
                return { session: existing, reused: true };
            } else {
                log('info', 'session_replacing', { sessionId });
                await this.closeSession(sessionId);
            }
        }

        // Check session limit
        if (this.sessions.size >= MAX_SESSIONS) {
            throw new BrowserMcpError(
                'LIMIT_EXCEEDED',
                `Maximum ${MAX_SESSIONS} sessions allowed`,
                { current: this.sessions.size, max: MAX_SESSIONS },
            );
        }

        log('info', 'session_launching', { sessionId, browserType, headless, recordHar, recordVideo });

        const browser = await BROWSERS[browserType].launch({
            headless,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
            timeout: DEFAULT_TIMEOUT,
            ...(BROWSER_EXECUTABLE_PATH && browserType === 'chromium'
                ? { executablePath: BROWSER_EXECUTABLE_PATH }
                : {}),
        });

        const harPath = recordHar
            ? path.join(os.tmpdir(), `browser-mcp-har-${sessionId}-${Date.now()}.har`)
            : undefined;
        const videoDir = recordVideo
            ? path.join(os.tmpdir(), `browser-mcp-video-${sessionId}-${Date.now()}`)
            : undefined;

        if (videoDir) fs.mkdirSync(videoDir, { recursive: true });

        const context = await browser.newContext({
            viewport: { width: 1280, height: 720 },
            permissions: [], // Deny all permissions by default
            ...(harPath ? { recordHar: { path: harPath, mode: 'full' as const } } : {}),
            ...(videoDir ? { recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } } } : {}),
        });

        // Set default timeouts
        context.setDefaultTimeout(DEFAULT_TIMEOUT);
        context.setDefaultNavigationTimeout(DEFAULT_TIMEOUT * 2);

        const session: Session = {
            browser,
            context,
            pages: new Map(),
            activePageId: null,
            createdAt: Date.now(),
            history: [],
            consoleLogs: [],
            networkErrors: [],
            stealthEnabled: false,
            harPath,
            videoDir,
        };

        this.sessions.set(sessionId, session);
        log('info', 'session_launched', { sessionId, browserType, headless });

        return { session, reused: false };
    }

    getSession(sessionId: string): Session {
        const session = this.sessions.get(sessionId);
        if (!session) {
            throw new BrowserMcpError('SESSION_NOT_FOUND', `Session "${sessionId}" not found`);
        }
        return session;
    }

    /**
     * Set up console and network listeners for a page
     */
    private setupPageListeners(session: Session, pageId: string, page: Page): void {
        // Console log listener
        page.on('console', (msg) => {
            const type = msg.type() as ConsoleEntry['type'];
            if (['log', 'warn', 'error', 'info', 'debug'].includes(type)) {
                session.consoleLogs.push({
                    type,
                    text: msg.text(),
                    timestamp: Date.now(),
                    pageId,
                });
                // Trim old logs
                if (session.consoleLogs.length > MAX_LOG_ENTRIES) {
                    session.consoleLogs = session.consoleLogs.slice(-MAX_LOG_ENTRIES);
                }
            }
        });

        // Network error listener
        page.on('requestfailed', (request) => {
            session.networkErrors.push({
                url: request.url(),
                failure: request.failure()?.errorText,
                timestamp: Date.now(),
                pageId,
            });
            // Trim old errors
            if (session.networkErrors.length > MAX_LOG_ENTRIES) {
                session.networkErrors = session.networkErrors.slice(-MAX_LOG_ENTRIES);
            }
        });

        // Response error listener (4xx, 5xx)
        page.on('response', (response) => {
            const status = response.status();
            if (status >= 400) {
                session.networkErrors.push({
                    url: response.url(),
                    status,
                    statusText: response.statusText(),
                    timestamp: Date.now(),
                    pageId,
                });
                // Trim old errors
                if (session.networkErrors.length > MAX_LOG_ENTRIES) {
                    session.networkErrors = session.networkErrors.slice(-MAX_LOG_ENTRIES);
                }
            }
        });

        // Auto-clear markers on navigation
        page.on('framenavigated', (frame) => {
            if (frame === page.mainFrame()) {
                this.clearMarkersForPage(pageId);
            }
        });
    }

    /**
     * Remove all event listeners from a page to prevent memory leaks.
     */
    private removePageListeners(page: Page): void {
        page.removeAllListeners('console');
        page.removeAllListeners('requestfailed');
        page.removeAllListeners('response');
        page.removeAllListeners('framenavigated');
    }

    async newPage(sessionId: string, pageId?: string): Promise<{ page: Page; id: string }> {
        const session = this.getSession(sessionId);

        // Check page limit
        if (session.pages.size >= MAX_PAGES_PER_SESSION) {
            throw new BrowserMcpError(
                'LIMIT_EXCEEDED',
                `Maximum ${MAX_PAGES_PER_SESSION} pages per session allowed`,
                { current: session.pages.size, max: MAX_PAGES_PER_SESSION },
            );
        }

        const page = await session.context.newPage();
        const id = pageId || `page_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        session.pages.set(id, page);
        session.activePageId = id;

        // Set up listeners for new page
        this.setupPageListeners(session, id, page);

        log('info', 'page_created', { sessionId, pageId: id });
        return { page, id };
    }

    getPage(sessionId: string, pageId?: string): { page: Page; id: string } {
        const session = this.getSession(sessionId);

        const id = pageId || session.activePageId;
        if (!id) {
            throw new BrowserMcpError(
                'PAGE_NOT_FOUND',
                'No active page. Call browser_launch first.',
            );
        }

        const page = session.pages.get(id);
        if (!page) {
            throw new BrowserMcpError('PAGE_NOT_FOUND', `Page "${id}" not found`);
        }

        return { page, id };
    }

    async closeSession(sessionId: string): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (session) {
            // Clear all markers for this session
            for (const [markerId, marker] of this.markers.entries()) {
                if (session.pages.has(marker.pageId)) {
                    await marker.element.dispose().catch(() => {});
                    this.markers.delete(markerId);
                }
            }
            // Remove event listeners from all pages before closing
            for (const page of session.pages.values()) {
                this.removePageListeners(page);
            }
            await session.browser.close().catch((err) => {
                log('warn', 'browser_close_failed', { sessionId, error: String(err) });
            });
            this.sessions.delete(sessionId);
            log('info', 'session_closed', { sessionId });
        }
    }

    createMarker(element: ElementHandle<Element>, pageId: string, description?: string): string {
        // Check marker limit
        if (this.markers.size >= MAX_MARKERS) {
            throw new BrowserMcpError('LIMIT_EXCEEDED', `Maximum ${MAX_MARKERS} markers allowed`, {
                current: this.markers.size,
                max: MAX_MARKERS,
            });
        }

        const markerId = `marker_${++this.markerCounter}_${Date.now()}`;
        const marker: Marker = {
            element,
            pageId,
            createdAt: Date.now(),
        };
        if (description !== undefined) {
            marker.description = description;
        }
        this.markers.set(markerId, marker);
        return markerId;
    }

    getMarker(markerId: string): Marker | undefined {
        return this.markers.get(markerId);
    }

    async removeMarker(markerId: string): Promise<void> {
        const marker = this.markers.get(markerId);
        if (marker) {
            await marker.element.dispose().catch(() => {});
            this.markers.delete(markerId);
        }
    }

    clearMarkersForPage(pageId: string): void {
        for (const [markerId, marker] of this.markers.entries()) {
            if (marker.pageId === pageId) {
                marker.element.dispose().catch(() => {});
                this.markers.delete(markerId);
            }
        }
    }

    listMarkers(pageId?: string): Array<{ id: string; description?: string; pageId: string }> {
        const result: Array<{ id: string; description?: string; pageId: string }> = [];
        for (const [id, marker] of this.markers.entries()) {
            if (!pageId || marker.pageId === pageId) {
                const item: { id: string; description?: string; pageId: string } = {
                    id,
                    pageId: marker.pageId,
                };
                if (marker.description !== undefined) {
                    item.description = marker.description;
                }
                result.push(item);
            }
        }
        return result;
    }

    private async cleanupStaleMarkers(): Promise<void> {
        const staleThreshold = Date.now() - 5 * 60 * 1000; // 5 minutes

        for (const [markerId, marker] of this.markers.entries()) {
            if (marker.createdAt < staleThreshold) {
                try {
                    const isAttached = await marker.element
                        .evaluate((el) => el.isConnected)
                        .catch(() => false);
                    if (!isAttached) {
                        await this.removeMarker(markerId);
                        log('debug', 'marker_cleaned', { markerId, reason: 'detached' });
                    }
                } catch {
                    await this.removeMarker(markerId);
                    log('debug', 'marker_cleaned', { markerId, reason: 'error' });
                }
            }
        }
    }

    async shutdown(): Promise<void> {
        log('info', 'shutdown_start', { sessions: this.sessions.size });

        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }

        // Close all sessions
        for (const sessionId of this.sessions.keys()) {
            await this.closeSession(sessionId);
        }

        log('info', 'shutdown_complete');
    }

    listSessions(): Array<{
        sessionId: string;
        pageCount: number;
        activePageId: string | null;
        harPath?: string;
        videoDir?: string;
        ageMs: number;
    }> {
        const result = [];
        for (const [sessionId, session] of this.sessions.entries()) {
            result.push({
                sessionId,
                pageCount: session.pages.size,
                activePageId: session.activePageId,
                harPath: session.harPath,
                videoDir: session.videoDir,
                ageMs: Date.now() - session.createdAt,
            });
        }
        return result;
    }

    getStats(): { sessions: number; pages: number; markers: number } {
        let pages = 0;
        for (const session of this.sessions.values()) {
            pages += session.pages.size;
        }
        return {
            sessions: this.sessions.size,
            pages,
            markers: this.markers.size,
        };
    }
}

const manager = new BrowserManager();

type ToolHandler<T> = (args: T) => Promise<ToolResult>;

function wrapHandler<T>(handler: ToolHandler<T>): ToolHandler<T> {
    return async (args: T): Promise<ToolResult> => {
        try {
            return await handler(args);
        } catch (error) {
            return errorResult(error);
        }
    };
}

export async function createPlaywrightMcpServer() {
    const server = new McpServer({
        name: 'playwright-server',
        version: '2.0.0',
    });

    server.registerTool(
        'browser_connect',
        {
            title: 'Connect to Your Chrome',
            description:
                'Connect to your existing Chrome browser via CDP. Requires Chrome started with --remote-debugging-port=9222. This lets you use YOUR browser with all extensions, logins, and cookies.',
            inputSchema: {
                sessionId: z.string().describe('Unique session ID'),
                cdpUrl: z.string().default('http://localhost:9222').describe('CDP endpoint URL'),
            },
        },
        wrapHandler(async ({ sessionId, cdpUrl }) => {
            const { session, reused } = await manager.connectOverCDP(sessionId, cdpUrl);

            // List existing tabs
            const tabs = await Promise.all(
                Array.from(session.pages.entries()).map(async ([id, page]) => ({
                    id,
                    url: page.url(),
                    title: await page.title().catch(() => ''),
                })),
            );

            return successResult(
                {
                    sessionId,
                    connected: true,
                    reused,
                    cdpUrl,
                    tabs,
                    activePageId: session.activePageId,
                },
                tabs.length > 0
                    ? 'Connected to Chrome. Use browser_switch_page to select a tab, then browser_snapshot to see contents.'
                    : 'Connected to Chrome. Use browser_new_page then browser_navigate to open a URL.',
            );
        }),
    );

    server.registerTool(
        'browser_launch',
        {
            title: 'Launch Browser (Isolated)',
            description:
                'Launch a NEW isolated browser. For using YOUR regular Chrome with extensions, use browser_connect instead.',
            inputSchema: {
                sessionId: z
                    .string()
                    .describe('Unique session ID. Same ID reuses existing browser.'),
                browserType: z.enum(['chromium', 'firefox', 'webkit']).default('chromium'),
                headless: z
                    .boolean()
                    .default(false)
                    .describe('false=visible (default), true=headless'),
                reuseExisting: z.boolean().default(true),
                recordHar: z
                    .boolean()
                    .optional()
                    .describe('Record all HTTP traffic as HAR. Retrieve with browser_get_har.'),
                recordVideo: z
                    .boolean()
                    .optional()
                    .describe('Record a video of each page. Save with browser_save_video.'),
            },
        },
        wrapHandler(async ({ sessionId, browserType, headless, reuseExisting, recordHar, recordVideo }) => {
            const { session, reused } = await manager.launchSession(
                sessionId,
                browserType,
                headless,
                reuseExisting,
                recordHar ?? false,
                recordVideo ?? false,
            );

            // Auto-create initial page
            let activePageId = session.activePageId;
            if (!reused && session.pages.size === 0) {
                const { id } = await manager.newPage(sessionId);
                activePageId = id;
            }

            return successResult(
                {
                    sessionId,
                    browserType,
                    headless,
                    reused,
                    pageCount: session.pages.size,
                    activePageId,
                    harPath: session.harPath,
                    videoDir: session.videoDir,
                },
                'Browser launched. Use browser_navigate to go to a URL, then browser_snapshot to see page contents.',
            );
        }),
    );

    server.registerTool(
        'browser_list_sessions',
        {
            title: 'List Sessions',
            description: 'List all active browser sessions',
            inputSchema: {},
        },
        wrapHandler(async () => {
            const sessions = manager.listSessions();
            return successResult({ count: sessions.length, sessions });
        }),
    );

    server.registerTool(
        'browser_close',
        {
            title: 'Close Browser',
            description: 'Close browser session and free resources',
            inputSchema: {
                sessionId: z.string(),
            },
        },
        wrapHandler(async ({ sessionId }) => {
            await manager.closeSession(sessionId);
            return successResult({ sessionId, closed: true });
        }),
    );

    server.registerTool(
        'browser_navigate',
        {
            title: 'Navigate',
            description: 'Navigate to URL (HTTP/HTTPS only, no localhost/private IPs)',
            inputSchema: {
                sessionId: z.string(),
                url: z.string(),
                pageId: z.string().optional(),
                waitUntil: z
                    .enum(['load', 'domcontentloaded', 'networkidle', 'commit'])
                    .default('domcontentloaded'),
            },
        },
        wrapHandler(async ({ sessionId, url, pageId, waitUntil }) => {
            // Security: Validate URL
            const validation = validateUrl(url);
            if (!validation.valid) {
                throw new BrowserMcpError('SECURITY_VIOLATION', validation.error!, { url });
            }

            const session = manager.getSession(sessionId);
            const { page, id } = manager.getPage(sessionId, pageId);
            await page.goto(url, { waitUntil });

            const title = await page.title();
            const finalUrl = page.url();

            // Track navigation in history
            session.history.push({
                url: finalUrl,
                title,
                timestamp: Date.now(),
                pageId: id,
            });

            return successResult(
                {
                    url: finalUrl,
                    pageId: id,
                    title,
                },
                'Use browser_snapshot to see page contents, or browser_breadcrumbs to see navigation history.',
            );
        }),
    );

    server.registerTool(
        'browser_info',
        {
            title: 'Page Info',
            description: 'Get current URL, title, and page info',
            inputSchema: {
                sessionId: z.string(),
                pageId: z.string().optional(),
            },
        },
        wrapHandler(async ({ sessionId, pageId }) => {
            const { page, id } = manager.getPage(sessionId, pageId);
            return successResult({
                pageId: id,
                url: page.url(),
                title: await page.title(),
            });
        }),
    );

    server.registerTool(
        'browser_history',
        {
            title: 'History',
            description: 'Navigate back, forward, or reload',
            inputSchema: {
                sessionId: z.string(),
                action: z.enum(['back', 'forward', 'reload']),
                pageId: z.string().optional(),
            },
        },
        wrapHandler(async ({ sessionId, action, pageId }) => {
            const { page } = manager.getPage(sessionId, pageId);

            if (action === 'back') await page.goBack();
            else if (action === 'forward') await page.goForward();
            else await page.reload();

            return successResult({ action, url: page.url() });
        }),
    );

    server.registerTool(
        'browser_breadcrumbs',
        {
            title: 'Navigation Breadcrumbs',
            description:
                "Get navigation history for this session. Shows where you've been - useful for understanding context or backtracking.",
            inputSchema: {
                sessionId: z.string(),
                limit: z.number().default(10).describe('Max entries to return (most recent first)'),
            },
        },
        wrapHandler(async ({ sessionId, limit }) => {
            const session = manager.getSession(sessionId);
            const history = session.history.slice(-limit).reverse(); // Most recent first

            return successResult(
                {
                    sessionId,
                    count: history.length,
                    totalNavigations: session.history.length,
                    breadcrumbs: history.map((entry, index) => ({
                        step: session.history.length - index,
                        url: entry.url,
                        title: entry.title,
                        pageId: entry.pageId,
                        timestamp: new Date(entry.timestamp).toISOString(),
                    })),
                },
                history.length === 0
                    ? 'No navigation history yet. Use browser_navigate to visit a page.'
                    : 'Use browser_navigate to go to a new URL, or browser_history to go back/forward.',
            );
        }),
    );

    server.registerTool(
        'browser_click',
        {
            title: 'Click',
            description: 'Click element by CSS selector',
            inputSchema: {
                sessionId: z.string(),
                selector: z.string().describe('CSS selector, e.g., "#submit", ".btn-primary"'),
                pageId: z.string().optional(),
                timeout: z.number().default(5000),
            },
        },
        wrapHandler(async ({ sessionId, selector, pageId, timeout }) => {
            const { page } = manager.getPage(sessionId, pageId);
            await page.click(selector, { timeout });
            return successResult(
                { action: 'click', selector },
                'Click completed. Use browser_wait_for_stability if page updates, then browser_snapshot to see changes.',
            );
        }),
    );

    server.registerTool(
        'browser_type',
        {
            title: 'Type',
            description: 'Type text into input field',
            inputSchema: {
                sessionId: z.string(),
                selector: z.string(),
                text: z.string(),
                pageId: z.string().optional(),
                clearFirst: z.boolean().default(true),
                pressEnter: z.boolean().default(false).describe('Press Enter after typing'),
            },
        },
        wrapHandler(async ({ sessionId, selector, text, pageId, clearFirst, pressEnter }) => {
            const { page } = manager.getPage(sessionId, pageId);

            if (clearFirst) {
                await page.fill(selector, text);
            } else {
                await page.type(selector, text);
            }

            if (pressEnter) {
                await page.press(selector, 'Enter');
            }

            return successResult({ selector, textLength: text.length, pressedEnter: pressEnter });
        }),
    );

    server.registerTool(
        'browser_press',
        {
            title: 'Press Key',
            description: 'Press keyboard key (Enter, Tab, Escape, ArrowDown, etc.)',
            inputSchema: {
                sessionId: z.string(),
                key: z.string().describe('Key name: Enter, Tab, Escape, ArrowDown, etc.'),
                pageId: z.string().optional(),
                modifiers: z.array(z.enum(['Control', 'Shift', 'Alt', 'Meta'])).optional(),
            },
        },
        wrapHandler(async ({ sessionId, key, pageId, modifiers }) => {
            const { page } = manager.getPage(sessionId, pageId);
            const keyCombo = modifiers?.length ? [...modifiers, key].join('+') : key;
            await page.keyboard.press(keyCombo);
            return successResult({ key: keyCombo });
        }),
    );

    server.registerTool(
        'browser_fill_form',
        {
            title: 'Fill Form',
            description:
                'Fill multiple form fields at once. More efficient than multiple browser_type calls. Supports text inputs, checkboxes, selects.',
            inputSchema: {
                sessionId: z.string(),
                pageId: z.string().optional(),
                fields: z
                    .array(
                        z.object({
                            selector: z.string().describe('CSS selector for the field'),
                            value: z
                                .string()
                                .describe(
                                    'Value to fill (for text) or "true"/"false" (for checkbox)',
                                ),
                            type: z.enum(['text', 'checkbox', 'select']).default('text'),
                        }),
                    )
                    .describe('Array of fields to fill'),
                submit: z.boolean().default(false).describe('Submit the form after filling'),
                submitSelector: z
                    .string()
                    .optional()
                    .describe('Submit button selector (default: form submit button)'),
            },
        },
        wrapHandler(async ({ sessionId, pageId, fields, submit, submitSelector }) => {
            const { page } = manager.getPage(sessionId, pageId);
            const results: Array<{ selector: string; success: boolean; error?: string }> = [];

            for (const field of fields) {
                try {
                    switch (field.type) {
                        case 'checkbox': {
                            const isChecked = await page.isChecked(field.selector);
                            const shouldCheck = field.value === 'true';
                            if (isChecked !== shouldCheck) {
                                await page.click(field.selector);
                            }
                            break;
                        }
                        case 'select':
                            await page.selectOption(field.selector, field.value);
                            break;
                        case 'text':
                        default:
                            await page.fill(field.selector, field.value);
                            break;
                    }
                    results.push({ selector: field.selector, success: true });
                } catch (error) {
                    results.push({
                        selector: field.selector,
                        success: false,
                        error: error instanceof Error ? error.message : 'Unknown error',
                    });
                }
            }

            // Submit if requested
            let submitted = false;
            if (submit) {
                try {
                    if (submitSelector) {
                        await page.click(submitSelector);
                    } else {
                        // Try common submit patterns
                        const submitButton = await page.$(
                            'button[type="submit"], input[type="submit"], form button:last-of-type',
                        );
                        if (submitButton) {
                            await submitButton.click();
                        } else {
                            // Press enter on last filled field
                            const lastField = fields[fields.length - 1];
                            if (lastField) {
                                await page.press(lastField.selector, 'Enter');
                            }
                        }
                    }
                    submitted = true;
                } catch (error) {
                    results.push({
                        selector: submitSelector || 'submit',
                        success: false,
                        error: error instanceof Error ? error.message : 'Submit failed',
                    });
                }
            }

            const successCount = results.filter((r) => r.success).length;
            const failCount = results.filter((r) => !r.success).length;

            return successResult(
                {
                    filled: successCount,
                    failed: failCount,
                    submitted,
                    results,
                },
                failCount > 0
                    ? 'Some fields failed. Use browser_snapshot to verify selectors.'
                    : submitted
                      ? 'Form submitted. Use browser_wait_for_stability then browser_snapshot to see result.'
                      : 'Fields filled. Use browser_snapshot to verify, or add submit: true to submit.',
            );
        }),
    );

    server.registerTool(
        'browser_select',
        {
            title: 'Select Option',
            description: 'Select dropdown option by value, label, or index',
            inputSchema: {
                sessionId: z.string(),
                selector: z.string(),
                value: z.string().optional(),
                label: z.string().optional(),
                index: z.number().optional(),
                pageId: z.string().optional(),
            },
        },
        wrapHandler(async ({ sessionId, selector, value, label, index, pageId }) => {
            const { page } = manager.getPage(sessionId, pageId);

            let selected: string[];
            if (value !== undefined) {
                selected = await page.selectOption(selector, { value });
            } else if (label !== undefined) {
                selected = await page.selectOption(selector, { label });
            } else if (index !== undefined) {
                selected = await page.selectOption(selector, { index });
            } else {
                throw new BrowserMcpError('INVALID_INPUT', 'Must provide value, label, or index');
            }

            return successResult({ selector, selected });
        }),
    );

    server.registerTool(
        'browser_scroll',
        {
            title: 'Scroll',
            description: 'Scroll page or element',
            inputSchema: {
                sessionId: z.string(),
                direction: z.enum(['up', 'down', 'left', 'right']).default('down'),
                amount: z.number().default(500).describe('Pixels to scroll'),
                selector: z.string().optional().describe('Scroll within specific element'),
                pageId: z.string().optional(),
            },
        },
        wrapHandler(async ({ sessionId, direction, amount, selector, pageId }) => {
            const { page } = manager.getPage(sessionId, pageId);

            const scrollX = direction === 'left' ? -amount : direction === 'right' ? amount : 0;
            const scrollY = direction === 'up' ? -amount : direction === 'down' ? amount : 0;

            if (selector) {
                await page
                    .locator(selector)
                    .evaluate((el, { x, y }) => el.scrollBy(x, y), { x: scrollX, y: scrollY });
            } else {
                await page.evaluate(({ x, y }) => window.scrollBy(x, y), {
                    x: scrollX,
                    y: scrollY,
                });
            }

            return successResult({ direction, amount });
        }),
    );

    server.registerTool(
        'browser_hover',
        {
            title: 'Hover',
            description: 'Move mouse over element',
            inputSchema: {
                sessionId: z.string(),
                selector: z.string(),
                pageId: z.string().optional(),
            },
        },
        wrapHandler(async ({ sessionId, selector, pageId }) => {
            const { page } = manager.getPage(sessionId, pageId);
            await page.hover(selector);
            return successResult({ action: 'hover', selector });
        }),
    );

    server.registerTool(
        'browser_wait_for',
        {
            title: 'Wait For',
            description: 'Wait for element to appear/disappear',
            inputSchema: {
                sessionId: z.string(),
                selector: z.string(),
                pageId: z.string().optional(),
                timeout: z.number().default(5000),
                state: z.enum(['attached', 'detached', 'visible', 'hidden']).default('visible'),
            },
        },
        wrapHandler(async ({ sessionId, selector, pageId, timeout, state }) => {
            const { page } = manager.getPage(sessionId, pageId);
            await page.waitForSelector(selector, { timeout, state });
            return successResult({ selector, state, found: true });
        }),
    );

    server.registerTool(
        'browser_wait_for_stability',
        {
            title: 'Wait for Page Stability',
            description:
                'Wait until page is stable (network idle + no DOM changes). Use after navigation or actions that trigger async updates.',
            inputSchema: {
                sessionId: z.string(),
                pageId: z.string().optional(),
                timeout: z.number().default(10000).describe('Max wait time in ms'),
                networkIdleTime: z
                    .number()
                    .default(500)
                    .describe('Time with no network activity to consider idle'),
            },
        },
        wrapHandler(async ({ sessionId, pageId, timeout, networkIdleTime }) => {
            const { page } = manager.getPage(sessionId, pageId);
            const startTime = Date.now();

            // Wait for network idle
            try {
                await page.waitForLoadState('networkidle', { timeout });
            } catch {
                // Network idle timeout is ok - page might have persistent connections
            }

            // Wait for DOM stability (no mutations for networkIdleTime ms)
            const isStable = await page.evaluate(async (idleTime: number) => {
                return new Promise<boolean>((resolve) => {
                    let timer: ReturnType<typeof setTimeout> | null = null;
                    let mutations = 0;

                    const observer = new MutationObserver(() => {
                        mutations++;
                        if (timer) clearTimeout(timer);
                        timer = setTimeout(() => {
                            observer.disconnect();
                            resolve(true);
                        }, idleTime);
                    });

                    observer.observe(document.body, {
                        childList: true,
                        subtree: true,
                        attributes: true,
                    });

                    // Initial timer in case no mutations happen
                    timer = setTimeout(() => {
                        observer.disconnect();
                        resolve(true);
                    }, idleTime);
                });
            }, networkIdleTime);

            const elapsed = Date.now() - startTime;

            return successResult(
                {
                    stable: isStable,
                    elapsed,
                    url: page.url(),
                },
                'Page is stable. Use browser_snapshot to see current contents.',
            );
        }),
    );

    server.registerTool(
        'browser_content',
        {
            title: 'Get Content',
            description: 'Get page text or HTML content',
            inputSchema: {
                sessionId: z.string(),
                pageId: z.string().optional(),
                type: z.enum(['text', 'html']).default('text'),
                maxLength: z.number().default(10000),
            },
        },
        wrapHandler(async ({ sessionId, pageId, type, maxLength }) => {
            const { page } = manager.getPage(sessionId, pageId);

            let content: string;
            if (type === 'html') {
                content = await page.content();
            } else {
                content = await page.evaluate(() => document.body.innerText);
            }

            const truncated = content.length > maxLength;
            return successResult({
                type,
                length: content.length,
                truncated,
                content: content.slice(0, maxLength),
            });
        }),
    );

    server.registerTool(
        'browser_snapshot',
        {
            title: 'Accessibility Snapshot',
            description:
                'Get structured accessibility tree with reference IDs for clicking. Use ref IDs with browser_click_ref for deterministic interaction.',
            inputSchema: {
                sessionId: z.string(),
                pageId: z.string().optional(),
            },
        },
        wrapHandler(async ({ sessionId, pageId }) => {
            const { page, id } = manager.getPage(sessionId, pageId);

            // Inject ref IDs into interactive elements for browser_click_ref
            const refCount = await page.evaluate(() => {
                let counter = 0;
                const interactiveSelectors =
                    'button, a, input, select, textarea, [role="button"], [role="link"], [onclick], [tabindex]';

                document.querySelectorAll(interactiveSelectors).forEach((el) => {
                    if (!el.getAttribute('data-ref')) {
                        el.setAttribute('data-ref', `ref${++counter}`);
                    }
                });
                return counter;
            });

            // Use modern ariaSnapshot API (page.accessibility was removed in Playwright 1.40+)
            const snapshot = await page.locator(':root').ariaSnapshot();

            return successResult(
                {
                    pageId: id,
                    url: page.url(),
                    title: await page.title(),
                    snapshot,
                    interactiveCount: refCount,
                    usage: 'Use browser_click_ref with ref ID (e.g., "ref5") for reliable clicking, or browser_type_ref for typing.',
                },
                refCount > 0
                    ? 'Found interactive elements. Use browser_click_ref or browser_type_ref with ref IDs for reliable interaction.'
                    : 'No interactive elements found. Page may still be loading - try browser_wait_for_stability.',
            );
        }),
    );

    server.registerTool(
        'browser_click_ref',
        {
            title: 'Click by Reference',
            description:
                'Click element using data-ref ID from browser_snapshot. More reliable than selectors.',
            inputSchema: {
                sessionId: z.string(),
                ref: z.string().describe('Reference ID from snapshot (e.g., "ref5")'),
                pageId: z.string().optional(),
            },
        },
        wrapHandler(async ({ sessionId, ref, pageId }) => {
            const { page } = manager.getPage(sessionId, pageId);

            // Find element by data-ref attribute
            const selector = `[data-ref="${ref}"]`;
            const element = await page.$(selector);

            if (!element) {
                throw new BrowserMcpError(
                    'ELEMENT_NOT_FOUND',
                    `Element with ref "${ref}" not found. Run browser_snapshot first.`,
                );
            }

            await element.click();

            // Get info about what was clicked
            const info = await element.evaluate((el) => ({
                tag: el.tagName.toLowerCase(),
                text: el.textContent?.slice(0, 50),
                type: el.getAttribute('type'),
            }));

            return successResult(
                { clicked: ref, element: info },
                'Click completed. Use browser_wait_for_stability if page updates, then browser_snapshot to see changes.',
            );
        }),
    );

    server.registerTool(
        'browser_type_ref',
        {
            title: 'Type by Reference',
            description: 'Type into element using data-ref ID from browser_snapshot.',
            inputSchema: {
                sessionId: z.string(),
                ref: z.string().describe('Reference ID from snapshot (e.g., "ref3")'),
                text: z.string(),
                pageId: z.string().optional(),
                clearFirst: z.boolean().default(true),
                pressEnter: z.boolean().default(false),
            },
        },
        wrapHandler(async ({ sessionId, ref, text, pageId, clearFirst, pressEnter }) => {
            const { page } = manager.getPage(sessionId, pageId);

            const selector = `[data-ref="${ref}"]`;
            const element = await page.$(selector);

            if (!element) {
                throw new BrowserMcpError(
                    'ELEMENT_NOT_FOUND',
                    `Element with ref "${ref}" not found. Run browser_snapshot first.`,
                );
            }

            if (clearFirst) {
                await element.fill(text);
            } else {
                await element.type(text);
            }

            if (pressEnter) {
                await element.press('Enter');
            }

            return successResult({
                ref,
                textLength: text.length,
                pressedEnter: pressEnter,
            });
        }),
    );

    server.registerTool(
        'browser_query',
        {
            title: 'Query Elements',
            description: 'Find elements and get their attributes',
            inputSchema: {
                sessionId: z.string(),
                selector: z.string(),
                pageId: z.string().optional(),
                attributes: z
                    .array(z.string())
                    .default(['innerText', 'href', 'src', 'value', 'id', 'class']),
                limit: z.number().default(10),
            },
        },
        wrapHandler(async ({ sessionId, selector, pageId, attributes, limit }) => {
            const { page } = manager.getPage(sessionId, pageId);

            const elements = await page.locator(selector).all();
            const results = await Promise.all(
                elements.slice(0, limit).map(async (el) => {
                    const data: Record<string, string | null> = {};
                    await Promise.all(
                        attributes.map(async (attr) => {
                            try {
                                if (attr === 'innerText') {
                                    data[attr] = await el.innerText();
                                } else if (attr === 'innerHTML') {
                                    data[attr] = await el.innerHTML();
                                } else {
                                    data[attr] = await el.getAttribute(attr);
                                }
                            } catch {
                                data[attr] = null;
                            }
                        }),
                    );
                    return data;
                }),
            );

            return successResult({
                selector,
                total: elements.length,
                returned: results.length,
                elements: results,
            });
        }),
    );

    server.registerTool(
        'browser_wait',
        {
            title: 'Wait',
            description:
                'Wait for a specified time. Use when page needs time to load dynamic content.',
            inputSchema: {
                sessionId: z.string(),
                ms: z
                    .number()
                    .min(100)
                    .max(10000)
                    .default(1000)
                    .describe('Milliseconds to wait (100-10000)'),
                pageId: z.string().optional(),
            },
        },
        wrapHandler(async ({ sessionId, ms, pageId }) => {
            manager.getPage(sessionId, pageId); // Validate session exists
            await new Promise((resolve) => setTimeout(resolve, ms));
            return successResult({ waited: ms });
        }),
    );

    server.registerTool(
        'browser_evaluate',
        {
            title: 'Run JavaScript',
            description:
                'Execute custom JavaScript in the page context. Use for complex extraction when other tools fail. Returns the result of the expression.',
            inputSchema: {
                sessionId: z.string(),
                script: z.string().describe('JavaScript code to execute. Use `return` for result.'),
                pageId: z.string().optional(),
            },
        },
        wrapHandler(async ({ sessionId, script, pageId }) => {
            const { page } = manager.getPage(sessionId, pageId);

            // Wrap in async function if not already
            const wrappedScript = script.includes('return ')
                ? `(async () => { ${script} })()`
                : `(async () => { return ${script} })()`;

            const result = await page.evaluate(wrappedScript);

            return successResult({
                result: typeof result === 'object' ? result : { value: result },
            });
        }),
    );

    server.registerTool(
        'browser_extract',
        {
            title: 'Smart Extract',
            description:
                'Extract structured data using common patterns. Use when snapshot fails on complex sites.',
            inputSchema: {
                sessionId: z.string(),
                pageId: z.string().optional(),
                pattern: z
                    .enum([
                        'all_text', // Get all visible text
                        'all_links', // Get all links with text and href
                        'all_headings', // Get h1-h6 structure
                        'tables', // Extract table data
                        'forms', // Get form fields
                        'prices', // Find price-like patterns
                        'metadata', // Get page metadata (title, description, og tags)
                    ])
                    .describe('Extraction pattern to use'),
                selector: z
                    .string()
                    .optional()
                    .describe('Optional CSS selector to scope extraction'),
            },
        },
        wrapHandler(async ({ sessionId, pageId, pattern, selector }) => {
            const { page } = manager.getPage(sessionId, pageId);

            const scope = selector || 'body';

            let result: any;

            switch (pattern) {
                case 'all_text':
                    result = await page.evaluate((sel) => {
                        const el = document.querySelector(sel) as HTMLElement | null;
                        return el ? el.innerText : '';
                    }, scope);
                    break;

                case 'all_links':
                    result = await page.evaluate((sel) => {
                        const container = document.querySelector(sel) || document.body;
                        return Array.from(container.querySelectorAll('a[href]'))
                            .map((a) => ({
                                text: a.textContent?.trim() || '',
                                href: a.getAttribute('href'),
                            }))
                            .filter((l) => l.text && l.href);
                    }, scope);
                    break;

                case 'all_headings':
                    result = await page.evaluate((sel) => {
                        const container = document.querySelector(sel) || document.body;
                        return Array.from(container.querySelectorAll('h1, h2, h3, h4, h5, h6')).map(
                            (h) => ({
                                level: h.tagName.toLowerCase(),
                                text: h.textContent?.trim() || '',
                            }),
                        );
                    }, scope);
                    break;

                case 'tables':
                    result = await page.evaluate((sel) => {
                        const container = document.querySelector(sel) || document.body;
                        return Array.from(container.querySelectorAll('table')).map((table) => {
                            const headers = Array.from(table.querySelectorAll('th')).map(
                                (th) => th.textContent?.trim() || '',
                            );
                            const rows = Array.from(table.querySelectorAll('tr'))
                                .map((tr) =>
                                    Array.from(tr.querySelectorAll('td')).map(
                                        (td) => td.textContent?.trim() || '',
                                    ),
                                )
                                .filter((row) => row.length > 0);
                            return { headers, rows };
                        });
                    }, scope);
                    break;

                case 'forms':
                    result = await page.evaluate((sel) => {
                        const container = document.querySelector(sel) || document.body;
                        return Array.from(
                            container.querySelectorAll('input, select, textarea'),
                        ).map((el) => ({
                            type: el.getAttribute('type') || el.tagName.toLowerCase(),
                            name: el.getAttribute('name') || '',
                            id: el.getAttribute('id') || '',
                            placeholder: el.getAttribute('placeholder') || '',
                            value: (el as HTMLInputElement).value || '',
                        }));
                    }, scope);
                    break;

                case 'prices':
                    result = await page.evaluate((sel) => {
                        const container = (document.querySelector(sel) ||
                            document.body) as HTMLElement;
                        const text = container.innerText;
                        // Match common price patterns
                        const pricePatterns = [
                            /\$[\d,]+\.?\d*/g, // $123.45
                            /USD\s*[\d,]+\.?\d*/gi, // USD 123.45
                            /[\d,]+\.?\d*\s*USD/gi, // 123.45 USD
                            /\u00A5[\d,]+/g, // ¥123
                            /\u20AC[\d,]+\.?\d*/g, // €123.45
                            /\u00A3[\d,]+\.?\d*/g, // £123.45
                        ];
                        const prices: string[] = [];
                        pricePatterns.forEach((pattern) => {
                            const matches = text.match(pattern);
                            if (matches) prices.push(...matches);
                        });
                        return [...new Set(prices)]; // Deduplicate
                    }, scope);
                    break;

                case 'metadata':
                    result = await page.evaluate(() => ({
                        title: document.title,
                        description:
                            document
                                .querySelector('meta[name="description"]')
                                ?.getAttribute('content') || '',
                        ogTitle:
                            document
                                .querySelector('meta[property="og:title"]')
                                ?.getAttribute('content') || '',
                        ogDescription:
                            document
                                .querySelector('meta[property="og:description"]')
                                ?.getAttribute('content') || '',
                        ogImage:
                            document
                                .querySelector('meta[property="og:image"]')
                                ?.getAttribute('content') || '',
                        canonical:
                            document.querySelector('link[rel="canonical"]')?.getAttribute('href') ||
                            '',
                    }));
                    break;
            }

            return successResult({
                pattern,
                selector: scope,
                data: result,
            });
        }),
    );

    server.registerTool(
        'browser_screenshot',
        {
            title: 'Screenshot (Use Sparingly)',
            description:
                'Capture screenshot. EXPENSIVE — use only for visual verification, debugging, or complex visual elements. For navigation/interaction, use browser_snapshot + browser_click_ref instead.',
            inputSchema: {
                sessionId: z.string(),
                pageId: z.string().optional(),
                fullPage: z.boolean().default(false),
                filename: z.string().optional().describe('Optional filename (alphanumeric only)'),
                reason: z
                    .string()
                    .optional()
                    .describe('Why screenshot needed? (for optimization tracking)'),
            },
        },
        wrapHandler(async ({ sessionId, pageId, fullPage, filename, reason }) => {
            const { page } = manager.getPage(sessionId, pageId);

            // Log why screenshot was taken (for optimization)
            log('info', 'screenshot_taken', { reason: reason || 'unspecified', fullPage });

            // Security: Sanitize filename
            let safePath: string | undefined;
            if (filename) {
                const sanitized = filename.replace(/[^a-zA-Z0-9_-]/g, '');
                if (sanitized.length === 0) {
                    throw new BrowserMcpError('INVALID_INPUT', 'Invalid filename');
                }
                safePath = path.join(SCREENSHOT_DIR, `${sanitized}.png`);
            }

            const screenshot = await page.screenshot({
                fullPage,
                ...(safePath ? { path: safePath } : {}),
            });

            const base64 = screenshot.toString('base64');

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            success: true,
                            size: screenshot.length,
                            path: safePath,
                            tip: 'For routine navigation, prefer browser_snapshot + browser_click_ref (faster, cheaper)',
                        }),
                    },
                    { type: 'image', data: base64, mimeType: 'image/png' },
                ],
            };
        }),
    );

    server.registerTool(
        'browser_pdf',
        {
            title: 'Save Page as PDF',
            description:
                'Save the current page as a PDF file. Only works with headless Chromium — not Firefox, WebKit, or headed mode. Useful for archiving pages or generating reports.',
            inputSchema: {
                sessionId: z.string(),
                pageId: z.string().optional(),
                format: z
                    .enum(['A4', 'A3', 'Letter', 'Legal', 'Tabloid'])
                    .default('A4'),
                printBackground: z
                    .boolean()
                    .default(true)
                    .describe('Include CSS background colors and images'),
                filename: z.string().optional().describe('Optional filename (alphanumeric only, no extension)'),
            },
        },
        wrapHandler(async ({ sessionId, pageId, format, printBackground, filename }) => {
            const { page } = manager.getPage(sessionId, pageId);

            const base = filename
                ? filename.replace(/[^a-zA-Z0-9_-]/g, '')
                : `page_${Date.now()}`;
            if (base.length === 0) {
                throw new BrowserMcpError('INVALID_INPUT', 'Invalid filename');
            }
            const pdfPath = path.join(SCREENSHOT_DIR, `${base}.pdf`);

            const pdf = await page.pdf({ format, printBackground, path: pdfPath });

            log('info', 'pdf_saved', { sessionId, pdfPath, bytes: pdf.length });

            return successResult(
                { path: pdfPath, size: pdf.length, format },
                `PDF saved to ${pdfPath}`,
            );
        }),
    );

    server.registerTool(
        'browser_get_har',
        {
            title: 'Get HAR Recording',
            description:
                'Return the path and summary of the HAR (HTTP Archive) recording for this session. Only available when the session was launched with recordHar: true. Call browser_close first for a fully flushed HAR.',
            inputSchema: {
                sessionId: z.string(),
            },
        },
        wrapHandler(async ({ sessionId }) => {
            const session = manager.getSession(sessionId);

            if (!session.harPath) {
                throw new BrowserMcpError(
                    'INVALID_INPUT',
                    'Session was not started with recordHar: true. Close this session and relaunch with recordHar: true.',
                );
            }
            if (!fs.existsSync(session.harPath)) {
                throw new BrowserMcpError(
                    'INVALID_INPUT',
                    'HAR file not yet written. Navigate to some pages first, then retry.',
                );
            }

            const stat = fs.statSync(session.harPath);
            let entryCount = 0;
            try {
                const har = JSON.parse(fs.readFileSync(session.harPath, 'utf-8'));
                entryCount = har?.log?.entries?.length ?? 0;
            } catch {
                // File may be partially written — still return the path
            }

            return successResult(
                {
                    path: session.harPath,
                    sizeBytes: stat.size,
                    entries: entryCount,
                    note: 'Call browser_close to flush all pending entries before reading the file.',
                },
                `HAR at ${session.harPath} — ${entryCount} entries, ${stat.size} bytes.`,
            );
        }),
    );

    server.registerTool(
        'browser_save_video',
        {
            title: 'Save Page Video',
            description:
                'Close a page and save its video recording. Only available when the session was launched with recordVideo: true. Closing the page is required to finalize the video file.',
            inputSchema: {
                sessionId: z.string(),
                pageId: z.string().optional(),
            },
        },
        wrapHandler(async ({ sessionId, pageId }) => {
            const session = manager.getSession(sessionId);

            if (!session.videoDir) {
                throw new BrowserMcpError(
                    'INVALID_INPUT',
                    'Session was not started with recordVideo: true. Close this session and relaunch with recordVideo: true.',
                );
            }

            const { page, id } = manager.getPage(sessionId, pageId);
            const video = page.video();

            manager.clearMarkersForPage(id);
            page.removeAllListeners();
            await page.close();
            session.pages.delete(id);

            if (session.activePageId === id) {
                const remaining = Array.from(session.pages.keys());
                session.activePageId = remaining[0] ?? null;
            }

            const videoPath = await video?.path().catch(() => null);

            log('info', 'video_saved', { sessionId, pageId: id, videoPath });

            return successResult(
                {
                    closedPageId: id,
                    videoPath,
                    videoDir: session.videoDir,
                    activePageId: session.activePageId,
                },
                videoPath
                    ? `Video saved to ${videoPath}`
                    : 'Page closed but video path unavailable — check videoDir for the file.',
            );
        }),
    );

    server.registerTool(
        'browser_new_page',
        {
            title: 'New Page',
            description: 'Open new browser tab',
            inputSchema: {
                sessionId: z.string(),
                pageId: z.string().optional(),
            },
        },
        wrapHandler(async ({ sessionId, pageId }) => {
            const { id } = await manager.newPage(sessionId, pageId);
            return successResult({ pageId: id });
        }),
    );

    server.registerTool(
        'browser_list_pages',
        {
            title: 'List Pages',
            description: 'List all open tabs',
            inputSchema: {
                sessionId: z.string(),
            },
        },
        wrapHandler(async ({ sessionId }) => {
            const session = manager.getSession(sessionId);
            const pages = await Promise.all(
                Array.from(session.pages.entries()).map(async ([id, page]) => ({
                    id,
                    url: page.url(),
                    title: await page.title().catch(() => ''),
                    isActive: id === session.activePageId,
                })),
            );
            return successResult({ sessionId, activePageId: session.activePageId, pages });
        }),
    );

    server.registerTool(
        'browser_switch_page',
        {
            title: 'Switch Page',
            description: 'Switch to different tab',
            inputSchema: {
                sessionId: z.string(),
                pageId: z.string(),
            },
        },
        wrapHandler(async ({ sessionId, pageId }) => {
            const session = manager.getSession(sessionId);
            const page = session.pages.get(pageId);
            if (!page) {
                throw new BrowserMcpError('PAGE_NOT_FOUND', `Page "${pageId}" not found`);
            }
            session.activePageId = pageId;
            await page.bringToFront();
            return successResult({ activePageId: pageId, url: page.url() });
        }),
    );

    server.registerTool(
        'browser_close_page',
        {
            title: 'Close Page',
            description: 'Close a tab',
            inputSchema: {
                sessionId: z.string(),
                pageId: z.string().optional(),
            },
        },
        wrapHandler(async ({ sessionId, pageId }) => {
            const session = manager.getSession(sessionId);
            const id = pageId || session.activePageId;
            if (!id) {
                throw new BrowserMcpError('PAGE_NOT_FOUND', 'No page specified');
            }

            const page = session.pages.get(id);
            if (!page) {
                throw new BrowserMcpError('PAGE_NOT_FOUND', `Page "${id}" not found`);
            }

            manager.clearMarkersForPage(id);
            page.removeAllListeners();
            await page.close();
            session.pages.delete(id);

            if (session.activePageId === id) {
                const remaining = Array.from(session.pages.keys());
                session.activePageId = remaining[0] || null;
            }

            return successResult({ closedPageId: id, activePageId: session.activePageId });
        }),
    );

    server.registerTool(
        'browser_mark',
        {
            title: 'Mark Element',
            description: 'Mark element for fast repeated access (returns marker ID)',
            inputSchema: {
                sessionId: z.string(),
                selector: z.string(),
                description: z.string().optional(),
                pageId: z.string().optional(),
            },
        },
        wrapHandler(async ({ sessionId, selector, description, pageId }) => {
            const { page, id: activePageId } = manager.getPage(sessionId, pageId);
            const element = await page.waitForSelector(selector, { timeout: DEFAULT_TIMEOUT });
            if (!element) {
                throw new BrowserMcpError('ELEMENT_NOT_FOUND', `Element not found: ${selector}`);
            }

            const markerId = manager.createMarker(
                element as ElementHandle<Element>,
                activePageId,
                description || selector,
            );

            return successResult({
                markerId,
                pageId: activePageId,
                description: description || selector,
            });
        }),
    );

    server.registerTool(
        'browser_click_marker',
        {
            title: 'Click Marker',
            description: 'Click marked element (fast) or use as CSS selector fallback',
            inputSchema: {
                markerId: z.string().describe('Marker ID or CSS selector'),
                sessionId: z.string(),
            },
        },
        wrapHandler(async ({ markerId, sessionId }) => {
            const marker = manager.getMarker(markerId);

            if (marker) {
                await marker.element.click();
                return successResult({ action: 'click', markerId, usedMarker: true });
            }

            // Fallback: treat as selector
            const { page } = manager.getPage(sessionId);
            await page.click(markerId, { timeout: DEFAULT_TIMEOUT });
            return successResult({ action: 'click', selector: markerId, usedMarker: false });
        }),
    );

    server.registerTool(
        'browser_type_marker',
        {
            title: 'Type in Marker',
            description: 'Type into marked element (fast) or use as CSS selector fallback',
            inputSchema: {
                markerId: z.string().describe('Marker ID or CSS selector'),
                text: z.string(),
                sessionId: z.string(),
                clearFirst: z.boolean().default(true),
            },
        },
        wrapHandler(async ({ markerId, text, sessionId, clearFirst }) => {
            const marker = manager.getMarker(markerId);

            if (marker) {
                if (clearFirst) {
                    await marker.element.fill(text);
                } else {
                    await marker.element.type(text);
                }
                return successResult({ markerId, textLength: text.length, usedMarker: true });
            }

            // Fallback: treat as selector
            const { page } = manager.getPage(sessionId);
            if (clearFirst) {
                await page.fill(markerId, text);
            } else {
                await page.type(markerId, text);
            }
            return successResult({
                selector: markerId,
                textLength: text.length,
                usedMarker: false,
            });
        }),
    );

    server.registerTool(
        'browser_list_markers',
        {
            title: 'List Markers',
            description: 'List all active markers',
            inputSchema: {
                pageId: z.string().optional(),
            },
        },
        wrapHandler(async ({ pageId }) => {
            const markers = manager.listMarkers(pageId);
            return successResult({ count: markers.length, markers });
        }),
    );

    server.registerTool(
        'browser_clear_markers',
        {
            title: 'Clear Markers',
            description: 'Remove markers',
            inputSchema: {
                markerId: z.string().optional(),
                pageId: z.string().optional(),
            },
        },
        wrapHandler(async ({ markerId, pageId }) => {
            if (markerId) {
                await manager.removeMarker(markerId);
            } else if (pageId) {
                manager.clearMarkersForPage(pageId);
            } else {
                for (const { id } of manager.listMarkers()) {
                    await manager.removeMarker(id);
                }
            }
            return successResult({ cleared: true });
        }),
    );

    server.registerTool(
        'browser_handle_dialog',
        {
            title: 'Handle Dialog',
            description: 'Set how to handle next alert/confirm/prompt dialog',
            inputSchema: {
                sessionId: z.string(),
                action: z.enum(['accept', 'dismiss']),
                promptText: z.string().optional().describe('Text to enter for prompt dialogs'),
                pageId: z.string().optional(),
            },
        },
        wrapHandler(async ({ sessionId, action, promptText, pageId }) => {
            const { page } = manager.getPage(sessionId, pageId);

            page.once('dialog', async (dialog) => {
                if (action === 'accept') {
                    await dialog.accept(promptText);
                } else {
                    await dialog.dismiss();
                }
            });

            return successResult({ dialogHandler: action, promptText });
        }),
    );

    server.registerTool(
        'browser_get_cookies',
        {
            title: 'Get Cookies',
            description: 'Get cookies for current page or specific URL',
            inputSchema: {
                sessionId: z.string(),
                url: z.string().optional(),
            },
        },
        wrapHandler(async ({ sessionId, url }) => {
            const session = manager.getSession(sessionId);
            const cookies = await session.context.cookies(url ? [url] : undefined);
            return successResult({ count: cookies.length, cookies });
        }),
    );

    server.registerTool(
        'browser_clear_cookies',
        {
            title: 'Clear Cookies',
            description: 'Clear all cookies',
            inputSchema: {
                sessionId: z.string(),
            },
        },
        wrapHandler(async ({ sessionId }) => {
            const session = manager.getSession(sessionId);
            await session.context.clearCookies();
            return successResult({ cleared: true });
        }),
    );

    server.registerTool(
        'browser_diagnose',
        {
            title: 'Diagnose Browser State',
            description:
                'Get comprehensive diagnostic info when something goes wrong. Shows session state, page state, console errors, and suggestions.',
            inputSchema: {
                sessionId: z.string(),
                pageId: z.string().optional(),
            },
        },
        wrapHandler(async ({ sessionId, pageId }) => {
            const stats = manager.getStats();
            const diagnostics: Record<string, unknown> = {
                timestamp: new Date().toISOString(),
                resources: stats,
            };

            // Check if session exists
            try {
                const session = manager.getSession(sessionId);
                diagnostics.session = {
                    exists: true,
                    pageCount: session.pages.size,
                    activePageId: session.activePageId,
                    historyLength: session.history.length,
                    uptime: Date.now() - session.createdAt,
                };

                // Check if page exists
                try {
                    const { page, id } = manager.getPage(sessionId, pageId);
                    const url = page.url();

                    // Get page state
                    const pageState = await page.evaluate(() => ({
                        readyState: document.readyState,
                        title: document.title,
                        bodyChildCount: document.body?.childElementCount || 0,
                        hasContent: (document.body?.innerText?.length || 0) > 100,
                        forms: document.forms.length,
                        inputs: document.querySelectorAll('input').length,
                        buttons: document.querySelectorAll('button, [role="button"]').length,
                        links: document.querySelectorAll('a').length,
                        iframes: document.querySelectorAll('iframe').length,
                    }));

                    diagnostics.page = {
                        id,
                        url,
                        state: pageState,
                    };

                    // Collect console errors (if any stored)
                    diagnostics.suggestions = [];

                    if (url === 'about:blank') {
                        (diagnostics.suggestions as string[]).push(
                            'Page is blank. Use browser_navigate to go to a URL.',
                        );
                    } else if (!pageState.hasContent) {
                        (diagnostics.suggestions as string[]).push(
                            'Page has little content. Try browser_wait_for_stability or browser_wait for dynamic content.',
                        );
                    }

                    if (pageState.readyState !== 'complete') {
                        (diagnostics.suggestions as string[]).push(
                            `Page still loading (${pageState.readyState}). Use browser_wait_for_stability.`,
                        );
                    }

                    if (pageState.iframes > 0) {
                        (diagnostics.suggestions as string[]).push(
                            'Page has iframes. Content might be inside them - standard selectors may not work.',
                        );
                    }

                    if (pageState.forms > 0) {
                        (diagnostics.suggestions as string[]).push(
                            `Found ${pageState.forms} form(s). Use browser_fill_form for efficient form filling.`,
                        );
                    }
                } catch (pageError) {
                    diagnostics.page = {
                        error: pageError instanceof Error ? pageError.message : 'Unknown error',
                        suggestion:
                            'Use browser_new_page to create a page, or browser_list_pages to see available pages.',
                    };
                }
            } catch (sessionError) {
                diagnostics.session = {
                    exists: false,
                    error: sessionError instanceof Error ? sessionError.message : 'Unknown error',
                    suggestion: 'Use browser_launch or browser_connect to create a session first.',
                };
            }

            // Recent navigation history (last 3)
            try {
                const session = manager.getSession(sessionId);
                diagnostics.recentHistory = session.history.slice(-3).map((h) => ({
                    url: h.url.substring(0, 80) + (h.url.length > 80 ? '...' : ''),
                    title: h.title.substring(0, 40),
                }));
            } catch {
                // Session doesn't exist, already handled
            }

            return successResult(diagnostics);
        }),
    );

    server.registerTool(
        'browser_get_logs',
        {
            title: 'Get Console & Network Logs',
            description:
                'Get recent console messages and network errors. Essential for debugging JS errors and failed requests.',
            inputSchema: {
                sessionId: z.string(),
                filter: z.enum(['all', 'errors', 'warnings', 'network']).default('all'),
                limit: z.number().default(20).describe('Max entries to return'),
                sinceMs: z.number().optional().describe('Only logs from last N milliseconds'),
            },
        },
        wrapHandler(async ({ sessionId, filter, limit, sinceMs }) => {
            const session = manager.getSession(sessionId);
            const now = Date.now();
            const cutoff = sinceMs ? now - sinceMs : 0;

            let consoleLogs = session.consoleLogs.filter((l) => l.timestamp >= cutoff);
            let networkErrors = session.networkErrors.filter((e) => e.timestamp >= cutoff);

            // Apply filter
            switch (filter) {
                case 'errors':
                    consoleLogs = consoleLogs.filter((l) => l.type === 'error');
                    break;
                case 'warnings':
                    consoleLogs = consoleLogs.filter(
                        (l) => l.type === 'warn' || l.type === 'error',
                    );
                    break;
                case 'network':
                    consoleLogs = [];
                    break;
            }

            // Limit results
            consoleLogs = consoleLogs.slice(-limit);
            networkErrors = networkErrors.slice(-limit);

            const hasErrors =
                consoleLogs.some((l) => l.type === 'error') || networkErrors.length > 0;

            return successResult(
                {
                    sessionId,
                    console: {
                        count: consoleLogs.length,
                        logs: consoleLogs.map((l) => ({
                            type: l.type,
                            text: l.text.substring(0, 200),
                            age: `${Math.round((now - l.timestamp) / 1000)}s ago`,
                            pageId: l.pageId,
                        })),
                    },
                    network: {
                        count: networkErrors.length,
                        errors: networkErrors.map((e) => ({
                            url: e.url.substring(0, 100),
                            status: e.status,
                            failure: e.failure,
                            age: `${Math.round((now - e.timestamp) / 1000)}s ago`,
                            pageId: e.pageId,
                        })),
                    },
                    hasErrors,
                },
                hasErrors
                    ? 'Errors found. Check console errors for JS issues, network errors for failed requests.'
                    : 'No errors found. Logs are clean.',
            );
        }),
    );

    server.registerTool(
        'browser_health_check',
        {
            title: 'Health Check',
            description:
                'Check if page is healthy and responsive. Detects loading spinners, broken pages, and unresponsive DOM.',
            inputSchema: {
                sessionId: z.string(),
                pageId: z.string().optional(),
                checks: z
                    .array(z.enum(['dom', 'network', 'spinner', 'scroll', 'responsive']))
                    .default(['dom', 'network', 'spinner']),
            },
        },
        wrapHandler(async ({ sessionId, pageId, checks }) => {
            const session = manager.getSession(sessionId);
            const { page, id } = manager.getPage(sessionId, pageId);

            const results: Record<string, { passed: boolean; details?: string }> = {};
            const issues: string[] = [];

            // DOM check - is page loaded?
            if (checks.includes('dom')) {
                const domState = await page.evaluate(() => ({
                    readyState: document.readyState,
                    bodyExists: !!document.body,
                    hasContent: (document.body?.childElementCount || 0) > 0,
                }));

                const passed =
                    domState.readyState === 'complete' &&
                    domState.bodyExists &&
                    domState.hasContent;
                results.dom = {
                    passed,
                    details: `readyState=${domState.readyState}, hasContent=${domState.hasContent}`,
                };
                if (!passed) issues.push('DOM not fully loaded');
            }

            // Network check - any recent errors?
            if (checks.includes('network')) {
                const recentErrors = session.networkErrors.filter(
                    (e) => e.pageId === id && Date.now() - e.timestamp < 30000,
                );
                const passed = recentErrors.length === 0;
                results.network = {
                    passed,
                    details: passed
                        ? 'No recent errors'
                        : `${recentErrors.length} error(s) in last 30s`,
                };
                if (!passed) issues.push(`${recentErrors.length} network error(s)`);
            }

            // Spinner check - detect loading indicators
            if (checks.includes('spinner')) {
                const hasSpinner = await page.evaluate(() => {
                    // Common spinner patterns
                    const spinnerSelectors = [
                        '[class*="spinner"]',
                        '[class*="loading"]',
                        '[class*="loader"]',
                        '[aria-busy="true"]',
                        '[role="progressbar"]',
                        '.sk-spinner',
                        '.lds-',
                        '.spin',
                    ];
                    for (const sel of spinnerSelectors) {
                        const el = document.querySelector(sel);
                        if (el && (el as HTMLElement).offsetParent !== null) {
                            return { found: true, selector: sel };
                        }
                    }
                    return { found: false };
                });

                results.spinner = {
                    passed: !hasSpinner.found,
                    details: hasSpinner.found
                        ? `Loading indicator: ${hasSpinner.selector}`
                        : 'No spinners detected',
                };
                if (hasSpinner.found) issues.push('Page still loading (spinner detected)');
            }

            // Scroll check - can we scroll?
            if (checks.includes('scroll')) {
                const canScroll = await page.evaluate(() => {
                    const before = window.scrollY;
                    window.scrollBy(0, 10);
                    const after = window.scrollY;
                    window.scrollTo(0, before); // Reset
                    return {
                        scrollable: document.body.scrollHeight > window.innerHeight,
                        scrolled: after !== before,
                    };
                });

                results.scroll = {
                    passed: true, // Scroll issues are informational
                    details: canScroll.scrollable ? 'Page is scrollable' : 'Page fits in viewport',
                };
            }

            // Responsive check - does page respond to interactions?
            if (checks.includes('responsive')) {
                try {
                    const start = Date.now();
                    await page.evaluate(() => document.body.getBoundingClientRect());
                    const elapsed = Date.now() - start;

                    const passed = elapsed < 1000;
                    results.responsive = {
                        passed,
                        details: `DOM query took ${elapsed}ms`,
                    };
                    if (!passed) issues.push('Page is slow to respond');
                } catch {
                    results.responsive = { passed: false, details: 'Failed to query DOM' };
                    issues.push('Page unresponsive');
                }
            }

            const allPassed = Object.values(results).every((r) => r.passed);

            return successResult(
                {
                    pageId: id,
                    url: page.url(),
                    healthy: allPassed,
                    results,
                    issues,
                },
                allPassed
                    ? 'Page is healthy. Proceed with interactions.'
                    : `Issues: ${issues.join(', ')}. Consider browser_wait_for_stability.`,
            );
        }),
    );

    server.registerTool(
        'browser_stealth',
        {
            title: 'Enable Stealth Mode',
            description:
                'Enable anti-detection measures to avoid bot detection on sites like LinkedIn, Google, Amazon. Should be called before navigating to protected sites.',
            inputSchema: {
                sessionId: z.string(),
                level: z
                    .enum(['gentle', 'balanced', 'aggressive'])
                    .default('balanced')
                    .describe('gentle=basic, balanced=recommended, aggressive=maximum stealth'),
            },
        },
        wrapHandler(async ({ sessionId, level }) => {
            const session = manager.getSession(sessionId);

            if (session.stealthEnabled) {
                return successResult(
                    {
                        sessionId,
                        enabled: true,
                        alreadyEnabled: true,
                    },
                    'Stealth was already enabled for this session.',
                );
            }

            const appliedPatches: string[] = [];

            // Apply stealth patches to all pages
            for (const [_pageId, page] of session.pages.entries()) {
                // Basic stealth (all levels)
                await page.addInitScript(() => {
                    // Hide webdriver
                    Object.defineProperty(navigator, 'webdriver', { get: () => false });

                    // Fake plugins
                    Object.defineProperty(navigator, 'plugins', {
                        get: () => [
                            { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
                            {
                                name: 'Chrome PDF Viewer',
                                filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai',
                            },
                            { name: 'Native Client', filename: 'internal-nacl-plugin' },
                        ],
                    });

                    // Fake languages
                    Object.defineProperty(navigator, 'languages', {
                        get: () => ['en-US', 'en'],
                    });
                });
                appliedPatches.push('webdriver', 'plugins', 'languages');

                // Balanced stealth
                if (level === 'balanced' || level === 'aggressive') {
                    await page.addInitScript(() => {
                        // Chrome runtime
                        (window as any).chrome = {
                            runtime: {},
                            loadTimes: () => ({}),
                            csi: () => ({}),
                        };

                        // Permission API
                        const originalQuery = window.navigator.permissions?.query;
                        if (originalQuery) {
                            window.navigator.permissions.query = (params: any) =>
                                params.name === 'notifications'
                                    ? Promise.resolve({ state: 'denied' } as PermissionStatus)
                                    : originalQuery.call(window.navigator.permissions, params);
                        }
                    });
                    appliedPatches.push('chrome_runtime', 'permissions');
                }

                // Aggressive stealth
                if (level === 'aggressive') {
                    await page.addInitScript(() => {
                        // Canvas fingerprint randomization
                        const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
                        HTMLCanvasElement.prototype.toDataURL = function (type?: string) {
                            if (type === 'image/png') {
                                const ctx = this.getContext('2d');
                                if (ctx) {
                                    const imageData = ctx.getImageData(
                                        0,
                                        0,
                                        this.width,
                                        this.height,
                                    );
                                    const data = imageData.data;
                                    for (let i = 0; i < data.length; i += 4) {
                                        data[i] = (data[i]! ^ 1) as number; // Tiny noise
                                    }
                                    ctx.putImageData(imageData, 0, 0);
                                }
                            }
                            return originalToDataURL.apply(this, arguments as any);
                        };

                        // WebGL vendor
                        const getParameterProto = WebGLRenderingContext.prototype.getParameter;
                        WebGLRenderingContext.prototype.getParameter = function (param: number) {
                            if (param === 37445) return 'Intel Inc.'; // UNMASKED_VENDOR
                            if (param === 37446) return 'Intel Iris OpenGL Engine'; // UNMASKED_RENDERER
                            return getParameterProto.apply(this, arguments as any);
                        };
                    });
                    appliedPatches.push('canvas_noise', 'webgl_vendor');

                    // Randomize viewport slightly
                    const randomOffset = Math.floor(Math.random() * 20) - 10;
                    await page.setViewportSize({
                        width: 1280 + randomOffset,
                        height: 720 + randomOffset,
                    });
                    appliedPatches.push('viewport_randomized');
                }
            }

            session.stealthEnabled = true;

            log('info', 'stealth_enabled', { sessionId, level, patches: appliedPatches });

            return successResult(
                {
                    sessionId,
                    enabled: true,
                    level,
                    patches: appliedPatches,
                },
                'Stealth enabled. Navigate to protected sites now. Note: stealth only applies to pages opened after this call.',
            );
        }),
    );

    server.registerTool(
        'browser_assert',
        {
            title: 'Assert Condition',
            description:
                'Assert that a condition is true. Returns pass/fail with evidence. Use for verification steps.',
            inputSchema: {
                sessionId: z.string(),
                pageId: z.string().optional(),
                assertion: z.enum([
                    'url_contains',
                    'url_equals',
                    'title_contains',
                    'title_equals',
                    'element_exists',
                    'element_visible',
                    'element_hidden',
                    'text_contains',
                    'text_equals',
                ]),
                value: z.string().describe('Expected value or selector'),
                selector: z
                    .string()
                    .optional()
                    .describe('CSS selector (for element/text assertions)'),
            },
        },
        wrapHandler(async ({ sessionId, pageId, assertion, value, selector }) => {
            const { page, id } = manager.getPage(sessionId, pageId);

            let passed = false;
            let actual: string = '';
            let details: string = '';

            switch (assertion) {
                case 'url_contains':
                    actual = page.url();
                    passed = actual.includes(value);
                    details = `URL ${passed ? 'contains' : 'does not contain'} "${value}"`;
                    break;

                case 'url_equals':
                    actual = page.url();
                    passed = actual === value;
                    details = `URL ${passed ? 'equals' : 'does not equal'} expected`;
                    break;

                case 'title_contains':
                    actual = await page.title();
                    passed = actual.includes(value);
                    details = `Title ${passed ? 'contains' : 'does not contain'} "${value}"`;
                    break;

                case 'title_equals':
                    actual = await page.title();
                    passed = actual === value;
                    details = `Title ${passed ? 'equals' : 'does not equal'} expected`;
                    break;

                case 'element_exists': {
                    const el = await page.$(value);
                    passed = el !== null;
                    actual = passed ? 'found' : 'not found';
                    details = `Element "${value}" ${actual}`;
                    break;
                }

                case 'element_visible': {
                    const el = await page.$(value);
                    if (el) {
                        passed = await el.isVisible();
                        actual = passed ? 'visible' : 'hidden';
                    } else {
                        passed = false;
                        actual = 'not found';
                    }
                    details = `Element "${value}" is ${actual}`;
                    break;
                }

                case 'element_hidden': {
                    const el = await page.$(value);
                    if (el) {
                        const visible = await el.isVisible();
                        passed = !visible;
                        actual = visible ? 'visible' : 'hidden';
                    } else {
                        passed = true; // Not found = hidden
                        actual = 'not found (counts as hidden)';
                    }
                    details = `Element "${value}" is ${actual}`;
                    break;
                }

                case 'text_contains': {
                    if (!selector) {
                        throw new BrowserMcpError(
                            'INVALID_INPUT',
                            'selector required for text_contains assertion',
                        );
                    }
                    const el = await page.$(selector);
                    if (el) {
                        actual = (await el.textContent()) || '';
                        passed = actual.includes(value);
                        details = `Text ${passed ? 'contains' : 'does not contain'} "${value}"`;
                    } else {
                        passed = false;
                        actual = '';
                        details = `Element "${selector}" not found`;
                    }
                    break;
                }

                case 'text_equals': {
                    if (!selector) {
                        throw new BrowserMcpError(
                            'INVALID_INPUT',
                            'selector required for text_equals assertion',
                        );
                    }
                    const el = await page.$(selector);
                    if (el) {
                        actual = ((await el.textContent()) || '').trim();
                        passed = actual === value;
                        details = `Text ${passed ? 'equals' : 'does not equal'} expected`;
                    } else {
                        passed = false;
                        actual = '';
                        details = `Element "${selector}" not found`;
                    }
                    break;
                }
            }

            const ctx = await buildContext(sessionId, page, id, `assert_${assertion}`);

            return successResult(
                {
                    assertion,
                    passed,
                    expected: value,
                    actual: actual.substring(0, 200),
                    details,
                    pageId: id,
                },
                passed
                    ? 'Assertion passed. Proceed with next step.'
                    : `Assertion failed: ${details}. Check if you're on the right page.`,
                ctx,
            );
        }),
    );

    server.registerResource(
        'health',
        'browser://health',
        {
            title: 'Server Health',
            description: 'Health status and statistics',
            mimeType: 'application/json',
        },
        async () => {
            const stats = manager.getStats();
            return {
                contents: [
                    {
                        uri: 'browser://health',
                        mimeType: 'application/json',
                        text: JSON.stringify({
                            status: 'healthy',
                            uptime: process.uptime(),
                            memory: process.memoryUsage(),
                            limits: {
                                maxSessions: MAX_SESSIONS,
                                maxPagesPerSession: MAX_PAGES_PER_SESSION,
                                maxMarkers: MAX_MARKERS,
                            },
                            ...stats,
                        }),
                    },
                ],
            };
        },
    );

    return server;
}

async function main() {
    log('info', 'server_starting', {
        headless: DEFAULT_HEADLESS,
        maxSessions: MAX_SESSIONS,
        maxPages: MAX_PAGES_PER_SESSION,
        screenshotDir: SCREENSHOT_DIR,
    });

    const server = await createPlaywrightMcpServer();
    const transport = new StdioServerTransport();

    // Graceful shutdown
    const shutdown = async (signal: string) => {
        log('info', 'shutdown_signal', { signal });
        await manager.shutdown();
        process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('uncaughtException', (error) => {
        log('error', 'uncaught_exception', { error: error.message, stack: error.stack });
        shutdown('uncaughtException');
    });

    await server.connect(transport);
    log('info', 'server_started');
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
    main().catch((error) => {
        log('error', 'fatal_error', { error: error.message });
        process.exit(1);
    });
}
