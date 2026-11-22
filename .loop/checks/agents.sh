#!/bin/bash
# C4: agent support is detected, not assumed. /api/policy reports each
# known agent as found/not-found matching the real PATH; a hand-out naming
# an unavailable agent is refused up front, before any worktree exists.
set -u
cd "$(dirname "$0")/../.."
PORT=8482
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
printf 'result of: %s\n' "$1" > output.txt
EOF
chmod +x "$WORK/agent.sh"

FLEET_DATA="$WORK/data" PORT=$PORT "${CARGO_TARGET_DIR:-./target}/debug/fleet" policies.rn > "$WORK/server.log" 2>&1 &
PIDS="$PIDS $!"
api() { curl -s "http://127.0.0.1:$PORT$1"; }
post() { curl -s -w "\n%{http_code}" -X POST "http://127.0.0.1:$PORT$1" -H 'Content-Type: application/json' -d "$2"; }
for i in $(seq 1 20); do api /api/sessions >/dev/null 2>&1 && break; sleep 0.5; done

policy=$(api /api/policy)
echo "$policy" | jq -e '.agents | type == "array"' >/dev/null \
  || { echo "FAIL: /api/policy has no agents array: $policy"; exit 1; }
for name in opencode claude codex; do
  if command -v "$name" >/dev/null 2>&1; then want=true; else want=false; fi
  got=$(echo "$policy" | jq -r ".agents[] | select(.name==\"$name\") | .found")
  [ "$got" = "$want" ] || { echo "FAIL: policy says $name found=$got, PATH says $want"; exit 1; }
done

# A hand-out naming an agent that does not exist is refused up front.
resp=$(post /api/sessions "{\"repo\":\"$WORK/repo\",\"project\":\"fixture\",\"task\":\"x\",\"agent\":\"definitely-not-a-real-agent-xyz\"}")
code=$(echo "$resp" | tail -1)
body=$(echo "$resp" | sed '$d')
[ "$code" = "400" ] || { echo "FAIL: unavailable agent hand-out returned $code, expected 400: $body"; exit 1; }
echo "$body" | grep -qi "definitely-not-a-real-agent-xyz" \
  || { echo "FAIL: refusal does not name the problem agent: $body"; exit 1; }
n=$(api /api/sessions | jq 'length')
[ "$n" = "0" ] || { echo "FAIL: refused hand-out still created a session"; exit 1; }
[ ! -d "$WORK/data/worktrees" ] || [ -z "$(ls -A "$WORK/data/worktrees" 2>/dev/null)" ] \
  || { echo "FAIL: refused hand-out created a worktree"; exit 1; }

# A directory is not an executable file: refused up front too.
resp=$(post /api/sessions "{\"repo\":\"$WORK/repo\",\"project\":\"fixture\",\"task\":\"x\",\"agent\":\"/tmp\"}")
code=$(echo "$resp" | tail -1)
[ "$code" = "400" ] || { echo "FAIL: directory-as-agent hand-out returned $code, expected 400: $resp"; exit 1; }
n=$(api /api/sessions | jq 'length')
[ "$n" = "0" ] || { echo "FAIL: directory-as-agent refusal still created a session"; exit 1; }

# /api/policy's source names the policy file actually loaded.
src=$(api /api/policy | jq -r '.source')
[ "$src" = "policies.rn" ] || { echo "FAIL: policy source is '$src', expected the loaded file 'policies.rn'"; exit 1; }
cp policies.rn "$WORK/alt-policies.rn"
FLEET_DATA="$WORK/data2" PORT=8492 "${CARGO_TARGET_DIR:-./target}/debug/fleet" "$WORK/alt-policies.rn" > "$WORK/server2.log" 2>&1 &
PIDS="$PIDS $!"
for i in $(seq 1 20); do curl -s "http://127.0.0.1:8492/api/policy" >/dev/null 2>&1 && break; sleep 0.5; done
src2=$(curl -s "http://127.0.0.1:8492/api/policy" | jq -r '.source')
case "$src2" in *alt-policies.rn) : ;; *) echo "FAIL: alt policy source is '$src2'"; exit 1;; esac

# A hand-out naming a real executable path runs under that agent.
resp=$(post /api/sessions "{\"repo\":\"$WORK/repo\",\"project\":\"fixture\",\"task\":\"alpha\",\"agent\":\"$WORK/agent.sh\"}")
code=$(echo "$resp" | tail -1)
[ "$code" = "201" ] || { echo "FAIL: fixture-agent hand-out returned $code: $resp"; exit 1; }
for i in $(seq 1 40); do
  st=$(api /api/sessions | jq -r '.[0].status')
  [ "$st" = "done" ] && break
  sleep 0.5
done
[ "$st" = "done" ] || { echo "FAIL: session under named agent reached '$st', expected done"; exit 1; }
ag=$(api /api/sessions | jq -r '.[0].agent')
[ "$ag" = "$WORK/agent.sh" ] || { echo "FAIL: session does not record its agent (got '$ag')"; exit 1; }

echo "AGENTS OK: detection matches PATH, unavailable agents refused up front, named agents run"
