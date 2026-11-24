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
# - macOS: the private app starts in the background (`open -g -n`) and is
#   hidden at once (`app.hide`); it is never brought to the front. Since
#   herdr-app 0.1.16 `herdr-app shot` draws the current frame even for a
#   hidden window, and keys posted to its process land there;
# - Linux: the same flows run in the test box (tests/box), on its own virtual
#   display, with real X input (x11input.py, XTest);
# - keys go to the private app only (keys.py, CGEventPostToPid, on macOS);
# - no Cmd+Q: the app is ended with a signal at the end.
#
# The mods are copied from this checkout's herdr-app/mods/ into the private home
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
# The window's size in pt (shift.py reads it to read frames). It is never
# shown on macOS (hidden at launch), so where it would open doesn't matter.
export E2E_WIN_W=1280 E2E_WIN_H=820
printf '{"state": "windowed", "bounds": [40.0, 60.0, %s, %s]}\n' "$E2E_WIN_W" "$E2E_WIN_H" >"$HERDR_APP_HOME/window.json"
declare -p HERDR_APP_HOME HC_SESSION XDG_STATE_HOME XDG_CONFIG_HOME XDG_DATA_HOME | sed 's/^declare -x/export/' >"$BASE/env.sh"
STATE="$HERDR_APP_HOME/data/herdr-chat" # the mod's --state-dir: chats/, debug/

find_app() {
  if [ -n "${HERDR_APP_BIN:-}" ]; then echo "$HERDR_APP_BIN"; return; fi
  local c
  for c in "$(command -v herdr-app 2>/dev/null || true)" /Applications/*.app/Contents/MacOS/Herdr /opt/herdr/herdr-app/herdr-app; do
    if [ -x "$c" ] && "$c" --version 2>/dev/null | grep -q '^herdr-app '; then echo "$c"; return; fi
  done
}
APP="$(find_app)"
APP_REAL="$(python3 -c "import os,sys; print(os.path.realpath(sys.argv[1]))" "$APP")"
[ -n "$APP" ] || { echo "no herdr-app" >&2; exit 1; }
export HERDR_APP_BIN="$APP"
version=$("$APP" --version 2>/dev/null | awk '{print $2}')
echo "{\"last_run\": \"$version\", \"presented\": []}" >"$HERDR_APP_HOME/update-notes.json" # no "Updated" toast

# The platform (platform.sh: OS, PK, keys, click, wheel).
. "$E2E/platform.sh"
# A python3 with pyobjc's Quartz (key presses on macOS): one that has it, else
# a venv made once in tests/.venv (gitignored). Linux needs none: XTest through python3-xlib.
PY=python3
if [ "$OS" = Darwin ]; then
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
elif [ -z "${DISPLAY:-}" ]; then
  echo "Linux: run the e2e in the test box (tests/box/box run), which has a private display" >&2; exit 1
fi

# A process's environment, one variable a line (macOS: ps eww; Linux: /proc, which ps doesn't show).
env_of() {
  if [ -r "/proc/$1/environ" ]; then tr '\0' '\n' <"/proc/$1/environ"
  else ps eww -o command= -p "$1" 2>/dev/null | tr ' ' '\n'; fi
}
APP_PID=""
EXTRA_PIDS=""   # helper processes a script starts (mock hosts, servers): killed at exit
cleanup() {
  set +e
  stop_pump
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
    env_of "$p" | grep -qx "XDG_STATE_HOME=$BASE/state" && kill "$p"
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
# Setup, not a check: wait for state the next step needs, and fail as expect does. For state a
# command writes and the dump reads straight back (a toggle), which proves nothing on its own.
need() { until_ "$1" "${3:-10}" || fail "$2"; }
screen() { hc read "$1" --lines 0 2>/dev/null; }
# Draw a frame now. On macOS the hidden window draws only when asked: `herdr-app
# shot` draws the current frame (into a throwaway file here). The Linux box's
# window draws on its own; a shot there is harmless.
draw() { "$APP" shot "$BASE/draw.png" >/dev/null 2>&1 || true; }
# macOS: a frame pump while the app runs, so the hidden window draws about as
# often as a visible one would (state set while drawing, sizes measured on
# layout, stays current). Started with the app, ended at cleanup.
PUMP_PID=
start_pump() {
  [ "$OS" = Darwin ] || return 0
  stop_pump
  # (|| true: under run.sh's set -e one failed shot, the app busy or restarting, would end the pump.)
  ( while kill -0 "$APP_PID" 2>/dev/null; do "$APP" shot "$BASE/pump.png" >/dev/null 2>&1 || true; sleep 0.1; done ) &
  PUMP_PID=$!
}
# (`wait` on the killed pump returns its signal: under run.sh's set -e that would end the run.)
stop_pump() { [ -z "$PUMP_PID" ] || { kill "$PUMP_PID" 2>/dev/null; wait "$PUMP_PID" 2>/dev/null || true; PUMP_PID=; }; }
# A chord's label as the chat shows it here, written out per platform (not computed by the chat's
# own chord.js: then a broken label would pass). $1: one of the chords the flows check.
label() {
  case "$OS:$1" in
    Darwin:model) echo "⇧⌘M" ;; Darwin:model-y) echo "⇧⌘Y" ;; Darwin:mode) echo "⇧⌘A" ;; Darwin:focus) echo "⌘L" ;; Darwin:copy) echo "⌘C" ;;
    *:model) echo "Ctrl+Shift+M" ;; *:model-y) echo "Ctrl+Shift+Y" ;; *:mode) echo "Ctrl+Shift+A" ;; *:focus) echo "Ctrl+L" ;; *:copy) echo "Ctrl+C" ;;
    *) echo "label: no label for $1" >&2; return 1 ;;
  esac
}
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
# Whether the app (not only the core) knows terminal $1 as an idle or done agent: Herdr's app
# learns a terminal's status a moment after the core, and new-chat.continue reads the app's
# view. Wait on this before running a command that looks at an agent's status.
app_sees_agent() {
  app_ls | python3 -c 'import json,sys
t = [x for s in json.load(sys.stdin)["spaces"] for tb in s["tabs"] for x in tb["terminals"] if x["terminal"] == sys.argv[1]]
sys.exit(0 if t and t[0].get("app") and t[0].get("status") in ("idle", "done") else 1)' "$1"
}
active_tab() { "$APP" ls | python3 -c "import json,sys; d=json.load(sys.stdin); print([t['id'] for s in d['spaces'] for t in s['tabs'] if t['active'] and s['active']][0])"; }
# $1 file name: the app's current frame (`herdr-app shot` draws it, even for
# a hidden window, since herdr-app 0.1.16); $2: a moment to settle first.
LAST_SHOT=
shot() {
  sleep "${2:-0.8}"
  "$APP" shot "$ART/$1.png" >/dev/null 2>>"$LOG" || { echo "shot $1.png failed" | tee -a "$LOG"; return 0; }
  local sum
  sum=$(shasum "$ART/$1.png" | cut -c1-40)
  if [ "$sum" = "$LAST_SHOT" ]; then echo "shot $1.png (same frame as the one before)" >>"$LOG"; else echo "shot $1.png" >>"$LOG"; fi
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
  for m in "$REPO"/herdr-app/mods/*/; do
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
  stop_pump
  # Gone before the new one starts: on macOS the app isn't this shell's child (open -g), so wait
  # can't tell, and start_app would find the dying process by its app home.
  kill "$APP_PID" 2>/dev/null; wait "$APP_PID" 2>/dev/null || true
  until_ '! kill -0 "$APP_PID"' 10 || fail "the private app (pid $APP_PID) didn't quit for a restart"
  start_app
  until_ '"$APP" status' 30 || fail "the private app came back"
  [ "$OS" != Darwin ] || "$APP" do app.hide >>"$LOG" 2>&1 || true
  start_pump
}

# Start the private app: on macOS in the background (`open -g -n`, its
# environment passed variable by variable: LaunchServices would give it
# launchd's), never in front; on Linux on the box's display. Sets APP_PID.
start_app() {
  APP_PID=
  if [ "$OS" = Darwin ] && [ "${APP_REAL%/Contents/MacOS/*}" != "$APP_REAL" ]; then
    local envs=() kv p
    while IFS= read -r -d '' kv; do
      case "${kv%%=*}" in _|PWD|OLDPWD|SHLVL|TERM_SESSION_ID|__CF*|XPC_*) continue ;; esac
      envs+=(--env "$kv")
    done < <(env -0)
    open -g -n -a "${APP_REAL%/Contents/MacOS/*}" --stdout "$BASE/app.log" --stderr "$BASE/app.log" "${envs[@]}"
    for _ in $(seq 1 100); do
      for p in $(pgrep -f "$APP_REAL"); do
        env_of "$p" | grep -qxF "HERDR_APP_HOME=$HERDR_APP_HOME" && APP_PID=$p
      done
      [ -n "$APP_PID" ] && break
      sleep 0.1
    done
    [ -n "$APP_PID" ] || { echo "the private app didn't start" >&2; exit 1; }
  else
    WAYLAND_DISPLAY= "$APP" >>"$BASE/app.log" 2>&1 &
    APP_PID=$!
  fi
}

# --- start -------------------------------------------------------------------------
step "private app + core (HERDR_APP_HOME=$HERDR_APP_HOME, HC_SESSION=$HC_SESSION)"
{ echo "herdr-app: $("$APP" --version 2>&1 | head -1) ($APP)"; echo "hc: $(hc --version 2>&1 | head -1) ($(command -v hc))"
  echo "node: $("$NODE" --version) ($NODE)"; echo "herdr-chat: $(cat "$REPO/.box-rev" 2>/dev/null || git -C "$REPO" rev-parse --short HEAD 2>/dev/null)"
  if [ "$OS" = Darwin ]; then echo "macOS: $(sw_vers -productVersion 2>/dev/null)"; else echo "Linux: $(. /etc/os-release; echo "$PRETTY_NAME") (test box, display $DISPLAY)"; fi; } | tee -a "$LOG"
[ -n "${E2E_NO_INSTALL:-}" ] || install_mods
hc server start >>"$LOG" 2>&1
: >"$BASE/app.log"
start_app
expect '"$APP" status' "the private app answers" 30
[ "$OS" != Darwin ] || "$APP" do app.hide >>"$LOG" 2>&1 || note "app.hide failed"
start_pump
