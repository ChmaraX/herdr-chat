# Shared by the herdr-chat e2e scripts: a private Herdr app + herdr-core (its own
# app home, core session and XDG dirs; nothing touches yours), cleanup on
# exit, and the step/assert/screenshot helpers. Adapted from herdr-gitview's
# herdr-app/e2e/lib.sh. Source it with the artifacts dir as $1; it starts the
# app.
#
# The person's own app, core, clipboard, keyboard focus and pointer are never
# touched:
# - every `hc` call runs with the HC_* and HERDR_* variables unset, against
#   this run's own core session (HC_SESSION);
# - the private window is moved on screen once (macOS only draws visible
#   windows; System Events, needs Accessibility) and never raised;
#   screenshots are `herdr-app shot` (the app's last frame, no raise);
# - keys go to the private app's process only (keys.py, CGEventPostToPid);
# - no Cmd+Q: the app is ended with a signal at the end.
#
# The mods are copied from this checkout's mod/ into the private home
# (install_mods), with mods/chat/config.json pointing at this checkout's
# bin/herdr-chat-host. The mod's debug dumps are on (data/herdr-chat/debug/enabled).
# No pipefail: the checks are `producer | grep -q x`, and grep stops reading at its
# match, so a producer that gets SIGPIPE (cat, herdr-app ls) must not fail them.
set +o pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
E2E="$REPO/tests/e2e"
ART="${1:-$REPO/tests/artifacts/e2e-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$ART"
ART="$(cd "$ART" && pwd)"
LOG="$ART/run.log"
: >"$LOG"

# --- a private instance --------------------------------------------------------
BASE="$(mktemp -d /tmp/pce.XXXX)"
for v in $(env | grep -oE '^(HERDR_[A-Z_]+|HC_[A-Z_]+)=' | tr -d =); do unset "$v"; done
[ -z "${HERDR_APP_BIN_E2E:-}" ] || HERDR_APP_BIN="$HERDR_APP_BIN_E2E"
export HERDR_APP_HOME="$BASE/home" HC_SESSION="pce$(printf %s "${BASE: -4}" | tr A-Z a-z)$$" XDG_STATE_HOME="$BASE/state"
export XDG_CONFIG_HOME="$BASE/config" XDG_DATA_HOME="$BASE/data" HERDR_APP_NO_SOUND=1 HERDR_TELEMETRY=0 DO_NOT_TRACK=1
export HERDR_RELEASES_URL=http://127.0.0.1:9 # never update the installed app or core
# Fake runs keep Pi's own state here; LIVE=1 uses the person's Pi auth and
# settings (the host gives real Pi a temp --session-dir).
[ -n "${LIVE:-}" ] || export PI_CODING_AGENT_DIR="$BASE/pi"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"
NODE="${NODE:-$(command -v node)}"
mkdir -p "$HERDR_APP_HOME" "$XDG_STATE_HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME"
echo '{"frame.welcomed": true, "layout": "main"}' >"$HERDR_APP_HOME/shared.json"
echo '{"zoom": 1, "theme": "graphite", "appearance": "dark"}' >"$HERDR_APP_HOME/settings.json"
# Where the window opens (left edge of the main display, where your own
# windows usually leave a strip uncovered; macOS doesn't draw covered windows).
# Accessibility moves it there again below, when it can.
python3 - "$HOME/.config/herdr-app/window.json" "$HERDR_APP_HOME/window.json" <<'EOF'
import json, sys
try:
    display = json.load(open(sys.argv[1])).get("display")  # read only: which display to open on
except Exception:
    display = None
w = {"state": "windowed", "bounds": [40.0, 60.0, 1280.0, 820.0]}
if display: w["display"] = display
json.dump(w, open(sys.argv[2], "w"))
EOF
declare -p HERDR_APP_HOME HC_SESSION XDG_STATE_HOME XDG_CONFIG_HOME XDG_DATA_HOME | sed 's/^declare -x/export/' >"$BASE/env.sh"
STATE="$HERDR_APP_HOME/data/herdr-chat" # the mod's --state-dir: chats/, debug/

find_app() {
  if [ -n "${HERDR_APP_BIN:-}" ]; then echo "$HERDR_APP_BIN"; return; fi
  local c
  for c in "$(command -v herdr-app 2>/dev/null || true)" /Applications/*.app/Contents/MacOS/Herdr; do
    if [ -x "$c" ] && "$c" --version 2>/dev/null | grep -q '^herdr-app '; then echo "$c"; return; fi
  done
}
APP="$(find_app)"
APP_REAL="$(python3 -c "import os,sys; print(os.path.realpath(sys.argv[1]))" "$APP")"
[ -n "$APP" ] || { echo "no herdr-app" >&2; exit 1; }
export HERDR_APP_BIN="$APP"
version=$(plutil -extract CFBundleShortVersionString raw "${APP_REAL%/MacOS/*}/Info.plist" 2>/dev/null || true)
echo "{\"last_run\": \"$version\", \"presented\": []}" >"$HERDR_APP_HOME/update-notes.json" # no "Updated" toast

# A python3 with pyobjc's Quartz (key presses, window order): one that has it,
# else a venv made once in tests/.venv (gitignored).
PY=
for c in "$REPO/tests/.venv/bin/python3" python3 /usr/bin/python3 /opt/homebrew/bin/python3; do
  if "$c" -c 'import Quartz' 2>/dev/null; then PY=$(command -v "$c"); break; fi
done
if [ -z "$PY" ]; then
  echo "making tests/.venv with pyobjc-framework-Quartz (once)" >&2
  python3 -m venv "$REPO/tests/.venv" && "$REPO/tests/.venv/bin/pip" install -q pyobjc-framework-Quartz >&2 &&
    PY="$REPO/tests/.venv/bin/python3"
fi
[ -n "$PY" ] || { echo "no python3 with pyobjc (Quartz) for key presses" >&2; exit 1; }

APP_PID=""
EXTRA_PIDS=""   # helper processes a script starts (mock hosts, servers): killed at exit
cleanup() {
  set +e
  hidden
  [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null && wait "$APP_PID" 2>/dev/null
  for p in $EXTRA_PIDS; do kill "$p" 2>/dev/null; done
  # Every terminal of this run's own core (never another core's).
  for t in $(hc ls --json 2>/dev/null | python3 -c 'import json,sys; print(" ".join(t["address"] for t in json.load(sys.stdin)["terminals"] if "/" not in t["address"]))' 2>/dev/null); do
    hc kill "$t" >/dev/null 2>&1
  done
  hc server stop >/dev/null 2>&1
  # A stopped core's holder keeps running, and any hc call restarts a core:
  # end this run's own cores and holders (matched by this run's state dir).
  for p in $(pgrep -f '(hc|herdr-core) (serve|hold)'); do
    ps eww -o command= -p "$p" 2>/dev/null | grep -q "XDG_STATE_HOME=$BASE/state " && kill "$p"
  done
  # Hosts and fake Pis this run started (their command lines name this run's state dir).
  for p in $(pgrep -f "$STATE"); do kill "$p" 2>/dev/null; done
  rm -rf "$ART/final" && mkdir -p "$ART/final"
  cp -R "$STATE" "$ART/final/herdr-chat" 2>/dev/null
  cp "$HERDR_APP_HOME/keys.json" "$ART/final/" 2>/dev/null
  cp "$BASE/app.log" "$ART/app.log" 2>/dev/null
  if [ -n "${E2E_KEEP_BASE:-}" ]; then echo "kept $BASE"; else rm -rf "$BASE"; fi
  echo "artifacts: $ART"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# --- helpers ---------------------------------------------------------------------
PASSES=0 SKIPS=0 BYCMD=0 BYCMD_NEXT=
step() { printf '\n== %s\n' "$*" | tee -a "$LOG"; }
# A key the window dropped was done by the mod's command instead (by_command):
# the next check holds through the command, not the key, so it's a SKIP.
by_command() { note "$1: by command"; BYCMD_NEXT=1; }
ok() {
  if [ -n "$BYCMD_NEXT" ]; then BYCMD_NEXT= BYCMD=$((BYCMD + 1)); skip "$* (by command: the key didn't land)"; return; fi
  PASSES=$((PASSES + 1)); printf 'PASS %s\n' "$*" | tee -a "$LOG"
}
skip() { SKIPS=$((SKIPS + 1)); printf 'SKIP %s\n' "$*" | tee -a "$LOG"; }
note() { printf 'note: %s\n' "$*" | tee -a "$LOG"; }
fail() {
  printf 'FAIL %s\n' "$*" | tee -a "$LOG"
  { echo "--- terminals"; terms; echo "--- status"; "$APP" status; echo "--- mod panes"; mod_panes
    for f in "$STATE"/debug/*.json; do [ -f "$f" ] && { echo "--- debug $f"; head -c 4000 "$f"; echo; }; done
    for f in "$STATE"/chats/*.json; do [ -f "$f" ] && { echo "--- registry $f"; cat "$f"; echo; }; done
    for t in $(terms | awk '{print $1}'); do echo "--- screen $t"; screen "$t" | tail -40; done
    echo "--- app log"; tail -40 "$BASE/app.log"
  } >>"$LOG" 2>&1 || true
  shot FAIL || true
  [ -z "${E2E_KEEP:-}" ] || { echo "kept: source $BASE/env.sh" | tee -a "$LOG"; trap - EXIT; }
  exit 1
}
passed() { if [ "$SKIPS" -gt 0 ]; then step "all passed: $PASSES checks, $SKIPS skipped ($BYCMD by command)"; else step "all passed: $PASSES checks"; fi; }
do_() { "$APP" do "$@" >>"$LOG" 2>&1 || fail "herdr-app do $*"; }
# Poll a condition (a shell snippet) for up to $2 seconds (default 10).
until_() {
  local deadline=$((SECONDS + ${2:-10}))
  until eval "$1" >/dev/null 2>&1; do
    [ $SECONDS -lt $deadline ] || return 1
    sleep 0.2
  done
}
# Now, in seconds with a fraction (for timings).
now_s() { perl -MTime::HiRes=time -e 'printf "%.3f\n", time'; }
expect() { until_ "$1" "${3:-10}" && ok "$2" || fail "$2"; }
screen() { hc read "$1" --lines 0 2>/dev/null; }
# Whether macOS draws the private window now (not fully covered by your
# windows; drawn.py only reads the window list). Covered, it gets no frames:
# screenshots are stale and a mod can't take the keyboard.
drawn() { "$PY" "$E2E/drawn.py" "$APP_PID"; }
# Keys to the private app's process only (keys.py: keycodes, names, text:).
keys() { "$PY" "$E2E/keys.py" "$APP_PID" "$@"; }
# The app process's CPU time so far, in seconds (for cost over a window of time).
cpu_secs() { ps -o cputime= -p "$APP_PID" | awk -F'[:.]' '{ if (NF==4) print $1*3600+$2*60+$3+$4/100; else print $1*60+$2+$3/100 }'; }
terms() { hc ls --json | python3 -c 'import json,sys; [print(t["address"], t.get("agent") or "-", t.get("parent") or "-", t.get("name") or "-") for t in json.load(sys.stdin)["terminals"]]'; }
term_json() { hc get "$1" --json; }
# No mod errors: none in the app's status, and no chat's last render threw (renderError in
# every debug dump; a throw keeps the last frame, so the data checks alone would still pass).
no_mod_errors() {
  "$APP" status | python3 -c 'import json,sys; e=json.load(sys.stdin).get("errors"); print("app errors:", json.dumps(e)) if e else None; sys.exit(1 if e else 0)' >>"$LOG" || return 1
  python3 - "$STATE/debug" >>"$LOG" <<'EOF'
import glob, json, sys
bad = 0
for f in sorted(glob.glob(sys.argv[1] + "/c-*.json")):
    try: e = json.load(open(f)).get("renderError")
    except ValueError: continue  # a dump read mid-write
    if e: bad += 1; print(f"render error in {f}: {e}")
sys.exit(1 if bad else 0)
EOF
}
overlay_open() { "$APP" status | python3 -c 'import json,sys; o=json.load(sys.stdin)["overlays"]; sys.exit(0 if any(sys.argv[1] == (x if isinstance(x, str) else x.get("mod") or x.get("name")) for x in o) else 1)' "$1"; }
# The core's herdr-app document (spaces > tabs > pane trees).
app_doc() {
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"hello","params":{"generation":1}}' \
    '{"jsonrpc":"2.0","id":2,"method":"doc.get","params":{"name":"herdr-app"}}' | hc connect |
    python3 -c 'import json,sys; print(json.dumps([json.loads(l) for l in sys.stdin if l.strip()][-1]["result"]["value"]))'
}
# Mod panes (the app's `ls` lists terminals only): "<tab> <pane> <mod> <props json>" lines.
mod_panes() {
  app_doc | python3 -c '
import json, sys
doc = json.load(sys.stdin)
def walk(tab, n):
    c = n.get("content", {})
    if c.get("mod"): print(tab, n["id"], c["mod"], json.dumps(c.get("props") or {}, separators=(",", ":")))
    for ch in n.get("children", []): walk(tab, ch)
for s in doc.get("spaces", []):
    for t in s["tabs"]: walk(t["id"], t["root"])'
}
# Terminal panes: "<tab> <pane> <terminal>" lines.
term_panes() {
  app_doc | python3 -c '
import json, sys
doc = json.load(sys.stdin)
def walk(tab, n):
    c = n.get("content", {})
    if c.get("terminal"): print(tab, n["id"], c["terminal"])
    for ch in n.get("children", []): walk(tab, ch)
for s in doc.get("spaces", []):
    for t in s["tabs"]: walk(t["id"], t["root"])'
}
# Every pane of tab $1 as "<pane> <terminal or mod:name>" lines.
tab_panes() {
  app_doc | python3 -c '
import json, sys
doc = json.load(sys.stdin)
def walk(n):
    c = n.get("content", {})
    if c.get("terminal") or c.get("mod"): print(n["id"], c.get("terminal") or "mod:" + c["mod"])
    for ch in n.get("children", []): walk(ch)
for s in doc.get("spaces", []):
    for t in s["tabs"]:
        if t["id"] == sys.argv[1]: walk(t["root"])' "$1"
}
# Terminal $1's panes in the layout document: "<tab> <pane> hidden|shown" lines.
node_of() {
  app_doc | python3 -c '
import json, sys
doc = json.load(sys.stdin)
def walk(tab, n):
    c = n.get("content") or {}
    if c.get("terminal") == sys.argv[1]: print(tab, n["id"], "hidden" if n.get("hidden") else "shown")
    for ch in n.get("children", []): walk(tab, ch)
for s in doc.get("spaces", []):
    for t in s["tabs"]: walk(t["id"], t["root"])' "$1"
}
# Terminal $2 has one pane, in tab $1, hidden.
hidden_in() { [ "$(node_of "$2" | awk -v t="$1" '$1 == t && $3 == "hidden"' | wc -l | tr -d ' ')" = 1 ] && [ "$(node_of "$2" | wc -l | tr -d ' ')" = 1 ]; }
app_ls() { "$APP" ls; }
active_tab() { "$APP" ls | python3 -c "import json,sys; d=json.load(sys.stdin); print([t['id'] for s in d['spaces'] for t in s['tabs'] if t['active'] and s['active']][0])"; }
# $1 file name: the app's last frame (no raise); give it a moment to draw.
# macOS doesn't draw a window that's fully covered: then the frame is the
# last one drawn, and the log says so (the checks never depend on drawing).
LAST_SHOT=
# A window behind another app's draws nothing (GPUI renders only while the
# private window is frontmost), so visual passes run between `visible` and
# `hidden`: the person's frontmost app is recorded, the private app is
# brought to the front, and the recorded app is activated again right after.
# Keys always go to the private pid only. Each activation is logged and kept
# short (VISIBLE_MAX seconds, checked by visible_budget). E2E_NO_VISUAL=1:
# never activate (screenshots are then stale).
VISIBLE_SINCE= FRONT_APP= FRONT_NAME=
VISIBLE_MAX=${VISIBLE_MAX:-170}
# The Mac's screen is locked (then no window draws at all).
screen_locked() { "$PY" -c 'import Quartz,sys; d=Quartz.CGSessionCopyCurrentDictionary(); sys.exit(0 if d.get("CGSSessionScreenIsLocked") else 1)'; }
visible() {
  [ -z "${E2E_NO_VISUAL:-}" ] || return 0
  [ -z "$VISIBLE_SINCE" ] || return 0
  if screen_locked; then echo "activation skipped: the screen is locked (nothing draws; screenshots stale)" | tee -a "$LOG"; return 0; fi
  # By pid: the person's Herdr and this one share a bundle id.
  FRONT_APP=$("$PY" "$E2E/front.py" get 2>/dev/null || true)
  [ "$FRONT_APP" != "$APP_PID" ] || FRONT_APP=$PERSON_FRONT
  FRONT_NAME=$(ps -o comm= -p "${FRONT_APP:-0}" 2>/dev/null || true)
  echo "activation start: private app (pid $APP_PID) to front; was pid ${FRONT_APP:-unknown} ${FRONT_NAME:-} ($(date +%T))" >>"$LOG"
  "$PY" "$E2E/front.py" "$APP_PID" >>"$LOG" 2>&1 || echo "activation: the private app didn't come to the front" >>"$LOG"
  VISIBLE_SINCE=$SECONDS
  sleep 0.8
}
hidden() {
  [ -n "$VISIBLE_SINCE" ] || return 0
  if [ -n "$FRONT_APP" ] && [ "$FRONT_APP" != "$APP_PID" ]; then
    "$PY" "$E2E/front.py" "$FRONT_APP" >>"$LOG" 2>&1 || echo "activation: pid $FRONT_APP didn't come back to the front" >>"$LOG"
  fi
  echo "activation end: back to pid ${FRONT_APP:-unknown} ${FRONT_NAME:-} after $((SECONDS - VISIBLE_SINCE)) s ($(date +%T))" >>"$LOG"
  VISIBLE_SINCE=
}
visible_budget() { [ -z "$VISIBLE_SINCE" ] || [ $((SECONDS - VISIBLE_SINCE)) -lt "$VISIBLE_MAX" ] || hidden; }
shot() {
  sleep "${2:-0.8}"
  [ -z "${E2E_VISUAL:-}" ] || { visible_budget; visible; }
  "$APP" shot "$ART/$1.png" >/dev/null 2>>"$LOG" || return 0
  local sum
  sum=$(shasum "$ART/$1.png" | cut -c1-40)
  if screen_locked; then
    echo "shot $1.png (stale: the screen is locked)" | tee -a "$LOG"
  elif [ -z "$VISIBLE_SINCE" ]; then
    echo "shot $1.png (likely stale: not in a visual pass)" | tee -a "$LOG"
  elif ! drawn; then
    echo "shot $1.png (maybe stale: another window covers the private one)" | tee -a "$LOG"
  elif [ "$sum" = "$LAST_SHOT" ]; then
    echo "shot $1.png (same frame as the one before)" | tee -a "$LOG"
  else
    echo "shot $1.png" >>"$LOG"
  fi
  LAST_SHOT=$sum
}

# --- herdr-chat --------------------------------------------------------------------------
# Copy this checkout's mods into the private home (hot reload picks them up)
# and write mods/chat/config.json (what install writes) and the person's
# settings (data/herdr-chat/settings.json, host/settings.ts) from the JSON in $1.
install_mods() {
  local extra="${1:-}"
  [ -n "$extra" ] || extra='{}'
  mkdir -p "$HERDR_APP_HOME/mods"
  for m in "$REPO"/mod/*/; do
    [ -f "$m/main.js" ] || continue
    local name; name=$(basename "$m")
    # chat-agents / chat-menu extend the app's shipped agents list and menu: only once the app wrote them (it does at start).
    case "$name" in chat-agents) [ -f "$HERDR_APP_HOME/mods/agents/main.js" ] || continue ;; chat-menu) [ -f "$HERDR_APP_HOME/mods/menu/main.js" ] || continue ;; esac
    mkdir -p "$HERDR_APP_HOME/mods/$name"
    # Files only (no jsconfig/d.ts the app writes); copy then replace keeps reloads atomic enough.
    (cd "$m" && find . -type f ! -name '*.d.ts' ! -name 'jsconfig.json' ! -name 'config.json' | while read -r f; do
      mkdir -p "$HERDR_APP_HOME/mods/$name/$(dirname "$f")"; cp "$f" "$HERDR_APP_HOME/mods/$name/$f"; done)
  done
  # Their install-time copies of the shipped mods (install/mods.ts, as install.sh makes them).
  [ ! -d "$HERDR_APP_HOME/mods/chat-agents" ] || "$NODE" "$REPO/install/mods.ts" bases "$HERDR_APP_HOME/mods" "$HERDR_APP_HOME/mods" >>"$LOG"
  if [ -d "$HERDR_APP_HOME/mods/chat" ]; then
    mkdir -p "$STATE"
    python3 - "$HERDR_APP_HOME/mods/chat/config.json" "$STATE/settings.json" "$REPO/bin/herdr-chat-host" "$NODE" "$extra" "$(command -v hc)" <<'EOF'
import json, sys
path, settings, host, node, extra, hc = sys.argv[1:]
json.dump({"host": host, "node": node, "hc": hc}, open(path, "w"), indent=1)
json.dump(json.loads(extra), open(settings, "w"), indent=1)
EOF
  fi
  mkdir -p "$STATE/debug" && touch "$STATE/debug/enabled"
}
# The mod's debug dump of a chat (written after each render batch): a python
# expression over `d`, e.g. dbg c-1234abcd 'd["connection"]'.
dbg() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); v=eval(sys.argv[2]); print(v if isinstance(v,str) else json.dumps(v))' "$STATE/debug/$1.json" "$2" 2>/dev/null; }
# The chat registry entry: reg c-1234abcd port
reg() { python3 -c 'import json,sys; v=json.load(open(sys.argv[1])).get(sys.argv[2]); print("" if v is None else v)' "$STATE/chats/$1.json" "$2" 2>/dev/null; }
# The host's view of a chat (herdr-chat-host inspect), as JSON.
inspect_chat() { "$REPO/bin/herdr-chat-host" inspect --chat "$1" --state-dir "$STATE" "${@:2}"; }

# Quit the private app (a signal, like closing the window for good) and start
# it again: terminals and hosts live on in the core.
restart_app() {
  local was_visible=$VISIBLE_SINCE
  hidden
  kill "$APP_PID" 2>/dev/null; wait "$APP_PID" 2>/dev/null || true
  "$APP" >>"$BASE/app.log" 2>&1 &
  APP_PID=$!
  until_ '"$APP" status' 30 || fail "the private app came back"
  sleep 1
  if [ "$("$PY" "$E2E/front.py" get 2>/dev/null)" = "$APP_PID" ] && [ -n "$PERSON_FRONT" ]; then "$PY" "$E2E/front.py" "$PERSON_FRONT" >>"$LOG" 2>&1 || true; fi
  [ -z "$was_visible" ] || visible
}

# --- start -------------------------------------------------------------------------
step "private app + core (HERDR_APP_HOME=$HERDR_APP_HOME, HC_SESSION=$HC_SESSION)"
{ echo "herdr-app: $("$APP" --version 2>&1 | head -1) ($APP)"; echo "hc: $(hc --version 2>&1 | head -1) ($(command -v hc))"
  echo "node: $("$NODE" --version) ($NODE)"; echo "herdr-chat: $(git -C "$REPO" rev-parse --short HEAD 2>/dev/null)"
  echo "macOS: $(sw_vers -productVersion 2>/dev/null)"; } | tee -a "$LOG"
[ -n "${E2E_NO_INSTALL:-}" ] || install_mods
hc server start >>"$LOG" 2>&1
PERSON_FRONT=$("$PY" "$E2E/front.py" get 2>/dev/null || true) # whatever you were using
"$APP" >"$BASE/app.log" 2>&1 &
APP_PID=$!
expect '"$APP" status' "the private app answers" 30
# Launched, it may take the front: give it back until a visual pass.
sleep 1
if [ "$("$PY" "$E2E/front.py" get 2>/dev/null)" = "$APP_PID" ] && [ -n "$PERSON_FRONT" ] && [ "$PERSON_FRONT" != "$APP_PID" ]; then
  "$PY" "$E2E/front.py" "$PERSON_FRONT" >>"$LOG" 2>&1 || true
  echo "the private app took the front at launch: gave it back to pid $PERSON_FRONT" >>"$LOG"
fi
place_window() {
  osascript -e "tell application \"System Events\" to tell (first process whose unix id is $APP_PID) to set position of window 1 to {40, 60}" \
    -e "tell application \"System Events\" to tell (first process whose unix id is $APP_PID) to set size of window 1 to {1280, 820}"
}
until_ place_window 5 || true # window.json already put it there
