#!/bin/bash
# B11/D6: a flooding agent cannot grow the in-memory transcript, the
# API payloads, or the persist cost without limit. The full record
# still exists — in the session's on-disk log file.
set -u
cd "$(dirname "$0")/../.."
PORT=8497
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
printf 'result\n' > output.txt
i=1
while [ $i -le 5000 ]; do echo "flood line $i"; i=$((i+1)); done
EOF
chmod +x "$WORK/agent.sh"

FLEET_AGENT="$WORK/agent.sh" FLEET_DATA="$WORK/data" PORT=$PORT \
  ./target/debug/fleet-rs policies.rn > "$WORK/server.log" 2>&1 &
PIDS="$PIDS $!"
api() { curl -s "http://127.0.0.1:$PORT$1"; }
for i in $(seq 1 20); do api /api/sessions >/dev/null 2>&1 && break; sleep 0.5; done

curl -s -X POST "http://127.0.0.1:$PORT/api/sessions" -H 'Content-Type: application/json' \
  -d "{\"repo\":\"$WORK/repo\",\"project\":\"fixture\",\"task\":\"flood task\"}" >/dev/null
for i in $(seq 1 60); do
  st=$(api /api/sessions | jq -r '.[0].status')
  [ "$st" = "done" ] && break
  sleep 0.5
done
[ "$st" = "done" ] || { echo "FAIL: flooding session reached '$st', expected done"; exit 1; }

n=$(api /api/sessions | jq '.[0].transcript | length')
[ "$n" -le 2100 ] || { echo "FAIL: in-memory transcript holds $n lines after a 5000-line flood — unbounded"; exit 1; }
api /api/sessions | jq -e '.[0].transcript | map(select(test("log file"))) | length >= 1' >/dev/null \
  || { echo "FAIL: trimmed transcript does not say where the full record lives"; exit 1; }
ID=$(api /api/sessions | jq -r '.[0].id')
lines=$(wc -l < "$WORK/data/logs/$ID.log")
[ "$lines" -ge 5000 ] || { echo "FAIL: on-disk log holds $lines lines — the full record was lost"; exit 1; }

echo "FLOOD OK: transcript is capped with a pointer to the log file, which keeps all $lines lines"
