#!/bin/bash
# C13: steer and stop are real.
# STEER: a message posted while a session works is delivered as a
# continuation run BEFORE commit+check — the fixture records both
# invocations in order, the final tree reflects the steering, the
# session still reaches verified done, and the transcript shows the
# operator's message.
# STOP: a stop posted while a session works kills the run within
# seconds (the agent's own sleep is 60s) and lands the session
# needs-you with "stopped by you" as the reason; the agent process is
# gone. Refusals: stop on a settled session, steer on a merged one.
set -u
cd "$(dirname "$0")/../.."
PORT=8513
WORK=$(mktemp -d)
PIDS=""
cleanup() { for p in $PIDS; do kill -9 $p 2>/dev/null; done; rm -rf "$WORK"; }
trap cleanup EXIT

[ -x ./target/debug/fleet-rs ] || cargo build >/dev/null 2>&1

git init -q -b main "$WORK/repo"
echo "seed" > "$WORK/repo/README.md"
git -C "$WORK/repo" add -A
git -C "$WORK/repo" -c user.email=p@p -c user.name=proof commit -qm init

# Steering fixture: first invocation sleeps (so the steer lands
# mid-run), then writes output.txt from its prompt; a continuation
# appends its prompt. Every invocation is recorded in order.
cat > "$WORK/agent.sh" <<'EOF'
#!/bin/bash
echo "CALL: $1" >> "$CALLS_LOG"
if [ -f output.txt ]; then
  printf 'steered: %s\n' "$1" >> output.txt
else
  sleep 3
  printf 'result of: %s\n' "$1" > output.txt
fi
EOF
chmod +x "$WORK/agent.sh"

# Stop fixture: announces itself, then sleeps far past the probe.
cat > "$WORK/sleeper.sh" <<'EOF'
#!/bin/bash
echo "sleeper started pid $$"
sleep 60
printf 'result of: %s\n' "$1" > output.txt
EOF
chmod +x "$WORK/sleeper.sh"

export CALLS_LOG="$WORK/calls.log"
FLEET_DATA="$WORK/data" PORT=$PORT ./target/debug/fleet-rs policies.rn > "$WORK/server.log" 2>&1 &
PIDS="$PIDS $!"
api() { curl -s "http://127.0.0.1:$PORT$1"; }
post() { curl -s -w "\n%{http_code}" -X POST "http://127.0.0.1:$PORT$1" -H 'Content-Type: application/json' -d "$2"; }
for i in $(seq 1 20); do api /api/sessions >/dev/null 2>&1 && break; sleep 0.5; done

# --- STEER ---
resp=$(post /api/sessions "{\"repo\":\"$WORK/repo\",\"project\":\"fixture\",\"task\":\"first draft\",\"agent\":\"$WORK/agent.sh\"}")
ID=$(echo "$resp" | sed '$d' | jq -r '.id')
# Wait until it is working, then steer it mid-run.
for i in $(seq 1 20); do
  st=$(api "/api/sessions/$ID" | jq -r '.status')
  [ "$st" = "working" ] && break
  sleep 0.25
done
[ "$st" = "working" ] || { echo "FAIL: session never reached working (got '$st')"; exit 1; }
resp=$(post "/api/sessions/$ID/steer" '{"message":"make it shorter"}')
code=$(echo "$resp" | tail -1)
[ "$code" = "200" ] || { echo "FAIL: steer returned $code: $resp"; exit 1; }
for i in $(seq 1 60); do
  st=$(api "/api/sessions/$ID" | jq -r '.status')
  [ "$st" = "done" ] && break
  sleep 0.5
done
[ "$st" = "done" ] || { echo "FAIL: steered session reached '$st', expected done"; api "/api/sessions/$ID" | jq '{status, reason}'; exit 1; }
grep -qx "CALL: first draft" "$CALLS_LOG" || { echo "FAIL: initial invocation not recorded"; cat "$CALLS_LOG"; exit 1; }
grep -qx "CALL: make it shorter" "$CALLS_LOG" || { echo "FAIL: continuation invocation not recorded"; cat "$CALLS_LOG"; exit 1; }
[ "$(grep -c '^CALL:' "$CALLS_LOG")" = "2" ] || { echo "FAIL: expected exactly 2 invocations"; cat "$CALLS_LOG"; exit 1; }
diff=$(api "/api/sessions/$ID" | jq -r '.diff')
echo "$diff" | grep -q "steered: make it shorter" \
  || { echo "FAIL: final diff does not reflect the steering"; echo "$diff"; exit 1; }
tr=$(api "/api/sessions/$ID" | jq -r '.transcript | join("\n")')
echo "$tr" | grep -q "you: make it shorter" \
  || { echo "FAIL: transcript does not show the operator's steering message"; exit 1; }

# --- STOP ---
resp=$(post /api/sessions "{\"repo\":\"$WORK/repo\",\"project\":\"fixture\",\"task\":\"long job\",\"agent\":\"$WORK/sleeper.sh\"}")
ID2=$(echo "$resp" | sed '$d' | jq -r '.id')
for i in $(seq 1 20); do
  st=$(api "/api/sessions/$ID2" | jq -r '.status')
  [ "$st" = "working" ] && break
  sleep 0.25
done
[ "$st" = "working" ] || { echo "FAIL: sleeper session never reached working (got '$st')"; exit 1; }
sleep 1  # let the sleeper announce itself and settle into its sleep
resp=$(post "/api/sessions/$ID2/stop" '{}')
code=$(echo "$resp" | tail -1)
[ "$code" = "200" ] || { echo "FAIL: stop returned $code: $resp"; exit 1; }
t0=$(date +%s)
for i in $(seq 1 40); do
  st=$(api "/api/sessions/$ID2" | jq -r '.status')
  [ "$st" = "needs-you" ] && break
  sleep 0.5
done
t1=$(date +%s)
[ "$st" = "needs-you" ] || { echo "FAIL: stopped session reached '$st', expected needs-you"; exit 1; }
[ $((t1 - t0)) -lt 20 ] || { echo "FAIL: stop took $((t1 - t0))s — the run was not killed, it wound down"; exit 1; }
reason=$(api "/api/sessions/$ID2" | jq -r '.reason')
echo "$reason" | grep -qi "stopped by you" \
  || { echo "FAIL: stop reason is '$reason', expected it to name the operator's stop"; exit 1; }
# The sleeper process itself must be gone, not merely disowned.
if pgrep -f "sleeper.sh" >/dev/null 2>&1; then
  echo "FAIL: sleeper process still alive after stop"; pgrep -af "sleeper.sh"; exit 1
fi

# --- REFUSALS ---
resp=$(post "/api/sessions/$ID/stop" '{}')
code=$(echo "$resp" | tail -1)
[ "$code" = "409" ] || { echo "FAIL: stop on a done session returned $code, expected 409"; exit 1; }
# Merge the done session, then steering it must be refused.
resp=$(post "/api/sessions/$ID/merge" '{}')
code=$(echo "$resp" | tail -1)
[ "$code" = "200" ] || { echo "FAIL: merge of steered session returned $code: $resp"; exit 1; }
resp=$(post "/api/sessions/$ID/steer" '{"message":"too late"}')
code=$(echo "$resp" | tail -1)
[ "$code" = "409" ] || { echo "FAIL: steer on a merged session returned $code, expected 409"; exit 1; }
resp=$(post "/api/sessions/nope-not-a-session/steer" '{"message":"x"}')
code=$(echo "$resp" | tail -1)
[ "$code" = "404" ] || { echo "FAIL: steer on a missing session returned $code, expected 404"; exit 1; }

echo "STEER/STOP OK: continuation delivered before the check, stop kills the run and names itself, refusals hold"
