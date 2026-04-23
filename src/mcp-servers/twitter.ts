// MCP Twitter/X Server — cookie-based via bird CLI.
// Auth is managed externally: run `flopsy auth twitter` once.
// The server never opens a browser; it checks the credential file written
// by the CLI and runs `bird check` to verify cookies are still valid.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveFlopsyHome } from '@flopsy/shared';

const execFileAsync = promisify(execFile);

const TIMEOUT_MS = 60000;

/** Check whether the CLI has stored a twitter sentinel credential. */
function hasStoredCredential(): boolean {
    const path = join(resolveFlopsyHome(), 'auth', 'twitter.json');
    if (!existsSync(path)) return false;
    try {
        const raw = JSON.parse(readFileSync(path, 'utf-8')) as { provider?: string };
        return raw.provider === 'twitter';
    } catch {
        return false;
    }
}

/**
 * Check if bird CLI is installed/accessible
 */
async function isBirdInstalled(): Promise<boolean> {
    try {
        await execFileAsync('npx', ['--yes', '@steipete/bird', '--version'], { timeout: 30000 });
        return true;
    } catch {
        return false;
    }
}

/**
 * Check if bird CLI is authenticated with X/Twitter
 */
async function isTwitterAuthenticated(): Promise<boolean> {
    try {
        const { stdout } = await execFileAsync('npx', ['--yes', '@steipete/bird', 'check'], {
            timeout: 30000,
        });
        return stdout.includes('Ready to tweet');
    } catch {
        return false;
    }
}

/**
 * Verify Twitter auth at startup — reads the credential file written by
 * `flopsy auth twitter` and confirms bird cookies are still valid.
 * Never opens a browser; tells the user to run the CLI command instead.
 */
async function ensureTwitterAuth(): Promise<boolean> {
    const installed = await isBirdInstalled();
    if (!installed) {
        console.error('[Twitter] bird CLI not found. Install with: npm install -g @steipete/bird');
        return false;
    }

    if (!hasStoredCredential()) {
        console.error('[Twitter] No credential found. Run: flopsy auth twitter');
        return false;
    }

    const authenticated = await isTwitterAuthenticated();
    if (!authenticated) {
        console.error('[Twitter] Cookies expired or invalid. Re-run: flopsy auth twitter');
        return false;
    }

    console.error('[Twitter] Authenticated via bird cookies.');
    return true;
}

interface TwitterResult {
    success: boolean;
    data?: unknown;
    error?: string;
}

async function runBird(argArray: string[]): Promise<TwitterResult> {
    try {
        // SECURITY: Use execFile with argument array to prevent command injection
        const birdArgs = [...argArray, '--json'];
        console.error(`[Twitter] Running: bird ${birdArgs.join(' ')}`);
        const { stdout, stderr } = await execFileAsync(
            'npx',
            ['--yes', '@steipete/bird', ...birdArgs],
            { timeout: TIMEOUT_MS },
        );

        if (stdout.trim()) {
            try {
                const data = JSON.parse(stdout);
                return { success: true, data };
            } catch {
                return { success: true, data: stdout.trim() };
            }
        }

        if (stderr && (stderr.includes('error') || stderr.includes('Error'))) {
            return { success: false, error: stderr.trim() };
        }

        return { success: true, data: { status: 'ok' } };
    } catch (err) {
        const error = err as Error & { stderr?: string; stdout?: string };
        const errorMsg = error.stderr || error.message;

        if (errorMsg.includes('cookie') || errorMsg.includes('auth')) {
            return {
                success: false,
                error: `Authentication failed. Make sure you're logged into X/Twitter in your browser. Run 'bird check' to verify. Error: ${errorMsg}`,
            };
        }

        if (errorMsg.includes('rate limit') || errorMsg.includes('429')) {
            return {
                success: false,
                error: 'Rate limited by Twitter. Please wait a few minutes and try again.',
            };
        }

        return { success: false, error: errorMsg };
    }
}

function formatTweet(tweet: Record<string, unknown>): string {
    const author = tweet.author as Record<string, unknown> | undefined;
    const handle = author?.screen_name || author?.username || 'unknown';
    const name = author?.name || handle;
    const text = tweet.full_text || tweet.text || '';
    const createdAt = tweet.created_at || '';
    const metrics = tweet.public_metrics as Record<string, number> | undefined;

    let result = `@${handle} (${name})`;
    if (createdAt) result += ` - ${createdAt}`;
    result += `\n${text}`;

    if (metrics) {
        const parts = [];
        if (metrics.reply_count) parts.push(`Replies: ${metrics.reply_count}`);
        if (metrics.retweet_count) parts.push(`Retweets: ${metrics.retweet_count}`);
        if (metrics.like_count) parts.push(`Likes: ${metrics.like_count}`);
        if (parts.length > 0) result += `\n${parts.join(' | ')}`;
    }

    return result;
}

function formatTweets(tweets: unknown[]): string {
    if (!Array.isArray(tweets) || tweets.length === 0) {
        return 'No tweets found.';
    }
    return tweets
        .map((t, i) => `${i + 1}. ${formatTweet(t as Record<string, unknown>)}`)
        .join('\n\n');
}

const server = new McpServer({
    name: 'twitter',
    version: '1.0.0',
});

server.registerTool(
    'twitter_read',
    {
        description: 'Read a specific tweet by URL or ID',
        inputSchema: { url: z.string().describe('Tweet URL or ID') },
    },
    async ({ url }) => {
        const result = await runBird(['read', url]);
        if (!result.success) {
            return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
        }
        const tweet = result.data as Record<string, unknown>;
        return { content: [{ type: 'text', text: formatTweet(tweet) }] };
    },
);

server.registerTool(
    'twitter_thread',
    {
        description: 'Read a full conversation thread',
        inputSchema: { url: z.string().describe('Tweet URL or ID of any tweet in the thread') },
    },
    async ({ url }) => {
        const result = await runBird(['thread', url]);
        if (!result.success) {
            return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
        }
        const tweets = result.data as unknown[];
        return { content: [{ type: 'text', text: formatTweets(tweets) }] };
    },
);

server.registerTool(
    'twitter_replies',
    {
        description: 'Get replies to a tweet',
        inputSchema: {
            url: z.string().describe('Tweet URL or ID'),
            count: z.number().optional().default(10).describe('Number of replies to fetch'),
        },
    },
    async ({ url, count }) => {
        const result = await runBird(['replies', url, '-n', String(count)]);
        if (!result.success) {
            return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
        }
        const tweets = result.data as unknown[];
        return { content: [{ type: 'text', text: formatTweets(tweets) }] };
    },
);

server.registerTool(
    'twitter_home',
    {
        description: 'Get home timeline (For You or Following)',
        inputSchema: {
            following: z
                .boolean()
                .optional()
                .default(false)
                .describe('Use Following timeline instead of For You'),
            count: z.number().optional().default(20).describe('Number of tweets'),
        },
    },
    async ({ following, count }) => {
        const args = following
            ? ['home', '--following', '-n', String(count)]
            : ['home', '-n', String(count)];
        const result = await runBird(args);
        if (!result.success) {
            return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
        }
        const tweets = result.data as unknown[];
        return { content: [{ type: 'text', text: formatTweets(tweets) }] };
    },
);

server.registerTool(
    'twitter_mentions',
    {
        description: 'Get tweets mentioning you (or another user)',
        inputSchema: {
            user: z
                .string()
                .optional()
                .describe('Username to check mentions for (default: your account)'),
            count: z.number().optional().default(20).describe('Number of tweets'),
        },
    },
    async ({ user, count }) => {
        const args = user
            ? ['mentions', '--user', user, '-n', String(count)]
            : ['mentions', '-n', String(count)];
        const result = await runBird(args);
        if (!result.success) {
            return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
        }
        const tweets = result.data as unknown[];
        return { content: [{ type: 'text', text: formatTweets(tweets) }] };
    },
);

server.registerTool(
    'twitter_user_tweets',
    {
        description: "Get a user's tweets",
        inputSchema: {
            username: z.string().describe('Twitter username (with or without @)'),
            count: z.number().optional().default(20).describe('Number of tweets'),
        },
    },
    async ({ username, count }) => {
        const handle = username.startsWith('@') ? username : `@${username}`;
        const result = await runBird(['user-tweets', handle, '-n', String(count)]);
        if (!result.success) {
            return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
        }
        const tweets = result.data as unknown[];
        return { content: [{ type: 'text', text: formatTweets(tweets) }] };
    },
);

server.registerTool(
    'twitter_search',
    {
        description: 'Search for tweets',
        inputSchema: {
            query: z.string().describe('Search query (supports Twitter search operators)'),
            count: z.number().optional().default(20).describe('Number of results'),
        },
    },
    async ({ query, count }) => {
        const result = await runBird(['search', query, '-n', String(count)]);
        if (!result.success) {
            return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
        }
        const tweets = result.data as unknown[];
        return { content: [{ type: 'text', text: formatTweets(tweets) }] };
    },
);

server.registerTool(
    'twitter_news',
    {
        description: 'Get trending news and topics from X/Twitter',
        inputSchema: {
            count: z.number().optional().default(10).describe('Number of items'),
            category: z
                .enum(['all', 'ai', 'sports'])
                .optional()
                .default('all')
                .describe('News category'),
        },
    },
    async ({ count, category }) => {
        const args = ['news', '-n', String(count)];
        if (category === 'ai') args.push('--ai-only');
        if (category === 'sports') args.push('--sports');

        const result = await runBird(args);
        if (!result.success) {
            return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
        }
        return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    },
);

server.registerTool(
    'twitter_tweet',
    {
        description: 'Post a new tweet',
        inputSchema: {
            text: z.string().describe('Tweet text (max 280 characters)'),
            media: z.string().optional().describe('Path to media file to attach'),
        },
    },
    async ({ text, media }) => {
        if (text.length > 280) {
            return { content: [{ type: 'text', text: 'Error: Tweet exceeds 280 characters' }] };
        }

        const args = ['tweet', text];
        if (media) args.push('--media', media);

        const result = await runBird(args);
        if (!result.success) {
            return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
        }
        return { content: [{ type: 'text', text: 'Tweet posted successfully!' }] };
    },
);

server.registerTool(
    'twitter_reply',
    {
        description: 'Reply to a tweet',
        inputSchema: {
            url: z.string().describe('Tweet URL or ID to reply to'),
            text: z.string().describe('Reply text'),
        },
    },
    async ({ url, text }) => {
        const result = await runBird(['reply', url, text]);
        if (!result.success) {
            return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
        }
        return { content: [{ type: 'text', text: 'Reply posted successfully!' }] };
    },
);

server.registerTool(
    'twitter_follow',
    {
        description: 'Follow a user',
        inputSchema: { username: z.string().describe('Username to follow') },
    },
    async ({ username }) => {
        const handle = username.startsWith('@') ? username : `@${username}`;
        const result = await runBird(['follow', handle]);
        if (!result.success) {
            return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
        }
        return { content: [{ type: 'text', text: `Now following ${handle}` }] };
    },
);

server.registerTool(
    'twitter_unfollow',
    {
        description: 'Unfollow a user',
        inputSchema: { username: z.string().describe('Username to unfollow') },
    },
    async ({ username }) => {
        const handle = username.startsWith('@') ? username : `@${username}`;
        const result = await runBird(['unfollow', handle]);
        if (!result.success) {
            return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
        }
        return { content: [{ type: 'text', text: `Unfollowed ${handle}` }] };
    },
);

server.registerTool(
    'twitter_bookmarks',
    {
        description: 'Get your bookmarked tweets',
        inputSchema: { count: z.number().optional().default(20).describe('Number of bookmarks') },
    },
    async ({ count }) => {
        const result = await runBird(['bookmarks', '-n', String(count)]);
        if (!result.success) {
            return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
        }
        const tweets = result.data as unknown[];
        return { content: [{ type: 'text', text: formatTweets(tweets) }] };
    },
);

server.registerTool(
    'twitter_likes',
    {
        description: 'Get your liked tweets',
        inputSchema: { count: z.number().optional().default(20).describe('Number of likes') },
    },
    async ({ count }) => {
        const result = await runBird(['likes', '-n', String(count)]);
        if (!result.success) {
            return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
        }
        const tweets = result.data as unknown[];
        return { content: [{ type: 'text', text: formatTweets(tweets) }] };
    },
);

server.registerTool(
    'twitter_whoami',
    {
        description: 'Get info about the authenticated account',
        inputSchema: {},
    },
    async () => {
        const result = await runBird(['whoami']);
        if (!result.success) {
            return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
        }
        return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    },
);

server.registerTool(
    'twitter_about',
    {
        description: 'Get info about a Twitter user',
        inputSchema: { username: z.string().describe('Username to look up') },
    },
    async ({ username }) => {
        const handle = username.startsWith('@') ? username : `@${username}`;
        const result = await runBird(['about', handle]);
        if (!result.success) {
            return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
        }
        return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    },
);

server.registerTool(
    'twitter_following',
    {
        description: 'Get list of users someone follows',
        inputSchema: {
            username: z.string().optional().describe('Username (default: your account)'),
            count: z.number().optional().default(20).describe('Number of users'),
        },
    },
    async ({ username, count }) => {
        const args = ['following', '-n', String(count)];
        if (username) {
            const handle = username.startsWith('@') ? username : `@${username}`;
            args.push('--user', handle);
        }
        const result = await runBird(args);
        if (!result.success) {
            return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
        }
        return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    },
);

server.registerTool(
    'twitter_followers',
    {
        description: 'Get list of followers',
        inputSchema: {
            username: z.string().optional().describe('Username (default: your account)'),
            count: z.number().optional().default(20).describe('Number of users'),
        },
    },
    async ({ username, count }) => {
        const args = ['followers', '-n', String(count)];
        if (username) {
            const handle = username.startsWith('@') ? username : `@${username}`;
            args.push('--user', handle);
        }
        const result = await runBird(args);
        if (!result.success) {
            return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
        }
        return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    },
);

/**
 * Classify a Twitter/X URL and dispatch to the right bird command.
 *
 * Supported URL shapes:
 *   https://x.com/<user>/status/<id>     → single tweet (bird read)
 *   https://twitter.com/<user>/status/<id>
 *   https://x.com/<user>                 → user profile (bird about)
 *   https://twitter.com/<user>
 *   Raw tweet ID (digits only)           → bird read
 */
function classifyUrl(raw: string): { kind: 'tweet' | 'profile' | 'unknown'; handle?: string; id?: string } {
    const trimmed = raw.trim();

    // Raw numeric ID
    if (/^\d+$/.test(trimmed)) return { kind: 'tweet', id: trimmed };

    let parsed: URL;
    try {
        parsed = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
    } catch {
        return { kind: 'unknown' };
    }

    const host = parsed.hostname.replace(/^www\./, '');
    if (host !== 'x.com' && host !== 'twitter.com') return { kind: 'unknown' };

    // /username/status/id
    const statusMatch = parsed.pathname.match(/^\/@?([^/]+)\/status\/(\d+)/i);
    if (statusMatch) return { kind: 'tweet', handle: statusMatch[1], id: statusMatch[2] };

    // /username (profile)
    const profileMatch = parsed.pathname.match(/^\/@?([^/]+)\/?$/i);
    if (profileMatch) return { kind: 'profile', handle: profileMatch[1] };

    return { kind: 'unknown' };
}

server.registerTool(
    'twitter_extract',
    {
        description:
            'Extract content from any Twitter/X URL — tweet, thread, or profile page. ' +
            'Pass the full URL (e.g. https://x.com/user/status/123) or a bare tweet ID. ' +
            'Returns the full tweet text, author, metrics, and for threads all replies in order.',
        inputSchema: {
            url: z.string().describe('Twitter/X URL or tweet ID to extract content from'),
            thread: z
                .boolean()
                .optional()
                .default(false)
                .describe('Fetch the full thread context instead of just the single tweet'),
        },
    },
    async ({ url, thread }) => {
        const classified = classifyUrl(url);

        if (classified.kind === 'unknown') {
            return {
                content: [{
                    type: 'text',
                    text: `Cannot extract: "${url}" is not a recognised Twitter/X URL.\n` +
                        'Expected: https://x.com/user/status/<id>, https://x.com/<user>, or a tweet ID.',
                }],
            };
        }

        if (classified.kind === 'profile') {
            const handle = classified.handle!;
            const result = await runBird(['about', `@${handle}`]);
            if (!result.success) {
                return { content: [{ type: 'text', text: `Error fetching profile: ${result.error}` }] };
            }
            return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
        }

        // Tweet — use thread mode or single read
        const target = classified.id ?? url;
        if (thread) {
            const result = await runBird(['thread', target]);
            if (!result.success) {
                return { content: [{ type: 'text', text: `Error fetching thread: ${result.error}` }] };
            }
            return { content: [{ type: 'text', text: formatTweets(result.data as unknown[]) }] };
        }

        const result = await runBird(['read', target]);
        if (!result.success) {
            return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
        }
        return {
            content: [{ type: 'text', text: formatTweet(result.data as Record<string, unknown>) }],
        };
    },
);

async function main() {
    console.error('[Twitter MCP] Starting server...');

    const authed = await ensureTwitterAuth();
    if (!authed) {
        console.error('[Twitter MCP] Warning: not authenticated — run `flopsy auth twitter` to fix.');
    }

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('[Twitter MCP] Server running');
}

main().catch((err) => {
    console.error('[Twitter MCP] Fatal error:', err);
    process.exit(1);
});
