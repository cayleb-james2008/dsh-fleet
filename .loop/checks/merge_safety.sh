#!/bin/bash
# C7: merge is safe. A dirty repo is refused untouched; a repo with a
# merge already in progress is refused; a conflicting merge aborts
# cleanly (no MERGE_HEAD left, tree clean, session still done); a clean
# merge still succeeds.
set -u
cd "$(dirname "$0")/../.."
PORT=8485
WORK=$(mktemp -d)
PIDS=""
cleanup() { for p in $PIDS; do kill -9 $p 2>/dev/null; done; rm -rf "$WORK"; }
trap cleanup EXIT

[ -x "${CARGO_TARGET_DIR:-./target}/debug/fleet-rs" ] || cargo build >/dev/null 2>&1

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
post() { curl -s -w "\n%{http_code}" -X POST "http://127.0.0.1:$PORT$1" -H 'Content-Type: application/json' -d "$2"; }
for i in $(seq 1 20); do api /api/sessions >/dev/null 2>&1 && break; sleep 0.5; done

post /api/sessions "{\"repo\":\"$WORK/repo\",\"project\":\"fixture\",\"task\":\"alpha task\"}" >/dev/null
for i in $(seq 1 40); do
  st=$(api /api/sessions | jq -r '.[0].status')
  [ "$st" = "done" ] && break
  sleep 0.5
done
[ "$st" = "done" ] || { echo "FAIL: session reached '$st', expected done"; exit 1; }
ID=$(api /api/sessions | jq -r '.[0].id')
BR=$(api /api/sessions | jq -r '.[0].branch')

# 1. Dirty repo: refused, untouched.
echo "operator's uncommitted edit" >> "$WORK/repo/README.md"
resp=$(post "/api/sessions/$ID/merge" '{}')
code=$(echo "$resp" | tail -1); body=$(echo "$resp" | sed '$d')
[ "$code" = "409" ] || { echo "FAIL: dirty-repo merge returned $code, expected 409: $body"; exit 1; }
echo "$body" | grep -qi "uncommitted" || { echo "FAIL: dirty refusal does not say why: $body"; exit 1; }
[ ! -f "$WORK/repo/output.txt" ] || { echo "FAIL: dirty-repo merge went ahead anyway"; exit 1; }
grep -q "operator's uncommitted edit" "$WORK/repo/README.md" || { echo "FAIL: operator's edit was disturbed"; exit 1; }
git -C "$WORK/repo" checkout -- README.md

# 2. Conflicting state on main + a merge already in progress: refused.
printf 'main version\n' > "$WORK/repo/output.txt"
git -C "$WORK/repo" add -A
git -C "$WORK/repo" -c user.email=p@p -c user.name=proof commit -qm "main output"
git -C "$WORK/repo" merge "$BR" >/dev/null 2>&1 || true
[ -f "$WORK/repo/.git/MERGE_HEAD" ] || { echo "FAIL: test setup could not create an in-progress merge"; exit 1; }
resp=$(post "/api/sessions/$ID/merge" '{}')
code=$(echo "$resp" | tail -1); body=$(echo "$resp" | sed '$d')
[ "$code" = "409" ] || { echo "FAIL: in-progress merge returned $code, expected 409: $body"; exit 1; }
echo "$body" | grep -qi "in progress" || { echo "FAIL: in-progress refusal does not say why: $body"; exit 1; }
git -C "$WORK/repo" merge --abort

# 3. A merge the app attempts that conflicts: aborted cleanly.
resp=$(post "/api/sessions/$ID/merge" '{}')
code=$(echo "$resp" | tail -1); body=$(echo "$resp" | sed '$d')
[ "$code" = "409" ] || { echo "FAIL: conflicting merge returned $code, expected 409: $body"; exit 1; }
echo "$body" | grep -qi "conflict" || { echo "FAIL: conflict error does not name the conflict: $body"; exit 1; }
[ ! -f "$WORK/repo/.git/MERGE_HEAD" ] || { echo "FAIL: repo left mid-merge (MERGE_HEAD present)"; exit 1; }
[ -z "$(git -C "$WORK/repo" status --porcelain)" ] || { echo "FAIL: repo left dirty after aborted merge"; exit 1; }
st=$(api /api/sessions | jq -r '.[0].status')
[ "$st" = "done" ] || { echo "FAIL: session became '$st' after aborted merge, expected done"; exit 1; }
grep -q "main version" "$WORK/repo/output.txt" || { echo "FAIL: main's version was overwritten by the aborted merge"; exit 1; }

# 4. Remove the collision: the same merge now succeeds.
git -C "$WORK/repo" rm -q output.txt
git -C "$WORK/repo" -c user.email=p@p -c user.name=proof commit -qm "remove main output"
resp=$(post "/api/sessions/$ID/merge" '{}')
code=$(echo "$resp" | tail -1)
[ "$code" = "200" ] || { echo "FAIL: clean merge returned $code: $resp"; exit 1; }
grep -q "agent version" "$WORK/repo/output.txt" || { echo "FAIL: merged content is not the agent's version"; exit 1; }

# 5. Gitignored work product can never land: the session must NOT be
# allowed to call itself verified done. Its check passes in the
# worktree (the file exists there), but the repo gitignores the file,
# so nothing could ever be committed or merged.
git init -q -b main "$WORK/repo2"
echo "seed" > "$WORK/repo2/README.md"
printf 'output.txt\n' > "$WORK/repo2/.gitignore"
git -C "$WORK/repo2" add -A
git -C "$WORK/repo2" -c user.email=p@p -c user.name=proof commit -qm init
post /api/sessions "{\"repo\":\"$WORK/repo2\",\"project\":\"fixture\",\"task\":\"ignored task\"}" >/dev/null
for i in $(seq 1 40); do
  st2=$(api /api/sessions | jq -r '.[1].status')
  [ "$st2" = "needs-you" ] || [ "$st2" = "done" ] && break
  sleep 0.5
done
[ "$st2" = "needs-you" ] || { echo "FAIL: session whose work product is gitignored reached '$st2' — it can never land, so 'done' would be invented"; exit 1; }
api /api/sessions | jq -e '.[1].reason | test("gitignore"; "i")' >/dev/null \
  || { echo "FAIL: gitignored-output session's reason does not name the gitignore problem: $(api /api/sessions | jq -c '.[1].reason')"; exit 1; }
# The check judges the committed tree (B16/B20): the work product
# is not in that tree, so the check did NOT pass there, and the
# record must say so — recording a pass from the mutable worktree
# was the pre-B16 shape round 3 broke.
api /api/sessions | jq -e '.[1].check_passed == false' >/dev/null \
  || { echo "FAIL: the check should be recorded as failed on the committed tree (the work product is not in it)"; exit 1; }

# 6. An untracked-file collision is a refusal, not a conflict — and
# the error must name the file it is about. The operator's untracked
# file stays untouched and the session stays done.
git init -q -b main "$WORK/repo3"
echo "seed" > "$WORK/repo3/README.md"
git -C "$WORK/repo3" add -A
git -C "$WORK/repo3" -c user.email=p@p -c user.name=proof commit -qm init
printf 'operator version\n' > "$WORK/repo3/output.txt"
post /api/sessions "{\"repo\":\"$WORK/repo3\",\"project\":\"fixture\",\"task\":\"collide task\"}" >/dev/null
for i in $(seq 1 40); do
  st3=$(api /api/sessions | jq -r '.[2].status')
  [ "$st3" = "done" ] && break
  sleep 0.5
done
[ "$st3" = "done" ] || { echo "FAIL: collision session reached '$st3', expected done"; exit 1; }
ID3=$(api /api/sessions | jq -r '.[2].id')
resp=$(post "/api/sessions/$ID3/merge" '{}')
code=$(echo "$resp" | tail -1)
[ "$code" = "409" ] || { echo "FAIL: untracked-collision merge returned $code, expected 409: $resp"; exit 1; }
err=$(echo "$resp" | head -1 | jq -r '.error')
case "$err" in *"merge conflict"*) echo "FAIL: an untracked collision is mislabelled a conflict: $err"; exit 1;; esac
case "$err" in *output.txt*) : ;; *) echo "FAIL: collision error does not name the file: $err"; exit 1;; esac
grep -q "operator version" "$WORK/repo3/output.txt" || { echo "FAIL: the operator's untracked file was touched"; exit 1; }
st3=$(api /api/sessions | jq -r '.[2].status')
[ "$st3" = "done" ] || { echo "FAIL: session left '$st3' after the refused merge, expected done"; exit 1; }

echo "MERGE SAFETY OK: dirty and in-progress repos refused, conflicts abort clean, clean merges land, gitignored work is never called done, untracked collisions are named refusals"
