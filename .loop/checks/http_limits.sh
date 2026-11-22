#!/bin/bash
# B15/D9: the HTTP layer bounds what a connection can hold: a declared
# body over the cap is refused 413 without being read, and a connection
# that never finishes its request is dropped by the read timeout
# instead of holding its handler thread forever.
set -u
cd "$(dirname "$0")/../.."
PORT=8401
WORK=$(mktemp -d)
PIDS=""
cleanup() { for p in $PIDS; do kill -9 $p 2>/dev/null; done; rm -rf "$WORK"; }
trap cleanup EXIT

[ -x "${CARGO_TARGET_DIR:-./target}/debug/fleet" ] || cargo build >/dev/null 2>&1
FLEET_DATA="$WORK/data" PORT=$PORT "${CARGO_TARGET_DIR:-./target}/debug/fleet" policies.rn > "$WORK/server.log" 2>&1 &
PIDS="$PIDS $!"
for i in $(seq 1 20); do curl -s "http://127.0.0.1:$PORT/api/sessions" >/dev/null 2>&1 && break; sleep 0.5; done

python3 - "$PORT" <<'PYEOF'
import socket, sys, time
port = int(sys.argv[1])

# 1. Oversized declared body: refused 413, promptly, without the body.
s = socket.create_connection(("127.0.0.1", port), timeout=10)
s.sendall(b"POST /api/sessions HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 5000000\r\n\r\n")
s.settimeout(10)
resp = s.recv(4096).decode("utf-8", "replace")
s.close()
assert "413" in resp, f"expected a 413 for an oversized declared body, got: {resp[:120]!r}"

# 2. A request that never completes is dropped by the read timeout.
s = socket.create_connection(("127.0.0.1", port), timeout=10)
s.sendall(b"GET /api/sessions HTTP/1.1\r\nHost: 127.0.0.1\r\n")  # no terminating blank line
s.settimeout(25)
t0 = time.time()
try:
    data = s.recv(4096)
    dropped = data == b""
except (ConnectionResetError, BrokenPipeError):
    dropped = True
except socket.timeout:
    dropped = False
elapsed = time.time() - t0
s.close()
assert dropped, "server held a never-completing request open past 25s"
assert elapsed < 24, f"connection dropped only after {elapsed:.0f}s"
print(f"python probes ok (drip connection dropped after {elapsed:.0f}s)")
PYEOF
[ $? -eq 0 ] || { echo "FAIL: HTTP limit probes failed"; exit 1; }

# The server is still healthy for normal traffic afterwards.
curl -s "http://127.0.0.1:$PORT/api/sessions" | grep -q '\[\]' \
  || { echo "FAIL: server unhealthy after the hostile connections"; exit 1; }

echo "HTTP LIMITS OK: oversized bodies refused 413 unread; stalled requests dropped by the read timeout"
