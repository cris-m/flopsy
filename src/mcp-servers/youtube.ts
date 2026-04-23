// MCP YouTube Server
// YouTube tools: search, get video details, list playlists, subscriptions
// Uses YouTube Data API v3

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { google, type youtube_v3 } from 'googleapis';
import { z } from 'zod';

import { createAuth, installAuthErrorHandler } from './shared/google-auth';

// Gateway injects Google OAuth tokens via env; this client refreshes in-process.
const auth = createAuth();
installAuthErrorHandler();

function formatDuration(isoDuration: string | null | undefined): string {
    if (!isoDuration) return 'Unknown';

    // Parse ISO 8601 duration (PT1H2M3S)
    const match = isoDuration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!match) return isoDuration;

    const hours = match[1] ? parseInt(match[1]) : 0;
    const minutes = match[2] ? parseInt(match[2]) : 0;
    const seconds = match[3] ? parseInt(match[3]) : 0;

    if (hours > 0) {
        return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function formatViewCount(count: string | null | undefined): string {
    if (!count) return 'Unknown';
    const num = parseInt(count);
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return count;
}

function parseVideo(item: youtube_v3.Schema$Video | youtube_v3.Schema$SearchResult) {
    const snippet = item.snippet;
    const stats = 'statistics' in item ? (item as youtube_v3.Schema$Video).statistics : undefined;
    const details =
        'contentDetails' in item ? (item as youtube_v3.Schema$Video).contentDetails : undefined;

    const videoId =
        typeof item.id === 'string'
            ? item.id
            : ((item.id as youtube_v3.Schema$ResourceId)?.videoId ?? '');

    return {
        id: videoId,
        title: snippet?.title ?? '',
        description: snippet?.description ?? '',
        channelTitle: snippet?.channelTitle ?? '',
        channelId: snippet?.channelId ?? '',
        publishedAt: snippet?.publishedAt ?? '',
        thumbnail: snippet?.thumbnails?.high?.url ?? snippet?.thumbnails?.default?.url ?? '',
        url: `https://www.youtube.com/watch?v=${videoId}`,
        duration: formatDuration(details?.duration),
        viewCount: formatViewCount(stats?.viewCount),
        likeCount: stats?.likeCount ?? null,
        commentCount: stats?.commentCount ?? null,
    };
}

function parseChannel(channel: youtube_v3.Schema$Channel | youtube_v3.Schema$SearchResult) {
    const snippet = channel.snippet;
    const stats =
        'statistics' in channel ? (channel as youtube_v3.Schema$Channel).statistics : undefined;

    const channelId =
        typeof channel.id === 'string'
            ? channel.id
            : ((channel.id as youtube_v3.Schema$ResourceId)?.channelId ?? '');

    return {
        id: channelId,
        title: snippet?.title ?? '',
        description: snippet?.description ?? '',
        thumbnail: snippet?.thumbnails?.high?.url ?? snippet?.thumbnails?.default?.url ?? '',
        url: `https://www.youtube.com/channel/${channelId}`,
        subscriberCount: stats?.subscriberCount ?? null,
        videoCount: stats?.videoCount ?? null,
        viewCount: stats?.viewCount ?? null,
    };
}

function parsePlaylist(playlist: youtube_v3.Schema$Playlist) {
    const snippet = playlist.snippet;
    const details = playlist.contentDetails;

    return {
        id: playlist.id ?? '',
        title: snippet?.title ?? '',
        description: snippet?.description ?? '',
        channelTitle: snippet?.channelTitle ?? '',
        thumbnail: snippet?.thumbnails?.high?.url ?? snippet?.thumbnails?.default?.url ?? '',
        url: `https://www.youtube.com/playlist?list=${playlist.id}`,
        itemCount: details?.itemCount ?? 0,
        publishedAt: snippet?.publishedAt ?? '',
    };
}

export async function createYouTubeMcpServer() {
    const youtube = (google.youtube as any)({ version: 'v3', auth });

    const server = new McpServer({
        name: 'youtube-server',
        version: '1.0.0',
    });

    server.registerTool(
        'youtube_search',
        {
            title: 'Search YouTube',
            description: 'Search for videos, channels, or playlists on YouTube',
            inputSchema: {
                query: z.string().describe('Search query'),
                type: z
                    .enum(['video', 'channel', 'playlist'])
                    .default('video')
                    .describe('Type of content to search'),
                maxResults: z.number().min(1).max(50).default(10).describe('Maximum results'),
                order: z
                    .enum(['relevance', 'date', 'viewCount', 'rating'])
                    .default('relevance')
                    .describe('Sort order'),
            },
        },
        async ({ query, type, maxResults, order }) => {
            const res = await youtube.search.list({
                part: ['snippet'],
                q: query,
                type: [type],
                maxResults,
                order,
            });

            const items = res.data.items ?? [];

            if (items.length === 0) {
                return {
                    content: [{ type: 'text', text: `No ${type}s found for "${query}"` }],
                };
            }

            const results = items.map((item: any) => {
                if (type === 'channel') return parseChannel(item);
                if (type === 'playlist') {
                    return {
                        id: (item.id as youtube_v3.Schema$ResourceId)?.playlistId ?? '',
                        title: item.snippet?.title ?? '',
                        description: item.snippet?.description ?? '',
                        channelTitle: item.snippet?.channelTitle ?? '',
                        thumbnail: item.snippet?.thumbnails?.high?.url ?? '',
                        url: `https://www.youtube.com/playlist?list=${(item.id as youtube_v3.Schema$ResourceId)?.playlistId}`,
                    };
                }
                return parseVideo(item);
            });

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(
                            { success: true, query, type, count: results.length, results },
                            null,
                            2,
                        ),
                    },
                ],
            };
        },
    );

    server.registerTool(
        'youtube_video',
        {
            title: 'Get Video Details',
            description: `Get detailed information about a YouTube video including title, description, view count, and duration.
Use when user asks about a specific video or wants video metadata.`,
            inputSchema: {
                videoId: z
                    .string()
                    .regex(
                        /^[a-zA-Z0-9_-]{11}$/,
                        'Invalid YouTube video ID format. Must be 11 characters (letters, numbers, - or _)',
                    )
                    .describe(
                        "YouTube video ID (11 characters from URL, e.g., 'dQw4w9WgXcQ' from youtube.com/watch?v=dQw4w9WgXcQ)",
                    ),
            },
        },
        async ({ videoId }) => {
            const res = await youtube.videos.list({
                part: ['snippet', 'statistics', 'contentDetails'],
                id: [videoId],
            });

            const video = res.data.items?.[0];

            if (!video) {
                return {
                    content: [{ type: 'text', text: `Video not found: ${videoId}` }],
                };
            }

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({ success: true, video: parseVideo(video) }, null, 2),
                    },
                ],
            };
        },
    );

    server.registerTool(
        'youtube_channel',
        {
            title: 'Get Channel Details',
            description: 'Get information about a YouTube channel',
            inputSchema: {
                channelId: z.string().describe('YouTube channel ID'),
            },
        },
        async ({ channelId }) => {
            const res = await youtube.channels.list({
                part: ['snippet', 'statistics', 'contentDetails'],
                id: [channelId],
            });

            const channel = res.data.items?.[0];

            if (!channel) {
                return {
                    content: [{ type: 'text', text: `Channel not found: ${channelId}` }],
                };
            }

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(
                            { success: true, channel: parseChannel(channel) },
                            null,
                            2,
                        ),
                    },
                ],
            };
        },
    );

    server.registerTool(
        'youtube_my_playlists',
        {
            title: 'My Playlists',
            description: 'List your YouTube playlists',
            inputSchema: {
                maxResults: z.number().min(1).max(50).default(25).describe('Maximum results'),
            },
        },
        async ({ maxResults }) => {
            const res = await youtube.playlists.list({
                part: ['snippet', 'contentDetails'],
                mine: true,
                maxResults,
            });

            const playlists = (res.data.items ?? []).map(parsePlaylist);

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(
                            { success: true, count: playlists.length, playlists },
                            null,
                            2,
                        ),
                    },
                ],
            };
        },
    );

    server.registerTool(
        'youtube_playlist_videos',
        {
            title: 'Get Playlist Videos',
            description: 'List videos in a playlist',
            inputSchema: {
                playlistId: z.string().describe('Playlist ID'),
                maxResults: z.number().min(1).max(50).default(25).describe('Maximum results'),
            },
        },
        async ({ playlistId, maxResults }) => {
            const res = await youtube.playlistItems.list({
                part: ['snippet', 'contentDetails'],
                playlistId,
                maxResults,
            });

            const videos = (res.data.items ?? []).map((item: any) => ({
                id: item.contentDetails?.videoId ?? '',
                title: item.snippet?.title ?? '',
                description: item.snippet?.description ?? '',
                channelTitle: item.snippet?.channelTitle ?? '',
                thumbnail: item.snippet?.thumbnails?.high?.url ?? '',
                url: `https://www.youtube.com/watch?v=${item.contentDetails?.videoId}`,
                position: item.snippet?.position ?? 0,
                addedAt: item.snippet?.publishedAt ?? '',
            }));

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(
                            { success: true, playlistId, count: videos.length, videos },
                            null,
                            2,
                        ),
                    },
                ],
            };
        },
    );

    server.registerTool(
        'youtube_subscriptions',
        {
            title: 'My Subscriptions',
            description: 'List your YouTube channel subscriptions',
            inputSchema: {
                maxResults: z.number().min(1).max(50).default(25).describe('Maximum results'),
                order: z
                    .enum(['alphabetical', 'relevance', 'unread'])
                    .default('relevance')
                    .describe('Sort order'),
            },
        },
        async ({ maxResults, order }) => {
            const res = await youtube.subscriptions.list({
                part: ['snippet'],
                mine: true,
                maxResults,
                order,
            });

            const subscriptions = (res.data.items ?? []).map((sub: any) => ({
                id: sub.id ?? '',
                channelId: sub.snippet?.resourceId?.channelId ?? '',
                channelTitle: sub.snippet?.title ?? '',
                description: sub.snippet?.description ?? '',
                thumbnail: sub.snippet?.thumbnails?.high?.url ?? '',
                url: `https://www.youtube.com/channel/${sub.snippet?.resourceId?.channelId}`,
            }));

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(
                            { success: true, count: subscriptions.length, subscriptions },
                            null,
                            2,
                        ),
                    },
                ],
            };
        },
    );

    server.registerTool(
        'youtube_trending',
        {
            title: 'Trending Videos',
            description: 'Get trending videos in a region',
            inputSchema: {
                regionCode: z.string().default('US').describe('Region code (US, GB, JP, etc.)'),
                category: z
                    .enum(['all', 'music', 'gaming', 'news', 'movies'])
                    .default('all')
                    .describe('Video category'),
                maxResults: z.number().min(1).max(50).default(10).describe('Maximum results'),
            },
        },
        async ({ regionCode, category, maxResults }) => {
            // Category IDs: Music=10, Gaming=20, News=25, Movies=1
            const categoryMap: Record<string, string> = {
                music: '10',
                gaming: '20',
                news: '25',
                movies: '1',
            };

            const params: youtube_v3.Params$Resource$Videos$List = {
                part: ['snippet', 'statistics', 'contentDetails'],
                chart: 'mostPopular',
                regionCode,
                maxResults,
            };

            // Only add category filter if not "all"
            const categoryId = categoryMap[category];
            if (category !== 'all' && categoryId) {
                params.videoCategoryId = categoryId;
            }

            const res = await youtube.videos.list(params);
            const videos = (res.data.items ?? []).map(parseVideo);

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(
                            { success: true, regionCode, category, count: videos.length, videos },
                            null,
                            2,
                        ),
                    },
                ],
            };
        },
    );

    server.registerTool(
        'youtube_comments',
        {
            title: 'Get Video Comments',
            description: `Get top comments on a YouTube video.
Use when user wants to see what people are saying about a video.`,
            inputSchema: {
                videoId: z
                    .string()
                    .regex(/^[a-zA-Z0-9_-]{11}$/, 'Invalid YouTube video ID format')
                    .describe("YouTube video ID (11 characters, e.g., 'dQw4w9WgXcQ')"),
                maxResults: z
                    .number()
                    .min(1)
                    .max(100)
                    .default(20)
                    .describe('Maximum number of comments to return'),
                order: z
                    .enum(['relevance', 'time'])
                    .default('relevance')
                    .describe("Sort order: 'relevance' for top comments, 'time' for newest first"),
            },
        },
        async ({ videoId, maxResults, order }) => {
            const res = await youtube.commentThreads.list({
                part: ['snippet'],
                videoId,
                maxResults,
                order,
            });

            const comments = (res.data.items ?? []).map((item: any) => {
                const comment = item.snippet?.topLevelComment?.snippet;
                return {
                    id: item.id ?? '',
                    author: comment?.authorDisplayName ?? '',
                    authorChannelUrl: comment?.authorChannelUrl ?? '',
                    text: comment?.textDisplay ?? '',
                    likeCount: comment?.likeCount ?? 0,
                    publishedAt: comment?.publishedAt ?? '',
                    replyCount: item.snippet?.totalReplyCount ?? 0,
                };
            });

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(
                            { success: true, videoId, count: comments.length, comments },
                            null,
                            2,
                        ),
                    },
                ],
            };
        },
    );

    server.registerTool(
        'youtube_liked_videos',
        {
            title: 'My Liked Videos',
            description: 'Get your liked videos',
            inputSchema: {
                maxResults: z.number().min(1).max(50).default(25).describe('Maximum results'),
            },
        },
        async ({ maxResults }) => {
            // The "liked videos" playlist has a special ID: LL
            const res = await youtube.playlistItems.list({
                part: ['snippet', 'contentDetails'],
                playlistId: 'LL',
                maxResults,
            });

            const videos = (res.data.items ?? []).map((item: any) => ({
                id: item.contentDetails?.videoId ?? '',
                title: item.snippet?.title ?? '',
                channelTitle: item.snippet?.channelTitle ?? '',
                thumbnail: item.snippet?.thumbnails?.high?.url ?? '',
                url: `https://www.youtube.com/watch?v=${item.contentDetails?.videoId}`,
                likedAt: item.snippet?.publishedAt ?? '',
            }));

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(
                            { success: true, count: videos.length, videos },
                            null,
                            2,
                        ),
                    },
                ],
            };
        },
    );

    server.registerResource(
        'youtube_my_channel',
        'youtube://my-channel',
        {
            title: 'My YouTube Channel',
            description: 'Your YouTube channel information',
            mimeType: 'application/json',
        },
        async () => {
            const res = await youtube.channels.list({
                part: ['snippet', 'statistics', 'contentDetails'],
                mine: true,
            });

            const channel = res.data.items?.[0];

            if (!channel) {
                return {
                    contents: [
                        {
                            uri: 'youtube://my-channel',
                            mimeType: 'application/json',
                            text: JSON.stringify({ error: 'No channel found' }),
                        },
                    ],
                };
            }

            return {
                contents: [
                    {
                        uri: 'youtube://my-channel',
                        mimeType: 'application/json',
                        text: JSON.stringify(parseChannel(channel), null, 2),
                    },
                ],
            };
        },
    );

    return server;
}

async function main() {
    try {
        const server = await createYouTubeMcpServer();
        const transport = new StdioServerTransport();
        await server.connect(transport);
        console.error('[MCP] YouTube started');
    } catch (error) {
        console.error('[MCP] YouTube failed:', error);
        process.exit(1);
    }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
    main();
}
