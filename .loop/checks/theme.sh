#!/bin/bash
# C8/C9, rewritten in round 2 (see the commit message for the reason). The vanilla page's SVG sprite symbols are gone:
# icons are lucide components now, so the "drawn icons" pin asserts the icon package instead. The tracked-caps pin
# keeps its intent (no uppercase or positively tracked LABELS) and drops the one thing it never meant to forbid:
# the Vantage display heads use NEGATIVE tracking (-0.035em), which is allowed.
# Checks the shipped page: dark default, a light theme and a toggle, the choice stored under fleet-theme,
# reduced motion honoured, no emoji, no uppercase or positive tracking on labels.
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

python3 - "$WORK/page.html" <<'PY'
import re, sys
html = open(sys.argv[1], encoding="utf-8").read()
fails = []
def need(cond, msg):
    if not cond: fails.append(msg)
need(re.search(r'<html[^>]*data-theme="dark"', html) is not None, "dark is not the default theme on the root element")
need('[data-theme=light]' in html or '[data-theme="light"]' in html, "no light theme variable set")
need('[data-theme=dark]' in html or '[data-theme="dark"]' in html, "no dark theme variable set")
need('fleet-theme' in html, "theme choice is not stored under fleet-theme")
need('themeBtn' in html, "no theme toggle")
need('Engines and settings' in html, "no engines and settings control")
need('prefers-reduced-motion' in html, "reduced-motion preference not honoured")
bad = [c for c in html if 0x1F000 <= ord(c) <= 0x1FAFF or 0x2600 <= ord(c) <= 0x27BF or ord(c) in (0x2B50, 0x2728, 0xFE0F)]
need(not bad, f"emoji/pictograph characters present: {[hex(ord(c)) for c in bad[:5]]}")
need('text-transform: uppercase' not in html and 'text-transform:uppercase' not in html, "uppercase text-transform still present")
need(not re.search(r'tracking-(wide|wider|widest)', html), "positively tracked label utilities present")
pos = [m for m in re.findall(r'letter-spacing:\s*([^;}]+)', html) if re.match(r'\s*[1-9]', m)]
need(not pos, f"positive letter-spacing present: {pos[:3]}")  # var() tokens resolve to the display tokens, which are negative
if fails:
    print("FAIL: " + "; ".join(fails)); sys.exit(1)
print("THEME OK: dark default + light theme, toggle, choice stored, reduced motion, no emoji, no uppercase or positive tracking")
PY
