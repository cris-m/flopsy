#!/bin/bash
# process.sh - Monitor a process by name or PID (cross-platform)

set -euo pipefail

usage() {
    cat <<EOF
process.sh - Monitor a process by name or PID

Usage:
  $0 name <process_name>   Monitor process by name
  $0 pid <pid>             Monitor process by PID
  $0 port <port>           Monitor process by port
  $0 self                  Monitor Flopsy (port 18789)

Examples:
  $0 name nginx
  $0 pid 1234
  $0 port 8080
  $0 self
EOF
    exit 1
}

CHECK_TYPE="${1:-}"
TARGET="${2:-}"

[[ -z "$CHECK_TYPE" ]] && usage

OS="$(uname -s)"

get_process_stats() {
    local pid=$1
    if [[ "$OS" == "Darwin" ]]; then
        ps -p "$pid" -o pid=,%cpu=,%mem=,rss=,etime=,comm= 2>/dev/null
    else
        ps -p "$pid" -o pid=,%cpu=,%mem=,rss=,etime=,comm= 2>/dev/null
    fi
}

format_output() {
    local pid=$1 cpu=$2 mem=$3 rss=$4 etime=$5 cmd=$6
    local rss_mb=$((rss / 1024))
    echo "status=running"
    echo "pid=$pid"
    echo "cpu=${cpu}%"
    echo "mem=${mem}%"
    echo "rss=${rss_mb}MB"
    echo "uptime=$etime"
    echo "command=$cmd"
}

case "$CHECK_TYPE" in
    name)
        [[ -z "$TARGET" ]] && usage

        PIDS=$(pgrep -f "$TARGET" 2>/dev/null || true)

        if [[ -z "$PIDS" ]]; then
            echo "status=not_running"
            echo "name=$TARGET"
            exit 2
        fi

        echo "name=$TARGET"
        echo "count=$(echo "$PIDS" | wc -l | xargs)"

        for pid in $PIDS; do
            stats=$(get_process_stats "$pid" || true)
            if [[ -n "$stats" ]]; then
                read -r p_pid p_cpu p_mem p_rss p_etime p_cmd <<< "$stats"
                echo "---"
                format_output "$p_pid" "$p_cpu" "$p_mem" "$p_rss" "$p_etime" "$p_cmd"
            fi
        done
        ;;

    pid)
        [[ -z "$TARGET" ]] && usage

        if ! ps -p "$TARGET" > /dev/null 2>&1; then
            echo "status=not_running"
            echo "pid=$TARGET"
            exit 2
        fi

        stats=$(get_process_stats "$TARGET")
        read -r p_pid p_cpu p_mem p_rss p_etime p_cmd <<< "$stats"
        format_output "$p_pid" "$p_cpu" "$p_mem" "$p_rss" "$p_etime" "$p_cmd"
        ;;

    port)
        [[ -z "$TARGET" ]] && usage

        if [[ "$OS" == "Darwin" ]]; then
            PID=$(lsof -i :"$TARGET" -t 2>/dev/null | head -1 || true)
        else
            PID=$(lsof -i :"$TARGET" -t 2>/dev/null | head -1 || ss -tlnp "sport = :$TARGET" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1 || true)
        fi

        if [[ -z "$PID" ]]; then
            echo "status=not_listening"
            echo "port=$TARGET"
            exit 2
        fi

        echo "port=$TARGET"
        stats=$(get_process_stats "$PID")
        read -r p_pid p_cpu p_mem p_rss p_etime p_cmd <<< "$stats"
        format_output "$p_pid" "$p_cpu" "$p_mem" "$p_rss" "$p_etime" "$p_cmd"
        ;;

    self)
        GATEWAY_PORT="${GATEWAY_PORT:-18789}"

        if [[ "$OS" == "Darwin" ]]; then
            PID=$(lsof -i :"$GATEWAY_PORT" -t 2>/dev/null | head -1 || true)
        else
            PID=$(lsof -i :"$GATEWAY_PORT" -t 2>/dev/null | head -1 || true)
        fi

        if [[ -z "$PID" ]]; then
            echo "status=not_running"
            echo "service=flopsybot"
            echo "port=$GATEWAY_PORT"
            exit 2
        fi

        echo "service=flopsybot"
        echo "port=$GATEWAY_PORT"
        stats=$(get_process_stats "$PID")
        read -r p_pid p_cpu p_mem p_rss p_etime p_cmd <<< "$stats"
        format_output "$p_pid" "$p_cpu" "$p_mem" "$p_rss" "$p_etime" "$p_cmd"
        ;;

    *)
        echo "error=unknown_check_type"
        echo "check_type=$CHECK_TYPE"
        usage
        ;;
esac
