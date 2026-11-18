#!/bin/bash
# C14: successor work self-claims. A hand-out naming `next` fires the
# successor automatically when — and only when — the session reaches
# verified done: the successor exists with its origin recorded, runs
# under the same agent/check, and reaches done itself. A chain of two
# fires in order. A session that lands needs-you fires nothing.
set -u
cd "$(dirname "$0")/../.."
PORT=8515
WORK=$(mktemp -d)
PIDS=""
cleanup() { for p in $PIDS; do kill -9 $p 2>/dev/null; done; rm -rf "$WORK"; }
trap cleanup EXIT

[ -x ./target/debug/fleet-rs ] || cargo build >/dev/null 2>&1

git init -q -b main "$WORK/repo"
echo "seed" > "$WORK/repo/README.md"
git -C "$WORK/repo" add -A
git -C "$WORK/repo" -c user.email=p@p -c user.name=proof commit -qm init

# Second fixture repo for the failure case (its check can never pass
# for the do-nothing agent used there).
git init -q -b main "$WORK/repo2"
echo "seed" > "$WORK/repo2/README.md"
git -C "$WORK/repo2" add -A
git -C "$WORK/repo2" -c user.email=p@p -c user.name=proof commit -qm init

cat > "$WORK/agent.sh" <<'EOF'
#!/bin/bash
printf 'result of: %s\n' "$1" > output.txt
EOF
chmod +x "$WORK/agent.sh"

cat > "$WORK/lazy.sh" <<'EOF'
#!/bin/bash
echo "doing nothing, claiming completion"
EOF
chmod +x "$WORK/lazy.sh"

FLEET_DATA="$WORK/data" PORT=$PORT ./target/debug/fleet-rs policies.rn > "$WORK/server.log" 2>&1 &
PIDS="$PIDS $!"
api() { curl -s "http://127.0.0.1:$PORT$1"; }
post() { curl -s -w "\n%{http_code}" -X POST "http://127.0.0.1:$PORT$1" -H 'Content-Type: application/json' -d "$2"; }
for i in $(seq 1 20); do api /api/sessions >/dev/null 2>&1 && break; sleep 0.5; done

wait_status() { # id, want, tries
  local id="$1" want="$2" n="${3:-80}" st=""
  for i in $(seq 1 "$n"); do
    st=$(api "/api/sessions/$id" | jq -r '.status')
    [ "$st" = "$want" ] && { echo "$st"; return 0; }
    sleep 0.5
  done
  echo "$st"
}

# --- a chain of two fires in order, each on verified done ---
resp=$(post /api/sessions "{\"repo\":\"$WORK/repo\",\"project\":\"fixture\",\"task\":\"step one\",\"agent\":\"$WORK/agent.sh\",\"next\":[\"step two\",\"step three\"]}")
code=$(echo "$resp" | tail -1)
[ "$code" = "201" ] || { echo "FAIL: chained hand-out returned $code: $resp"; exit 1; }
ID1=$(echo "$resp" | sed '$d' | jq -r '.id')
st=$(wait_status "$ID1" done)
[ "$st" = "done" ] || { echo "FAIL: step one reached '$st'"; exit 1; }

# The successor appears on its own — nobody handed it out.
ID2=""
for i in $(seq 1 40); do
  ID2=$(api /api/sessions | jq -r --arg p "$ID1" '.[] | select(.spawned_from == $p) | .id' | head -1)
  [ -n "$ID2" ] && break
  sleep 0.5
done
[ -n "$ID2" ] || { echo "FAIL: no successor session appeared after step one finished"; api /api/sessions | jq -c '.[] | {id, task, spawned_from}'; exit 1; }
t2=$(api "/api/sessions/$ID2" | jq -r '.task')
[ "$t2" = "step two" ] || { echo "FAIL: successor task is '$t2', expected 'step two'"; exit 1; }
succ=$(api "/api/sessions/$ID1" | jq -r '.successor')
[ "$succ" = "$ID2" ] || { echo "FAIL: parent successor field is '$succ', expected '$ID2'"; exit 1; }
st=$(wait_status "$ID2" done)
[ "$st" = "done" ] || { echo "FAIL: step two reached '$st'"; exit 1; }

ID3=""
for i in $(seq 1 40); do
  ID3=$(api /api/sessions | jq -r --arg p "$ID2" '.[] | select(.spawned_from == $p) | .id' | head -1)
  [ -n "$ID3" ] && break
  sleep 0.5
done
[ -n "$ID3" ] || { echo "FAIL: chain's third item never fired"; exit 1; }
t3=$(api "/api/sessions/$ID3" | jq -r '.task')
[ "$t3" = "step three" ] || { echo "FAIL: third task is '$t3', expected 'step three'"; exit 1; }
st=$(wait_status "$ID3" done)
[ "$st" = "done" ] || { echo "FAIL: step three reached '$st'"; exit 1; }

# --- a single-string next fires too ---
resp=$(post /api/sessions "{\"repo\":\"$WORK/repo\",\"project\":\"fixture\",\"task\":\"solo parent\",\"agent\":\"$WORK/agent.sh\",\"next\":\"solo child\"}")
IDP=$(echo "$resp" | sed '$d' | jq -r '.id')
st=$(wait_status "$IDP" done)
[ "$st" = "done" ] || { echo "FAIL: solo parent reached '$st'"; exit 1; }
IDC=""
for i in $(seq 1 40); do
  IDC=$(api /api/sessions | jq -r --arg p "$IDP" '.[] | select(.spawned_from == $p) | .id' | head -1)
  [ -n "$IDC" ] && break
  sleep 0.5
done
[ -n "$IDC" ] || { echo "FAIL: single-string next never fired"; exit 1; }
st=$(wait_status "$IDC" done)
[ "$st" = "done" ] || { echo "FAIL: solo child reached '$st'"; exit 1; }

# --- failure fires nothing ---
resp=$(post /api/sessions "{\"repo\":\"$WORK/repo2\",\"project\":\"fixture\",\"task\":\"doomed\",\"agent\":\"$WORK/lazy.sh\",\"next\":\"never runs\"}")
IDF=$(echo "$resp" | sed '$d' | jq -r '.id')
st=$(wait_status "$IDF" needs-you)
[ "$st" = "needs-you" ] || { echo "FAIL: doomed session reached '$st', expected needs-you"; exit 1; }
sleep 2  # give a wrongful cascade a chance to appear
n=$(api /api/sessions | jq '[.[] | select(.task == "never runs")] | length')
[ "$n" = "0" ] || { echo "FAIL: a needs-you session fired its successor — failed work cascaded"; exit 1; }
succ=$(api "/api/sessions/$IDF" | jq -r '.successor')
[ "$succ" = "null" ] || { echo "FAIL: doomed session claims successor '$succ'"; exit 1; }

echo "SUCCESSOR OK: chains fire in order on verified done only; origins recorded; failure cascades nothing"
