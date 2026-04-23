#!/usr/bin/env -S npx tsx
/**
 * Spotify MCP server — direct Spotify Web API, no third-party wrappers.
 *
 * 45 tools organised by functional area (see the section banners below
 * for the full breakdown): core playback, common playlist/library CRUD,
 * advanced controls, entity metadata lookups, podcasts, audiobooks,
 * markets, follow/unfollow, and playlist image helpers.
 *
 * Auth: reads tokens injected by the gateway's MCP loader (from
 * <FLOPSY_HOME>/auth/spotify.json, written by `flopsy auth spotify`).
 * Auto-refreshes in-process on expiry.
 *
 * Note on November 2024 Spotify API restrictions: new apps are locked out
 * of Recommendations, Audio Features, Featured Playlists, and Related
 * Artists. Those tools are intentionally NOT exposed here.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getValidAccessToken } from './shared/spotify-auth';

const API = 'https://api.spotify.com/v1';

// Exit codes: 1 = retry (token refresh failed mid-session), 2 = config
// broken (no credential, user needs to re-auth).
const EXIT_RETRY = 1;
const EXIT_CONFIG_BROKEN = 2;

/**
 * Call a Spotify Web API endpoint. Returns parsed JSON on 2xx, throws a
 * descriptive error on 4xx/5xx. On 401 we exit so the gateway can
 * respawn us with a refreshed env; `getValidAccessToken` has already
 * refreshed from disk, so a second 401 means the stored refresh_token
 * is revoked — exit with code 2 so the user knows to re-auth.
 */
async function api<T = unknown>(
    path: string,
    opts: {
        method?: 'GET' | 'PUT' | 'POST' | 'DELETE';
        body?: unknown;
        query?: Record<string, string | number | undefined>;
    } = {},
): Promise<T> {
    const token = await getValidAccessToken();
    const url = new URL(`${API}${path}`);
    if (opts.query) {
        for (const [k, v] of Object.entries(opts.query)) {
            if (v !== undefined) url.searchParams.set(k, String(v));
        }
    }
    const res = await fetch(url, {
        method: opts.method ?? 'GET',
        headers: {
            Authorization: `Bearer ${token}`,
            ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (res.status === 204) return undefined as T; // some writes return empty body
    const text = await res.text();
    if (!res.ok) {
        if (res.status === 401) {
            console.error('[spotify] 401 after refresh — refresh_token likely revoked.');
            console.error('[spotify] Re-run: flopsy auth spotify');
            process.exit(EXIT_CONFIG_BROKEN);
        }
        if (res.status === 403) {
            throw new Error(
                `Spotify 403 (${path}): ${text}. ` +
                    `Common causes: not a Premium user (playback write endpoints), ` +
                    `or device is restricted.`,
            );
        }
        if (res.status === 429) {
            const retryAfter = res.headers.get('retry-after') ?? '?';
            throw new Error(
                `Spotify rate-limited (${path}). Retry after ${retryAfter}s.`,
            );
        }
        throw new Error(`Spotify ${res.status} (${path}): ${text}`);
    }
    return text ? (JSON.parse(text) as T) : (undefined as T);
}

// --- types for common responses ------------------------------------------

interface SpotifyDevice {
    id: string | null;
    is_active: boolean;
    is_private_session: boolean;
    is_restricted: boolean;
    name: string;
    type: string;
    volume_percent: number | null;
    supports_volume: boolean;
}

interface PlaybackState {
    device: SpotifyDevice | null;
    is_playing: boolean;
    progress_ms: number | null;
    shuffle_state: boolean;
    repeat_state: 'off' | 'context' | 'track';
    item: { uri: string; name: string; artists?: { name: string }[] } | null;
}

// --- helpers -------------------------------------------------------------

/**
 * Resolve a user-supplied device reference to a concrete device_id. The
 * user can pass either an exact id or a name substring (case-insensitive,
 * first match wins). Refreshing the device list on every call is
 * intentional — Spotify rotates device_ids frequently.
 */
async function resolveDevice(ref?: string): Promise<{ id: string; name: string } | null> {
    if (!ref) return null;
    const { devices } = await api<{ devices: SpotifyDevice[] }>('/me/player/devices');
    const byId = devices.find((d) => d.id === ref);
    if (byId?.id) return { id: byId.id, name: byId.name };
    const needle = ref.toLowerCase();
    const byName = devices.find((d) => d.id && d.name.toLowerCase().includes(needle));
    if (byName?.id) return { id: byName.id, name: byName.name };
    throw new Error(
        `No device matches "${ref}". Available: ${devices
            .map((d) => `${d.name} (${d.type})`)
            .join(', ')}`,
    );
}

function asTextResult(obj: unknown) {
    return {
        content: [
            {
                type: 'text' as const,
                text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2),
            },
        ],
    };
}

// --- MCP server setup ----------------------------------------------------

const server = new McpServer({ name: 'spotify', version: '1.0.0' });

/**
 * Thin wrapper around `server.registerTool` that keeps the old
 * `(name, description, schemaShape, cb)` signature — lets us register
 * tools compactly without filling the file with `inputSchema:` keys.
 * The SDK deprecated `tool(...)` in favour of a config-object
 * form; this is the minimal shim to adopt it.
 */
function tool<T extends z.ZodRawShape>(
    name: string,
    description: string,
    schema: T,
    cb: (args: z.infer<z.ZodObject<T>>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>,
): void {
    server.registerTool(
        name,
        { description, inputSchema: schema },
        cb as Parameters<typeof server.registerTool>[2],
    );
}

// ============================================================
// CORE (8)
// ============================================================

// 1. Search
tool(
    'spotify_search',
    'Search Spotify for tracks, artists, albums, playlists, shows, or episodes. Returns top matches by relevance.',
    {
        query: z.string().describe('Free-text search query'),
        types: z
            .array(z.enum(['track', 'artist', 'album', 'playlist', 'show', 'episode']))
            .default(['track'])
            .describe('Which entity types to search'),
        limit: z.number().int().min(1).max(50).default(10).describe('Max items per type'),
        market: z.string().optional().describe('Two-letter country code (optional)'),
    },
    async (args) => {
        const data = await api('/search', {
            query: {
                q: args.query,
                type: args.types.join(','),
                limit: args.limit,
                market: args.market,
            },
        });
        return asTextResult(data);
    },
);

// 2. Get current playback
tool(
    'spotify_get_current_playback',
    'Get the current playback state: what is playing, on which device, progress, shuffle/repeat mode.',
    {},
    async () => {
        const data = await api<PlaybackState | undefined>('/me/player');
        if (!data) return asTextResult('No active playback.');
        return asTextResult(data);
    },
);

// 3. List devices
tool(
    'spotify_list_devices',
    'List every Spotify Connect device currently available to this user (speakers, phones, computers, web players).',
    {},
    async () => {
        const { devices } = await api<{ devices: SpotifyDevice[] }>('/me/player/devices');
        return asTextResult({
            count: devices.length,
            devices: devices.map((d) => ({
                id: d.id,
                name: d.name,
                type: d.type,
                is_active: d.is_active,
                is_restricted: d.is_restricted,
                volume_percent: d.volume_percent,
                supports_volume: d.supports_volume,
            })),
        });
    },
);

// 4. Transfer playback
tool(
    'spotify_transfer_playback',
    'Move current playback to another device. Accepts a device id or a name substring (e.g. "laptop", "kitchen").',
    {
        device: z.string().describe('Device id or name substring to match'),
        play: z
            .boolean()
            .default(true)
            .describe('If true, start/resume playback on the new device. If false, just transfer state.'),
    },
    async (args) => {
        const d = await resolveDevice(args.device);
        if (!d) throw new Error('device required');
        await api('/me/player', {
            method: 'PUT',
            body: { device_ids: [d.id], play: args.play },
        });
        return asTextResult(`Transferred playback to ${d.name}.`);
    },
);

// 5. Pause
tool(
    'spotify_pause',
    'Pause playback on the active device (or a specified one).',
    {
        device: z.string().optional().describe('Optional device name or id'),
    },
    async (args) => {
        const d = args.device ? await resolveDevice(args.device) : null;
        await api('/me/player/pause', {
            method: 'PUT',
            query: { device_id: d?.id },
        });
        return asTextResult('Paused.');
    },
);

// 6. Resume / play
tool(
    'spotify_play',
    'Start or resume playback. Optionally specify a context (album/playlist/artist URI), a list of track URIs, or a device. No arguments = resume current.',
    {
        context_uri: z.string().optional().describe('e.g. "spotify:album:..." or "spotify:playlist:..."'),
        uris: z.array(z.string()).optional().describe('Up to ~100 track URIs to play in order'),
        position_ms: z.number().int().min(0).optional().describe('Seek to this position in the first track'),
        device: z.string().optional().describe('Optional device name or id'),
    },
    async (args) => {
        const d = args.device ? await resolveDevice(args.device) : null;
        const body: Record<string, unknown> = {};
        if (args.context_uri) body.context_uri = args.context_uri;
        if (args.uris) body.uris = args.uris;
        if (args.position_ms !== undefined) body.position_ms = args.position_ms;
        await api('/me/player/play', {
            method: 'PUT',
            body: Object.keys(body).length > 0 ? body : undefined,
            query: { device_id: d?.id },
        });
        return asTextResult('Playing.');
    },
);

// 7. Queue a track
tool(
    'spotify_queue',
    'Add a track or episode URI to the end of the current playback queue.',
    {
        uri: z.string().describe('Spotify URI, e.g. "spotify:track:..."'),
        device: z.string().optional().describe('Optional device name or id'),
    },
    async (args) => {
        const d = args.device ? await resolveDevice(args.device) : null;
        await api('/me/player/queue', {
            method: 'POST',
            query: { uri: args.uri, device_id: d?.id },
        });
        return asTextResult(`Queued ${args.uri}.`);
    },
);

// 8. User profile
tool(
    'spotify_user_profile',
    'Fetch the authenticated user profile: display name, email, country, subscription tier (product = "premium" / "free").',
    {},
    async () => {
        const data = await api('/me');
        return asTextResult(data);
    },
);

// ============================================================
// COMMON (7)
// ============================================================

// 9. Skip next
tool(
    'spotify_skip_next',
    'Skip to the next track in the current playback queue.',
    {
        device: z.string().optional().describe('Optional device name or id'),
    },
    async (args) => {
        const d = args.device ? await resolveDevice(args.device) : null;
        await api('/me/player/next', {
            method: 'POST',
            query: { device_id: d?.id },
        });
        return asTextResult('Skipped forward.');
    },
);

// 10. Skip previous
tool(
    'spotify_skip_previous',
    'Skip to the previous track.',
    {
        device: z.string().optional(),
    },
    async (args) => {
        const d = args.device ? await resolveDevice(args.device) : null;
        await api('/me/player/previous', {
            method: 'POST',
            query: { device_id: d?.id },
        });
        return asTextResult('Skipped back.');
    },
);

// 11. Create playlist
tool(
    'spotify_create_playlist',
    'Create a new playlist for the authenticated user. Returns the new playlist id + URI.',
    {
        name: z.string().describe('Playlist display name'),
        description: z.string().optional().describe('Optional description'),
        public: z.boolean().default(false).describe('Whether the playlist is publicly visible'),
        collaborative: z.boolean().default(false).describe('Allow other users to edit'),
    },
    async (args) => {
        const me = await api<{ id: string }>('/me');
        const data = await api(`/users/${me.id}/playlists`, {
            method: 'POST',
            body: {
                name: args.name,
                description: args.description,
                public: args.public,
                collaborative: args.collaborative,
            },
        });
        return asTextResult(data);
    },
);

// 12. Add tracks to playlist
tool(
    'spotify_add_to_playlist',
    'Add up to 100 track/episode URIs to a playlist (appends by default).',
    {
        playlist_id: z.string().describe('Playlist id (not the full URI)'),
        uris: z.array(z.string()).min(1).max(100).describe('Track/episode URIs'),
        position: z.number().int().min(0).optional().describe('Insert at this position (0-indexed)'),
    },
    async (args) => {
        const data = await api(`/playlists/${args.playlist_id}/tracks`, {
            method: 'POST',
            body: { uris: args.uris, position: args.position },
        });
        return asTextResult(data);
    },
);

// 13. Saved tracks (get)
tool(
    'spotify_get_saved_tracks',
    'List the authenticated user\'s saved (liked) tracks with pagination.',
    {
        limit: z.number().int().min(1).max(50).default(20),
        offset: z.number().int().min(0).default(0),
    },
    async (args) => {
        const data = await api('/me/tracks', { query: args });
        return asTextResult(data);
    },
);

// 14. Saved tracks (save)
tool(
    'spotify_save_tracks',
    'Save (like) up to 50 tracks to the user\'s library.',
    {
        ids: z.array(z.string()).min(1).max(50).describe('Track ids (not URIs)'),
    },
    async (args) => {
        await api('/me/tracks', {
            method: 'PUT',
            body: { ids: args.ids },
        });
        return asTextResult(`Saved ${args.ids.length} track(s).`);
    },
);

// 15. Recently played
tool(
    'spotify_recently_played',
    'Get the user\'s recent listening history (tracks only, podcasts excluded).',
    {
        limit: z.number().int().min(1).max(50).default(20),
    },
    async (args) => {
        const data = await api('/me/player/recently-played', { query: args });
        return asTextResult(data);
    },
);

// ============================================================
// ADVANCED (3)
// ============================================================

// 16. Seek
tool(
    'spotify_seek',
    'Jump to a specific position (ms) in the currently playing track.',
    {
        position_ms: z.number().int().min(0).describe('Milliseconds from track start'),
        device: z.string().optional(),
    },
    async (args) => {
        const d = args.device ? await resolveDevice(args.device) : null;
        await api('/me/player/seek', {
            method: 'PUT',
            query: { position_ms: args.position_ms, device_id: d?.id },
        });
        return asTextResult(`Seeked to ${args.position_ms}ms.`);
    },
);

// 17. Volume
tool(
    'spotify_set_volume',
    'Set playback volume (0-100). Silently ignored by devices that do not support volume control.',
    {
        volume_percent: z.number().int().min(0).max(100),
        device: z.string().optional(),
    },
    async (args) => {
        const d = args.device ? await resolveDevice(args.device) : null;
        await api('/me/player/volume', {
            method: 'PUT',
            query: { volume_percent: args.volume_percent, device_id: d?.id },
        });
        return asTextResult(`Volume set to ${args.volume_percent}%.`);
    },
);

// 18. Top items
tool(
    'spotify_top_items',
    'Fetch the user\'s top tracks or artists over a time range.',
    {
        type: z.enum(['tracks', 'artists']),
        time_range: z
            .enum(['short_term', 'medium_term', 'long_term'])
            .default('medium_term')
            .describe('short_term ≈ 4 weeks, medium_term ≈ 6 months, long_term ≈ all time'),
        limit: z.number().int().min(1).max(50).default(20),
    },
    async (args) => {
        const data = await api(`/me/top/${args.type}`, {
            query: { time_range: args.time_range, limit: args.limit },
        });
        return asTextResult(data);
    },
);

// ============================================================
// ENTITY METADATA (3) — full details for a specific id.
// Useful when `spotify_search` returns an abbreviated hit and
// the agent needs the full track/album/artist record.
// ============================================================

// 19. Track details
tool(
    'spotify_get_track',
    'Fetch full metadata for a specific track id (title, artists, album, duration, explicit flag, external URLs).',
    {
        id: z.string().describe('Track id (not the full URI)'),
        market: z.string().optional().describe('Two-letter country code for availability filtering'),
    },
    async (args) => {
        const data = await api(`/tracks/${args.id}`, {
            query: { market: args.market },
        });
        return asTextResult(data);
    },
);

// 20. Album details
tool(
    'spotify_get_album',
    'Fetch full metadata for an album id — track listing, release date, label, copyrights, images.',
    {
        id: z.string().describe('Album id'),
        market: z.string().optional(),
    },
    async (args) => {
        const data = await api(`/albums/${args.id}`, {
            query: { market: args.market },
        });
        return asTextResult(data);
    },
);

// 21. Artist details
tool(
    'spotify_get_artist',
    'Fetch artist metadata: name, genres, popularity, follower count, images.',
    {
        id: z.string().describe('Artist id'),
    },
    async (args) => {
        const data = await api(`/artists/${args.id}`);
        return asTextResult(data);
    },
);

// New releases — the only Browse endpoint still open to new apps
// (featured-playlists + category-playlists were restricted in Nov 2024).
tool(
    'spotify_new_releases',
    'Get the latest album releases — good for "what dropped this week" queries.',
    {
        country: z.string().optional().describe('Two-letter ISO country code'),
        limit: z.number().int().min(1).max(50).default(20),
        offset: z.number().int().min(0).default(0),
    },
    async (args) => {
        const data = await api('/browse/new-releases', { query: args });
        return asTextResult(data);
    },
);

// ============================================================
// PODCASTS (9) — shows + episodes, plus library CRUD for both.
// Podcasts use `user-library-read` / `user-library-modify`
// scopes — already in our scope request.
// ============================================================

// 22. Show details
tool(
    'spotify_get_show',
    'Fetch podcast show metadata: name, publisher, description, total_episodes, images.',
    {
        id: z.string().describe('Show id'),
        market: z.string().optional(),
    },
    async (args) => {
        const data = await api(`/shows/${args.id}`, {
            query: { market: args.market },
        });
        return asTextResult(data);
    },
);

// 23. Show episodes
tool(
    'spotify_get_show_episodes',
    'List episodes for a podcast show, newest first, with pagination.',
    {
        id: z.string().describe('Show id'),
        limit: z.number().int().min(1).max(50).default(20),
        offset: z.number().int().min(0).default(0),
        market: z.string().optional(),
    },
    async (args) => {
        const { id, ...q } = args;
        const data = await api(`/shows/${id}/episodes`, { query: q });
        return asTextResult(data);
    },
);

// 24. Single episode details
tool(
    'spotify_get_episode',
    'Fetch full metadata for a specific podcast episode (duration, publish date, description, audio preview URL).',
    {
        id: z.string().describe('Episode id'),
        market: z.string().optional(),
    },
    async (args) => {
        const data = await api(`/episodes/${args.id}`, {
            query: { market: args.market },
        });
        return asTextResult(data);
    },
);

// 25. Saved shows — list
tool(
    'spotify_get_saved_shows',
    'List the shows the user has saved to their podcast library.',
    {
        limit: z.number().int().min(1).max(50).default(20),
        offset: z.number().int().min(0).default(0),
    },
    async (args) => {
        const data = await api('/me/shows', { query: args });
        return asTextResult(data);
    },
);

// 26. Saved shows — save
tool(
    'spotify_save_shows',
    'Save up to 50 shows to the user\'s podcast library.',
    {
        ids: z.array(z.string()).min(1).max(50).describe('Show ids'),
    },
    async (args) => {
        await api('/me/shows', {
            method: 'PUT',
            query: { ids: args.ids.join(',') },
        });
        return asTextResult(`Saved ${args.ids.length} show(s).`);
    },
);

// 27. Saved shows — remove
tool(
    'spotify_remove_saved_shows',
    'Remove up to 50 shows from the user\'s podcast library.',
    {
        ids: z.array(z.string()).min(1).max(50),
    },
    async (args) => {
        await api('/me/shows', {
            method: 'DELETE',
            query: { ids: args.ids.join(',') },
        });
        return asTextResult(`Removed ${args.ids.length} show(s).`);
    },
);

// 28. Saved episodes — list
tool(
    'spotify_get_saved_episodes',
    'List the individual episodes the user has saved (distinct from saving the whole show).',
    {
        limit: z.number().int().min(1).max(50).default(20),
        offset: z.number().int().min(0).default(0),
    },
    async (args) => {
        const data = await api('/me/episodes', { query: args });
        return asTextResult(data);
    },
);

// 29. Saved episodes — save
tool(
    'spotify_save_episodes',
    'Save up to 50 individual episodes to the user\'s library.',
    {
        ids: z.array(z.string()).min(1).max(50),
    },
    async (args) => {
        await api('/me/episodes', {
            method: 'PUT',
            body: { ids: args.ids },
        });
        return asTextResult(`Saved ${args.ids.length} episode(s).`);
    },
);

// 30. Saved episodes — remove
tool(
    'spotify_remove_saved_episodes',
    'Remove up to 50 episodes from the user\'s saved library.',
    {
        ids: z.array(z.string()).min(1).max(50),
    },
    async (args) => {
        await api('/me/episodes', {
            method: 'DELETE',
            body: { ids: args.ids },
        });
        return asTextResult(`Removed ${args.ids.length} episode(s).`);
    },
);

// ============================================================
// PLAYBACK EXTRAS (3) — shuffle, repeat, queue inspection.
// ============================================================

tool(
    'spotify_toggle_shuffle',
    'Enable or disable shuffle on the active playback device.',
    {
        state: z.boolean().describe('true = shuffle on, false = shuffle off'),
        device: z.string().optional(),
    },
    async (args) => {
        const d = args.device ? await resolveDevice(args.device) : null;
        await api('/me/player/shuffle', {
            method: 'PUT',
            query: { state: args.state ? 'true' : 'false', device_id: d?.id },
        });
        return asTextResult(`Shuffle ${args.state ? 'on' : 'off'}.`);
    },
);

tool(
    'spotify_toggle_repeat',
    'Set repeat mode: "off" (no repeat), "context" (repeat album/playlist), or "track" (loop current track).',
    {
        state: z.enum(['off', 'context', 'track']),
        device: z.string().optional(),
    },
    async (args) => {
        const d = args.device ? await resolveDevice(args.device) : null;
        await api('/me/player/repeat', {
            method: 'PUT',
            query: { state: args.state, device_id: d?.id },
        });
        return asTextResult(`Repeat: ${args.state}.`);
    },
);

tool(
    'spotify_get_queue',
    'Show what is currently playing plus the upcoming queue (both user-added and context-queued items).',
    {},
    async () => {
        const data = await api('/me/player/queue');
        return asTextResult(data);
    },
);

// ============================================================
// PLAYLIST CRUD EXTENSIONS (5)
// ============================================================

tool(
    'spotify_get_user_playlists',
    'List all playlists owned or followed by the authenticated user. Essential for finding an existing playlist by name before modifying it.',
    {
        limit: z.number().int().min(1).max(50).default(20),
        offset: z.number().int().min(0).default(0),
    },
    async (args) => {
        const data = await api('/me/playlists', { query: args });
        return asTextResult(data);
    },
);

tool(
    'spotify_get_playlist',
    'Fetch a specific playlist with its track listing, owner, images, and follower count.',
    {
        id: z.string().describe('Playlist id'),
        market: z.string().optional(),
    },
    async (args) => {
        const data = await api(`/playlists/${args.id}`, {
            query: { market: args.market },
        });
        return asTextResult(data);
    },
);

tool(
    'spotify_update_playlist_details',
    'Rename or update a playlist\'s description / public / collaborative flags.',
    {
        id: z.string().describe('Playlist id'),
        name: z.string().optional(),
        description: z.string().optional(),
        public: z.boolean().optional(),
        collaborative: z.boolean().optional(),
    },
    async (args) => {
        const { id, ...body } = args;
        await api(`/playlists/${id}`, { method: 'PUT', body });
        return asTextResult('Playlist updated.');
    },
);

tool(
    'spotify_reorder_playlist',
    'Move a range of tracks within a playlist to a new position. Range = [range_start, range_start + range_length).',
    {
        id: z.string().describe('Playlist id'),
        range_start: z.number().int().min(0).describe('First track position to move (0-indexed)'),
        insert_before: z.number().int().min(0).describe('Position to insert before'),
        range_length: z.number().int().min(1).default(1).describe('Number of tracks to move'),
    },
    async (args) => {
        const { id, ...body } = args;
        const data = await api(`/playlists/${id}/tracks`, { method: 'PUT', body });
        return asTextResult(data);
    },
);

tool(
    'spotify_remove_from_playlist',
    'Remove tracks or episodes from a playlist by URI.',
    {
        id: z.string().describe('Playlist id'),
        uris: z.array(z.string()).min(1).max(100).describe('URIs to remove'),
    },
    async (args) => {
        const data = await api(`/playlists/${args.id}/tracks`, {
            method: 'DELETE',
            body: { tracks: args.uris.map((u) => ({ uri: u })) },
        });
        return asTextResult(data);
    },
);

// ============================================================
// LIBRARY EXTRAS (2) — unlike + bulk-check.
// ============================================================

tool(
    'spotify_remove_saved_tracks',
    'Un-like up to 50 tracks (remove from library).',
    {
        ids: z.array(z.string()).min(1).max(50),
    },
    async (args) => {
        await api('/me/tracks', { method: 'DELETE', body: { ids: args.ids } });
        return asTextResult(`Removed ${args.ids.length} track(s) from library.`);
    },
);

tool(
    'spotify_check_saved_tracks',
    'Check whether a batch of tracks is in the user\'s liked library. Returns an array of booleans parallel to `ids`.',
    {
        ids: z.array(z.string()).min(1).max(50),
    },
    async (args) => {
        const data = await api('/me/tracks/contains', {
            query: { ids: args.ids.join(',') },
        });
        return asTextResult(data);
    },
);

// ============================================================
// FOLLOW (3) — artists only. Check + subscribe + unsubscribe.
// ============================================================

tool(
    'spotify_follow_artist',
    'Subscribe (follow) up to 50 artists.',
    {
        ids: z.array(z.string()).min(1).max(50),
    },
    async (args) => {
        await api('/me/following', {
            method: 'PUT',
            query: { type: 'artist', ids: args.ids.join(',') },
        });
        return asTextResult(`Following ${args.ids.length} artist(s).`);
    },
);

tool(
    'spotify_unfollow_artist',
    'Unfollow up to 50 artists.',
    {
        ids: z.array(z.string()).min(1).max(50),
    },
    async (args) => {
        await api('/me/following', {
            method: 'DELETE',
            query: { type: 'artist', ids: args.ids.join(',') },
        });
        return asTextResult(`Unfollowed ${args.ids.length} artist(s).`);
    },
);

tool(
    'spotify_check_following_artists',
    'Check whether the user follows a list of artists. Returns an array of booleans parallel to `ids`.',
    {
        ids: z.array(z.string()).min(1).max(50),
    },
    async (args) => {
        const data = await api('/me/following/contains', {
            query: { type: 'artist', ids: args.ids.join(',') },
        });
        return asTextResult(data);
    },
);

// ============================================================
// ARTIST EXTRAS (1)
// ============================================================

tool(
    'spotify_get_artist_top_tracks',
    'Get an artist\'s hit tracks in a given market — useful companion to search when the user says "play some <artist>".',
    {
        id: z.string().describe('Artist id'),
        market: z.string().default('US').describe('Two-letter country code; defaults to US'),
    },
    async (args) => {
        const data = await api(`/artists/${args.id}/top-tracks`, {
            query: { market: args.market },
        });
        return asTextResult(data);
    },
);

// --- main ----------------------------------------------------------------

async function main(): Promise<void> {
    // Pre-flight: try to read a valid token. Fail fast with an actionable
    // message so the gateway's MCP loader logs something useful instead
    // of a silent hang.
    try {
        await getValidAccessToken();
    } catch (err) {
        console.error(
            '[spotify] not authorized:',
            err instanceof Error ? err.message : err,
        );
        process.exit(EXIT_CONFIG_BROKEN);
    }

    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch((err) => {
    console.error('[spotify] fatal:', err instanceof Error ? err.message : err);
    process.exit(EXIT_RETRY);
});
