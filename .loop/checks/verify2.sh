#!/bin/bash
# B20: round 3's structural findings. The check now runs in a
# pristine checkout of the pinned commit; the gates read the
# session's own delta with NUL-separated git output; index bits are
# cleared before staging; detached (setsid) processes holding the
# worktree are swept at settle; the request deadline covers the
# body; absurd policy timeouts are clamped.
#   1. assume-unchanged: the hidden change is committed, checked,
#      merged — the landed file is the checked file
#   2. a check that edits files judges the pinned tree (its edits
#      stay in the throwaway checkout); the merge lands the commit
#   3. a check that builds an ignored artifact from committed
#      sources passes on the pinned tree
#   4. a non-ASCII-named symlink out of the repo is gated
#   5. a pre-existing gitlink does NOT block a clean session
#   6. a setsid ghost writer is killed when the run settles
#   7. a body drip is dropped at the whole-request deadline
#   8. timeout_secs = i64::MAX is clamped; the session still settles
#   9. needs-you + check-passed does not wear the verified claim
#  10. the merge response names the branch it landed on
set -u
cd "$(dirname "$0")/../.."
PORT=8551
WORK=$(mktemp -d)
PIDS=""
cleanup() { for p in $PIDS; do kill -9 $p 2>/dev/null; done; rm -rf "$WORK"; }
trap cleanup EXIT

export PATH="$HOME/.rust/bin:$PATH"
cargo build >/dev/null 2>&1 || { echo "FAIL: cargo build failed"; exit 1; }

mkrepo() { git init -q -b main "$WORK/$1"; }
seed() { git -C "$WORK/$1" add -A && git -C "$WORK/$1" -c user.email=p@p -c user.name=proof commit -qm init; }
agent() { printf '#!/bin/bash\n%s\n' "$2" > "$WORK/$1.sh"; chmod +x "$WORK/$1.sh"; }

# 1. index bits
mkrepo r_bits; printf 'bad\n' > "$WORK/r_bits/result.txt"; seed r_bits
agent a_bits "printf 'good\n' > result.txt && git update-index --assume-unchanged result.txt && printf 'note\n' > note.txt"
# 2. check mutates
mkrepo r_mut; printf 'bad\n' > "$WORK/r_mut/data.txt"; seed r_mut
agent a_mut "printf 'work\n' > output.txt"
# 3. check builds an ignored artifact
mkrepo r_gen; printf 'build/\n' > "$WORK/r_gen/.gitignore"; seed r_gen
agent a_gen "printf '#!/bin/bash\nmkdir -p build && printf made > build/out.txt\n' > gen.sh && chmod +x gen.sh && printf 'note\n' > note.txt"
# 4. non-ASCII symlink
mkrepo r_link; seed r_link 2>/dev/null || { echo seed > "$WORK/r_link/README.md"; seed r_link; }
agent a_link "printf 'work\n' > output.txt && ln -s /etc/passwd 'léen'"
# 5. pre-existing gitlink (committed straight into the index —
# an add -A would drop it, since no directory exists for it)
mkrepo r_sub
echo seed > "$WORK/r_sub/README.md"
git -C "$WORK/r_sub" add README.md
git -C "$WORK/r_sub" -c user.email=p@p -c user.name=proof commit -qm init
git -C "$WORK/r_sub" update-index --add --cacheinfo 160000,1111111111111111111111111111111111111111,vendor/sub
git -C "$WORK/r_sub" -c user.email=p@p -c user.name=proof commit -qm gitlink
agent a_clean "printf 'work\n' > output.txt"

FLEET_DATA="$WORK/data" PORT=$PORT ./target/debug/fleet-rs policies.rn > "$WORK/server.log" 2>&1 &
PIDS="$PIDS $!"
api() { curl -s "http://127.0.0.1:$PORT$1"; }
post() { curl -s -X POST "http://127.0.0.1:$PORT$1" -H 'Content-Type: application/json' -d "$2"; }
for i in $(seq 1 20); do api /api/sessions >/dev/null 2>&1 && break; sleep 0.5; done

run_case() { # repo agent check tasklabel — echoes "status<TAB>reason<TAB>id"
  post /api/sessions "{\"repo\":\"$WORK/$1\",\"project\":\"fixture\",\"task\":\"$4\",\"agent\":\"$WORK/$2.sh\",\"check\":\"$3\"}" >/dev/null
  local id st
  id=$(api /api/sessions | jq -r --arg t "$4" '[.[] | select(.task==$t)][0].id')
  for i in $(seq 1 80); do
    st=$(api "/api/sessions" | jq -r --arg id "$id" '.[] | select(.id==$id) | .status')
    case "$st" in done|needs-you|merged) break;; esac
    sleep 0.5
  done
  api /api/sessions | jq -r --arg id "$id" '.[] | select(.id==$id) | [.status, (.reason // ""), .id] | @tsv'
}

# Case 1: the assume-unchanged change lands for real.
res=$(run_case r_bits a_bits "grep -q good result.txt" "case bits")
[ "$(echo "$res" | cut -f1)" = "done" ] || { echo "FAIL [bits]: $res"; exit 1; }
id1=$(echo "$res" | cut -f3)
mres=$(post "/api/sessions/$id1/merge" "")
echo "$mres" | jq -e '.merged == true and .branch == "main"' >/dev/null \
  || { echo "FAIL [bits/merge]: response does not name the landing branch: $mres"; exit 1; }
[ "$(cat "$WORK/r_bits/result.txt")" = "good" ] \
  || { echo "FAIL [bits]: merged repo does not hold the checked content: $(cat "$WORK/r_bits/result.txt")"; exit 1; }

# Case 2: the check's own edits never land; the commit is what merged.
res=$(run_case r_mut a_mut "sed -i s/bad/good/ data.txt; grep -q good data.txt" "case mut")
[ "$(echo "$res" | cut -f1)" = "done" ] || { echo "FAIL [mut]: $res"; exit 1; }
id2=$(echo "$res" | cut -f3)
post "/api/sessions/$id2/merge" "" >/dev/null
[ "$(cat "$WORK/r_mut/data.txt")" = "bad" ] \
  || { echo "FAIL [mut]: the check's scratch edit landed in the repo: $(cat "$WORK/r_mut/data.txt")"; exit 1; }

# Case 3: a generated artifact verifies against the pinned tree.
res=$(run_case r_gen a_gen "./gen.sh && test -s build/out.txt" "case gen")
[ "$(echo "$res" | cut -f1)" = "done" ] || { echo "FAIL [gen]: $res"; exit 1; }

# Case 4: the quoted-name symlink is gated, and the session's API
# state (check passed, needs you) is the one the page must not call
# verified — the page carries the honest banner text for it.
res=$(run_case r_link a_link "test -s output.txt" "case link")
[ "$(echo "$res" | cut -f1)" = "needs-you" ] || { echo "FAIL [link]: $res"; exit 1; }
echo "$res" | cut -f2 | grep -q 'léen' || { echo "FAIL [link]: reason does not name the path: $res"; exit 1; }
id4=$(echo "$res" | cut -f3)
api /api/sessions | jq -e --arg id "$id4" '.[] | select(.id==$id) | .check_passed == true and .status == "needs-you"' >/dev/null \
  || { echo "FAIL [link/ui]: session is not in the check-passed needs-you state"; exit 1; }
curl -s "http://127.0.0.1:$PORT/" | grep -q 'Check passed — but this session needs you' \
  || { echo "FAIL [link/ui]: the page lacks the honest banner for a check-passed needs-you session"; exit 1; }

# Case 5: the pre-existing gitlink is not this session's problem.
res=$(run_case r_sub a_clean "test -s output.txt" "case sub")
[ "$(echo "$res" | cut -f1)" = "done" ] || { echo "FAIL [sub]: a pre-existing gitlink blocked a clean session: $res"; exit 1; }

# Case 6: a setsid ghost is swept when the run settles (timeout 3s).
cat > "$WORK/pol3.rn" <<'RN'
pub fn max_parallel() { 4 }
pub fn timeout_secs() { 3 }
pub fn default_check(project) { "test -s output.txt" }
RN
agent a_ghost "printf 'real\n' > output.txt && setsid sh -c 'sleep 5; echo GHOST >> output.txt' </dev/null >/dev/null 2>&1 & sleep 30"
FLEET_DATA="$WORK/data3" PORT=8552 ./target/debug/fleet-rs "$WORK/pol3.rn" > "$WORK/server3.log" 2>&1 &
PIDS="$PIDS $!"
for i in $(seq 1 20); do curl -s "http://127.0.0.1:8552/api/sessions" >/dev/null 2>&1 && break; sleep 0.5; done
curl -s -X POST "http://127.0.0.1:8552/api/sessions" -H 'Content-Type: application/json' \
  -d "{\"repo\":\"$WORK/r_link\",\"project\":\"fixture\",\"task\":\"ghost case\",\"agent\":\"$WORK/a_ghost.sh\",\"check\":\"test -s output.txt\"}" >/dev/null
for i in $(seq 1 30); do
  st=$(curl -s "http://127.0.0.1:8552/api/sessions" | jq -r '.[0].status')
  [ "$st" = "needs-you" ] && break; sleep 0.5
done
[ "$st" = "needs-you" ] || { echo "FAIL [ghost]: session did not settle needs-you ($st)"; exit 1; }
wt6=$(curl -s "http://127.0.0.1:8552/api/sessions" | jq -r '.[0].worktree')
sleep 5
grep -q GHOST "$wt6/output.txt" && { echo "FAIL [ghost]: a setsid writer kept writing into the settled worktree"; exit 1; }
curl -s "http://127.0.0.1:8552/api/sessions" | jq -r '.[0].transcript | join("\n")' | grep -q 'detached process' \
  || { echo "FAIL [ghost]: the sweep was not recorded in the transcript"; exit 1; }

# Case 7: a body drip dies at the whole-request deadline (~30s),
# not at twice it.
before=$(api /api/sessions | jq 'length')
python3 - "$PORT" <<'PYEOF'
import socket, sys, time
port = int(sys.argv[1])
body = b'{"repo":"/tmp","task":"drip","agent":"x","check":"true"}'
s = socket.create_connection(("127.0.0.1", port))
s.sendall(b"POST /api/sessions HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: " + str(len(body)).encode() + b"\r\n\r\n")
s.sendall(body[:-30])
start = time.time()
try:
    for b in body[-30:]:
        s.sendall(bytes([b]))
        time.sleep(2)
        s.settimeout(0.5)
        try:
            data = s.recv(1024)
            if data == b"":
                break
        except socket.timeout:
            pass
except (BrokenPipeError, ConnectionResetError):
    pass
elapsed = time.time() - start
print(f"drip connection ended after {elapsed:.1f}s")
assert elapsed < 45, f"the drip outlived the deadline: {elapsed:.1f}s"
PYEOF
[ $? -eq 0 ] || { echo "FAIL [drip]: body drip outlived the whole-request deadline"; exit 1; }
after=$(api /api/sessions | jq 'length')
[ "$before" = "$after" ] || { echo "FAIL [drip]: the dripped request created a session"; exit 1; }

# Case 8: an absurd policy timeout is clamped, and work still settles.
cat > "$WORK/polmax.rn" <<'RN'
pub fn max_parallel() { 4 }
pub fn timeout_secs() { 9223372036854775807 }
pub fn default_check(project) { "test -s output.txt" }
RN
agent a_fast "printf 'work\n' > output.txt"
FLEET_DATA="$WORK/data8" PORT=8553 ./target/debug/fleet-rs "$WORK/polmax.rn" > "$WORK/server8.log" 2>&1 &
PIDS="$PIDS $!"
for i in $(seq 1 20); do curl -s "http://127.0.0.1:8553/api/policy" >/dev/null 2>&1 && break; sleep 0.5; done
curl -s "http://127.0.0.1:8553/api/policy" | jq -e '.timeout_secs == 604800' >/dev/null \
  || { echo "FAIL [clamp]: timeout_secs not clamped: $(curl -s http://127.0.0.1:8553/api/policy)"; exit 1; }
curl -s -X POST "http://127.0.0.1:8553/api/sessions" -H 'Content-Type: application/json' \
  -d "{\"repo\":\"$WORK/r_sub\",\"project\":\"fixture\",\"task\":\"clamp case\",\"agent\":\"$WORK/a_fast.sh\",\"check\":\"test -s output.txt\"}" >/dev/null
for i in $(seq 1 40); do
  st=$(curl -s "http://127.0.0.1:8553/api/sessions" | jq -r '.[0].status')
  case "$st" in done|needs-you) break;; esac
  sleep 0.5
done
[ "$st" = "done" ] || { echo "FAIL [clamp]: a trivial session did not settle under the clamped policy ($st)"; exit 1; }

echo "VERIFY2 OK: pristine-tree checks, delta gates with -z parsing, index bits committed, setsid sweep, body deadline, timeout clamp, honest banner state, named merge branch"
