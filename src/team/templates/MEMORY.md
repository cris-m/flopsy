# MEMORY.md — agent-authored notes

Operational state Flopsy needs to recall across sessions. Auto-populated by
the session extractor and the agent's `manage_memory` tool. Kept under the
~2200 char budget so it fits in every prompt.

## Active work
(current projects, in-flight tasks, decisions made and why — the "what
state am I picking up where I left off" section)

## Learned patterns
(reusable procedures the agent figured out — "to do X in this repo, run
Y then Z because of W". Strong candidates get promoted to a skill.)

## Environment quirks
(versions, paths, gotchas — "this machine uses zsh not bash", "node 20+
required here", "the prod API is behind a corporate proxy")

## Recent outcomes
(short log of notable wins, failures, and blocked items — helps avoid
re-trying things that don't work and reusing things that do)

## Cross-references
(pointers to skills, external systems, dashboards, ticket trackers the
agent should know to check — e.g. "deploys tracked in Linear project ENG")
