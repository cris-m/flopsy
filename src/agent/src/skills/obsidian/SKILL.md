---
name: obsidian
compatibility: Designed for FlopsyBot agent
description: Read, create, search, and link notes in an Obsidian vault. Includes direct file access fallback when the MCP server is unavailable.
---

# Obsidian

Read and write notes inside the user's Obsidian vault via the obsidian MCP server. Falls back to direct file access when MCP is unavailable.

## Recovery Chain

**CRITICAL: Follow this order on ANY failure. Do NOT stop at step 1.**

1. **MCP tool** (e.g., `obsidian_search`) — try the native tool first
2. **Direct file access via `execute()`** — Obsidian vaults are just folders of Markdown files:
   ```
   execute("find ~ -name '.obsidian' -type d -maxdepth 4 2>/dev/null")  # find vault path
   execute("ls '/path/to/vault/'")                                       # list notes
   execute("cat '/path/to/vault/note.md'")                               # read a note
   execute("grep -rl 'keyword' '/path/to/vault/' --include='*.md'")      # search
   ```
3. **`read_file` / `write_file`** — use agent file tools if `execute` is restricted
4. **Report failure** — ONLY after steps 1-3 fail. State which steps were tried

**Vault path resolution**: If you don't know the vault path:
1. Check the MCP config: the vault path is set in `OBSIDIAN_VAULT_PATH` env var
2. If unknown: `execute("find ~ -name '.obsidian' -type d -maxdepth 4 2>/dev/null")` to locate vaults
3. Common locations: `~/Documents/Obsidian Vault`, `~/Obsidian`, `~/vaults`

**"Note not found"**: Don't give up after one search. Try:
- Different keywords (shorter, broader)
- `obsidian_list` to browse all notes, then `obsidian_get` by path
- Direct search: `execute("grep -rl 'keyword' '/vault/path/' --include='*.md'")`
- Check for spaces/special chars in note titles

## Vault Location

The vault path is configured via the `OBSIDIAN_VAULT_PATH` environment variable in the MCP server config. Notes are standard Markdown files stored in the vault directory.

## Tools

| Tool | Purpose |
|------|---------|
| `obsidian_list` | List notes in the vault, optionally filtered by folder |
| `obsidian_search` | Full-text search across all vault notes |
| `obsidian_get` | Read a note by path |
| `obsidian_create` | Create a new note |
| `obsidian_update` | Update an existing note |
| `obsidian_delete` | Delete a note |
| `obsidian_tags` | List all tags used in the vault |

## Obsidian-Specific Conventions

### Internal Links
Wiki-style links create bidirectional connections:
```markdown
See also: [[Note Title]]
```

### Tags
Tags are prefixed with `#` and can be nested:
```markdown
#topic/ai #project/flopsy
```

### Frontmatter
YAML frontmatter for metadata:
```markdown
---
created: 2026-01-28
aliases: [alternative name]
tags: [topic/ai]
---
```

## Workflows

### Creating a Note
1. Determine the folder within the vault (or use root)
2. Compose with title, optional frontmatter (tags, dates), and body in Markdown
3. Use internal links `[[...]]` to reference related notes — search first to get correct titles
4. `obsidian_create` with path and content
5. If MCP fails → `execute("cat > '/vault/path/Note Title.md' << 'EOF'\n---\ntags: [topic]\n---\n# Title\nContent\nEOF")`

### Searching the Vault
1. `obsidian_search` with relevant keywords
2. If no results → try shorter keywords, different terms
3. If still nothing → `obsidian_list` to browse all notes
4. If MCP fails → `execute("grep -rl 'keyword' '/vault/path/' --include='*.md'")`
5. Retrieve full content with `obsidian_get` (or `execute("cat '/vault/path/note.md'")`)

### Updating a Note
1. Find the note (search or list)
2. `obsidian_get` to read current content
3. Apply changes preserving frontmatter and internal links
4. `obsidian_update` with path and new content
5. If MCP fails → read with `execute("cat")`, modify, write back with `execute("cat > ...")`

## Direct File Access Reference

When MCP tools are down:

| Action | Command |
|--------|---------|
| Find vault | `find ~ -name '.obsidian' -type d -maxdepth 4 2>/dev/null` |
| List all notes | `find '/vault/path' -name '*.md' -type f` |
| List folder | `ls '/vault/path/folder/'` |
| Read a note | `cat '/vault/path/Note Title.md'` |
| Search content | `grep -rl 'keyword' '/vault/path/' --include='*.md'` |
| Search with context | `grep -rn 'keyword' '/vault/path/' --include='*.md'` |
| List tags | `grep -roh '#[a-zA-Z/]*' '/vault/path/' --include='*.md' \| sort -u` |
| Create a note | Write content to `/vault/path/Title.md` using `write_file` |

## When to Save to Obsidian (Proactive)

After completing research, coding tasks, or learning something useful — save it to Obsidian for the user's knowledge base.

| What You Did | Save To Obsidian | Structure |
|---|---|---|
| Research on a topic | Yes — create a note | Folder: Research/{topic}. Tags: #research #topic |
| Built a coding project | Yes — save the approach | Folder: Projects/{name}. Tags: #project #coding |
| Found useful APIs/tools | Yes — reference note | Folder: Reference/. Tags: #reference #tool |
| News digest / briefing | Yes — archive it | Folder: Briefings/YYYY-MM-DD. Tags: #briefing |
| Learned a lesson / correction | No — goes to MEMORY.md | (agent memory, not vault) |
| Quick calculation / one-off | No — ephemeral | (stays in /scratch/) |

**Folder structure to maintain:**
- Research/ — topic deep-dives, comparisons
- Projects/ — project notes, architecture decisions
- Reference/ — API docs, tool guides, cheat sheets
- Briefings/ — daily/weekly digests
- Finance/ — market snapshots, portfolio reports

**Rules:**
- Always add frontmatter (created date, tags)
- Always use [[internal links]] to connect related notes
- Search before creating — don't duplicate existing notes
- Save AFTER the work is done (not before — no empty notes)

## Guidelines

- Notes are plain Markdown plus Obsidian extensions (wiki links, tags, frontmatter)
- Keep note titles descriptive — they become link targets in `[[...]]` syntax
- When creating notes that reference existing content, search first to get correct note titles for accurate internal links
- Never expose the vault path to end users; reference notes by title or relative path only
- Preserve frontmatter when updating notes — read first, merge changes, write back
