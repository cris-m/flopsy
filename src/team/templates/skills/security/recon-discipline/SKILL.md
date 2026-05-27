---
name: recon-discipline
category: security
compatibility: Designed for FlopsyBot agent
description: Reconnaissance methodology for "how many X are exposed / show me the public state of Y" queries. Multi-query triangulation, cost-aware tool use, false-positive checks, structured output. Distinct from the `research` skill (which targets news/topic gathering); this targets infrastructure + security recon via Shodan, VirusTotal, web fingerprints.
when-to-use: "Use when starting a security investigation that involves both free and paid intelligence sources — covers disambiguation, triangulation, and cost-aware probing."
metadata:
  flopsy:
    agent-affinity: [aragorn]
---

# Recon Discipline

Methodology for reconnaissance-shape questions. Avoids the failure mode of "one tool call → one-line answer" that masks ambiguity and misses context.

## When to Use

The user's request maps to "what's out there on the public internet" or "what's the state of X":

- "How many X are exposed?"
- "Scan for / find / show me public X"
- "What CVEs hit X this week?"
- "What's the attack surface of Y?"
- "Is my X exposed?" (← extra: check your `<agent_memory>` block first — USER.md / MEMORY.md may already say what the user actually runs)

If the question is about news, topic learning, or comparison shopping, use the `research` skill instead. This one is for infrastructure + security recon.

## The Five-Step Pattern

Every recon-shape answer follows the same shape. Skipping a step is a quality bug.

### 1. Disambiguate the term before searching

Many recon targets share names with unrelated projects, products, or pop culture. **One Shodan search on a bare term is rarely what you want.**

Before the first paid call, ask yourself:
- Does this term collide with anything (game, movie, common word, brand)?
- If yes, plan queries that disambiguate (e.g. `product:openclaw` filters Shodan's fingerprinter results vs the bare word in any banner).

Example collision: "openclaw" is FlopsyBot's local sweeper AND a 1997 game remake. 159K bare matches; most are the game.

### 2. Triangulate with FREE queries first

For Shodan specifically: use `shodan_host_count` (zero credits) with multiple variant queries. Compare counts to find the signal.

| Query shape | What it filters for |
|---|---|
| `<term>` (bare) | Any banner, cert, HTML, or title — broadest, noisiest |
| `http.title:<term>` | HTML `<title>` only |
| `http.html:<term>` | HTML body anywhere |
| `product:<term>` | Shodan's service fingerprinter classified it as `<term>` |
| `ssl.cert.subject.cn:<term>` | TLS cert CN — most precise |
| `port:<n> <term>` | Filtered to a specific port |

Render a query → count table in your reply so the user sees the triangulation.

### 3. Aggregate with facets (still free)

`shodan_host_count` accepts `facets=port,country,org,product`. Each facet returns a server-side GROUP BY with top values and counts. Use this to characterize the result set:

- `port` reveals the typical service ports (and outliers like `:18789`)
- `country` reveals geo concentration
- `org` reveals the hosting providers
- `product` reveals what fingerprints are running

Render facet breakdowns as small tables.

### 4. Only THEN call paid `shodan_search`

Once free reconnaissance has narrowed the candidate set, use `shodan_search` (1 credit/call) for individual host records — banners, CVEs, hostnames. Choose targeted queries:
- A specific suspicious port (`port:18789 product:<term>`)
- A specific country if geo concentration suggests a cluster
- A specific cert pattern for high-confidence matches

### 5. Ground in user context

Before the final answer, **read your `<agent_memory>` block (USER.md, MEMORY.md) if the question is about the user's own systems**. The user may not actually run this thing publicly. The right answer to "how many of my sweepers are exposed?" can be 0 — even if generic queries return thousands.

## Output Shape

Channel default is concise. Recon mode is the exception — multi-message delivery is correct here.

### Required sections (in this order)

1. **Headline verdict** (1-2 lines) — the count and the framing
2. **Methodology** — what queries you ran, why. A table works well.
3. **Aggregate breakdown** — facets table (port, country, org)
4. **Caveats** — name collision warning if applicable; false-positive sources
5. **User context** — what's grounded in memory about the user's actual exposure
6. **Next step offer** — "want me to drill into port X / pivot to query Y / inspect sample banner?"

### Length guidance

- Discord/Telegram: split across 2-4 messages. Don't try to cram into one.
- CLI/chat TUI: one structured response with markdown tables.

## Anti-patterns

| Bad | Why |
|---|---|
| One bare Shodan search → one-line answer | Hides ambiguity, misses signal |
| Calling `shodan_search` first | Burns credits before narrowing |
| Treating bare-term counts as authoritative | Includes name collisions and noise |
| Skipping facets | Loses free per-port/per-country structure |
| Not checking memory for user-specific questions | Generic answer when grounded answer was possible |
| No follow-up offer | Treats reconnaissance as a one-shot lookup |

## Worked Example

User: "How many openclaw endpoints are exposed publicly?"

```
1. shodan_host_count(query="openclaw", facets="port,country")
   → 159,137; top ports: 5353 (44k mDNS), 443 (4.6k), 18789 (222)
2. shodan_host_count(query="http.title:openclaw")     → 61,626
3. shodan_host_count(query="product:openclaw")        → 62,333
4. shodan_host_count(query="ssl.cert.subject.cn:openclaw") → 2,249
5. read `<agent_memory>` MEMORY.md
   → confirms: FlopsyBot openclaw is a LOCAL SQLite sweeper, no network port
```

Then deliver: methodology table, facet table, name-collision caveat ("OpenClaw the 1997 Captain Claw remake explains the mDNS chatter"), grounded answer ("0 of YOUR sweepers exposed — it's a local-process pattern"), follow-up ("want me to inspect what's on port 18789?").

That's the shape. Apply to any recon question.
