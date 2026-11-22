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

[ -x "${CARGO_TARGET_DIR:-./target}/debug/fleet-rs" ] || cargo build >/dev/null 2>&1

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
  FLEET_AGENT="$3" FLEET_DATA="$4" PORT=$1 "${CARGO_TARGET_DIR:-./target}/debug/fleet-rs" "$2" > "$WORK/server-$1.log" 2>&1 &
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

# --- Grandchildren (round-2 R2-4/R2-13): the timeout must bound the
# PIPE HOLDERS, not just the direct child, and a timed-out run's
# detached children must not keep writing into the settled worktree.
cat > "$WORK/pipeholder.sh" <<'EOF'
#!/bin/bash
printf 'work product\n' > output.txt
(sleep 25) &
echo "agent done, a grandchild holds the pipes"
EOF
cat > "$WORK/ghost.sh" <<'EOF'
#!/bin/bash
printf 'work product\n' > output.txt
(for i in $(seq 1 30); do echo "ghost $i" >> late.txt; sleep 1; done) &
sleep 30
EOF
chmod +x "$WORK/pipeholder.sh" "$WORK/ghost.sh"
git init -q -b main "$WORK/repoc"
echo "seed" > "$WORK/repoc/README.md"
git -C "$WORK/repoc" add -A
git -C "$WORK/repoc" -c user.email=p@p -c user.name=proof commit -qm init
start 8497 "$WORK/policyA.rn" "$WORK/pipeholder.sh" "$WORK/dataC"

t0=$(date +%s)
curl -s -X POST http://127.0.0.1:8497/api/sessions -H 'Content-Type: application/json' \
  -d "{\"repo\":\"$WORK/repoc\",\"project\":\"fixture\",\"task\":\"pipe holder\"}" >/dev/null
wait_status 8497 needs-you 20 || { echo "FAIL: pipe-holding agent did not settle to needs-you (status: $(curl -s http://127.0.0.1:8497/api/sessions | jq -r '.[0].status'))"; exit 1; }
elapsed=$(( $(date +%s) - t0 ))
[ "$elapsed" -lt 15 ] || { echo "FAIL: pipe-holding agent took ${elapsed}s to settle — the grandchild still bounds the session"; exit 1; }
curl -s http://127.0.0.1:8497/api/sessions | jq -e '.[0].reason | test("detached process")' >/dev/null \
  || { echo "FAIL: pipe-held reason does not name the detached process: $(curl -s http://127.0.0.1:8497/api/sessions | jq -c '.[0].reason')"; exit 1; }

# Ghost writer: after the timeout the group is dead — late.txt stops.
curl -s -X POST http://127.0.0.1:8497/api/sessions -H 'Content-Type: application/json' \
  -d "{\"repo\":\"$WORK/repoc\",\"project\":\"fixture\",\"task\":\"ghost\",\"agent\":\"$WORK/ghost.sh\"}" >/dev/null
for i in $(seq 1 40); do
  st=$(curl -s http://127.0.0.1:8497/api/sessions | jq -r '.[1].status')
  [ "$st" = "needs-you" ] && break
  sleep 0.5
done
[ "$st" = "needs-you" ] || { echo "FAIL: ghost agent did not reach needs-you ($st)"; exit 1; }
WT=$(curl -s http://127.0.0.1:8497/api/sessions | jq -r '.[1].worktree')
size1=$(wc -l < "$WT/late.txt" 2>/dev/null || echo 0)
sleep 4
size2=$(wc -l < "$WT/late.txt" 2>/dev/null || echo 0)
[ "$size1" = "$size2" ] || { echo "FAIL: ghost writer kept writing after the timeout ($size1 -> $size2 lines) — the process group survived"; exit 1; }

# Check-side pipe holder: the check exits 0 instantly but its
# background child holds the check's pipes.
curl -s -X POST http://127.0.0.1:8497/api/sessions -H 'Content-Type: application/json' \
  -d "{\"repo\":\"$WORK/repoc\",\"project\":\"fixture\",\"task\":\"check pipes\",\"agent\":\"$WORK/fixture.sh\",\"check\":\"(sleep 25 &); test -s output.txt\"}" >/dev/null
for i in $(seq 1 40); do
  st=$(curl -s http://127.0.0.1:8497/api/sessions | jq -r '.[2].status')
  [ "$st" = "needs-you" ] && break
  sleep 0.5
done
[ "$st" = "needs-you" ] || { echo "FAIL: pipe-holding check did not settle to needs-you ($st)"; exit 1; }
curl -s http://127.0.0.1:8497/api/sessions | jq -e '.[2].reason | test("detached process")' >/dev/null \
  || { echo "FAIL: check pipe-held reason does not name the detached process: $(curl -s http://127.0.0.1:8497/api/sessions | jq -c '.[2].reason')"; exit 1; }

echo "TIMEOUT OK: hung agents and checks time out into needs-you with the timeout named, slots free up, pipe-holding grandchildren are bounded, and timed-out groups stop writing"
