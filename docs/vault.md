# Vault

The vault is an encrypted credential store with an MITM HTTPS proxy that substitutes placeholder strings for real credentials at the network egress point. Agents (the flopsy daemon itself, sandboxed code, external tools like Claude Code) carry only placeholders and a scoped token — the real API keys never enter the agent's process address space.

## When to use the vault

| Situation | Decision |
|---|---|
| You have API keys in `.env` and want them encrypted at rest | Yes — `flopsy vault import-env --emit` |
| You want one operator-controlled secret (master password) to unlock everything | Yes |
| You want each external agent to use scoped tokens that you can revoke | Yes |
| You want a tamper-evident log of every credential read | Yes |
| You're the only user, plaintext `.env` is acceptable, no audit needed | Skip — vault adds complexity |

The vault is opt-in. If `FLOPSY_VAULT_MASTER_PASSWORD` (or the equivalent Keychain entry / file) is not set, the daemon falls back to plain `.env`.

## Threat model

What the vault defends against:

| Threat | Defense |
|---|---|
| Prompt-injected agent emits `read_env("ANTHROPIC_API_KEY")` | Agent has no env-read tool; sandbox env is scrubbed; in proxy mode the daemon doesn't hold real keys either |
| Malicious MCP server inherits secrets via env | MCP env is scoped (P2-C2); in proxy mode it gets placeholders + a scoped token |
| Sandbox code reads `/proc/self/environ` | Sandbox env contains only `HTTPS_PROXY`, `AGENT_VAULT_TOKEN`, CA path — no credentials |
| Filesystem snapshot leaks `vault.db` | AES-256-GCM ciphertext, KEK from Argon2id of master password |
| Process-memory dump of the daemon | In proxy mode: daemon holds no DEK and no plaintext credentials |
| Stolen agent token | Scope-bounded (allow-hosts, allow-secrets), revocable, TTL-able |
| Audit log tampering | Per-row HMAC chain keyed off DEK — deletion or mutation breaks the chain |
| Cloud-metadata SSRF via the proxy | Egress IP guard blocks `169.254.169.254` and friends (planned: M5 hardening) |

What it does *not* defend against:

- Root on the same host (can ptrace the vault server, read its memory)
- Compromised vault binary
- A user who hands their master password to an attacker

## Architecture

Two modes; both ship.

### Mode 1: in-process (default — simpler, fewer guarantees)

```
flopsy daemon
  ├─ at startup: resolveMasterPassword() → bootstrapVault()
  ├─ DEK loaded from vault.db, hydrates secrets into process.env
  └─ all existing code paths (channels, LLM clients, MCP) read process.env normally
```

Trade-off: keys live in daemon RAM. Same blast radius as `.env`, but encrypted at rest. Good for single-host laptop use where the daemon process is trusted.

### Mode 2: separate proxy (harder isolation)

```
┌─ flopsy vault server (standalone process) ─┐
│  Holds DEK in memory.                       │
│  :18800 mgmt — health, counts               │
│  :18801 proxy — CONNECT + MITM TLS          │
└────────────────────────────────────────────┘
         ▲
         │ HTTPS_PROXY + AGENT_VAULT_TOKEN
         │
┌─ external agent (daemon, sandbox, Claude Code, …) ┐
│  Has placeholder strings + a scoped token.        │
│  Makes HTTPS calls; proxy substitutes at egress.  │
└───────────────────────────────────────────────────┘
```

The real key only exists in:

1. AES-GCM ciphertext at rest in `vault.db`
2. Vault server RAM during request processing
3. The outbound HTTPS request to the upstream API (where it must be)

Daemon and agent processes hold only placeholders.

## Storage and crypto

| Element | Choice |
|---|---|
| Cipher | AES-256-GCM, fresh 96-bit nonce per row, AAD = secret name |
| KDF | Argon2id, `t=3, m=64 MiB, p=4`, 128-bit salt |
| DEK | 256-bit, random, generated once on `init`, wrapped under KEK |
| KEK | Argon2id of master password, derived in memory, wiped after unwrap |
| Audit chain | HMAC-SHA256 of (prev hmac ‖ row fields), key derived from DEK |
| File | `.flopsy/state/vault.db` mode 0600, SQLite WAL |
| Tokens | 256-bit from `crypto.randomBytes`, SHA-256 hashed at rest, raw shown once |
| Cert minting | Root CA (RSA-2048, 10-year, encrypted at rest under DEK); leaf certs RSA-2048, 24-hour TTL, in-memory cache |

The master password resolves in priority order (`@flopsy/vault/master-password.ts`):

1. **macOS Keychain** (`security find-generic-password -s flopsy-vault -a vault`)
2. **`FLOPSY_VAULT_MASTER_PASSWORD_FILE`** — path to a 0600 file
3. **`FLOPSY_VAULT_MASTER_PASSWORD`** env (prints warning; least safe)
4. **Interactive prompt** (CLI only, if TTY)

The env variant is visible to other processes via `/proc/<pid>/environ` and `ps auxe`. Prefer Keychain or the file.

## CLI reference

### High-level (use these for daily operations)

```
flopsy vault setup                             # one-shot wizard: init + import-env + ca + token + server
flopsy vault doctor                            # 6-check health probe (db, server, /health, token, ca, rules)
flopsy vault add <name> [--host <p>] [--into <t>]      # atomic: put + auto-create rule + append placeholder
flopsy vault run -- <cmd> [args...]            # exec child with proxy/CA/token wired; per-run token revoked on exit
                                                #   --ttl 1h        per-run token TTL (default 1h)
                                                #   --hosts a,b     scope override (default = union of rule hostPatterns)
                                                #   --secrets X,Y   scope override (default = union of rule secretNames)
                                                #   --reuse-token   use the long-lived daemon token (less secure, only for unattended use)
                                                #   --no-server     do not auto-start the proxy if it is not running
                                                #   --envfile <p>   explicit vault.env path (auto-detects sibling of .env)
```

### Primitives

```
flopsy vault init                              # create vault.db, set master password
flopsy vault put <name>                        # store secret (stdin or prompt)
flopsy vault list                              # names + timestamps, never values (paginated)
flopsy vault get <name>                        # decrypt to stdout
flopsy vault rm <name>                         # delete
flopsy vault import-env [path] [--emit]        # bulk-migrate .env → vault.db
                                                #   --emit also writes vault.env with placeholders
                                                #   --emit also auto-creates host=* substitution rules

flopsy vault rule add --host <p> --placeholder <s> --secret <name> [--into <target>]
flopsy vault rule list
flopsy vault rule rm <id>

flopsy vault token mint --label <l> [--ttl 30d] [--allow-hosts a,b] [--allow-secrets X,Y]
flopsy vault token list
flopsy vault token revoke <label>

flopsy vault ca export [--out <path>]          # PEM for agents to trust

flopsy vault server start [--foreground] [--host 127.0.0.1] [--mgmt-port N] [--proxy-port N]
flopsy vault server stop                        # ESRCH-safe; auto-cleans stale pidfile
flopsy vault server status

flopsy vault audit [--since 24h] [--limit 50] [--actor T] [--action A]
flopsy vault stats [--since 24h]               # aggregated 4-way grouping

flopsy vault keychain-set                      # macOS: store master password in Keychain
flopsy vault keychain-clear                    # macOS: remove from Keychain
flopsy vault change-password                   # re-wraps DEK; secrets untouched
```

## Operator setup (wizard)

One command does everything for first-time setup:

```bash
flopsy vault setup
```

This walks you through five steps in one go:

1. **Initialise `vault.db`** — prompts for a master password (twice). Offers to store it in macOS Keychain so subsequent commands don't prompt.
2. **Import `.env`** — auto-detects your `.env`, encrypts every secret-looking key (`KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|PASSPHRASE|CLIENT_ID|PAT|BEARER|JWT`), and writes `vault.env` alongside with placeholder strings. Auto-creates `host=*, into=any` substitution rules for each imported key.
3. **Export the root CA** — writes `.flopsy/state/vault-ca.pem` so HTTPS clients can trust the MITM proxy.
4. **Mint the daemon token** — labelled `flopsy-daemon`, scoped from the union of imported rules (not `'*'` unless you have no rules). Stored directly in macOS Keychain (account `daemon-token`) or a 0600 file — never printed.
5. **Start the proxy server** — daemonises on `:18800` (mgmt) / `:18801` (proxy).

After setup, daily use is one command:

```bash
flopsy vault run -- npm start              # run the flopsy daemon through the vault
flopsy vault run -- python my_agent.py     # any external agent
flopsy vault run --ttl 5m --hosts api.anthropic.com -- claude    # narrowly-scoped
```

Health check whenever you want:

```bash
flopsy vault doctor
# ✔ vault.db, vault server, mgmt /health, daemon token, CA cert, rules coverage
```

### Manual setup (if you want fine control)

The wizard is equivalent to:

```bash
flopsy vault init                          # set master password
flopsy vault keychain-set                  # macOS: stash master pw in Keychain
flopsy vault import-env --emit             # bulk-import .env + auto-create rules + write vault.env
flopsy vault ca export --out .flopsy/state/vault-ca.pem
flopsy vault token mint --label flopsy-daemon --allow-hosts <list> --allow-secrets '*'
flopsy vault server start
```

### Adding a single new credential later

```bash
flopsy vault add ANTHROPIC_API_KEY
# stores the secret + creates a host=*, into=any rule + appends ANTHROPIC_API_KEY=__anthropic_api_key__ to vault.env
```

### Verify

```bash
flopsy vault audit --action proxy.forward --limit 10
flopsy vault stats --since 1h
flopsy status                              # Vault box shows live counts
```

## Agent integration patterns

### Pattern A — daemon-internal (simplest)

Set the master password (Keychain), run `npm start`. The daemon's `main.ts` calls `bootstrapVault()` which hydrates `process.env` from the vault. Every existing tool that reads `process.env.ANTHROPIC_API_KEY` etc. gets the vault value transparently.

This is **Mode 1** above. No proxy server required.

### Pattern B — external agent via `flopsy vault run` (Claude Code, Python, anything)

The wrapper handles all env-var plumbing and per-run token minting:

```bash
flopsy vault run -- claude
flopsy vault run -- python my_agent.py
flopsy vault run -- curl https://api.anthropic.com/v1/messages -H "x-api-key: $ANTHROPIC_API_KEY" ...
```

The wrapper:

1. Resolves the master password from Keychain (silent on Mac)
2. Mints a **per-run token** scoped to the union of rule host patterns (or the explicit `--hosts` flag), TTL 1h by default
3. Sets `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`, `AGENT_VAULT_TOKEN`, `AGENT_VAULT_ADDR`, `AGENT_VAULT_PROXY`
4. Overlays `vault.env` placeholders into the child's env
5. `spawn`s the child with `stdio: 'inherit'` and forwards SIGINT/SIGTERM
6. **Revokes the per-run token** when the child exits (any path)

For unattended scripts that need a long-lived token, pass `--reuse-token` to fall back to the daemon's stored token — less secure, but doesn't require the wrapper to manage lifetime.

Manual plumbing (if you can't use `vault run`):

```bash
HTTPS_PROXY=http://127.0.0.1:18801
AGENT_VAULT_TOKEN=fv_agt_xxx
NODE_EXTRA_CA_CERTS=$PWD/.flopsy/state/vault-ca.pem
# Plus the placeholder env: ANTHROPIC_API_KEY=__anthropic_api_key__
```

Anything that respects `HTTPS_PROXY` (Claude Code, Python `requests` with `verify=$CA`, `curl -x`, Node fetch with `ProxyAgent`) will tunnel through the proxy and have its placeholders rewritten at egress.

### Pattern C — Node-native (when fetch doesn't respect HTTPS_PROXY automatically)

Node 24's global `fetch` (undici) does not honour `HTTPS_PROXY` unless you wire it up. In code:

```ts
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import { readFileSync } from 'node:fs';

setGlobalDispatcher(new ProxyAgent({
    uri: process.env.HTTPS_PROXY,
    token: `Bearer ${process.env.AGENT_VAULT_TOKEN}`,
    requestTls: { ca: readFileSync(process.env.NODE_EXTRA_CA_CERTS) },
}));

// All subsequent global fetch() calls go through the vault proxy.
```

For OpenAI-compatible clients (NVIDIA NIM, Groq, vLLM, …):

```ts
import { OpenAIChatModel } from 'flopsygraph/llm';

const model = new OpenAIChatModel(
    'meta/llama-3.1-8b-instruct',
    { temperature: 0.2, maxTokens: 60 },
    '__nvidia_api_key__',                      // placeholder, not the real key
    'https://integrate.api.nvidia.com/v1',     // upstream base URL
    [],
    'nvidia',                                  // provider label for telemetry
);

const response = await model.invoke([
    { role: 'user', content: 'hello' },
]);
```

The proxy substitutes `__nvidia_api_key__` for the real `NVIDIA_API_KEY` from the vault. The model object never holds the real key.

A complete runnable example lives at `test-vault-nvidia.mjs` in the repo root.

### Pattern D — sandbox code

Sandbox sessions are isolated; their env is scrubbed except for the proxy bootstrap. To give a sandbox the ability to call APIs via the vault:

```ts
const sandbox = new LocalSandboxSession({
    language: 'python',
    vaultEnv: {
        // Per-session scoped token minted now and revoked on close.
        AGENT_VAULT_TOKEN: 'fv_agt_session-scoped-xxx',
    },
});
// HTTPS_PROXY, NODE_EXTRA_CA_CERTS, etc. are auto-forwarded from the parent.
```

The `vaultEnv` channel bypasses the `SECRET_PATTERN` filter that strips `*_TOKEN` from regular `env`. Use it only for short-TTL, narrowly-scoped tokens.

## Audit log

Every credential access is logged in `vault_audit` with a tamper-evident HMAC chain. Inspect via:

```bash
flopsy vault audit --since 24h
flopsy vault audit --actor tool:text_to_speech
flopsy vault audit --action credential.read
```

Rows have:

| Field | Meaning |
|---|---|
| `ts_ms` | when |
| `actor_token` | who (token label or caller name) |
| `action` | `credential.read`, `proxy.connect`, `proxy.forward`, `token.mint`, … |
| `resource` | secret name, host, or `<method> <url>` |
| `outcome` | `success`, `denied:host-not-in-scope`, `denied:token-expired`, `error:upstream`, … |
| `metadata` | JSON with mode, latency, http status |
| `chain_hmac` | HMAC over (prev_chain ‖ row). Deletion or mutation breaks the chain. |

For aggregate views:

```bash
flopsy vault stats --since 7d
# groups by action, outcome, actor, resource
```

## Security best practices

1. **Use Keychain or a 0600 file for the master password.** Avoid `FLOPSY_VAULT_MASTER_PASSWORD` in the shell or `.env`.
2. **Mint narrowly-scoped tokens.** Set `--allow-hosts` to only the hosts the agent legitimately needs. `--allow-secrets` to only the names it needs to substitute.
3. **Set TTLs.** A token with no expiry is fine for the daemon itself; for external agents, use `--ttl 24h` or shorter and rotate.
4. **Revoke when done.** `flopsy vault token revoke <label>` for off-boarding.
5. **Keep `vault.db` on local disk, not network shares.** The ciphertext is opaque but availability still matters.
6. **Back up `vault.db` and remember the master password.** They're co-equal recovery requirements.
7. **Run `flopsy vault audit` periodically.** Look for `denied:*` outcomes — that's where misconfiguration or attack attempts show up.
8. **Watch the `proxy.forward` resource column for unexpected hosts.** If you see calls to a host you didn't authorise, the token's `allowHosts` is too loose.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `[vault] skipped: vault.db does not exist` | not initialised | `flopsy vault init` |
| `[vault] skipped: FLOPSY_VAULT_MASTER_PASSWORD not set` | no unseal source available | `flopsy vault keychain-set` or `export FLOPSY_VAULT_MASTER_PASSWORD_FILE=…` |
| `vault server did not start — see vault.log` | port in use, bad master pw, or pidfile collision | check log, kill stale pid on 18800/18801 |
| `flopsy status` shows `server stopped` while you started it | the daemon wrote a stale state file; you may have killed it without graceful shutdown | `flopsy vault server stop` (it'll clear), then `start` again |
| Proxy returns `407 Proxy Authentication Required` | missing or wrong `Proxy-Authorization: Bearer fv_agt_…` | check `AGENT_VAULT_TOKEN` is exported |
| Proxy returns `403 Forbidden` | token scope doesn't allow the host | `flopsy vault token mint --allow-hosts …` with the right host |
| Agent gets `401` from upstream API | placeholder wasn't substituted — no matching rule | `flopsy vault rule add --host <h> --placeholder <p> --secret <s>` |
| `curl --cacert` succeeds, agent SDK fails | SDK isn't reading `NODE_EXTRA_CA_CERTS` or doesn't honour `HTTPS_PROXY` | wire `undici.ProxyAgent` explicitly (Pattern C) |
| `flopsy vault audit` shows `credential.read` with `outcome=denied:not-found` | secret name in the rule doesn't match what's in the vault | check `flopsy vault list`; case-sensitive |

## File locations

| Path | Contents |
|---|---|
| `.flopsy/state/vault.db` | encrypted SQLite store, mode 0600 |
| `.flopsy/state/vault-ca.pem` | exported root CA (generated by `flopsy vault ca export`) |
| `.flopsy/vault.pid` | running server's pid (deleted on graceful shutdown; auto-cleaned on stale ESRCH) |
| `.flopsy/vault.state.json` | bound ports + pid (used by `flopsy status` and `flopsy vault run`) |
| `.flopsy/logs/vault.log` | server stdout/stderr when daemonised |
| `vault.env` | placeholder env file, sibling of `.env`, written by `import-env --emit` |
| macOS Keychain | service `flopsy-vault` accounts: `vault` (master pw), `daemon-token` (token raw) |
| Linux fallback | `.flopsy/state/daemon.token` (mode 0600) when Keychain unavailable |

## Security guarantees (current)

- **AES-256-GCM** at rest with per-row random 96-bit nonce and secret name as AAD.
- **Argon2id** KEK derivation: `t=3, m=64 MiB, p=4`.
- **KEK/DEK wrapping** — password change re-wraps the DEK only; row ciphertexts unchanged.
- **Audit chain** with **length-prefixed field encoding** (no field-boundary collision; tamper-evidence holds even when paths/labels contain control bytes).
- **Master password via stdin pipe** to the daemonised vault server (not env) — invisible to `ps eww` and `/proc/<pid>/environ`.
- **Per-run ephemeral tokens** by default for `vault run` — 1-hour TTL, auto-revoked on child exit, scope derived from the rule set (not `'*'`).
- **Token storage** in macOS Keychain or 0600 file — never printed to terminal in `setup` or `mint`.
- **TLS upstream verification** explicit (`rejectUnauthorized: true`) on the proxy's `httpsRequest`; Host header bound to the CONNECT target.
- **Vault server graceful stop**: tracks live sockets and destroys them on close, so `vault server stop` no longer hangs waiting for CONNECT tunnels to drain.
- **Hook scripts** run with scrubbed env (only `PATH`, `HOME`, `LANG`, `FLOPSY_HOOK_EVENT`) and refused if world/group-writable or symlinked.

## How it differs from Infisical Agent Vault

The architecture mirrors Infisical's Agent Vault closely (same MITM-proxy pattern, same KEK/DEK wrapping, same Argon2id parameters). Differences:

- Single-operator scope: no user accounts, sessions, or invites
- In-process broker (Pattern A) is offered as a simpler default for laptop use
- Auto-detects placeholders from `import-env --emit` and wires substitution rules in one command
- Integrates with `flopsy status` and the existing audit pipeline
- TypeScript end-to-end, no Go binary to manage

If you outgrow this, both designs can interoperate: Infisical Agent Vault speaks the same `__placeholder__` substitution language and an `HTTPS_PROXY` interface.
