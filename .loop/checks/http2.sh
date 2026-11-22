#!/bin/bash
# B19: the HTTP layer's second round — a whole-request deadline (a
# slow drip must not park a handler thread), POST guards that make a
# drive-by from another web page impossible, stale index.lock
# recovery, and the max_parallel floor.
set -u
cd "$(dirname "$0")/../.."
PORT=8503
WORK=$(mktemp -d)
PIDS=""
cleanup() { for p in $PIDS; do kill -9 $p 2>/dev/null; done; rm -rf "$WORK"; }
trap cleanup EXIT

export PATH="$HOME/.rust/bin:$PATH"
cargo build >/dev/null 2>&1 || { echo "FAIL: cargo build failed"; exit 1; }

git init -q -b main "$WORK/repo"
echo "seed" > "$WORK/repo/README.md"
git -C "$WORK/repo" add -A
git -C "$WORK/repo" -c user.email=p@p -c user.name=proof commit -qm init
cat > "$WORK/agent.sh" <<'EOF'
#!/bin/bash
printf 'agent version\n' > output.txt
EOF
chmod +x "$WORK/agent.sh"

FLEET_AGENT="$WORK/agent.sh" FLEET_DATA="$WORK/data" PORT=$PORT \
  "${CARGO_TARGET_DIR:-./target}/debug/fleet-rs" policies.rn > "$WORK/server.log" 2>&1 &
PIDS="$PIDS $!"
api() { curl -s "http://127.0.0.1:$PORT$1"; }
for i in $(seq 1 20); do api /api/sessions >/dev/null 2>&1 && break; sleep 0.5; done

# 1. Foreign Origin on a POST: refused 403, no session created.
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/sessions" \
  -H 'Content-Type: application/json' -H 'Origin: https://evil.example' \
  -d "{\"repo\":\"$WORK/repo\",\"project\":\"fixture\",\"task\":\"driveby\"}")
[ "$code" = "403" ] || { echo "FAIL: foreign-Origin POST returned $code, expected 403"; exit 1; }
[ "$(api /api/sessions | jq 'length')" = "0" ] || { echo "FAIL: the drive-by POST created a session"; exit 1; }

# 2. A browser "simple request" shape (text/plain, no preflight):
# refused 415 before any handler runs.
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/sessions" \
  -H 'Content-Type: text/plain' \
  -d "{\"repo\":\"$WORK/repo\",\"project\":\"fixture\",\"task\":\"driveby\"}")
[ "$code" = "415" ] || { echo "FAIL: text/plain POST returned $code, expected 415"; exit 1; }
[ "$(api /api/sessions | jq 'length')" = "0" ] || { echo "FAIL: the simple-request POST created a session"; exit 1; }

# 3. The drip: one byte every 2s. The per-read timeout alone would
# let this run forever; the 30s whole-request deadline must drop it.
python3 - <<PYEOF
import socket, time, sys
s = socket.create_connection(("127.0.0.1", $PORT))
s.settimeout(45)
req = b"GET /api/sessions HTTP/1.1\r\nHost: x\r\n\r\n"
start = time.time()
got = b""
closed = False
try:
    for b in req:
        s.sendall(bytes([b]))
        time.sleep(2)
        s.settimeout(0.5)
        try:
            chunk = s.recv(4096)
            if chunk:
                got += chunk
                break
            closed = True  # EOF: the server hung up
            break
        except socket.timeout:
            pass
        s.settimeout(45)
except (ConnectionResetError, BrokenPipeError):
    closed = True
elapsed = time.time() - start
if got:
    print(f"FAIL: dripped request received a response after {elapsed:.0f}s — the deadline did not drop it")
    sys.exit(1)
if not closed and elapsed > 40:
    print("FAIL: drip connection was still open at 40s — no whole-request deadline")
    sys.exit(1)
print(f"drip dropped after {elapsed:.0f}s with no response")
PYEOF
[ $? -eq 0 ] || exit 1

# 4. Stale index.lock: a needs-you session (check failed) whose
# worktree git dir holds a lock from a killed git process. Age it
# past the staleness bound, make the agent's script write the file
# (the recorded agent path is the identity — replace its content),
# retry — the commit must now succeed instead of refusing forever.
cat > "$WORK/fail.sh" <<'EOF'
#!/bin/bash
echo "not writing the file"
EOF
chmod +x "$WORK/fail.sh"
curl -s -X POST "http://127.0.0.1:$PORT/api/sessions" -H 'Content-Type: application/json' \
  -d "{\"repo\":\"$WORK/repo\",\"project\":\"fixture\",\"task\":\"locked2\",\"agent\":\"$WORK/fail.sh\",\"check\":\"test -s output.txt\"}" >/dev/null
for i in $(seq 1 40); do
  st=$(api /api/sessions | jq -r '[.[] | select(.task=="locked2")][0].status')
  [ "$st" = "needs-you" ] && break
  sleep 0.5
done
ID2=$(api /api/sessions | jq -r '[.[] | select(.task=="locked2")][0].id')
WT2=$(api /api/sessions | jq -r '[.[] | select(.task=="locked2")][0].worktree')
GD2=$(git -C "$WT2" rev-parse --git-dir)
case "$GD2" in /*) LOCK2="$GD2/index.lock";; *) LOCK2="$WT2/$GD2/index.lock";; esac
touch -d '2 minutes ago' "$LOCK2"
# Point the session's agent at the working script by replacing the
# file the recorded agent path points to (the path is the identity).
cp "$WORK/agent.sh" "$WORK/fail.sh"
curl -s -X POST "http://127.0.0.1:$PORT/api/sessions/$ID2/retry" -H 'Content-Type: application/json' -d '{}' >/dev/null
for i in $(seq 1 40); do
  st=$(api /api/sessions | jq -r '[.[] | select(.task=="locked2")][0].status')
  [ "$st" = "done" ] && break
  sleep 0.5
done
[ "$st" = "done" ] || { echo "FAIL: stale-lock session reached '$st' after retry, expected done: $(api /api/sessions | jq -c '[.[] | select(.task=="locked2")][0].reason')"; exit 1; }

# 5. max_parallel floor: a policy naming 0 must not queue forever.
cat > "$WORK/policy0.rn" <<'EOF'
pub fn max_parallel() { 0 }
pub fn default_check(project) { "test -s output.txt" }
EOF
FLEET_AGENT="$WORK/agent.sh" FLEET_DATA="$WORK/data0" PORT=8504 \
  "${CARGO_TARGET_DIR:-./target}/debug/fleet-rs" "$WORK/policy0.rn" > "$WORK/server0.log" 2>&1 &
PIDS="$PIDS $!"
for i in $(seq 1 20); do curl -s http://127.0.0.1:8504/api/sessions >/dev/null 2>&1 && break; sleep 0.5; done
curl -s -X POST http://127.0.0.1:8504/api/sessions -H 'Content-Type: application/json' \
  -d "{\"repo\":\"$WORK/repo\",\"project\":\"fixture\",\"task\":\"floor\"}" >/dev/null
for i in $(seq 1 40); do
  st=$(curl -s http://127.0.0.1:8504/api/sessions | jq -r '.[0].status')
  [ "$st" = "done" ] && break
  sleep 0.5
done
[ "$st" = "done" ] || { echo "FAIL: max_parallel=0 session reached '$st', expected done (the floor is 1)"; exit 1; }
curl -s http://127.0.0.1:8504/api/policy | jq -e '.max_parallel >= 1' >/dev/null \
  || { echo "FAIL: /api/policy still reports a max_parallel below 1"; exit 1; }

echo "HTTP2 OK: foreign origins and simple-request POSTs are refused, the drip dies at the request deadline, stale index.locks are cleared, and max_parallel has a floor of 1"
