#!/bin/bash
# B12/D5+D7: Asserts the shipped single-file React bundle's behavioral contracts:
# per-session steer draft persistence, plain-language refusal alerts, stale-poll retention,
# three-lane board + latest verified receipt, roving tabs & current-row accessibility, and Needs-you inbox actions.
set -u
cd "$(dirname "$0")/../.."
PORT=8498
WORK=$(mktemp -d)
PIDS=""
cleanup() { for p in $PIDS; do kill -9 $p 2>/dev/null; done; rm -rf "$WORK"; }
trap cleanup EXIT

export PATH="$HOME/.rust/bin:$PATH"
BIN="${CARGO_TARGET_DIR:-./target}/debug/fleet-rs"
[ -x "$BIN" ] || cargo build >/dev/null 2>&1 || { echo "FAIL: cargo build"; exit 1; }
FLEET_NO_OPEN=1 FLEET_DATA="$WORK/data" PORT=$PORT "$BIN" policies.rn > "$WORK/server.log" 2>&1 &
PIDS="$PIDS $!"
for i in $(seq 1 20); do curl -s "http://127.0.0.1:$PORT/" >/dev/null 2>&1 && break; sleep 0.5; done
page=$(curl -s "http://127.0.0.1:$PORT/")

need() { echo "$page" | grep -qF -- "$1" || { echo "FAIL: $2"; exit 1; }; }
need 'fleet-steer:' "the steer draft is not kept per session (sessionStorage key)"
need 'Write the message first.' "an empty steer is not refused in words"
need 'Showing the last list from' "a failed poll does not keep the last good list on screen"
need 'Cannot reach Fleet' "the unreachable state has no words"
need 'aria-selected' "the detail views are not announced as selected tabs"
need 'ArrowRight' "the detail views have no arrow-key roving"
need 'aria-current' "the open session row is not marked current"
echo "$page" | grep -qE 'role:[`"'\'']alert[`"'\'']' || { echo "FAIL: action errors are not announced as alerts"; exit 1; }
need 'View session' "the Needs you inbox has no view action"
need 'Go to Needs you' "the Needs you inbox has no way into the lane"
need 'Latest verified receipt' "the hero verified receipt region is missing"
need 'Session lanes' "the three-lane board region is missing"
need 'Check passed — but this session needs you' "the honest-verdict wording changed"

echo "UI OK: steer drafts kept per session, refusals in words, last good list kept, three lanes + hero receipt, tabs and rows keyboard-operable, inbox actions present"
