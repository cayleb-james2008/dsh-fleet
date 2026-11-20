#!/bin/bash
# B12/D5+D7, rewritten in round 2 (see the commit message for the reason). The vanilla page's raw JavaScript names
# (lastDetailKey, scrollTop = prevScroll, detailError, lastListKey, lastInboxKey, slice(-80)) do not exist in the React
# build, so they cannot be pinned. Their intent is asserted on the shipped page as string literals that survive the
# bundle's minifier: the steer draft is kept per session, a refused action is announced and not swallowed, session rows
# and detail views are keyboard-operable, and a failed poll keeps the last good list on screen.
# (Static assertions: this environment has no browser run in the check kit.)
set -u
cd "$(dirname "$0")/../.."
PORT=8498
WORK=$(mktemp -d)
PIDS=""
cleanup() { for p in $PIDS; do kill -9 $p 2>/dev/null; done; rm -rf "$WORK"; }
trap cleanup EXIT

export PATH="$HOME/.rust/bin:$PATH"
cargo build >/dev/null 2>&1 || { echo "FAIL: cargo build"; exit 1; }
FLEET_DATA="$WORK/data" PORT=$PORT ./target/debug/fleet-rs policies.rn > "$WORK/server.log" 2>&1 &
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
need 'role:`alert`' "action errors are not announced as alerts"
need 'View session' "the Needs you inbox has no view action"
need 'Go to Needs you' "the Needs you inbox has no way into the lane"
need 'Check passed — but this session needs you' "the honest-verdict wording changed"

echo "UI OK: steer drafts kept per session, refusals in words, last good list kept, tabs and rows keyboard-operable, inbox actions present"
