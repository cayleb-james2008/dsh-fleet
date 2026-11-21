#!/bin/bash
# Fixture stand-in for a coding agent (test mode). Tasks starting "slow:" stream a line every 2 s for ten minutes.
# Fleet runs each agent in its own process group; the pid lands in ../agents/ so the fixture can stop it.
[ -d "$(dirname "$0")/agents" ] && echo $$ > "$(dirname "$0")/agents/$$.pid"
echo "fixture agent received task: $1"
case "$1" in
  slow:*) for i in $(seq 1 300); do echo "step $i: reading the code and making the change ($1)"; sleep 2; done ;;
esac
printf 'result of: %s\n' "$1" > output.txt
echo "fixture agent finished"
