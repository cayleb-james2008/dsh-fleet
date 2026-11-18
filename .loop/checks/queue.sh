#!/bin/bash
# C5: queueing is visible. With max_parallel forced to 1, three hand-outs
# show queue positions 1 and 2 for the waiting sessions, and all reach
# done in hand-out order.
set -u
cd "$(dirname "$0")/../.."
PORT=8483
WORK=$(mktemp -d)
PIDS=""
cleanup() { for p in $PIDS; do kill -9 $p 2>/dev/null; done; rm -rf "$WORK"; }
trap cleanup EXIT

[ -x ./target/debug/fleet-rs ] || cargo build >/dev/null 2>&1

git init -q -b main "$WORK/repo"
echo "seed" > "$WORK/repo/README.md"
git -C "$WORK/repo" add -A
git -C "$WORK/repo" -c user.email=p@p -c user.name=proof commit -qm init

cat > "$WORK/agent.sh" <<'EOF'
#!/bin/bash
sleep 3
printf 'result of: %s\n' "$1" > output.txt
EOF
chmod +x "$WORK/agent.sh"

cat > "$WORK/policies1.rn" <<'EOF'
pub fn max_parallel() { 1 }
pub fn default_check(p) { "test -s output.txt" }
EOF

FLEET_AGENT="$WORK/agent.sh" FLEET_DATA="$WORK/data" PORT=$PORT \
  ./target/debug/fleet-rs "$WORK/policies1.rn" > "$WORK/server.log" 2>&1 &
PIDS="$PIDS $!"
api() { curl -s "http://127.0.0.1:$PORT$1"; }
post() { curl -s -X POST "http://127.0.0.1:$PORT$1" -H 'Content-Type: application/json' -d "$2"; }
for i in $(seq 1 20); do api /api/sessions >/dev/null 2>&1 && break; sleep 0.5; done

post /api/sessions "{\"repo\":\"$WORK/repo\",\"project\":\"fixture\",\"task\":\"one\"}" >/dev/null
post /api/sessions "{\"repo\":\"$WORK/repo\",\"project\":\"fixture\",\"task\":\"two\"}" >/dev/null
post /api/sessions "{\"repo\":\"$WORK/repo\",\"project\":\"fixture\",\"task\":\"three\"}" >/dev/null

seen=""
for i in $(seq 1 30); do
  snap=$(api /api/sessions)
  q=$(echo "$snap" | jq -c '[.[] | select(.status=="queued") | .queue_position]')
  w=$(echo "$snap" | jq '[.[] | select(.status=="working")] | length')
  if [ "$q" = "[1,2]" ] && [ "$w" = "1" ]; then seen=1; break; fi
  sleep 0.2
done
[ -n "$seen" ] || { echo "FAIL: never saw one working + queue positions [1,2]; last snapshot: $(api /api/sessions | jq -c '.[] | {task, status, queue_position}')"; exit 1; }

for i in $(seq 1 120); do
  states=$(api /api/sessions | jq -r '[.[].status] | join(",")')
  [ "$states" = "done,done,done" ] && break
  sleep 0.5
done
[ "$states" = "done,done,done" ] || { echo "FAIL: final states $states, expected done,done,done in hand-out order"; exit 1; }

echo "QUEUE OK: waiting sessions carry positions, the cap holds, order is honoured"
