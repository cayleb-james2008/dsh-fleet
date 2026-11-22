#!/bin/bash
# C15: the settle boundary holds under the thermonuclear review's
# three reproduced shapes.
# F1 FAIRNESS: a successor fired at a verified-done settle joins the
# queue in hand-out order — a session queued EARLIER gets the freed
# slot first; the chain never jumps the queue.
# F2 STEER DURABILITY: steering is removed from the persisted queue
# only after the run that carries it. A kill -9 mid-delivery leaves
# the message queued across the restart, and the retry delivers it.
# N1 CHAIN RECOVERY: a done session whose successor never fired
# (server died in the settle-to-fire window) has its chain fired by
# startup recovery instead of stalling in silence.
set -u
cd "$(dirname "$0")/../.."
WORK=$(mktemp -d)
PIDS=""
cleanup() { for p in $PIDS; do kill -9 $p 2>/dev/null; done; rm -rf "$WORK"; }
trap cleanup EXIT

[ -x "${CARGO_TARGET_DIR:-./target}/debug/fleet" ] || cargo build >/dev/null 2>&1

git init -q -b main "$WORK/repo"
echo "seed" > "$WORK/repo/README.md"
git -C "$WORK/repo" add -A
git -C "$WORK/repo" -c user.email=p@p -c user.name=proof commit -qm init

cat > "$WORK/fast.sh" <<'EOF'
#!/bin/bash
printf 'result of: %s\n' "$1" > output.txt
EOF
cat > "$WORK/slow.sh" <<'EOF'
#!/bin/bash
sleep 20
printf 'result of: %s\n' "$1" > output.txt
EOF
# Medium agent for the parent: settles only after all three hand-outs
# are placed (a fast parent could legitimately fire its successor
# into an empty queue before C even exists).
cat > "$WORK/medium.sh" <<'EOF'
#!/bin/bash
sleep 4
printf 'result of: %s\n' "$1" > output.txt
EOF
# Steer fixture (steer_stop.sh pattern, slower continuation): first
# call sleeps briefly then writes; a continuation sleeps long enough
# to be killed mid-delivery, then appends.
cat > "$WORK/steeragent.sh" <<'EOF'
#!/bin/bash
echo "CALL: $1" >> "$CALLS_LOG"
if [ -f output.txt ]; then
  sleep 10
  printf 'steered: %s\n' "$1" >> output.txt
else
  sleep 3
  printf 'result of: %s\n' "$1" > output.txt
fi
EOF
chmod +x "$WORK/fast.sh" "$WORK/slow.sh" "$WORK/medium.sh" "$WORK/steeragent.sh"
export CALLS_LOG="$WORK/calls.log"

api() { curl -s "http://127.0.0.1:$1$2"; }
post() { curl -s -X POST "http://127.0.0.1:$1$2" -H 'Content-Type: application/json' -d "$3"; }
wait_up() { for i in $(seq 1 20); do api "$1" /api/sessions >/dev/null 2>&1 && break; sleep 0.5; done; }
status_of() { api "$1" "/api/sessions/$2" | jq -r '.status'; }
wait_status() { # port id want tries
  local st=""
  for i in $(seq 1 "${4:-60}"); do
    st=$(status_of "$1" "$2")
    [ "$st" = "$3" ] && { echo "$st"; return 0; }
    sleep 0.5
  done
  echo "$st"
}

# ================= F1: successor fairness under a contended cap ====
cat > "$WORK/pol2.rn" <<'RN'
pub fn max_parallel() { 2 }
pub fn timeout_secs() { 60 }
pub fn default_check(project) { "test -s output.txt" }
RN
PORT=8517
FLEET_DATA="$WORK/dataA" PORT=$PORT "${CARGO_TARGET_DIR:-./target}/debug/fleet" "$WORK/pol2.rn" > "$WORK/serverA.log" 2>&1 &
PIDS="$PIDS $!"
wait_up $PORT
A=$(post $PORT /api/sessions "{\"repo\":\"$WORK/repo\",\"project\":\"fixture\",\"task\":\"parent A\",\"agent\":\"$WORK/medium.sh\",\"next\":[\"child of A\"]}" | jq -r '.id')
B=$(post $PORT /api/sessions "{\"repo\":\"$WORK/repo\",\"project\":\"fixture\",\"task\":\"blocker B\",\"agent\":\"$WORK/slow.sh\"}" | jq -r '.id')
C=$(post $PORT /api/sessions "{\"repo\":\"$WORK/repo\",\"project\":\"fixture\",\"task\":\"queued third C\",\"agent\":\"$WORK/medium.sh\"}" | jq -r '.id')
[ "$(wait_status $PORT "$A" done 40)" = "done" ] || { echo "FAIL [F1]: parent A never settled done"; exit 1; }
# A's successor has now fired. The freed slot belongs to C (queued
# before the child existed). Judge from ONE snapshot, taken while C
# (a 4s agent) is mid-run and B (20s) still blocks the other slot:
# C must hold the freed slot and the child must still be queued.
snap=""
for i in $(seq 1 30); do
  snap=$(api $PORT /api/sessions)
  cst=$(echo "$snap" | jq -r --arg id "$C" '.[] | select(.id == $id) | .status')
  [ "$cst" != "queued" ] && [ -n "$cst" ] && break
  sleep 0.5
done
CHILD=$(echo "$snap" | jq -r '.[] | select(.spawned_from != null) | .id' | head -1)
[ -n "$CHILD" ] || { echo "FAIL [F1]: no successor session was created"; exit 1; }
chst=$(echo "$snap" | jq -r --arg id "$CHILD" '.[] | select(.id == $id) | .status')
bst=$(echo "$snap" | jq -r --arg id "$B" '.[] | select(.id == $id) | .status')
[ "$bst" = "working" ] || { echo "FAIL [F1]: premise broken — blocker B is '$bst', the cap was never contended"; exit 1; }
[ "$cst" = "working" ] || { echo "FAIL [F1]: earlier-queued C is '$cst', expected it to hold the freed slot"; exit 1; }
[ "$chst" = "queued" ] || { echo "FAIL [F1]: successor jumped the queue — child is '$chst' while C was handed out first"; exit 1; }
echo "F1 OK: the freed slot went to the earlier-queued session; the successor waits its turn"

# ================= F2: steering survives a mid-delivery kill =======
PORT=8519
FLEET_DATA="$WORK/dataB" PORT=$PORT "${CARGO_TARGET_DIR:-./target}/debug/fleet" policies.rn > "$WORK/serverB.log" 2>&1 &
SRV=$!
PIDS="$PIDS $SRV"
wait_up $PORT
S=$(post $PORT /api/sessions "{\"repo\":\"$WORK/repo\",\"project\":\"fixture\",\"task\":\"orig task\",\"agent\":\"$WORK/steeragent.sh\"}" | jq -r '.id')
[ "$(wait_status $PORT "$S" working 20)" = "working" ] || { echo "FAIL [F2]: session never reached working"; exit 1; }
post $PORT "/api/sessions/$S/steer" '{"message":"make it shorter"}' >/dev/null
# Wait until the continuation run has STARTED (second CALL logged) —
# delivery is in flight — then kill the server dead.
for i in $(seq 1 40); do
  n=$(grep -c '^CALL:' "$CALLS_LOG" 2>/dev/null || echo 0)
  [ "$n" -ge 2 ] && break
  sleep 0.5
done
[ "$n" -ge 2 ] || { echo "FAIL [F2]: continuation run never started (calls=$n)"; exit 1; }
kill -9 $SRV
sleep 1
FLEET_DATA="$WORK/dataB" PORT=$PORT "${CARGO_TARGET_DIR:-./target}/debug/fleet" policies.rn > "$WORK/serverB2.log" 2>&1 &
PIDS="$PIDS $!"
wait_up $PORT
st=$(status_of $PORT "$S")
[ "$st" = "needs-you" ] || { echo "FAIL [F2]: after restart the session is '$st', expected needs-you"; exit 1; }
pending=$(api $PORT "/api/sessions/$S" | jq -r '.steer | length')
[ "$pending" = "1" ] || { echo "FAIL [F2]: steering was lost in the crash window — steer queue holds $pending message(s) after restart, expected 1"; exit 1; }
post $PORT "/api/sessions/$S/retry" '{}' >/dev/null
[ "$(wait_status $PORT "$S" done 60)" = "done" ] || { echo "FAIL [F2]: retried session never reached done"; exit 1; }
deliveries=$(grep -c '^CALL: make it shorter$' "$CALLS_LOG")
[ "$deliveries" -ge 2 ] || { echo "FAIL [F2]: the message was not re-delivered after the restart (deliveries=$deliveries)"; exit 1; }
echo "F2 OK: the steering message survived a kill -9 mid-delivery and was delivered on the retry"

# ================= N1: a stalled chain fires at startup ============
PORT=8521
FLEET_DATA="$WORK/dataC" PORT=$PORT "${CARGO_TARGET_DIR:-./target}/debug/fleet" policies.rn > "$WORK/serverC.log" 2>&1 &
SRV=$!
PIDS="$PIDS $SRV"
wait_up $PORT
P=$(post $PORT /api/sessions "{\"repo\":\"$WORK/repo\",\"project\":\"fixture\",\"task\":\"chain parent\",\"agent\":\"$WORK/fast.sh\",\"next\":[\"first child\"]}" | jq -r '.id')
[ "$(wait_status $PORT "$P" done 40)" = "done" ] || { echo "FAIL [N1]: chain parent never settled done"; exit 1; }
for i in $(seq 1 30); do
  CH=$(api $PORT /api/sessions | jq -r '.[] | select(.spawned_from != null) | .id' | head -1)
  [ -n "$CH" ] && break
  sleep 0.5
done
[ -n "$CH" ] || { echo "FAIL [N1]: successor never fired in the healthy run"; exit 1; }
kill $SRV 2>/dev/null; sleep 1
# Surgery: rewind the store to the settle-to-fire crash window —
# parent done with its chain unfired, the child never recorded.
jq --arg p "$P" --arg ch "$CH" '
  .sessions |= map(if .id == $p then .next_queue = ["revived job"] | .successor = null else . end)
  | .sessions |= map(select(.id != $ch))' "$WORK/dataC/sessions.json" > "$WORK/dataC/sessions.json.new"
mv "$WORK/dataC/sessions.json.new" "$WORK/dataC/sessions.json"
FLEET_DATA="$WORK/dataC" PORT=$PORT "${CARGO_TARGET_DIR:-./target}/debug/fleet" policies.rn > "$WORK/serverC2.log" 2>&1 &
PIDS="$PIDS $!"
wait_up $PORT
for i in $(seq 1 40); do
  R=$(api $PORT /api/sessions | jq -r --arg p "$P" '.[] | select(.task == "revived job" and .spawned_from == $p) | .id' | head -1)
  [ -n "$R" ] && break
  sleep 0.5
done
[ -n "$R" ] || { echo "FAIL [N1]: startup recovery did not fire the stalled chain"; exit 1; }
[ "$(wait_status $PORT "$R" done 40)" = "done" ] || { echo "FAIL [N1]: the revived successor never reached done"; exit 1; }
echo "N1 OK: startup recovery fired the stalled chain"

echo "SETTLE RACES OK: successor fairness, steer durability, chain recovery"
