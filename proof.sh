#!/bin/bash
# fleet-rs proof: two fixture-agent sessions run in parallel in separate
# worktrees of a fixture repo, both reach verified-done through the app's
# own API, their diffs are served, and one is merged into the repo.
set -u
cd "$(dirname "$0")"
PORT=8477
WORK=$(mktemp -d)
trap 'kill $SERVER_PID 2>/dev/null; rm -rf "$WORK"' EXIT

cargo build 2>&1 | tail -1

# Fixture repo
git init -q -b main "$WORK/repo"
echo "seed" > "$WORK/repo/README.md"
git -C "$WORK/repo" add -A
git -C "$WORK/repo" -c user.email=p@p -c user.name=proof commit -qm init

# Fixture agent: does the work the task describes, claims completion.
cat > "$WORK/agent.sh" <<'EOF'
#!/bin/bash
echo "fixture agent received task: $1"
printf 'result of: %s\n' "$1" > output.txt
echo "fixture agent finished"
EOF
chmod +x "$WORK/agent.sh"

FLEET_AGENT="$WORK/agent.sh" FLEET_DATA="$WORK/data" PORT=$PORT \
  ./target/debug/fleet-rs policies.rn > "$WORK/server.log" 2>&1 &
SERVER_PID=$!
sleep 1

api() { curl -s "http://127.0.0.1:$PORT$1"; }
post() { curl -s -X POST "http://127.0.0.1:$PORT$1" -H 'Content-Type: application/json' -d "$2"; }

echo "== policy (from policies.rn via Rune) =="
api /api/policy; echo

echo "== hand out two tasks =="
post /api/sessions "{\"repo\":\"$WORK/repo\",\"project\":\"fixture\",\"task\":\"alpha task\"}" >/dev/null
post /api/sessions "{\"repo\":\"$WORK/repo\",\"project\":\"fixture\",\"task\":\"beta task\"}" >/dev/null

echo "== wait for both to reach verified done =="
for i in $(seq 1 60); do
  states=$(api /api/sessions | jq -r '[.[].status] | join(",")')
  echo "  poll $i: $states"
  [ "$states" = "done,done" ] && break
  sleep 1
done
[ "$states" = "done,done" ] || { echo "PROOF FAILED: states=$states"; api /api/sessions | jq .; exit 1; }

echo "== worktrees are separate =="
ls "$WORK/data/worktrees"
git -C "$WORK/repo" worktree list

ID1=$(api /api/sessions | jq -r '.[0].id')
ID2=$(api /api/sessions | jq -r '.[1].id')
echo "session ids: $ID1 $ID2"

echo "== diffs served by the app =="
api "/api/sessions/$ID1" | jq -r '.diff'
api "/api/sessions/$ID2" | jq -r '.diff'

echo "== checks recorded as passed =="
api /api/sessions | jq -r '.[] | "\(.id): check_passed=\(.check_passed) status=\(.status)"'

echo "== merge first session =="
post "/api/sessions/$ID1/merge" '{}'; echo
echo "repo now contains:"; cat "$WORK/repo/output.txt"
grep -q "alpha task" "$WORK/repo/output.txt" && echo "PROOF OK: merged work is in the repo" || { echo "PROOF FAILED: merge missing"; exit 1; }
