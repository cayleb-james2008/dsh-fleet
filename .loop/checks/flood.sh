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

[ -x "${CARGO_TARGET_DIR:-./target}/debug/fleet" ] || cargo build >/dev/null 2>&1

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
  "${CARGO_TARGET_DIR:-./target}/debug/fleet" policies.rn > "$WORK/server.log" 2>&1 &
S1=$!
PIDS="$PIDS $S1"
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

# --- B18 phase 2: a restart must NOT resurrect the dropped lines.
# The restore used to replace the capped transcript with the whole
# log file; the cap must survive the restart, and the check-output
# block stored in the same file must not pollute the transcript.
kill -9 "$S1" 2>/dev/null
sleep 1
FLEET_AGENT="$WORK/agent.sh" FLEET_DATA="$WORK/data" PORT=$PORT \
  "${CARGO_TARGET_DIR:-./target}/debug/fleet" policies.rn > "$WORK/server2.log" 2>&1 &
S2=$!
PIDS="$PIDS $S2"
for i in $(seq 1 20); do api /api/sessions >/dev/null 2>&1 && break; sleep 0.5; done
n2=$(api /api/sessions | jq '.[0].transcript | length')
[ "$n2" -le 2100 ] || { echo "FAIL: after restart the transcript holds $n2 lines — the cap was undone by the restore"; exit 1; }
api /api/sessions | jq -e '.[0].transcript | map(select(. == "--- check output ---")) | length == 0' >/dev/null \
  || { echo "FAIL: the restored transcript contains the check-output block"; exit 1; }
[ "$(api /api/sessions | jq -r '.[0].status')" = "done" ] \
  || { echo "FAIL: the done session did not survive the restart"; exit 1; }

# --- B18 phase 3: one enormous line cannot defeat the caps.
cat > "$WORK/bigline.sh" <<'EOF'
#!/bin/bash
printf 'result\n' > output.txt
head -c 5000000 /dev/zero | tr '\0' 'x'
echo
EOF
chmod +x "$WORK/bigline.sh"
curl -s -X POST "http://127.0.0.1:$PORT/api/sessions" -H 'Content-Type: application/json' \
  -d "{\"repo\":\"$WORK/repo\",\"project\":\"fixture\",\"task\":\"big line\",\"agent\":\"$WORK/bigline.sh\"}" >/dev/null
for i in $(seq 1 60); do
  st=$(api /api/sessions | jq -r '.[1].status')
  [ "$st" = "done" ] && break
  sleep 0.5
done
[ "$st" = "done" ] || { echo "FAIL: big-line session reached '$st', expected done"; exit 1; }
payload=$(curl -s "http://127.0.0.1:$PORT/api/sessions" | wc -c)
[ "$payload" -lt 3000000 ] || { echo "FAIL: /api/sessions payload is $payload bytes after a 5MB single line — the caps were defeated"; exit 1; }
snapsize=$(wc -c < "$WORK/data/sessions.json")
[ "$snapsize" -lt 3000000 ] || { echo "FAIL: sessions.json is $snapsize bytes — the caps were defeated"; exit 1; }

# --- B18 phase 4: lose sessions.json entirely — the sessions are
# recovered from their logs as needs-you, never silently vanished.
kill -9 "$S2" 2>/dev/null
sleep 1
rm "$WORK/data/sessions.json"
FLEET_AGENT="$WORK/agent.sh" FLEET_DATA="$WORK/data" PORT=$PORT \
  "${CARGO_TARGET_DIR:-./target}/debug/fleet" policies.rn > "$WORK/server3.log" 2>&1 &
S3=$!
PIDS="$PIDS $S3"
for i in $(seq 1 20); do api /api/sessions >/dev/null 2>&1 && break; sleep 0.5; done
api /api/sessions | jq -e 'length >= 2' >/dev/null \
  || { echo "FAIL: sessions vanished with sessions.json — no recovery from logs"; api /api/sessions; exit 1; }
api /api/sessions | jq -e '[.[] | select(((.transcript // []) | map(select(test("restored from its record"))) | length) > 0 or ((.reason // "") | test("recovered")))] | length >= 1' >/dev/null \
  || { echo "FAIL: recovered sessions do not say they were recovered"; api /api/sessions | jq -c '.[].reason'; exit 1; }

echo "FLOOD OK: transcript is capped with a pointer to the log file (all $lines lines kept), the cap survives restart, one huge line stays bounded, and a lost sessions.json recovers from the logs"
