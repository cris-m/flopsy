#!/usr/bin/env bash
# shell-boot-log handler — context arrives on stdin as JSON (no trailing newline).
# Appends it to logs/boot.jsonl under FLOPSY_HOME. 30s wall-clock budget.
set -euo pipefail
# Read ALL of stdin — `read -r` returns non-zero at EOF without a trailing
# newline, which under `set -e` would kill the script before it writes.
ctx="$(cat)"
home="${FLOPSY_HOME:-$HOME/.flopsy}"
mkdir -p "${home}/logs"
printf '%s\n' "$ctx" >> "${home}/logs/boot.jsonl"
