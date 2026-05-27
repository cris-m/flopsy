# vault

A language-agnostic encrypted credential broker for AI agents.

Your agent never holds the real API keys. It uses placeholder strings (e.g. `__anthropic_api_key__`) and routes HTTPS calls through a local MITM proxy. The proxy decrypts, swaps the placeholder for the real key on the way out, and forwards to the upstream API. Real credentials live encrypted at rest under AES-256-GCM with an Argon2id-derived key.

Inspired by [Infisical Agent Vault](https://github.com/Infisical/agent-vault) — same architecture, smaller surface, no separate identity model, works the same with any HTTPS client in any language.

## How it works

```
┌─────────────────────────────────────────────────────────────────┐
│  Public internet                                                │
│       api.anthropic.com   api.openai.com   api.github.com  ...  │
└──────────────────────────────▲──────────────────────────────────┘
                               │  outbound HTTPS — real key here
┌──────────────────────────────┼──────────────────────────────────┐
│  Local host                  │                                  │
│                                                                 │
│  ┌─────────────┐   CONNECT   ┌──────────────────┐               │
│  │  Your agent │────────────▶│  vault proxy     │── unseals     │
│  │  (any lang) │  + token    │  :proxy-port     │   vault.db    │
│  │  HTTPS_PROXY│             │  swaps __key__   │               │
│  └─────────────┘             │  for real value  │               │
│                              └──────────────────┘               │
│                                                                 │
│  vault.db  AES-256-GCM, Argon2id KEK, KEK/DEK wrapped           │
└─────────────────────────────────────────────────────────────────┘
```

The agent's environment looks like:
```bash
HTTPS_PROXY=http://127.0.0.1:18801
NODE_EXTRA_CA_CERTS=/path/to/vault-ca.pem   # Node
SSL_CERT_FILE=/path/to/vault-ca.pem         # Python requests, urllib
REQUESTS_CA_BUNDLE=/path/to/vault-ca.pem    # Python requests
CURL_CA_BUNDLE=/path/to/vault-ca.pem        # curl
AGENT_VAULT_TOKEN=fv_agt_xxx                # proxy auth
ANTHROPIC_API_KEY=__anthropic_api_key__     # placeholder, swapped at egress
```

## Cross-language usage

Any HTTPS client that honors a proxy + a custom CA bundle works. The placeholder substitution is invisible to the client — it just sees a normal response.

### Node.js

```js
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import { readFileSync } from 'node:fs';

setGlobalDispatcher(new ProxyAgent({
    uri: process.env.HTTPS_PROXY,
    token: `Bearer ${process.env.AGENT_VAULT_TOKEN}`,
    requestTls: { ca: readFileSync(process.env.NODE_EXTRA_CA_CERTS, 'utf8') },
}));

const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
    },
    body: JSON.stringify({ /* ... */ }),
});
```

### Python (requests)

```python
import os, requests

resp = requests.post(
    'https://api.anthropic.com/v1/messages',
    headers={
        'x-api-key': os.environ['ANTHROPIC_API_KEY'],
        'anthropic-version': '2023-06-01',
    },
    json={ ... },
    proxies={'https': os.environ['HTTPS_PROXY']},
    verify=os.environ['REQUESTS_CA_BUNDLE'],
    auth=('', f"Bearer {os.environ['AGENT_VAULT_TOKEN']}"),
)
```

### Go (net/http)

```go
proxyUrl, _ := url.Parse(os.Getenv("HTTPS_PROXY"))
caPem, _ := os.ReadFile(os.Getenv("SSL_CERT_FILE"))
pool := x509.NewCertPool()
pool.AppendCertsFromPEM(caPem)

client := &http.Client{Transport: &http.Transport{
    Proxy: http.ProxyURL(proxyUrl),
    ProxyConnectHeader: http.Header{
        "Proxy-Authorization": []string{"Bearer " + os.Getenv("AGENT_VAULT_TOKEN")},
    },
    TLSClientConfig: &tls.Config{RootCAs: pool},
}}
```

### curl

```bash
curl -x "$HTTPS_PROXY" \
     --cacert "$CURL_CA_BUNDLE" \
     --proxy-header "Proxy-Authorization: Bearer $AGENT_VAULT_TOKEN" \
     -H "x-api-key: $ANTHROPIC_API_KEY" \
     -H "anthropic-version: 2023-06-01" \
     https://api.anthropic.com/v1/messages
```

## What's in the package

### Programmatic API (Node, TypeScript)

```ts
import {
    initVault, unsealVault, changeMasterPassword,
    putSecret, getSecret, listSecrets, deleteSecret,
    addRule, listRules, removeRule,
    mintToken, verifyToken, revokeToken,
    startVaultServer,
    appendAudit, listAudit,
    bootstrapVault, getBroker,
} from '@flopsy/vault';
```

### Server

`startVaultServer({ vaultDbPath, masterPassword, host, mgmtPort, proxyPort })` boots both:
- **Mgmt HTTP** (default `:18800`) — `/health`, `/v1/status`
- **MITM proxy** (default `:18801`) — handles `CONNECT`, validates `Proxy-Authorization: Bearer <token>`, mints per-host leaf certs from the vault's root CA, decrypts the inner request, applies substitution rules, forwards via plain `https.request`

### Substitution rules

A rule is `{hostPattern, placeholder, secretName, injectInto}`. The proxy iterates all matching rules per request — one outbound request can have multiple substitutions across multiple headers / query params / body.

- `hostPattern` — `*` (any), `api.anthropic.com`, `*.github.com`
- `placeholder` — string to look for, e.g. `__anthropic_api_key__`
- `injectInto` — `any` (scan all headers, query, body), `header:<name>`, `body`, `query:<name>`

### Scoped tokens

```ts
const t = mintToken(db, {
    label: 'my-agent',
    ttlMs: 60 * 60 * 1000,
    allowHosts: ['api.anthropic.com', '*.github.com'],
    allowSecrets: ['ANTHROPIC_API_KEY', 'GITHUB_PAT'],
});
// t.rawToken — give to the agent (shown once)
// stored as SHA-256 hash, constant-time verified
```

Tokens that don't match a host or secret get `403`.

## Security model

| Layer | What |
|---|---|
| KDF | Argon2id `t=3 m=64MiB p=4` (CPU + memory hard) |
| At-rest cipher | AES-256-GCM, per-row 96-bit random nonce, secret name as AAD |
| Key wrapping | Random DEK encrypts all rows; KEK (from master pw) wraps the DEK |
| CA | RSA-2048 self-signed root, 10-year, encrypted under DEK; leaf certs minted per host, 24h TTL |
| Token | 256-bit `crypto.randomBytes`, `fv_agt_` prefix, SHA-256 at rest, raw shown once, constant-time `timingSafeEqual` compare |
| Audit | Chain-HMAC: `mac_n = HMAC(DEK_chain_key, prev_mac ‖ row)`. Deletion or mutation breaks the chain. |
| Password rotation | Re-wraps the DEK only — no row-by-row re-encryption |

## Operator commands (CLI ships with FlopsyBot)

```bash
flopsy vault setup           # one-shot wizard: init + import + ca + token + server
flopsy vault add <NAME>      # atomic: secret + rule + placeholder line
flopsy vault run -- <cmd>    # exec child with proxy/CA/token/env injected
flopsy vault doctor          # 6-check health probe
flopsy vault audit           # tamper-evident audit log
flopsy vault server start    # standalone proxy lifecycle
```

If you're integrating without FlopsyBot, the same operations are available as direct module imports — each CLI command is a ~30 line wrapper around the exports listed above.

## Differences vs. Infisical Agent Vault

| | This vault | Infisical Agent Vault |
|---|---|---|
| Install | npm workspace member | `curl \| sh` single binary |
| First-time setup | One CLI command (`flopsy vault setup`) | Web UI: create owner, vault, credentials, services, agent |
| Master password | Keychain (Mac) / 0600 file / env | env var |
| Bulk credential import | `import-env --emit` reads `.env` and auto-creates rules | one-at-a-time UI or CLI |
| Per-run token | Default for `vault run -- cmd`, auto-revoked on exit | manual mint per agent |
| Conceptual model | secret + rule + token | vault + service + credential + agent + token |
| Storage | single SQLite file | single SQLite file |
| Cryptography | AES-256-GCM + Argon2id (same primitives) | same |
| Audit | HMAC chain | HMAC chain |
| Deployment model | local same-host (broker mode) **or** separate-host (proxy mode) | separate-host only |

If you want Infisical's web UI + multi-tenancy + RBAC, use Infisical. If you want a smaller surface, no UI, and a daily flow that's one command, this is leaner.

## License

MIT.
