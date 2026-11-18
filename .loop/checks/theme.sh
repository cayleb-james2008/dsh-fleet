#!/bin/bash
# C8/C9: the served page carries light + dark themes (dark default,
# toggle in settings, choice persisted) and no emoji or letter-icons —
# status icons are drawn SVG symbols.
set -u
cd "$(dirname "$0")/../.."
PORT=8486
WORK=$(mktemp -d)
PIDS=""
cleanup() { for p in $PIDS; do kill -9 $p 2>/dev/null; done; rm -rf "$WORK"; }
trap cleanup EXIT

[ -x ./target/debug/fleet-rs ] || cargo build >/dev/null 2>&1
FLEET_DATA="$WORK/data" PORT=$PORT ./target/debug/fleet-rs policies.rn > "$WORK/server.log" 2>&1 &
PIDS="$PIDS $!"
for i in $(seq 1 20); do curl -s "http://127.0.0.1:$PORT/" >/dev/null 2>&1 && break; sleep 0.5; done
curl -s "http://127.0.0.1:$PORT/" > "$WORK/page.html"

python3 - "$WORK/page.html" <<'EOF'
import re, sys
html = open(sys.argv[1], encoding="utf-8").read()
fails = []
def need(cond, msg):
    if not cond: fails.append(msg)
need('data-theme="dark"' in html, "dark is not the default theme on the root element")
need('[data-theme="light"]' in html, "no light theme variable set")
need('[data-theme="dark"]' in html or ':root' in html, "no dark theme variable set")
need('id="settings"' in html, "no settings area")
need('id="themeBtn"' in html, "no theme toggle in settings")
need('localStorage' in html and 'fleet-theme' in html, "theme choice is not persisted")
need('<symbol id="i-check"' in html and '<symbol id="i-alert"' in html, "drawn SVG icon symbols missing")
need('prefers-reduced-motion' in html, "reduced-motion preference not honoured")
# No emoji or pictograph characters anywhere in the page.
bad = [c for c in html if 0x1F000 <= ord(c) <= 0x1FAFF or 0x2600 <= ord(c) <= 0x27BF or ord(c) in (0x2B50, 0x2728, 0xFE0F)]
need(not bad, f"emoji/pictograph characters present: {[hex(ord(c)) for c in bad[:5]]}")
# No shouty uppercase micro-labels in CSS (baseline slop).
need('text-transform: uppercase' not in html, "uppercase text-transform still present")
need('letter-spacing' not in html, "tracked-out labels still present")
if fails:
    print("FAIL: " + "; ".join(fails)); sys.exit(1)
print("THEME OK: dark default + light theme, settings toggle persisted, drawn icons only, no emoji")
EOF
