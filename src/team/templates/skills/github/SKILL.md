---
name: github
compatibility: Designed for FlopsyBot agent
description: Perform GitHub operations via the gh CLI including auth, repo management (create/clone/fork), issues, pull requests, releases, code search, and CI. Use when the user wants to interact with GitHub.
---

# GitHub

Interact with GitHub repositories, issues, pull requests, releases, and workflows using the `gh` CLI tool.

## When to Use This Skill

- User says "check GitHub issues", "open a pull request", or "create a repo"
- User wants to clone, fork, or create a repository
- User wants to review PRs, manage labels, or check CI status
- User sends a GitHub URL (repo, issue, PR, or file link)
- User asks to explore an external repository's code

## How to Run Commands

Run `gh` and `git` commands directly via the available Bash-style command runner. Never tell the user to run commands themselves — run them yourself.

## Authentication

```bash
gh auth status                        # Check current auth
gh auth login                         # Interactive login
gh auth token                         # Print current token
```

If any `gh` command returns 401 or permission errors, run `gh auth status` first.

## Repository Management

### Create / Clone / Fork
```bash
gh repo create my-project --public    # Create new repo
gh repo create my-project --private --clone  # Create + clone locally
gh repo clone owner/repo              # Clone existing repo
gh repo clone owner/repo /tmp/repo    # Clone to specific path
gh repo fork owner/repo               # Fork a repo
gh repo fork owner/repo --clone       # Fork + clone locally
```

### View and List
```bash
gh repo list                          # List your repos
gh repo list --limit 50 --json name,description  # JSON output
gh repo view owner/repo               # View repo details
gh repo view owner/repo --web         # Open in browser
gh repo view owner/repo --json name,description,stargazerCount,defaultBranchRef
```

### Repo Settings
```bash
gh repo edit owner/repo --description "New desc"
gh repo edit owner/repo --visibility public
gh repo delete owner/repo --yes       # DESTRUCTIVE — confirm first
```

## Exploring Files (no clone needed)

### Browse in Browser
```bash
gh browse --repo owner/repo           # Open repo
gh browse --repo owner/repo path/to/file.py  # Open file
gh browse main.go:312                 # Open at line number
gh browse --repo owner/repo --issues  # Open issues tab
gh browse --repo owner/repo --pulls   # Open PRs tab
gh browse --repo owner/repo --releases # Open releases tab
gh browse -n path/to/file.py          # Print URL only (don't open)
```

### Read Files via API (no clone)
```bash
# List root directory
gh api repos/OWNER/REPO/contents/ --jq '.[] | .name'

# List subdirectory
gh api repos/OWNER/REPO/contents/path/to/dir --jq '.[] | .name'

# List ALL files (recursive tree)
gh api repos/OWNER/REPO/git/trees/main?recursive=true \
  --jq '.tree[] | .path'

# Filter by extension
gh api repos/OWNER/REPO/git/trees/main?recursive=true \
  --jq '.tree[] | select(.path | endswith(".py")) | .path'

# Read a file (base64-decoded)
gh api repos/OWNER/REPO/contents/path/to/file.py \
  --jq '.content' | base64 -d

# Read README
gh api repos/OWNER/REPO/readme --jq .content | base64 -d
```

### Search Code
```bash
# Search for keyword in a repo
gh api 'search/code?q=keyword+repo:owner/repo' --jq '.items[].path'

# Search with language filter
gh api 'search/code?q=keyword+repo:owner/repo+language:python' --jq '.items[] | "\(.path):\(.text_matches[0].fragment)"'

# Search across all repos
gh search repos "topic" --language python --sort stars
```

### Clone for Deep Exploration
```bash
gh repo clone owner/repo /tmp/repo-name
# Then use local tools (glob, grep, read_file) on /tmp/repo-name/
```

## Issues

```bash
gh issue list --repo owner/repo                # List open issues
gh issue list --repo owner/repo --state all     # Include closed
gh issue list --repo owner/repo --label bug     # Filter by label
gh issue view 42 --repo owner/repo              # View issue
gh issue view 42 --repo owner/repo --comments   # With comments

gh issue create --title "Bug: ..." --body "Description"
gh issue create --title "..." --body "..." --label bug --assignee @me

gh issue close 42 --repo owner/repo
gh issue reopen 42 --repo owner/repo
gh issue edit 42 --add-label bug --add-assignee user
gh issue comment 42 --body "Comment text"
```

## Pull Requests

```bash
gh pr list --repo owner/repo                   # List open PRs
gh pr list --repo owner/repo --state merged     # Merged PRs
gh pr view 7 --repo owner/repo                 # View PR
gh pr view 7 --repo owner/repo --comments      # With comments
gh pr diff 7 --repo owner/repo                 # View diff
gh pr checks 7 --repo owner/repo              # View CI checks

gh pr create --title "feat: ..." --body "Summary" --base main
gh pr create --fill                            # Auto-fill from commits

gh pr merge 7 --squash                         # Squash merge
gh pr merge 7 --rebase                         # Rebase merge
gh pr review 7 --approve                       # Approve
gh pr review 7 --comment --body "Looks good"   # Comment review

# View PR comments (full thread)
gh api repos/owner/repo/pulls/7/comments --jq '.[] | "\(.user.login): \(.body)"'
```

## Releases

```bash
gh release list --repo owner/repo              # List releases
gh release view v1.0.0 --repo owner/repo       # View release
gh release view --latest --repo owner/repo     # Latest release

gh release create v1.0.0 --title "v1.0.0" --notes "Release notes"
gh release create v1.0.0 --generate-notes      # Auto-generate from commits
gh release create v1.0.0 ./dist/*.tar.gz       # Upload assets

gh release download v1.0.0 --repo owner/repo   # Download assets
gh release delete v1.0.0 --repo owner/repo --yes
```

## CI and Workflows

```bash
gh run list --repo owner/repo                  # List recent runs
gh run view <run-id>                           # View run details
gh run view <run-id> --log                     # View full logs
gh run watch <run-id>                          # Watch live
gh run rerun <run-id>                          # Re-run failed

gh workflow list --repo owner/repo             # List workflows
gh workflow run deploy.yml --repo owner/repo   # Trigger workflow
```

## Labels and Milestones

```bash
gh label list --repo owner/repo
gh label create "priority:high" --color FF0000
gh issue edit 42 --add-label bug
gh pr edit 7 --milestone "v1.0"
```

## Notifications and Starring

```bash
gh api notifications --jq '.[].subject.title'  # Check notifications
gh repo star owner/repo                         # Star a repo
```

## Branch and Commit Workflow

```bash
git checkout -b feature/my-branch     # Create branch
# ... make changes ...
git add -A && git commit -m "feat: description"
git push -u origin feature/my-branch
gh pr create                          # Open PR from current branch
```

## Workflow

1. Determine what the user wants (view/create/update/explore)
2. Identify the repository (owner/repo) — check context if not specified
3. Run the appropriate `gh` command directly
4. Present output clearly — summarize large results
5. Chain follow-up actions when natural (e.g., clone → explore → create issue)

## Guidelines

- Always check `gh auth status` on 401 or permission errors
- Use `--repo owner/repo` when not inside the target repository
- Prefer `gh pr create` over manual git push workflows
- Use `gh api` for operations not covered by top-level commands
- For large repos, use API tree listing before cloning
- Never force-push to main/master without explicit user confirmation
- Use `--json` flag for machine-readable output when processing results
- Run all `gh` and `git` commands yourself — never tell the user to run them manually
- When user sends a GitHub URL, extract owner/repo and use `gh` commands — never say "I can't access that"
