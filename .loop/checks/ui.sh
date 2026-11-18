#!/bin/bash
# B12/D5+D7: the live UI must not fight the operator. The detail view
# re-renders only when the session's visible state changes (a 2s poll
# must not destroy scroll, focus, or an error being read), action
# errors live outside the re-rendered DOM, and session rows are
# keyboard-operable. (Served-page assertions, like theme.sh: this
# environment has no browser to execute the page.)
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

echo "$page" | grep -q 'lastDetailKey' || { echo "FAIL: detail view has no change-signature — every poll rebuilds it"; exit 1; }
echo "$page" | grep -q 'scrollTop = prevScroll' || { echo "FAIL: detail re-render does not restore scroll position"; exit 1; }
echo "$page" | grep -q 'detailError' || { echo "FAIL: action errors are not kept outside the re-rendered DOM"; exit 1; }
echo "$page" | grep -q 'tabindex' || { echo "FAIL: session rows are not focusable"; exit 1; }
echo "$page" | grep -q 'onkeydown' || { echo "FAIL: session rows have no keyboard activation"; exit 1; }
echo "$page" | grep -q 'lastListKey' || { echo "FAIL: session list rebuilds unconditionally, dropping row focus"; exit 1; }
echo "$page" | grep -q 'lastInboxKey' || { echo "FAIL: the inbox rebuilds unconditionally, dropping button focus (the B12 discipline never reached it)"; exit 1; }
echo "$page" | grep -q 'inboxError' || { echo "FAIL: inbox retry failures are swallowed instead of shown"; exit 1; }
echo "$page" | grep -q 'slice(-80)' || { echo "FAIL: the detail signature keys on lengths only — a capped live transcript would never re-render"; exit 1; }

echo "UI OK: detail renders on change only with scroll/focus restored, errors persist across renders, rows are keyboard-operable, the inbox is gated and surfaces its errors"
