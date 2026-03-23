---
name: project-scaffolding
compatibility: Designed for FlopsyBot agent
description: Initialize new projects from templates and boilerplates. Use when the user wants to create a new codebase, start a project from scratch, or clone and customize a template.
---

# Project Scaffolding

Initialize new codebases using templates, starter kits, or framework generators.

## When to Use This Skill

- User says "create a new [framework] project" or "initialize a [type] app"
- Starting a greenfield project that needs standard setup
- Cloning a template and customizing it for a specific use case

## How to Run Commands

**Always use the `execute` tool to run commands.** Pass the command string as the `command` parameter. Never tell the user to run commands themselves — you have the `execute` tool.

## Common Scaffolding Tools

| Tool | Use Case | Command |
|------|----------|---------|
| `create-vite` | Vite projects (React, Vue, Svelte) | `npm create vite@latest` |
| `create-next-app` | Next.js apps | `npx create-next-app@latest` |
| `create-t3-app` | T3 stack (Next, tRPC, Prisma) | `npm create t3-app@latest` |
| `npm init` | Node.js package | `npm init -y` |
| `cargo new` | Rust project | `cargo new my-project` |
| `go mod init` | Go module | `go mod init module/path` |
| `poetry new` | Python project | `poetry new my-project` |
| `django-admin` | Django project | `django-admin startproject mysite` |

## Scaffolding Workflow

### Step 1: Clarify Requirements
Ask the user:
- What language/framework?
- What type of project? (web app, CLI, library, API)
- Any specific features needed? (TypeScript, tests, linting)
- Where to create it? (current dir, new dir)

### Step 2: Choose the Right Tool
Match requirements to scaffolding tool from table above.

### Step 3: Run the Generator
```bash
# Most generators are interactive - use non-interactive flags when possible
npm create vite@latest my-app -- --template react-ts
cd my-app
npm install
```

### Step 4: Verify Structure
```bash
ls -la
cat package.json   # Verify dependencies
```

### Step 5: Customize
After scaffolding:
- Add custom configuration (ESLint, Prettier, etc.)
- Initialize git if not done: `git init && git add . && git commit -m "Initial commit"`
- Add project-specific files (.env.example, README, etc.)

## Guidelines

- Prefer official generators over DIY (less error-prone)
- Always run install step to verify dependencies
- After scaffolding, run basic commands to confirm it works:
  - `npm run dev` or `npm start` for web apps
  - `npm test` for libraries
- Save commands used in a note for user reference
