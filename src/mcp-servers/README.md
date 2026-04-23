# MCP servers

First-party Model Context Protocol servers spawned by the gateway. Each file is a standalone stdio MCP server — runs via `npx tsx <file>.ts`.

## Registered servers

| File | Purpose | Requires |
|---|---|---|
| `obsidian.ts` | Read/search/write an Obsidian vault (markdown, frontmatter, Dataview-aware) | `OBSIDIAN_VAULT_PATH` |
| `home-assistant.ts` | Control lights, switches, climate, sensors, automations | `HOME_ASSISTANT_URL`, `HOME_ASSISTANT_TOKEN` |
| `virustotal.ts` | File / URL / IP / domain reputation + sample analysis | `VIRUSTOTAL_API_KEY` |
| `shodan.ts` | IP lookup, device search, DNS, vulnerability data | `SHODAN_API_KEY` |
| `spotify.ts` | Search, playback (play/pause/queue/skip/seek/volume), device management (transfer-to-device), library + playlists + top items — 18 tools | `SPOTIFY_CLIENT_ID` + `flopsy auth spotify` |

## Spotify setup

```bash
# 1. Create an app at developer.spotify.com/dashboard
#    Register the redirect URI from flopsy.json5 (mcp.servers.spotify.redirectBase),
#    default: http://127.0.0.1:8888/spotify
# 2. Paste the Client ID into .env as SPOTIFY_CLIENT_ID
# 3. Run the OAuth flow (opens your browser):
flopsy auth spotify
# 4. Restart:
flopsy gateway restart
```

`flopsy auth spotify` writes the credential to `<FLOPSY_HOME>/auth/spotify.json`. The gateway injects `SPOTIFY_ACCESS_TOKEN` into the MCP child process via `requiresAuth: ["spotify"]`; the MCP auto-refreshes the access token in-process on expiry.

## Adding a new server

1. Drop a `<name>.ts` file here that speaks MCP stdio (start from any existing file as a template).
2. Add an entry to `mcp.servers` in `flopsy.json5`:
   ```json5
   {
     enabled: true,
     transport: "stdio",
     command: "npx",
     args: ["tsx", "${MCP_ROOT}/<name>.ts"],
     requires: ["<ENV_VAR_NEEDED>"],           // optional — doctor checks these
     requiresAuth: ["<provider>"],             // optional — FLOPSY_<PROVIDER>_ACCESS_TOKEN injected
     assignTo: ["gandalf", "aragorn"],         // per-agent allow-list
     description: "…"
   }
   ```
3. `flopsy gateway restart` — the loader spawns it and probes `list_tools`.

## Env injection

When a server declares `requiresAuth: ["google"]`, the gateway auto-refreshes the stored credential and injects `GOOGLE_ACCESS_TOKEN` (+ `GOOGLE_REFRESH_TOKEN`, `GOOGLE_EXPIRES_AT`) into the spawned process. Servers read it from `process.env` — no local OAuth flow needed.

See `src/team/src/mcp/loader.ts` for the full env-expansion rules.
