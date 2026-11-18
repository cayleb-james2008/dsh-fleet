#!/bin/bash
# C2/C3: sessions survive a server restart; per-session log files survive.
# A done session keeps status/transcript/check/diff; a session mid-work at
# the kill is honestly marked needs-you with the reason in its transcript.
set -u
cd "$(dirname "$0")/../.."
PORT=8481
WORK=$(mktemp -d)
PIDS=""
cleanup() { for p in $PIDS; do kill -9 $p 2>/dev/null; done; rm -rf "$WORK"; }
trap cleanup EXIT

[ -x ./target/debug/fleet-rs ] || cargo build >/dev/null 2>&1

git init -q -b main "$WORK/repo"
echo "seed" > "$WORK/repo/README.md"
git -C "$WORK/repo" add -A
git -C "$WORK/repo" -c user.email=p@p -c user.name=proof commit -qm init

cat > "$WORK/agent.sh" <<'EOF'
#!/bin/bash
echo "fixture agent received task: $1"
case "$1" in *slow*) echo "starting slow work"; sleep 30;; esac
printf 'result of: %s\n' "$1" > output.txt
echo "fixture agent finished"
EOF
chmod +x "$WORK/agent.sh"

api() { curl -s "http://127.0.0.1:$PORT$1"; }
post() { curl -s -X POST "http://127.0.0.1:$PORT$1" -H 'Content-Type: application/json' -d "$2"; }
start_server() {
  FLEET_AGENT="$WORK/agent.sh" FLEET_DATA="$WORK/data" PORT=$PORT \
    ./target/debug/fleet-rs policies.rn > "$WORK/server-$1.log" 2>&1 &
  PIDS="$PIDS $!"
  for i in $(seq 1 20); do api /api/sessions >/dev/null 2>&1 && return 0; sleep 0.5; done
  echo "FAIL: server $1 did not come up"; exit 1
}

start_server 1
post /api/sessions "{\"repo\":\"$WORK/repo\",\"project\":\"fixture\",\"task\":\"alpha task\"}" >/dev/null
for i in $(seq 1 40); do
  st=$(api /api/sessions | jq -r '.[0].status')
  [ "$st" = "done" ] && break
  sleep 0.5
done
[ "$st" = "done" ] || { echo "FAIL: first session never reached done (got $st)"; exit 1; }
ID_A=$(api /api/sessions | jq -r '.[0].id')

post /api/sessions "{\"repo\":\"$WORK/repo\",\"project\":\"fixture\",\"task\":\"slow task\"}" >/dev/null
for i in $(seq 1 20); do
  st2=$(api /api/sessions | jq -r '.[1].status')
  [ "$st2" = "working" ] && break
  sleep 0.5
done
[ "$st2" = "working" ] || { echo "FAIL: slow session never reached working (got $st2)"; exit 1; }
ID_B=$(api /api/sessions | jq -r '.[1].id')

# Wait until the slow agent's first line is actually in its log file:
# the kill must land mid-work WITH output produced, or the C3
# assertion below tests a state that never existed. (Since B10 the
# agent's stdout drains on its own thread; under load the "working"
# status can be visible a moment before the first line lands.)
for i in $(seq 1 30); do
  grep -q "fixture agent received task" "$WORK/data/logs/$ID_B.log" 2>/dev/null && break
  sleep 0.5
done
grep -q "fixture agent received task" "$WORK/data/logs/$ID_B.log" 2>/dev/null \
  || { echo "FAIL: slow agent's first line never reached its log file while working"; exit 1; }

# Kill the server mid-work, hard.
kill -9 $! 2>/dev/null; sleep 0.5
start_server 2

sessions=$(api /api/sessions)
n=$(echo "$sessions" | jq 'length')
[ "$n" = "2" ] || { echo "FAIL: after restart expected 2 sessions, got $n: $sessions"; exit 1; }

a=$(echo "$sessions" | jq -r ".[] | select(.id==\"$ID_A\") | .status")
[ "$a" = "done" ] || { echo "FAIL: done session came back as '$a'"; exit 1; }
echo "$sessions" | jq -e ".[] | select(.id==\"$ID_A\") | select(.check_passed==true) | select(.diff | contains(\"alpha task\")) | select(.transcript | join(\" \") | contains(\"verified done\"))" >/dev/null \
  || { echo "FAIL: done session lost its check result, diff or transcript"; exit 1; }

b=$(echo "$sessions" | jq -r ".[] | select(.id==\"$ID_B\") | .status")
[ "$b" = "needs-you" ] || { echo "FAIL: interrupted session came back as '$b', expected needs-you"; exit 1; }
echo "$sessions" | jq -e ".[] | select(.id==\"$ID_B\") | select(.transcript | join(\" \") | test(\"restart\"; \"i\"))" >/dev/null \
  || { echo "FAIL: interrupted session's transcript does not give the restart reason"; exit 1; }

# C3: per-session log files on disk contain the transcript. (The log
# file is data/logs/<id>.log specifically — other per-session files,
# e.g. the meta/<id>.ignored baseline B7 added, are not the log.)
for id in "$ID_A" "$ID_B"; do
  log="$WORK/data/logs/$id.log"
  [ -f "$log" ] || { echo "FAIL: no log file found for session $id at $log"; exit 1; }
  grep -q "fixture agent received task" "$log" || { echo "FAIL: log file for $id lacks transcript lines"; exit 1; }
done

# A fresh hand-out after restart must not collide with restored ids.
post /api/sessions "{\"repo\":\"$WORK/repo\",\"project\":\"fixture\",\"task\":\"gamma task\"}" >/dev/null
ids=$(api /api/sessions | jq -r '.[].id' | sort | uniq -d)
[ -z "$ids" ] || { echo "FAIL: duplicate session ids after restart: $ids"; exit 1; }

echo "PERSIST OK: sessions, transcripts, checks, diffs and logs survive restart; interrupted work is honestly marked"
