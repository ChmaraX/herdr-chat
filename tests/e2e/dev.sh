#!/usr/bin/env bash
# A private Herdr app kept running for looking at the mod while changing it
# (lib.sh: its own app home and core; nothing touches yours). It installs the
# mods, makes a fake project and waits; drive it with dev-ctl.sh:
#
#   tests/e2e/dev.sh &                 # start (writes /tmp/pcdev/env)
#   tests/e2e/dev-ctl.sh open tools    # a chat on a fake-pi scenario
#   tests/e2e/dev-ctl.sh sync          # copy herdr-app/mods/ again (hot reload)
#   tests/e2e/dev-ctl.sh shot name     # PNG of the current frame (the window stays hidden)
#   tests/e2e/dev-ctl.sh stop
#
# DEV_DIR (default /tmp/pcdev) holds env, the run's art/ and the stop file: the
# test box keeps its live app there (tests/box/box app up).
set -euo pipefail
DEV=${DEV_DIR:-/tmp/pcdev}
mkdir -p "$DEV"
. "$(dirname "$0")/lib.sh" "$DEV/art"
FAKE="$REPO/tests/fake-pi"
CONFIG='{"pi": {"command": "'"$FAKE"'/fake-pi.mjs"}, "claude": {"command": "'"$REPO"'/tests/fake-claude/fake-claude.mjs"}, "codex": {"command": "'"$REPO"'/tests/fake-codex/fake-codex.mjs"}, "env": {"FAKE_CODEX_HOME": "'"$BASE"'/codex-home", "FAKE_CODEX_LOG": "'"$BASE"'/fake-codex.log", "FAKE_CODEX_SPEED": "2", "CLAUDE_CONFIG_DIR": "'"$BASE"'/claude-config", "FAKE_CLAUDE_LOG": "'"$BASE"'/fake-claude.log", "FAKE_CLAUDE_SPEED": "2", "FAKE_PI_SPEED": "'"${FAKE_PI_SPEED:-1}"'", "FAKE_PI_SCENARIO": "'"$FAKE"'/scenarios/tools.json", "FAKE_PI_LOG": "'"$BASE"'/fake-pi.log"}}'
install_mods "$CONFIG"
PROJ="$BASE/project"
mkdir -p "$PROJ/src"
PROJ="$(cd "$PROJ" && pwd -P)"
printf '# Fake project\n' >"$PROJ/README.md"
printf 'export const a = 1;\n' >"$PROJ/src/a.ts"
git -C "$PROJ" init -q && git -C "$PROJ" add -A && git -C "$PROJ" -c user.email=e@x -c user.name=e commit -qm init
MADE=$("$APP" do space.new --name project --folder "$PROJ")
SPACE=$(echo "$MADE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["space"])')
SHELL_T=$(echo "$MADE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["terminal"])')
sleep 1; "$APP" do pane.focus --terminal "$SHELL_T" >/dev/null; sleep 0.3; keys 56:shift
{ declare -p HERDR_APP_HOME HC_SESSION XDG_STATE_HOME XDG_CONFIG_HOME XDG_DATA_HOME | sed 's/^declare -x/export/'
  echo "APP=$APP APP_PID=$APP_PID BASE=$BASE STATE=$STATE PROJ=$PROJ SPACE=$SPACE SHELL_T=$SHELL_T PY=$PY REPO=$REPO"; } >"$DEV/env.tmp"
mv "$DEV/env.tmp" "$DEV/env" # (whole: a reader never sees half of it)
echo "dev app ready (pid $APP_PID): $DEV/env"
rm -f "$DEV/stop"
# Until stopped, or the app is gone. A restart (dev-ctl.sh restart, box app restart) writes the new
# app's pid to $DEV/env: follow it, and cleanup ends that one.
# ($DEV/restarting: a restart is under way, the app may be gone for a moment.)
while [ ! -e "$DEV/stop" ]; do
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    [ -e "$DEV/restarting" ] && { sleep 0.2; continue; }
    p=$(sed -n 's/.*APP_PID=\([0-9]*\).*/\1/p' "$DEV/env")
    if [ "$p" != "$APP_PID" ] && kill -0 "$p" 2>/dev/null; then APP_PID=$p; else break; fi
  fi
  sleep 1
done
rm -f "$DEV/stop" "$DEV/env"
