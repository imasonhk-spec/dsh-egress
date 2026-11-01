#!/bin/bash
# dsh-exitnode-watchdog: 保证 8.6 出网始终可用
# exit node 可用性用"真实出网探测"(gstatic 204) 判定：
#   连续 2 次失败 -> tailscale set --exit-node= (回落物理直连)
# 已摘除状态下: tailscale ping 目标连续 2 次成功 -> 自动重新挂上
TARGET=100.100.82.8
SFAIL=/run/dsh-exitnode-watchdog.fail
SOK=/run/dsh-exitnode-watchdog.ok
log(){ logger -t dsh-exitnode-watchdog "$1"; }

cur=$(/usr/bin/tailscale debug prefs 2>/dev/null | /usr/bin/grep -o '"ExitNodeID": "[^"]*"' | /usr/bin/sed 's/.*: "//;s/"$//')

if [ -n "$cur" ]; then
    rm -f "$SOK"
    if /usr/bin/curl -m 6 -fsS -o /dev/null https://www.gstatic.com/generate_204 2>/dev/null; then
        rm -f "$SFAIL"
    else
        n=$(( $(cat "$SFAIL" 2>/dev/null || echo 0) + 1 ))
        echo "$n" > "$SFAIL"
        log "egress probe failed ($n/2), ExitNodeID=$cur"
        if [ "$n" -ge 2 ]; then
            log "exit node unreachable twice -> clearing exit node (fallback to direct)"
            /usr/bin/tailscale set --exit-node= && rm -f "$SFAIL"
        fi
    fi
else
    rm -f "$SFAIL"
    if /usr/bin/tailscale ping -c 1 --timeout 3s "$TARGET" 2>/dev/null | /usr/bin/grep -q pong; then
        n=$(( $(cat "$SOK" 2>/dev/null || echo 0) + 1 ))
        echo "$n" > "$SOK"
        if [ "$n" -ge 2 ]; then
            log "exit node $TARGET reachable twice -> re-enabling"
            /usr/bin/tailscale set --exit-node="$TARGET" --exit-node-allow-lan-access=true && rm -f "$SOK"
        fi
    else
        rm -f "$SOK"
    fi
fi
