#!/bin/bash
# B10/D2: agent and check execution are time-boxed by policy
# (timeout_secs). A hung agent or check must reach needs-you with the
# timeout named, and its parallel slot must free up for other work.
set -u
cd "$(dirname "$0")/../.."
WORK=$(mktemp -d)
PIDS=""
cleanup() { for p in $PIDS; do kill -9 $p 2>/dev/null; done; rm -rf "$WORK"; }
trap cleanup EXIT

[ -x ./target/debug/fleet-rs ] || cargo build >/dev/null 2>&1

for r in a b; do
  git init -q -b main "$WORK/repo$r"
  echo "seed" > "$WORK/repo$r/README.md"
  git -C "$WORK/repo$r" add -A
  git -C "$WORK/repo$r" -c user.email=p@p -c user.name=proof commit -qm init
done

cat > "$WORK/fixture.sh" <<'EOF'
#!/bin/bash
printf 'result of: %s\n' "$1" > output.txt
echo "fixture agent received task: $1"
EOF
cat > "$WORK/sleeper.sh" <<'EOF'
#!/bin/bash
echo "sleeper agent starting"
sleep 60
EOF
chmod +x "$WORK/fixture.sh" "$WORK/sleeper.sh"

# Policy A: 3s timeout, normal check. Policy B: 3s timeout, check sleeps.
cat > "$WORK/policyA.rn" <<'EOF'
pub fn max_parallel() { 1 }
pub fn timeout_secs() { 3 }
pub fn default_check(project) { "test -s output.txt" }
EOF
cat > "$WORK/policyB.rn" <<'EOF'
pub fn max_parallel() { 1 }
pub fn timeout_secs() { 3 }
pub fn default_check(project) { "sleep 60" }
EOF

start() { # port policy agent datadir
  FLEET_AGENT="$3" FLEET_DATA="$4" PORT=$1 ./target/debug/fleet-rs "$2" > "$WORK/server-$1.log" 2>&1 &
  PIDS="$PIDS $!"
  for i in $(seq 1 20); do curl -s "http://127.0.0.1:$1/api/sessions" >/dev/null 2>&1 && break; sleep 0.5; done
}
start 8495 "$WORK/policyA.rn" "$WORK/sleeper.sh" "$WORK/dataA"
start 8496 "$WORK/policyB.rn" "$WORK/fixture.sh" "$WORK/dataB"

wait_status() { # port want timeout_secs
  for i in $(seq 1 $(($3 * 2))); do
    st=$(curl -s "http://127.0.0.1:$1/api/sessions" | jq -r '.[0].status')
    [ "$st" = "$2" ] && return 0
    sleep 0.5
  done
  return 1
}

# Server A: the default agent sleeps forever -> agent timeout.
curl -s -X POST http://127.0.0.1:8495/api/sessions -H 'Content-Type: application/json' \
  -d "{\"repo\":\"$WORK/repoa\",\"project\":\"fixture\",\"task\":\"alpha task\"}" >/dev/null
wait_status 8495 needs-you 20 || { echo "FAIL: sleeping agent did not reach needs-you (status: $(curl -s http://127.0.0.1:8495/api/sessions | jq -r '.[0].status'))"; exit 1; }
curl -s http://127.0.0.1:8495/api/sessions | jq -e '.[0].reason | test("timed out")' >/dev/null \
  || { echo "FAIL: agent-timeout reason does not name the timeout: $(curl -s http://127.0.0.1:8495/api/sessions | jq -c '.[0].reason')"; exit 1; }

# The freed slot runs the next session (named fixture agent) to done.
curl -s -X POST http://127.0.0.1:8495/api/sessions -H 'Content-Type: application/json' \
  -d "{\"repo\":\"$WORK/repoa\",\"project\":\"fixture\",\"task\":\"beta task\",\"agent\":\"$WORK/fixture.sh\"}" >/dev/null
for i in $(seq 1 30); do
  st=$(curl -s http://127.0.0.1:8495/api/sessions | jq -r '.[1].status')
  [ "$st" = "done" ] && break
  sleep 0.5
done
[ "$st" = "done" ] || { echo "FAIL: after the agent timeout the slot did not free (second session: $st)"; exit 1; }

# Server B: the check sleeps forever -> check timeout.
curl -s -X POST http://127.0.0.1:8496/api/sessions -H 'Content-Type: application/json' \
  -d "{\"repo\":\"$WORK/repob\",\"project\":\"fixture\",\"task\":\"alpha task\"}" >/dev/null
wait_status 8496 needs-you 20 || { echo "FAIL: sleeping check did not reach needs-you (status: $(curl -s http://127.0.0.1:8496/api/sessions | jq -r '.[0].status'))"; exit 1; }
curl -s http://127.0.0.1:8496/api/sessions | jq -e '.[0].reason | test("timed out")' >/dev/null \
  || { echo "FAIL: check-timeout reason does not name the timeout: $(curl -s http://127.0.0.1:8496/api/sessions | jq -c '.[0].reason')"; exit 1; }

echo "TIMEOUT OK: hung agents and checks time out into needs-you with the timeout named, and slots free up"
