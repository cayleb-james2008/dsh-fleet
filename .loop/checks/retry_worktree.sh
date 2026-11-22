#!/bin/bash
# B9/D4: retry must survive the session's worktree directory being
# deleted. The branch still holds the session's committed work; retry
# restores the worktree from that branch instead of failing forever on
# `worktree add -b` (branch already exists).
set -u
cd "$(dirname "$0")/../.."
PORT=8493
WORK=$(mktemp -d)
PIDS=""
cleanup() { for p in $PIDS; do kill -9 $p 2>/dev/null; done; rm -rf "$WORK"; }
trap cleanup EXIT

[ -x "${CARGO_TARGET_DIR:-./target}/debug/fleet" ] || cargo build >/dev/null 2>&1

git init -q -b main "$WORK/repo"
echo "seed" > "$WORK/repo/README.md"
git -C "$WORK/repo" add -A
git -C "$WORK/repo" -c user.email=p@p -c user.name=proof commit -qm init

cat > "$WORK/agent.sh" <<EOF
#!/bin/bash
if [ -f "$WORK/allow" ]; then printf 'result of: %s\n' "\$1" > output.txt; fi
echo "agent ran: \$1"
EOF
chmod +x "$WORK/agent.sh"

FLEET_AGENT="$WORK/agent.sh" FLEET_DATA="$WORK/data" PORT=$PORT \
  "${CARGO_TARGET_DIR:-./target}/debug/fleet" policies.rn > "$WORK/server.log" 2>&1 &
PIDS="$PIDS $!"
api() { curl -s "http://127.0.0.1:$PORT$1"; }
post() { curl -s -X POST "http://127.0.0.1:$PORT$1" -H 'Content-Type: application/json' -d "$2"; }
for i in $(seq 1 20); do api /api/sessions >/dev/null 2>&1 && break; sleep 0.5; done

post /api/sessions "{\"repo\":\"$WORK/repo\",\"project\":\"fixture\",\"task\":\"alpha task\"}" >/dev/null
for i in $(seq 1 40); do
  st=$(api /api/sessions | jq -r '.[0].status')
  [ "$st" = "needs-you" ] && break
  sleep 0.5
done
[ "$st" = "needs-you" ] || { echo "FAIL: session reached '$st', expected needs-you"; exit 1; }
ID=$(api /api/sessions | jq -r '.[0].id')
BR=$(api /api/sessions | jq -r '.[0].branch')
WT=$(api /api/sessions | jq -r '.[0].worktree')

# Delete the worktree directory entirely, then retry.
rm -rf "$WT"
touch "$WORK/allow"
post "/api/sessions/$ID/retry" '{}' >/dev/null
for i in $(seq 1 40); do
  st=$(api /api/sessions | jq -r '.[0].status')
  [ "$st" = "done" ] && break
  sleep 0.5
done
[ "$st" = "done" ] || { echo "FAIL: retry after worktree deletion reached '$st' (reason: $(api /api/sessions | jq -r '.[0].reason')), expected done"; exit 1; }
n=$(git -C "$WORK/repo" log --oneline "$BR" | wc -l)
[ "$n" -ge 2 ] || { echo "FAIL: branch $BR holds $n commits — the first run's committed work was stranded or lost"; exit 1; }

echo "RETRY-WORKTREE OK: a deleted worktree is restored from its branch; earlier work is not stranded"
