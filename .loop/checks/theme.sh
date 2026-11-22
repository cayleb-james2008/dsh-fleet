#!/bin/bash
# C8/C9: Asserts the shipped page's House Frontend theme & typography contract:
# light default + dark parity, themeBtn toggle stored under fleet-theme, self-hosted Geist + Geist Mono,
# prefers-reduced-motion honoured, zero emoji, zero uppercase/positively-tracked eyebrow labels.
set -u
cd "$(dirname "$0")/../.."
PORT=8486
WORK=$(mktemp -d)
PIDS=""
cleanup() { for p in $PIDS; do kill -9 $p 2>/dev/null; done; rm -rf "$WORK"; }
trap cleanup EXIT

export PATH="$HOME/.rust/bin:$PATH"
BIN="${CARGO_TARGET_DIR:-./target}/debug/fleet-rs"
[ -x "$BIN" ] || cargo build >/dev/null 2>&1 || { echo "FAIL: cargo build"; exit 1; }
FLEET_NO_OPEN=1 FLEET_DATA="$WORK/data" PORT=$PORT "$BIN" policies.rn > "$WORK/server.log" 2>&1 &
PIDS="$PIDS $!"
for i in $(seq 1 20); do curl -s "http://127.0.0.1:$PORT/" >/dev/null 2>&1 && break; sleep 0.5; done
curl -s "http://127.0.0.1:$PORT/" > "$WORK/page.html"

python3 - "$WORK/page.html" <<'PY'
import re, sys
html = open(sys.argv[1], encoding="utf-8").read()
fails = []
def need(cond, msg):
    if not cond: fails.append(msg)
need(re.search(r'<html[^>]*data-theme="light"', html) is not None, "light is not the default theme on the root element")
need('[data-theme=light]' in html or '[data-theme="light"]' in html, "no light theme variable set")
need('[data-theme=dark]' in html or '[data-theme="dark"]' in html, "no dark theme variable set")
need('fleet-theme' in html, "theme choice is not stored under fleet-theme")
need('themeBtn' in html, "no theme toggle")
need('Appearance' in html, "Appearance section inside Settings missing")
need('Engines and settings' in html, "no engines and settings control")
need('font-family:Geist' in html or 'font-family:"Geist"' in html or 'font-family: "Geist"' in html, "Geist font-face missing")
need('Geist Mono' in html, "Geist Mono font-face missing")
need('prefers-reduced-motion' in html, "reduced-motion preference not honoured")
bad = [c for c in html if 0x1F000 <= ord(c) <= 0x1FAFF or 0x2600 <= ord(c) <= 0x27BF or ord(c) in (0x2B50, 0x2728, 0xFE0F)]
need(not bad, f"emoji/pictograph characters present: {[hex(ord(c)) for c in bad[:5]]}")
need('text-transform: uppercase' not in html and 'text-transform:uppercase' not in html, "uppercase text-transform still present")
need(not re.search(r'tracking-(wide|wider|widest)', html), "positively tracked label utilities present")
pos = [m for m in re.findall(r'letter-spacing:\s*([^;}]+)', html) if re.match(r'\s*[1-9]', m)]
need(not pos, f"positive letter-spacing present: {pos[:3]}")
if fails:
    print("FAIL: " + "; ".join(fails)); sys.exit(1)
print("THEME OK: light default + dark theme, Geist + Geist Mono, toggle, choice stored, reduced motion, no emoji, no uppercase or positive tracking")
PY
