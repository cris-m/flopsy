---
name: spotify
compatibility: Designed for FlopsyBot agent
description: Control Spotify playback, browse music, manage playlists and library. Includes automatic auth recovery via browser cookie import and spotify_player CLI fallback when MCP tools fail.
---

# Spotify

Control Spotify playback, search music, manage playlists, and browse the library via MCP tools. Falls back to CLI tools automatically when MCP is unavailable.

## Recovery Chain

**CRITICAL: Follow this order on ANY failure. Do NOT stop at step 1.**

1. **MCP tool** (e.g., `spotify_play`) — try the native tool first
2. **Re-auth + retry** — if 401/expired/auth error, the MCP server auto-reimports cookies from browsers (safari, chrome, brave, firefox, edge). If the tool still fails after re-auth, continue to step 3
3. **`execute("spogo <command> --json")`** — CLI fallback using the same underlying engine
4. **`execute("spotify_player <command>")`** — alternative CLI with a different auth bucket (survives rate limits that hit spogo)
5. **`web_search`** — for info lookups (artist bio, album details) when all playback tools are down
6. **Report failure** — ONLY after exhausting steps 1-5. State exactly which steps were tried

**Rate limit (429)**: The MCP server automatically falls back to `spotify_player` on rate limit. If both are rate-limited, wait 30 seconds then retry once. Do NOT retry in a loop.

**"No active device"**: Do NOT tell the user to open Spotify. Instead: call `spotify_devices` to list available devices, then `spotify_set_device` to activate one. Only ask the user if zero devices are returned.

## Authentication Recovery

Auth is handled automatically by the MCP server on startup and on 401 errors. The server:

1. Probes the API with `spogo status --json` to verify the session is live (not just cookie file existence)
2. On failure, tries importing cookies from 5 browsers in order: safari, chrome, brave, firefox, edge
3. If all browser imports fail, logs a warning

**If a tool returns an auth error despite auto-recovery:**
```
execute("spogo auth import --browser safari")   # try each browser
execute("spogo auth import --browser chrome")
execute("spogo auth import --browser brave")
execute("spogo auth import --browser firefox")
execute("spogo auth import --browser edge")
execute("spogo auth status")                     # verify
```

Only tell the user "please log in to Spotify in your browser" after ALL 5 browsers fail.

## Tools — Complete Inventory (34 tools)

### Playback Control

| Tool | Purpose |
|------|---------|
| `spotify_status` | Current track, artist, album, progress, device, shuffle/repeat state |
| `spotify_play` | Resume playback or play a specific URI (track/album/playlist/artist) |
| `spotify_pause` | Pause current playback |
| `spotify_next` | Skip to next track |
| `spotify_previous` | Go back to previous track |
| `spotify_volume` | Set volume 0-100 (computers/speakers only, NOT mobile) |
| `spotify_shuffle` | Toggle or set shuffle mode |
| `spotify_repeat` | Set repeat: off, track, or context (album/playlist) |
| `spotify_seek` | Seek to position: seconds ("30"), mm:ss ("1:30"), or percentage ("50%") |

### Device Management

| Tool | Purpose |
|------|---------|
| `spotify_devices` | List all available playback devices |
| `spotify_set_device` | Transfer playback to a different device (target must have Spotify open) |

### Search & Discovery

| Tool | Purpose |
|------|---------|
| `spotify_search` | Search tracks, albums, artists, playlists, episodes, shows. Returns URIs for playback |

### Info Lookups

| Tool | Purpose |
|------|---------|
| `spotify_track_info` | Detailed track info by Spotify ID |
| `spotify_album_info` | Detailed album info by Spotify ID |
| `spotify_artist_info` | Detailed artist info by Spotify ID |
| `spotify_playlist_info` | Detailed playlist info by Spotify ID |
| `spotify_show_info` | Podcast show info by Spotify ID |
| `spotify_episode_info` | Podcast episode info by Spotify ID |

### Queue

| Tool | Purpose |
|------|---------|
| `spotify_queue` | View current queue (no args) or add a track to queue (pass URI) |
| `spotify_queue_clear` | Clear the playback queue |

### Playlist Management

| Tool | Purpose |
|------|---------|
| `spotify_library_playlists` | List your playlists (with limit/offset pagination) |
| `spotify_playlist_create` | Create a new playlist (name, description, public flag) |
| `spotify_playlist_tracks` | List tracks in a playlist (with pagination) |
| `spotify_playlist_add` | Add tracks to a playlist (array of track IDs/URIs) |
| `spotify_playlist_remove` | Remove tracks from a playlist |

### Library (Liked Songs, Albums, Artists)

| Tool | Purpose |
|------|---------|
| `spotify_library_tracks` | List liked/saved tracks (with pagination) |
| `spotify_like` | Save/like tracks by ID |
| `spotify_unlike` | Remove tracks from Liked Songs |
| `spotify_library_albums` | List saved albums |
| `spotify_save_album` | Save albums to library |
| `spotify_remove_album` | Remove albums from library |
| `spotify_followed_artists` | List followed artists |
| `spotify_follow_artist` | Follow artists by ID |
| `spotify_unfollow_artist` | Unfollow artists by ID |

## Workflows

### "What am I listening to?" + "Tell me about the artist"
1. `spotify_status` — get current track, note the artist ID from the response
2. Report track name, artist, album, progress
3. If user asks about the artist: extract artist ID from status → `spotify_artist_info` with that ID
4. If `spotify_artist_info` fails → `web_search("artist name spotify biography")`

### "Play [something]"
1. `spotify_search` with query, type = track (or album/artist/playlist based on context)
2. Present top 3-5 matches if ambiguous; pick best match if clear
3. `spotify_play` with the URI from search results
4. If "no active device" error → `spotify_devices` → `spotify_set_device` → retry `spotify_play`
5. Confirm what's now playing with `spotify_status`

### "Transfer to my phone" / "Play on my speaker"
1. `spotify_devices` — list all available devices
2. Find the matching device by name (phone, speaker, TV, etc.)
3. `spotify_set_device` with the device name or ID
4. Confirm transfer with `spotify_status`
5. If target device not listed → tell user to open Spotify on that device, then retry

### "Make me a playlist"
1. `spotify_playlist_create` with name and optional description
2. `spotify_search` for each requested track/genre
3. `spotify_playlist_add` with the playlist ID and collected track URIs
4. Confirm with `spotify_playlist_tracks` to verify

### "What's in my queue?"
1. `spotify_queue` (no args) — shows upcoming tracks
2. To add: `spotify_search` → `spotify_queue` with the track URI
3. To clear: `spotify_queue_clear`

## CLI Fallback Reference

When MCP tools are down, use `execute()` with these commands:

### spogo (primary CLI)
| Command | Example |
|---------|---------|
| Status | `spogo status --json` |
| Play | `spogo play "spotify:track:ID" --json` |
| Pause | `spogo pause --json` |
| Next/Prev | `spogo next --json` / `spogo prev --json` |
| Search | `spogo search track "query" --json` |
| Volume | `spogo volume 50 --json` |
| Devices | `spogo device list --json` |
| Set device | `spogo device set "DeviceName" --json` |
| Queue | `spogo queue --json` |
| Auth status | `spogo auth status` |
| Auth import | `spogo auth import --browser safari` |

### spotify_player (fallback CLI — different rate limit bucket)
| Command | Example |
|---------|---------|
| Status | `spotify_player get key playback` |
| Play | `spotify_player playback play` |
| Play URI | `spotify_player playback start track --uri spotify:track:ID` |
| Pause | `spotify_player playback pause` |
| Next/Prev | `spotify_player playback next` / `spotify_player playback previous` |
| Volume | `spotify_player playback volume 50` |
| Seek | `spotify_player playback seek <offset_ms>` |
| Shuffle | `spotify_player playback shuffle` |
| Devices | `spotify_player get key devices` |
| Search | `spotify_player search "query"` |
| Queue | `spotify_player get key queue` |

## Guidelines

- URIs (not URLs) identify tracks/albums/playlists: `spotify:track:ID`, `spotify:album:ID`, etc.
- Extract IDs from status/search results to use with info lookup tools
- Volume control works on computers/speakers only, NOT on mobile devices
- Premium account required for on-demand playback controls
- Search supports types: track, album, artist, playlist, episode, show
- Always use `--json` flag with CLI commands for parseable output
