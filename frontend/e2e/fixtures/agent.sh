#!/bin/bash
# Fixture stand-in for a coding agent (test mode). Tasks starting "slow:" stream a line every 2 s for ten minutes.
# Fleet runs each agent in its own process group; the pid lands in ../agents/ so the fixture can stop it.
[ -d "$(dirname "$0")/agents" ] && echo $$ > "$(dirname "$0")/agents/$$.pid"
echo "worktree checked out for task: $1"
case "$1" in
  slow:*)
    for i in $(seq 1 300); do
      echo "[$i] applying patch and checking invariants ($1)"
      sleep 2
    done
    ;;
  *without\ writing*)
    echo "agent exited 0 claiming completion without creating output.txt"
    exit 0
    ;;
esac
cat > README.md <<EOF
# Fixture service
Task applied: $1
Status: verified in isolated worktree
EOF
printf 'result of: %s\n' "$1" > output.txt
echo "patch staged for verification"
