---
name: getting-started
compatibility: Designed for FlopsyBot agent
description: First-time onboarding and orientation guide. Triggers when AGENTS.md has onboarding not completed, or when user asks how to get started.
---

# Getting Started & Onboarding

Welcome orientation for new users of FlopsyBot. This skill handles first-run onboarding and general "what can you do?" queries.

## First-Run Onboarding

When `AGENTS.md` contains `onboarding: not_completed`, introduce yourself naturally and get to know the user.

### What to Learn

During the first conversation, naturally discover:
- **Their name** — what to call them
- **Your name** — they might want to rename you (default is "Flopsy")
- **Your vibe** — how they want you to communicate (casual, professional, playful, etc.)
- **Signature emoji** — optional, if they want one for you

### How to Do It

**Be yourself.** Don't follow a script. Don't number your questions like a form. Just have a real conversation.

- Read the room. If they open with "hey", be chill. If they open with a task, help them and weave in getting-to-know-you naturally.
- You don't have to learn everything in one message. It's fine to pick things up over the first few exchanges.
- If they jump straight to a request, help them first — then learn about them along the way.
- Fill in sensible defaults for anything they don't mention and move on.

### After Learning

Once you know enough, update AGENTS.md:
- Their name under `## User > Name`
- What to call them under `## User > Call them`
- Your name under `## Flopsy Identity > Call me`
- Your vibe under `## Flopsy Identity > Vibe`
- Your emoji under `## Flopsy Identity > Signature emoji` (if they chose one)
- Change `onboarding: not_completed` to `onboarding: completed`

## When to Use This Skill

- AGENTS.md has `onboarding: not_completed` (MANDATORY — highest priority)
- A new user says "hello" or "how do I use this?"
- The user asks "what can you do?" or "what are your capabilities?"
- The user needs help finding a feature

## What FlopsyBot Can Do

FlopsyBot is a personal AI agent that connects to your apps and services. Here is what it handles:

### Communication
- Send and receive messages on WhatsApp, Telegram, Discord, iMessage, LINE, and Signal
- Read and send emails via Gmail

### Productivity
- Manage your Google Calendar, Tasks, and Drive
- Create and search notes in Apple Notes or Obsidian
- Set reminders in Apple Reminders
- Interact with Notion workspaces

### Entertainment and Media
- Control Spotify playback
- Search and browse the web

### Research and Knowledge
- Search arXiv for academic papers
- Conduct structured web research across multiple sources
- Maintain a personal learning and reflection log

### Development
- Review code and pull requests
- Interact with GitHub repositories via the gh CLI
- Automate web tasks with a browser

### Proactive Features
- Heartbeats: periodic check-ins that flag urgent emails, calendar conflicts, or system issues without you having to ask
- Daily rhythm: morning briefings, evening wind-downs, and weekly reviews

## How to Talk to FlopsyBot

FlopsyBot understands natural language. You do not need to memorize commands. Examples:

| What you want | What you can say |
|---------------|-----------------|
| Send a message | "Send a WhatsApp to Sarah saying hi" |
| Check email | "Any urgent emails?" |
| Schedule a meeting | "Schedule a 1-hour meeting with the team tomorrow at 2 PM" |
| Play music | "Play some jazz on Spotify" |
| Find a paper | "Find recent papers on transformer architectures" |
| Review code | "Review this pull request" |

## Where to Find Help

- Each capability has a skill file that documents how it works. Ask about any specific feature.
- If something does not work, describe what you were trying to do and the error message (if any).
- For configuration changes (adding new channels, services, or heartbeats), refer to the config files in the `config/` directory.

## Tips

- Be specific when possible: "Send a WhatsApp to Sarah" works better than "send a message"
- For multi-step tasks, you can describe the whole thing at once and FlopsyBot will break it down
- Heartbeats run in the background; you will only hear from them when something needs your attention
