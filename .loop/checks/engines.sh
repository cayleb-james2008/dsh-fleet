#!/bin/bash
# C12: real engines are driven through the adapter, not a bare name.
# (a) /api/policy exposes the house model (from policies.rn) and the
#     engine it applies to.
# (b) A recording stand-in named `opencode` on PATH proves the exact
#     adapter invocation — run --model <policy model> <task> — and the
#     session reaches verified done through the normal gate. Steering
#     it records the continuation invocation (--continue + message).
# (c) With the real codex binary present but NOT logged in, a hand-out
#     naming "codex" spawns the real process and lands needs-you
#     naming the failure — never done, never hung. (Skipped when
#     codex is absent or logged in; the shape is environment-specific.)
# (d) Sessions record their engine kind; a path agent is labelled
#     custom + test_mode in the API.
set -u
cd "$(dirname "$0")/../.."
PORT=8511
WORK=$(mktemp -d)
PIDS=""
cleanup() { for p in $PIDS; do kill -9 $p 2>/dev/null; done; rm -rf "$WORK"; }
trap cleanup EXIT

[ -x "${CARGO_TARGET_DIR:-./target}/debug/fleet" ] || cargo build >/dev/null 2>&1

git init -q -b main "$WORK/repo"
echo "seed" > "$WORK/repo/README.md"
git -C "$WORK/repo" add -A
git -C "$WORK/repo" -c user.email=p@p -c user.name=proof commit -qm init

# Recording stand-in for the opencode CLI: logs argv (one line per
# invocation) and does the work the fixture check expects.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/opencode" <<'EOF'
#!/bin/bash
echo "$@" >> "$OPENCODE_ARGV_LOG"
printf 'result of: %s\n' "${@: -1}" > output.txt
echo "stand-in opencode ran"
EOF
chmod +x "$WORK/bin/opencode"

# Custom-path fixture agent (the test-mode contract).
cat > "$WORK/agent.sh" <<'EOF'
#!/bin/bash
printf 'result of: %s\n' "$1" > output.txt
EOF
chmod +x "$WORK/agent.sh"

export OPENCODE_ARGV_LOG="$WORK/argv.log"
PATH="$WORK/bin:$PATH" FLEET_DATA="$WORK/data" PORT=$PORT \
  "${CARGO_TARGET_DIR:-./target}/debug/fleet" policies.rn > "$WORK/server.log" 2>&1 &
PIDS="$PIDS $!"
api() { curl -s "http://127.0.0.1:$PORT$1"; }
post() { curl -s -w "\n%{http_code}" -X POST "http://127.0.0.1:$PORT$1" -H 'Content-Type: application/json' -d "$2"; }
for i in $(seq 1 20); do api /api/sessions >/dev/null 2>&1 && break; sleep 0.5; done

# (a) policy carries the model from policies.rn.
model=$(api /api/policy | jq -r '.model')
[ "$model" = "opencode/deepseek-v4.1-flash-free" ] \
  || { echo "FAIL: /api/policy model is '$model', expected the policies.rn agent_model()"; exit 1; }
meng=$(api /api/policy | jq -r '.model_engine')
[ "$meng" = "opencode" ] || { echo "FAIL: model_engine is '$meng'"; exit 1; }

# (b) hand out under agent name "opencode" — resolved from PATH.
resp=$(post /api/sessions "{\"repo\":\"$WORK/repo\",\"project\":\"fixture\",\"task\":\"alpha job\",\"agent\":\"opencode\"}")
code=$(echo "$resp" | tail -1)
[ "$code" = "201" ] || { echo "FAIL: opencode hand-out returned $code: $resp"; exit 1; }
ID=$(echo "$resp" | sed '$d' | jq -r '.id')
for i in $(seq 1 60); do
  st=$(api "/api/sessions/$ID" | jq -r '.status')
  [ "$st" = "done" ] && break
  sleep 0.5
done
[ "$st" = "done" ] || { echo "FAIL: opencode session reached '$st', expected done"; api "/api/sessions/$ID" | jq '{status, reason, transcript}'; exit 1; }
grep -qx "run --model opencode/deepseek-v4.1-flash-free alpha job" "$OPENCODE_ARGV_LOG" \
  || { echo "FAIL: adapter did not invoke opencode as 'run --model opencode/deepseek-v4.1-flash-free alpha job'; recorded:"; cat "$OPENCODE_ARGV_LOG"; exit 1; }
eng=$(api "/api/sessions/$ID" | jq -r '.engine')
[ "$eng" = "opencode" ] || { echo "FAIL: session engine is '$eng', expected opencode"; exit 1; }
tm=$(api "/api/sessions/$ID" | jq -r '.test_mode')
[ "$tm" = "false" ] || { echo "FAIL: opencode session test_mode is $tm, expected false"; exit 1; }

# (b2) steering the done session reopens it and delivers a
# continuation invocation: run --model ... --continue <message>.
resp=$(post "/api/sessions/$ID/steer" '{"message":"polish it"}')
code=$(echo "$resp" | tail -1)
[ "$code" = "200" ] || { echo "FAIL: steer of done session returned $code: $resp"; exit 1; }
for i in $(seq 1 60); do
  st=$(api "/api/sessions/$ID" | jq -r '.status')
  [ "$st" = "done" ] && break
  sleep 0.5
done
[ "$st" = "done" ] || { echo "FAIL: steered session reached '$st', expected done again"; exit 1; }
grep -qx "run --model opencode/deepseek-v4.1-flash-free --continue polish it" "$OPENCODE_ARGV_LOG" \
  || { echo "FAIL: continuation invocation not recorded; argv log:"; cat "$OPENCODE_ARGV_LOG"; exit 1; }

# (d) a path agent is labelled custom + test mode.
resp=$(post /api/sessions "{\"repo\":\"$WORK/repo\",\"project\":\"fixture\",\"task\":\"beta job\",\"agent\":\"$WORK/agent.sh\"}")
ID2=$(echo "$resp" | sed '$d' | jq -r '.id')
for i in $(seq 1 60); do
  st=$(api "/api/sessions/$ID2" | jq -r '.status')
  [ "$st" = "done" ] && break
  sleep 0.5
done
[ "$st" = "done" ] || { echo "FAIL: custom-agent session reached '$st', expected done"; exit 1; }
eng=$(api "/api/sessions/$ID2" | jq -r '.engine')
tm=$(api "/api/sessions/$ID2" | jq -r '.test_mode')
[ "$eng" = "custom" ] && [ "$tm" = "true" ] \
  || { echo "FAIL: path agent labelled engine=$eng test_mode=$tm, expected custom/true"; exit 1; }

# (c) the real codex binary, present but not logged in: the session
# must land needs-you with the failure visible — the credential wall,
# reached honestly. Never done, never hung.
if command -v codex >/dev/null 2>&1 && codex login status 2>&1 | grep -qi "not logged in"; then
  resp=$(post /api/sessions "{\"repo\":\"$WORK/repo\",\"project\":\"fixture\",\"task\":\"codex job\",\"agent\":\"codex\"}")
  code=$(echo "$resp" | tail -1)
  [ "$code" = "201" ] || { echo "FAIL: codex hand-out returned $code: $resp"; exit 1; }
  ID3=$(echo "$resp" | sed '$d' | jq -r '.id')
  # Unauthenticated codex climbs a websocket retry ladder before it
  # fails (measured 25–35s); give it room to reach its own verdict.
  for i in $(seq 1 160); do
    st=$(api "/api/sessions/$ID3" | jq -r '.status')
    [ "$st" = "needs-you" ] && break
    sleep 0.5
  done
  [ "$st" = "needs-you" ] || { echo "FAIL: unauthenticated codex session reached '$st', expected needs-you"; api "/api/sessions/$ID3" | jq '{status, reason}'; exit 1; }
  eng=$(api "/api/sessions/$ID3" | jq -r '.engine')
  [ "$eng" = "codex" ] || { echo "FAIL: codex session engine is '$eng'"; exit 1; }
  tr=$(api "/api/sessions/$ID3" | jq -r '.transcript | join("\n")')
  reason=$(api "/api/sessions/$ID3" | jq -r '.reason')
  # Proof the real binary ran and failed on its own terms: either its
  # own auth wording is in the transcript, or Fleet's verdict is the
  # plain "agent exited non-zero" (a spawn failure would say so).
  if echo "$tr" | grep -qiE "not logged in|login|unauthor"; then :;
  elif [ "$reason" = "agent exited non-zero" ]; then :;
  else echo "FAIL: codex session shows no sign the real process ran (reason: $reason)"; exit 1; fi
  echo "codex wall reached: real binary spawned, session needs-you (not logged in)"
else
  echo "codex wall probe skipped (codex absent or logged in on this machine)"
fi

echo "ENGINES OK: adapter invocation proven, model from policy, engine kinds labelled, codex wall honest"
