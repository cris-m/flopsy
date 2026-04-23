#!/bin/bash
# system.sh - Get system health stats (cross-platform)

set -euo pipefail

OS="$(uname -s)"

get_uptime() {
    if [[ "$OS" == "Darwin" ]]; then
        uptime | awk -F'up ' '{print $2}' | awk -F',' '{print $1}' | xargs
    else
        uptime -p 2>/dev/null || uptime | awk -F'up ' '{print $2}' | awk -F',' '{print $1}'
    fi
}

get_load() {
    if [[ "$OS" == "Darwin" ]]; then
        sysctl -n vm.loadavg | awk '{print $2, $3, $4}'
    else
        cat /proc/loadavg | awk '{print $1, $2, $3}'
    fi
}

get_cpu_usage() {
    if [[ "$OS" == "Darwin" ]]; then
        top -l 1 -n 0 2>/dev/null | grep "CPU usage" | awk '{print $3}' | tr -d '%'
    else
        top -bn1 | grep "Cpu(s)" | awk '{print $2}' | tr -d '%'
    fi
}

get_memory() {
    if [[ "$OS" == "Darwin" ]]; then
        top -l 1 -n 0 2>/dev/null | grep PhysMem | awk '{
            used=$2; unused=$8
            # Convert to MB
            if (index(used, "G")) { gsub(/G/, "", used); used = used * 1024 }
            else { gsub(/M/, "", used) }
            if (index(unused, "G")) { gsub(/G/, "", unused); unused = unused * 1024 }
            else { gsub(/M/, "", unused) }
            total = used + unused
            pct = int(used * 100 / total)
            if (total > 1024) {
                printf "%.1fG/%.1fG (%d%%)", used/1024, total/1024, pct
            } else {
                printf "%dM/%dM (%d%%)", used, total, pct
            }
        }'
    else
        free -m | awk 'NR==2{printf "%dM/%dM (%d%%)", $3, $2, $3*100/$2}'
    fi
}

get_disk() {
    df -h / | tail -1 | awk '{print $3"/"$2" ("$5")"}'
}

get_cpu_cores() {
    if [[ "$OS" == "Darwin" ]]; then
        sysctl -n hw.ncpu
    else
        nproc
    fi
}

get_swap() {
    if [[ "$OS" == "Darwin" ]]; then
        sysctl -n vm.swapusage 2>/dev/null | awk '{
            gsub(/M/, "", $3); gsub(/M/, "", $6); gsub(/M/, "", $9)
            printf "%.0fM/%.0fM (free: %.0fM)", $6+0, $3+0, $9+0
        }' 2>/dev/null || echo "N/A"
    else
        free -m | awk 'NR==3{if($2>0) printf "%dM/%dM (%d%%)", $3, $2, $3*100/$2; else print "0M/0M (0%)"}'
    fi
}

get_network() {
    # Quick connectivity check — ping + DNS
    local ping_ok="false"
    local dns_ok="false"
    local latency="N/A"

    if ping -c 1 -W 3 1.1.1.1 >/dev/null 2>&1; then
        ping_ok="true"
        latency=$(ping -c 1 -W 3 1.1.1.1 2>/dev/null | grep 'time=' | sed 's/.*time=\([^ ]*\).*/\1/')
    fi

    if host -W 3 api.anthropic.com >/dev/null 2>&1; then
        dns_ok="true"
    fi

    echo "ping=$ping_ok dns=$dns_ok latency=${latency}ms"
}

get_battery() {
    if [[ "$OS" == "Darwin" ]]; then
        pmset -g batt 2>/dev/null | grep -o '[0-9]*%' | head -1 || echo "N/A"
    elif [[ -f /sys/class/power_supply/BAT0/capacity ]]; then
        echo "$(cat /sys/class/power_supply/BAT0/capacity)%"
    else
        echo "N/A"
    fi
}

get_top_disk_dirs() {
    # Top 5 biggest dirs in home (1 level deep, skip hidden except .flopsy)
    du -sh ~/*/  ~/.flopsy/ 2>/dev/null | sort -rh | head -5
}

# Output
echo "os=$OS"
echo "uptime=$(get_uptime)"
echo "load=$(get_load)"
echo "cpu_usage=$(get_cpu_usage)%"
echo "cpu_cores=$(get_cpu_cores)"
echo "memory=$(get_memory)"
echo "swap=$(get_swap)"
echo "disk=$(get_disk)"
echo "network=$(get_network)"
echo "battery=$(get_battery)"
echo "---top_disk---"
get_top_disk_dirs
