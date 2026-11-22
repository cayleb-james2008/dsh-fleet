#!/bin/bash
# C6: the needs-you inbox aggregates every session that needs the
# operator, each with its reason; retry re-runs a needs-you session in
# its existing worktree.
set -u
cd "$(dirname "$0")/../.."
PORT=8484
WORK=$(mktemp -d)
PIDS=""
cleanup() { for p in $PIDS; do kill -9 $p 2>/dev/null; done; rm -rf "$WORK"; }
trap cleanup EXIT

[ -x "${CARGO_TARGET_DIR:-./target}/debug/fleet" ] || cargo build >/dev/null 2>&1

git init -q -b main "$WORK/repo"
echo "seed" > "$WORK/repo/README.md"
git -C "$WORK/repo" add -A
git -C "$WORK/repo" -c user.email=p@p -c user.name=proof commit -qm init

# Stateful fixture agent: writes output.txt only when $ALLOW exists;
# crashes on tasks containing "crash".
cat > "$WORK/agent.sh" <<EOF
#!/bin/bash
case "\$1" in *crash*) echo "boom"; exit 1;; esac
if [ -f "$WORK/allow" ]; then printf 'result of: %s\n' "\$1" > output.txt; fi
echo "agent ran: \$1"
EOF
chmod +x "$WORK/agent.sh"

FLEET_AGENT="$WORK/agent.sh" FLEET_DATA="$WORK/data" PORT=$PORT \
  "${CARGO_TARGET_DIR:-./target}/debug/fleet" policies.rn > "$WORK/server.log" 2>&1 &
PIDS="$PIDS $!"
api() { curl -s "http://127.0.0.1:$PORT$1"; }
post() { curl -s -w "\n%{http_code}" -X POST "http://127.0.0.1:$PORT$1" -H 'Content-Type: application/json' -d "$2"; }
for i in $(seq 1 20); do api /api/sessions >/dev/null 2>&1 && break; sleep 0.5; done

wait_status() { # id index, want
  for i in $(seq 1 40); do
    st=$(api /api/sessions | jq -r ".[$1].status")
    [ "$st" = "$2" ] && return 0
    sleep 0.5
  done
  echo "FAIL: session $1 reached '$st', expected '$2'"; exit 1
}

post /api/sessions "{\"repo\":\"$WORK/repo\",\"project\":\"fixture\",\"task\":\"alpha task\"}" >/dev/null
wait_status 0 needs-you
post /api/sessions "{\"repo\":\"$WORK/repo\",\"project\":\"fixture\",\"task\":\"crash task\"}" >/dev/null
wait_status 1 needs-you

inbox=$(api /api/inbox)
n=$(echo "$inbox" | jq 'length')
[ "$n" = "2" ] || { echo "FAIL: inbox holds $n entries, expected 2: $inbox"; exit 1; }
echo "$inbox" | jq -e '.[] | select(.task=="alpha task") | select(.reason | test("[Cc]heck failed"))' >/dev/null \
  || { echo "FAIL: alpha's inbox reason does not name the failed check: $inbox"; exit 1; }
echo "$inbox" | jq -e '.[] | select(.task=="crash task") | select(.reason | test("agent exited"))' >/dev/null \
  || { echo "FAIL: crash's inbox reason does not name the agent exit: $inbox"; exit 1; }

# A done session never appears in the inbox.
touch "$WORK/allow"
post /api/sessions "{\"repo\":\"$WORK/repo\",\"project\":\"fixture\",\"task\":\"beta task\"}" >/dev/null
wait_status 2 done
echo "$inbox" | jq -e '.[] | select(.task=="beta task")' >/dev/null 2>&1 \
  && { echo "FAIL: done session present in a stale inbox read"; exit 1; }
inbox=$(api /api/inbox)
echo "$inbox" | jq -e '.[] | select(.task=="beta task")' >/dev/null 2>&1 \
  && { echo "FAIL: done session appears in inbox"; exit 1; }

# Retry the check-failed session: the agent can now produce the output.
ID_A=$(api /api/sessions | jq -r '.[0].id')
resp=$(post "/api/sessions/$ID_A/retry" '{}')
code=$(echo "$resp" | tail -1)
[ "$code" = "200" ] || { echo "FAIL: retry returned $code: $resp"; exit 1; }
wait_status 0 done
inbox=$(api /api/inbox)
n=$(echo "$inbox" | jq 'length')
[ "$n" = "1" ] || { echo "FAIL: after successful retry inbox holds $n, expected 1"; exit 1; }
api "/api/sessions/$ID_A" | jq -e '.transcript | join(" ") | test("retry"; "i")' >/dev/null \
  || { echo "FAIL: retried session's transcript does not record the retry"; exit 1; }

# Retry is refused for a session that does not need the operator.
resp=$(post "/api/sessions/$ID_A/retry" '{}')
code=$(echo "$resp" | tail -1)
[ "$code" = "409" ] || { echo "FAIL: retry of a done session returned $code, expected 409"; exit 1; }

echo "INBOX OK: needs-you work aggregates with reasons; retry re-runs and clears"
