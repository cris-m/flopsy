export interface CatalogPrompt {
    readonly token: string;
    readonly label: string;
    readonly secret?: boolean;
    readonly target: 'env' | 'arg';
}

export interface McpCatalogEntry {
    readonly name: string;
    readonly displayName: string;
    readonly description: string;
    readonly source: string;
    readonly transport: 'stdio';
    readonly command: string;
    readonly args: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
    readonly prompts?: readonly CatalogPrompt[];
}

const NPM = 'https://www.npmjs.com/package';

export const MCP_CATALOG: readonly McpCatalogEntry[] = [
    {
        name: 'filesystem',
        displayName: 'Filesystem',
        description: 'Read/write files under an allowlisted directory.',
        source: `${NPM}/@modelcontextprotocol/server-filesystem`,
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '${ROOT_PATH}'],
        prompts: [{ token: 'ROOT_PATH', label: 'Directory the server may access (absolute path)', target: 'arg' }],
    },
    {
        name: 'memory',
        displayName: 'Memory (knowledge graph)',
        description: 'Persistent knowledge-graph memory store.',
        source: `${NPM}/@modelcontextprotocol/server-memory`,
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-memory'],
    },
    {
        name: 'sequential-thinking',
        displayName: 'Sequential Thinking',
        description: 'Structured step-by-step reasoning scratchpad.',
        source: `${NPM}/@modelcontextprotocol/server-sequential-thinking`,
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    },
    {
        name: 'github',
        displayName: 'GitHub',
        description: 'GitHub repos, issues, PRs, code search.',
        source: `${NPM}/@modelcontextprotocol/server-github`,
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_PERSONAL_ACCESS_TOKEN}' },
        prompts: [{ token: 'GITHUB_PERSONAL_ACCESS_TOKEN', label: 'GitHub personal access token', secret: true, target: 'env' }],
    },
    {
        name: 'brave-search',
        displayName: 'Brave Search',
        description: 'Web + local search via the Brave Search API.',
        source: `${NPM}/@modelcontextprotocol/server-brave-search`,
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-brave-search'],
        env: { BRAVE_API_KEY: '${BRAVE_API_KEY}' },
        prompts: [{ token: 'BRAVE_API_KEY', label: 'Brave Search API key', secret: true, target: 'env' }],
    },
    {
        name: 'postgres',
        displayName: 'PostgreSQL (read-only)',
        description: 'Read-only SQL queries + schema inspection.',
        source: `${NPM}/@modelcontextprotocol/server-postgres`,
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-postgres', '${CONNECTION_STRING}'],
        prompts: [{ token: 'CONNECTION_STRING', label: 'Postgres connection string (postgresql://…)', secret: true, target: 'arg' }],
    },
    {
        name: 'slack',
        displayName: 'Slack',
        description: 'Read channels + post messages in a Slack workspace.',
        source: `${NPM}/@modelcontextprotocol/server-slack`,
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-slack'],
        env: { SLACK_BOT_TOKEN: '${SLACK_BOT_TOKEN}', SLACK_TEAM_ID: '${SLACK_TEAM_ID}' },
        prompts: [
            { token: 'SLACK_BOT_TOKEN', label: 'Slack bot token (xoxb-…)', secret: true, target: 'env' },
            { token: 'SLACK_TEAM_ID', label: 'Slack team ID (T…)', target: 'env' },
        ],
    },
    {
        name: 'puppeteer',
        displayName: 'Puppeteer (browser)',
        description: 'Headless-browser navigation, screenshots, scraping.',
        source: `${NPM}/@modelcontextprotocol/server-puppeteer`,
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-puppeteer'],
    },
    {
        name: 'gdrive',
        displayName: 'Google Drive',
        description: 'Search + read Google Drive files.',
        source: `${NPM}/@modelcontextprotocol/server-gdrive`,
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-gdrive'],
    },
    {
        name: 'everything',
        displayName: 'Everything (reference/demo)',
        description: 'Reference server exercising every MCP feature — useful for testing.',
        source: `${NPM}/@modelcontextprotocol/server-everything`,
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-everything'],
    },
];

export function getCatalogEntry(name: string): McpCatalogEntry | undefined {
    const n = name.trim().toLowerCase();
    return MCP_CATALOG.find((e) => e.name === n);
}
