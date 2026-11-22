#!/bin/bash
# B16 (merge side): a merge consumes the exact commit the check
# verified — never the branch's later tip; a detached HEAD is refused;
# a session whose branch was deleted leaves the dead "done" state for
# Needs you, from which retry recovers it.
set -u
cd "$(dirname "$0")/../.."
PORT=8502
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
cat > "$WORK/agent2.sh" <<'EOF'
#!/bin/bash
printf 'agent version\n' > detached.txt
EOF
cat > "$WORK/agent3.sh" <<'EOF'
#!/bin/bash
printf 'agent version\n' > orphan.txt
EOF
chmod +x "$WORK/agent.sh" "$WORK/agent2.sh" "$WORK/agent3.sh"

FLEET_DATA="$WORK/data" PORT=$PORT "${CARGO_TARGET_DIR:-./target}/debug/fleet" policies.rn > "$WORK/server.log" 2>&1 &
PIDS="$PIDS $!"
api() { curl -s "http://127.0.0.1:$PORT$1"; }
post() { curl -s -w "\n%{http_code}" -X POST "http://127.0.0.1:$PORT$1" -H 'Content-Type: application/json' -d "$2"; }
for i in $(seq 1 20); do api /api/sessions >/dev/null 2>&1 && break; sleep 0.5; done

wait_status() { # id wanted
  local st=""
  for i in $(seq 1 60); do
    st=$(api /api/sessions | jq -r --arg id "$1" '.[] | select(.id==$id) | .status')
    [ "$st" = "$2" ] && { echo "$st"; return; }
    sleep 0.5
  done
  echo "$st"
}

# --- Session 1: the pin. Done, then an UNVERIFIED commit is added to
# its branch by hand. The merge must land the verified commit only.
post /api/sessions "{\"repo\":\"$WORK/repo\",\"project\":\"fixture\",\"task\":\"pinned\",\"agent\":\"$WORK/agent.sh\"}" >/dev/null
ID=$(api /api/sessions | jq -r '.[0].id')
BR=$(api /api/sessions | jq -r '.[0].branch')
WT=$(api /api/sessions | jq -r '.[0].worktree')
[ "$(wait_status "$ID" done)" = "done" ] || { echo "FAIL: session 1 did not reach done"; api /api/sessions; exit 1; }
PIN=$(api /api/sessions | jq -r '.[0].verified_commit')
[ -n "$PIN" ] && [ "$PIN" != "null" ] || { echo "FAIL: done session carries no verified_commit"; api /api/sessions; exit 1; }
printf 'unreviewed\n' > "$WT/extra.txt"
git -C "$WT" add -A
git -C "$WT" -c user.email=x@x -c user.name=x commit -qm "unreviewed extra"
resp=$(post "/api/sessions/$ID/merge" '{}')
code=$(echo "$resp" | tail -1); body=$(echo "$resp" | sed '$d')
[ "$code" = "200" ] || { echo "FAIL: pinned merge returned $code: $body"; exit 1; }
echo "$body" | jq -e --arg pin "$PIN" '.merged == true and .commit == $pin' >/dev/null \
  || { echo "FAIL: merge response does not name the verified commit: $body (pin $PIN)"; exit 1; }
[ -f "$WORK/repo/output.txt" ] || { echo "FAIL: verified work did not land"; exit 1; }
[ ! -f "$WORK/repo/extra.txt" ] || { echo "FAIL: UNVERIFIED commit landed via the branch tip"; exit 1; }
git -C "$WORK/repo" merge-base --is-ancestor "$PIN" HEAD || { echo "FAIL: pin is not in repo history"; exit 1; }

# --- Session 2: detached HEAD is refused, session stays done.
post /api/sessions "{\"repo\":\"$WORK/repo\",\"project\":\"fixture\",\"task\":\"detached\",\"agent\":\"$WORK/agent2.sh\",\"check\":\"test -s detached.txt\"}" >/dev/null
ID2=$(api /api/sessions | jq -r '[.[] | select(.task=="detached")][0].id')
[ "$(wait_status "$ID2" done)" = "done" ] || { echo "FAIL: session 2 did not reach done"; exit 1; }
git -C "$WORK/repo" checkout -q --detach HEAD
resp=$(post "/api/sessions/$ID2/merge" '{}')
code=$(echo "$resp" | tail -1); body=$(echo "$resp" | sed '$d')
[ "$code" = "409" ] || { echo "FAIL: detached-HEAD merge returned $code, expected 409: $body"; exit 1; }
echo "$body" | grep -qi 'detached' || { echo "FAIL: refusal does not name the detached HEAD: $body"; exit 1; }
[ "$(api /api/sessions | jq -r --arg id "$ID2" '.[] | select(.id==$id) | .status')" = "done" ] \
  || { echo "FAIL: session 2 left done after a detached refusal"; exit 1; }
git -C "$WORK/repo" checkout -q main

# --- Session 3: branch deleted under a done session. Merge moves it
# to Needs you (no dead state); retry re-runs it to done.
post /api/sessions "{\"repo\":\"$WORK/repo\",\"project\":\"fixture\",\"task\":\"orphan\",\"agent\":\"$WORK/agent3.sh\",\"check\":\"test -s orphan.txt\"}" >/dev/null
ID3=$(api /api/sessions | jq -r '[.[] | select(.task=="orphan")][0].id')
BR3=$(api /api/sessions | jq -r --arg id "$ID3" '.[] | select(.id==$id) | .branch')
WT3=$(api /api/sessions | jq -r --arg id "$ID3" '.[] | select(.id==$id) | .worktree')
[ "$(wait_status "$ID3" done)" = "done" ] || { echo "FAIL: session 3 did not reach done"; exit 1; }
git -C "$WORK/repo" worktree remove --force "$WT3" >/dev/null 2>&1 || rm -rf "$WT3"
git -C "$WORK/repo" branch -D "$BR3" >/dev/null
resp=$(post "/api/sessions/$ID3/merge" '{}')
code=$(echo "$resp" | tail -1)
[ "$code" = "409" ] || { echo "FAIL: branch-gone merge returned $code, expected 409"; exit 1; }
[ "$(api /api/sessions | jq -r --arg id "$ID3" '.[] | select(.id==$id) | .status')" = "needs-you" ] \
  || { echo "FAIL: branch-gone session did not move to needs-you"; api /api/sessions; exit 1; }
post "/api/sessions/$ID3/retry" '{}' >/dev/null
[ "$(wait_status "$ID3" done)" = "done" ] || { echo "FAIL: retried orphan did not recover to done"; api /api/sessions; exit 1; }

echo "MERGE2 OK: merges consume the verified commit only, detached HEADs are refused, and a deleted branch is a recoverable Needs you — never a dead done"
