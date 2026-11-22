#!/usr/bin/env bash
# Drive the app tests/e2e/dev.sh keeps running. See dev.sh.
set -euo pipefail
DEV=${DEV_DIR:-/tmp/pcdev}
. "$DEV/env"
for v in $(env | grep -oE '^HERDR_[A-Z_]+=' | tr -d =); do [ "$v" = HERDR_APP_HOME ] || unset "$v"; done
E2E="$REPO/tests/e2e"
chat() { cat "$DEV/chat" 2>/dev/null; }
. "$E2E/platform.sh" # keys, click: its process on macOS, the box's display on Linux
case "${1:-}" in
  sync) # copy herdr-app/mods/ into the private home (keeps config.json)
    for m in "$REPO"/herdr-app/mods/*/; do n=$(basename "$m"); mkdir -p "$HERDR_APP_HOME/mods/$n"
      (cd "$m" && find . -type f ! -name '*.d.ts' ! -name 'jsconfig.json' ! -name 'config.json' | while read -r f; do
        mkdir -p "$HERDR_APP_HOME/mods/$n/$(dirname "$f")"; cp "$f" "$HERDR_APP_HOME/mods/$n/$f"; done); done
    sleep 1.2; "$APP" status | python3 -c 'import json,sys; e=json.load(sys.stdin).get("errors"); print(json.dumps(e, indent=1) if e else "no errors")' ;;
  open) # open <scenario> [name]: a chat tab on tests/fake-pi/scenarios/<scenario>.json
    c="c-$(openssl rand -hex 4)"
    "$APP" do pane.focus --terminal "$SHELL_T" >/dev/null; keys 56:shift
    "$APP" do tab.new "{\"name\":\"${3:-pi}\",\"space\":\"$SPACE\",\"mod\":\"chat\",\"props\":{\"chat\":\"$c\",\"cwd\":\"$PROJ\",\"hostEnv\":{\"FAKE_PI_SCENARIO\":\"$REPO/tests/fake-pi/scenarios/$2.json\"}}}" >/dev/null
    echo "$c" >"$DEV/chat"; echo "$c" ;;
  openc) # openc [scenario] [provider]: a Claude Code (or Codex) chat on the real host + its fake (tests/e2e/<provider>/<scenario>.json)
    c="c-$(openssl rand -hex 4)"
    "$APP" do pane.focus --terminal "$SHELL_T" >/dev/null; keys 56:shift
    "$APP" do tab.new "{\"name\":\"${3:-claude}\",\"space\":\"$SPACE\",\"mod\":\"chat\",\"props\":{\"chat\":\"$c\",\"provider\":\"${3:-claude}\",\"cwd\":\"$PROJ\",\"hostEnv\":{\"FAKE_$(echo ${3:-claude} | tr a-z A-Z)_SCENARIO\":\"$REPO/tests/e2e/${3:-claude}/${2:-e2e}.json\"}}}" >/dev/null
    echo "$c" >"$DEV/chat"; echo "$c" ;;
  use) echo "$2" >"$DEV/chat" ;;
  shot) # shot <name> [wait]: the app's current frame (it draws it; the window stays hidden)
    sleep "${3:-0.9}"
    mkdir -p "$DEV/shots"; "$APP" shot "$DEV/shots/$2.png" >/dev/null
    echo "$DEV/shots/$2.png" ;;
  keys) shift; keys "$@" ;;
  click) shift; click "$@" ;;
  do) shift; "$APP" do "$@" ;;
  cmd) shift; "$APP" do "chat.$1" ;;
  dbg) python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); v=eval(sys.argv[2]); print(v if isinstance(v,str) else json.dumps(v, indent=1))' "$STATE/debug/$(chat).json" "${2:-d}" ;;
  status) "$APP" status ;;
  hc) shift; hc "$@" ;;
  restart) # the window only: dev.sh runs lib.sh's restart_app; wait until env names the new app
    old=$APP_PID; touch "$DEV/restart"
    for _ in $(seq 150); do [ ! -e "$DEV/restart" ] && break; sleep 0.2; done
    [ ! -e "$DEV/restart" ] || { echo "the restart didn't finish" >&2; exit 1; }
    . "$DEV/env"; echo "restarted: pid $old -> $APP_PID" ;;
  stop) # end dev.sh (its cleanup ends the app, the core and the hosts), and wait for it
    pid=$(cat "$DEV/pid" 2>/dev/null || true); touch "$DEV/stop"
    [ -z "$pid" ] || for _ in $(seq 150); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done ;;
  *) echo "usage: dev-ctl.sh sync|open <scenario>|shot <name>|keys …|click …|do …|cmd <c>|dbg [expr]|status|restart|stop" >&2; exit 2 ;;
esac
