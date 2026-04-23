---
name: arxiv-search
compatibility: Designed for FlopsyBot agent
description: Search arXiv for academic papers by title, author, or topic. Use when the user wants to find research papers, explore a scientific topic, or get paper summaries.
---

# arXiv Search

Search and retrieve academic papers from arXiv using the arxiv MCP tools.

## When to Use This Skill

- User says "find papers about ..." or "search arXiv for ..."
- User wants to read about a scientific or technical topic
- User wants paper summaries, authors, or citation information
- A research task requires finding relevant literature

## Core Tools

| Tool | Purpose |
|------|---------|
| `arxiv_search` | Search papers by query (title, abstract, author) |
| `arxiv_get` | Get full metadata and abstract for a paper by ID |
| `arxiv_list` | List recent papers in a category |

## Search Query Syntax

The arXiv search supports field-specific queries:

| Prefix | Searches |
|--------|----------|
| `ti:` | Title only |
| `au:` | Author name |
| `abs:` | Abstract only |
| `all:` | All fields (default) |
| `cat:` | Category (e.g., `cs.AI`, `physics.quant-ph`) |

**Examples:**
- `all:large language models` -- search all fields
- `ti:transformer au:vaswani` -- title contains "transformer" AND author is Vaswani
- `cat:cs.AI` -- list papers in AI category

## Workflow

### Finding Papers on a Topic
1. Formulate a query from the user's topic
2. Call `arxiv_search` with the query and a reasonable max results count (10-20)
3. Present results: title, authors, date, abstract snippet
4. If the user wants more detail on a specific paper, call `arxiv_get` with the paper ID

### Exploring a Category
1. Call `arxiv_list` with the category code and optional date filter
2. Present recent papers with titles and abstracts
3. Let the user drill into any paper they find interesting

## Output Format

Present search results clearly:

```
1. "Attention Is All You Need" — Vaswani et al., 2017
   arXiv: 1706.03762
   Abstract: We propose a new simple network architecture, the Transformer, based solely on attention mechanisms...

2. "BERT: Pre-training of Deep Bidirectional Transformers" — Devlin et al., 2019
   arXiv: 1810.04805
   Abstract: We introduce BERT, a method for pre-training language representations...
```

## Guidelines

- arXiv papers are preprints and may not have been peer-reviewed; note this to the user when appropriate
- Paper IDs have the format `YYMM.NNNNN` (e.g., `2301.12345`); use these for `arxiv_get`
- For broad topics, start with a category listing to understand the landscape before narrowing with keyword search
- If the user wants PDFs, provide the direct arXiv link: `https://arxiv.org/abs/{paper_id}`
