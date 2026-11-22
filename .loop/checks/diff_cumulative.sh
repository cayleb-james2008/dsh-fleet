#!/bin/bash
# B13: the diff an operator reviews before merging must be everything
# the merge will land — including work committed by earlier runs of a
# retried session, not just the latest run's changes.
set -u
cd "$(dirname "$0")/../.."
PORT=8499
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
mode=\$(cat "$WORK/mode")
if [ "\$mode" = "a" ]; then printf 'aaa\n' > a.txt; else printf 'bbb\n' > b.txt; fi
echo "agent wrote \$mode"
EOF
chmod +x "$WORK/agent.sh"
echo a > "$WORK/mode"

FLEET_AGENT="$WORK/agent.sh" FLEET_DATA="$WORK/data" PORT=$PORT \
  "${CARGO_TARGET_DIR:-./target}/debug/fleet" policies.rn > "$WORK/server.log" 2>&1 &
PIDS="$PIDS $!"
api() { curl -s "http://127.0.0.1:$PORT$1"; }
post() { curl -s -X POST "http://127.0.0.1:$PORT$1" -H 'Content-Type: application/json' -d "$2"; }
for i in $(seq 1 20); do api /api/sessions >/dev/null 2>&1 && break; sleep 0.5; done

post /api/sessions "{\"repo\":\"$WORK/repo\",\"project\":\"fixture\",\"task\":\"two files\",\"check\":\"test -s a.txt && test -s b.txt\"}" >/dev/null
for i in $(seq 1 40); do
  st=$(api /api/sessions | jq -r '.[0].status')
  [ "$st" = "needs-you" ] && break
  sleep 0.5
done
[ "$st" = "needs-you" ] || { echo "FAIL: first run reached '$st', expected needs-you"; exit 1; }
ID=$(api /api/sessions | jq -r '.[0].id')

echo b > "$WORK/mode"
post "/api/sessions/$ID/retry" '{}' >/dev/null
for i in $(seq 1 40); do
  st=$(api /api/sessions | jq -r '.[0].status')
  [ "$st" = "done" ] && break
  sleep 0.5
done
[ "$st" = "done" ] || { echo "FAIL: retry reached '$st', expected done"; exit 1; }

diff=$(api /api/sessions | jq -r '.[0].diff')
echo "$diff" | grep -q 'a.txt' || { echo "FAIL: served diff omits a.txt, committed by the first run — the operator would review an incomplete diff"; echo "$diff"; exit 1; }
echo "$diff" | grep -q 'b.txt' || { echo "FAIL: served diff omits b.txt from the retry run"; echo "$diff"; exit 1; }

post "/api/sessions/$ID/merge" '{}' >/dev/null
[ -f "$WORK/repo/a.txt" ] && [ -f "$WORK/repo/b.txt" ] \
  || { echo "FAIL: merge did not land both files"; exit 1; }

echo "DIFF OK: the reviewed diff covers every run of the session, and the merge lands exactly that"
