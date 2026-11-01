#!/bin/bash
# dsh-egress-route.sh <dest/cidr> <priority>
#
# Force <dest> out via the CURRENT primary default route (normally Wi-Fi),
# resolved dynamically at call time. This way a Wi-Fi IP / gateway / interface
# change needs NO config edit — just re-run this (or let the NM dispatcher do it).
#
# Keeps the original semantic (pin src to the egress iface's own IP) but derives
# gw / dev / src from `ip route` instead of hardcoding them.
set -euo pipefail

DEST="${1:?usage: dsh-egress-route.sh <dest/cidr> <priority>}"
PRIO="${2:?usage: dsh-egress-route.sh <dest/cidr> <priority>}"

# primary default route = lowest metric
LINE="$(ip -4 route show default | awk '{m=99999; for(i=1;i<=NF;i++) if($i=="metric") m=$(i+1); print m, $0}' | sort -n | head -1 | cut -d' ' -f2-)"
[ -n "$LINE" ] || { echo "dsh-egress: no default route, skip $DEST"; exit 0; }

GW="$(echo "$LINE" | awk '{for(i=1;i<=NF;i++) if($i=="via"){print $(i+1); exit}}')"
DEV="$(echo "$LINE" | awk '{for(i=1;i<=NF;i++) if($i=="dev"){print $(i+1); exit}}')"
[ -n "$GW" ] && [ -n "$DEV" ] || { echo "dsh-egress: cannot parse gw/dev from: $LINE"; exit 1; }

# dynamic source IP = primary IPv4 of the egress iface (faithful to original `src`)
SRC="$(ip -4 addr show "$DEV" 2>/dev/null | awk '/inet /{print $2; exit}' | cut -d/ -f1)"
SRCARG=""; [ -n "$SRC" ] && SRCARG="src $SRC"

BASE="${DEST%/*}"
# replace updates the existing /32 host route in-place (no stale leftovers)
ip route replace "$DEST" via "$GW" dev "$DEV" $SRCARG
if ! ip rule show | grep -q "^$PRIO:.*to $BASE "; then
    ip rule add priority "$PRIO" to "$BASE" lookup main
fi
echo "dsh-egress: $DEST -> via $GW dev $DEV src ${SRC:-auto} (prio $PRIO)"
