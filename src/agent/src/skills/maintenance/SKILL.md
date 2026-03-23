---
name: maintenance
compatibility: Designed for FlopsyBot agent
description: System maintenance and health monitoring for FlopsyBot. Use when the user wants to check system status, diagnose issues, or perform routine maintenance tasks.
---

# Maintenance

Monitor and maintain the health of the FlopsyBot system, including processes, resources, and service availability.

## When to Use This Skill

- User says "how is the system doing?" or "check system health"
- A service seems unresponsive and needs to be diagnosed
- Routine maintenance is due (log cleanup, session checks, etc.)
- A heartbeat or scheduler triggers a system health check

## How to Run Commands

**Always use the `execute` tool to run commands.** Pass the command string as the `command` parameter. Never tell the user to run commands themselves — you have the `execute` tool.

## Diagnostic Scripts

Two helper scripts live in `scripts/` alongside this skill.

### system.sh — System-Level Health

Collects OS-level metrics. Run with execute tool:

    execute(command: "bash /skills/maintenance/scripts/system.sh")

Output fields:
- `os` — Operating system
- `uptime` — System uptime
- `load` — 1, 5, 15-minute load averages
- `cpu_usage` — Current CPU usage percentage
- `cpu_cores` — Number of CPU cores
- `memory` — Used/total memory with percentage
- `swap` — Swap usage (used/total, free)
- `disk` — Disk usage on root volume
- `network` — Connectivity check: `ping=true/false dns=true/false latency=Xms`
- `battery` — Battery percentage (laptops) or `N/A`
- `---top_disk---` — Section header, followed by top 5 biggest directories in home

### process.sh — Process Monitoring

Monitor specific processes by name, PID, or port. Run with execute tool:

    execute(command: "bash /skills/maintenance/scripts/process.sh name nginx")   # By name
    execute(command: "bash /skills/maintenance/scripts/process.sh pid 1234")     # By PID
    execute(command: "bash /skills/maintenance/scripts/process.sh port 8080")    # By port
    execute(command: "bash /skills/maintenance/scripts/process.sh self")         # FlopsyBot

Output fields:
- `status` — `running` or `not_running`
- `pid` — Process ID
- `cpu` — CPU usage percentage
- `mem` — Memory usage percentage
- `rss` — Resident set size in MB
- `uptime` — How long the process has been running
- `command` — The command that started the process

## Health Check Workflow

### Quick Health Check
1. Use the `execute` tool: `bash /skills/maintenance/scripts/system.sh`
2. Use the `execute` tool: `bash /skills/maintenance/scripts/process.sh self`
3. Report any anomalies (high CPU, low memory, process not running)

### Full Diagnostic
1. Run the quick health check above
2. Check log files for recent errors
3. Verify key services are reachable (e.g., can Gmail tools respond? Is Spotify connected?)
4. Check session files for expiration: `.flopsy/sessions/`
5. Report findings with recommended actions

### Routine Maintenance
- Periodically clean up old log files
- Check for and rotate large files in `.flopsy/`
- Verify OAuth tokens are not close to expiration
- Confirm heartbeat states are being updated (not stale)

## Alert Thresholds

| Metric | Warning | Critical |
|--------|---------|----------|
| CPU usage | 70% | 90% |
| Memory usage | 80% | 95% |
| Swap usage | Any swap in use | >50% swap used |
| Disk usage | 75% | 90% |
| Network (ping) | — | `ping=false` (no internet) |
| Network (DNS) | — | `dns=false` (DNS resolution broken) |
| Network (latency) | >200ms | >500ms |
| Battery | <20% | <10% |
| FlopsyBot process | Not running | Not running for 5+ minutes |

## Guidelines

- Use the `execute` tool for all commands — never tell the user to run them manually
- Run `process.sh self` first when diagnosing any issue; if the main process is down, that is the root cause
- Resource metrics are snapshots; run them multiple times to distinguish spikes from sustained issues
- Do not restart services without confirming with the user unless an automated recovery policy is in place
- Log the results of health checks so that trends can be identified over time
