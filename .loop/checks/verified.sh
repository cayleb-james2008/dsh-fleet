#!/bin/bash
# B16: "verified done" describes the COMMITTED tree, never a moment in
# the worktree. Five ways the old flow invented done, each now a
# needs-you with the problem named:
#   1. the work product lives in a gitignored DIRECTORY
#   2. the work product is a nested git repository (bare gitlink)
#   3. the work product is a symlink out of the repo
#   4. the session produced no changes at all (check passed on
#      pre-existing state)
#   5. a pre-commit hook rewrites the file during commit — the check
#      judges the committed tree, so the rewrite fails it
set -u
cd "$(dirname "$0")/../.."
PORT=8501
WORK=$(mktemp -d)
PIDS=""
cleanup() { for p in $PIDS; do kill -9 $p 2>/dev/null; done; rm -rf "$WORK"; }
trap cleanup EXIT

export PATH="$HOME/.rust/bin:$PATH"
cargo build >/dev/null 2>&1 || { echo "FAIL: cargo build failed"; exit 1; }

mkrepo() { # name gitignore-extra
  git init -q -b main "$WORK/$1"
  echo "seed" > "$WORK/$1/README.md"
  [ -n "${2:-}" ] && printf '%s\n' "$2" > "$WORK/$1/.gitignore"
  git -C "$WORK/$1" add -A
  git -C "$WORK/$1" -c user.email=p@p -c user.name=proof commit -qm init
}
agent() { # name body
  printf '#!/bin/bash\n%s\n' "$2" > "$WORK/$1.sh"; chmod +x "$WORK/$1.sh"
}
agent a_dir "mkdir -p build && printf 'product\\n' > build/result.txt"
agent a_sub "mkdir -p sub && printf 'product\\n' > sub/output.txt && git -C sub init -q && git -C sub add -A && git -C sub -c user.email=a@a -c user.name=a commit -qm inner"
agent a_link "ln -s /etc/hostname output.txt"
agent a_none "echo just talking"
agent a_hook "printf 'agent version\\n' > output.txt"

FLEET_DATA="$WORK/data" PORT=$PORT "${CARGO_TARGET_DIR:-./target}/debug/fleet-rs" policies.rn > "$WORK/server.log" 2>&1 &
PIDS="$PIDS $!"
api() { curl -s "http://127.0.0.1:$PORT$1"; }
post() { curl -s -X POST "http://127.0.0.1:$PORT$1" -H 'Content-Type: application/json' -d "$2"; }
for i in $(seq 1 20); do api /api/sessions >/dev/null 2>&1 && break; sleep 0.5; done

run_case() { # repo agent check — echoes "status<TAB>reason"
  post /api/sessions "{\"repo\":\"$WORK/$1\",\"project\":\"fixture\",\"task\":\"case $1\",\"agent\":\"$WORK/$2.sh\",\"check\":\"$3\"}" >/dev/null
  local id st
  id=$(api /api/sessions | jq -r '[.[] | select(.task=="case '"$1"'")][0].id')
  for i in $(seq 1 60); do
    st=$(api "/api/sessions" | jq -r --arg id "$id" '.[] | select(.id==$id) | .status')
    case "$st" in done|needs-you|merged) break;; esac
    sleep 0.5
  done
  api /api/sessions | jq -r --arg id "$id" '.[] | select(.id==$id) | [.status, (.reason // "")] | @tsv'
}

expect_needs_you() { # label result needle
  local st reason
  st=$(echo "$2" | cut -f1); reason=$(echo "$2" | cut -f2)
  [ "$st" = "needs-you" ] || { echo "FAIL [$1]: status '$st', expected needs-you (reason: $reason)"; exit 1; }
  echo "$reason" | grep -qi "$3" || { echo "FAIL [$1]: reason does not name '$3': $reason"; exit 1; }
  echo "  [$1] needs-you, naming: $3"
}

mkrepo r_dir 'build/'
expect_needs_you "ignored directory" "$(run_case r_dir a_dir 'test -s build/result.txt')" 'build/result.txt'

mkrepo r_sub ''
expect_needs_you "nested repo" "$(run_case r_sub a_sub 'test -s sub/output.txt')" 'nested git repository'

mkrepo r_link ''
expect_needs_you "escaping symlink" "$(run_case r_link a_link 'test -s output.txt')" 'symlink'

mkrepo r_none ''
expect_needs_you "no changes" "$(run_case r_none a_none 'test -s README.md')" 'no changes'

mkrepo r_hook ''
mkdir -p "$WORK/r_hook/.git/hooks"
cat > "$WORK/r_hook/.git/hooks/pre-commit" <<'EOF'
#!/bin/bash
printf 'hook version\n' > output.txt
git add output.txt
EOF
chmod +x "$WORK/r_hook/.git/hooks/pre-commit"
expect_needs_you "rewriting hook" "$(run_case r_hook a_hook 'grep -q agent output.txt')" 'check failed'

echo "VERIFIED OK: done is a claim about the committed tree — ignored dirs, gitlinks, escaping symlinks, empty runs and hook rewrites all land in Needs you, named"
