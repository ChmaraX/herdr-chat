#!/usr/bin/env bash
# The box's live app, from inside the box: `/opt/box/app.sh <verb> [args...]`.
# tests/box/box runs it with docker exec; read that file's help for the verbs.
#
# The live app is tests/e2e/dev.sh, kept running: a private Herdr app with the
# mods from the snapshot (~/src), herdr-core on its own session, a fake project
# space and the fake agents. Its environment (app home, core session, pids)
# is in $DEV/env. Every verb below acts on that app.
#
# Herdr's own scripts/sandbox (herdr-app, Apache-2.0) has the same verbs; the
# input ones run input.py, adapted from its sandbox-input.py.
set -euo pipefail
DEV=/home/box/live
SRC=/home/box/src
. /tmp/display.env
die() { echo "box: $*" >&2; exit 1; }
live() { [ -f "$DEV/env" ] && . "$DEV/env" && kill -0 "$APP_PID" 2>/dev/null; }
need_live() {
  live || die "no live app (box app up <item>)"
  for v in $(env | grep -oE '^(HERDR_[A-Z_]+|HC_[A-Z_]+)=' | tr -d =); do
    case $v in HERDR_APP_HOME|HC_SESSION) ;; *) unset "$v" ;; esac
  done
  export HERDR_APP_HOME HC_SESSION XDG_STATE_HOME XDG_CONFIG_HOME XDG_DATA_HOME APP
  export BOX_POINTER_FILE=${BOX_POINTER_FILE:-$DEV/pointer.json}
}
H() { "$APP" "$@"; }

verb=${1:-}; shift || true
case $verb in
  up)
    live && { echo "the live app is up (pid $APP_PID): box app down first for a new one"; exit 0; }
    mkdir -p "$DEV"; rm -f "$DEV/env" "$DEV/stop" "$DEV/pointer.json"
    (cd "$SRC" && DEV_DIR=$DEV setsid tests/e2e/dev.sh >"$DEV/dev.log" 2>&1 </dev/null &)
    for _ in $(seq 150); do [ -f "$DEV/env" ] && break; sleep 0.2; done
    live || { tail -30 "$DEV/dev.log" >&2; die "the live app didn't start (log above)"; }
    echo "live app up: pid $APP_PID, space $SPACE (project $PROJ), terminal $SHELL_T"
    echo "home $HERDR_APP_HOME, core session $HC_SESSION"
    ;;
  down)
    if live; then touch "$DEV/stop"; for _ in $(seq 100); do [ -f "$DEV/env" ] || break; sleep 0.1; done; fi
    pkill -f "tests/e2e/dev.sh" 2>/dev/null || true
    rm -rf "$DEV"; echo "live app down" ;;
  restart) # the window only: terminals live on in the core
    need_live
    # dev.sh waits while $DEV/restarting is there, then follows the new pid in env.
    touch "$DEV/restarting"
    kill "$APP_PID" 2>/dev/null || true
    for _ in $(seq 50); do kill -0 "$APP_PID" 2>/dev/null || break; sleep 0.1; done
    WAYLAND_DISPLAY= setsid "$APP" >>"$DEV/dev.log" 2>&1 </dev/null &
    new=$!
    sed -i "s/APP_PID=[0-9]*/APP_PID=$new/" "$DEV/env"
    rm -f "$DEV/restarting"
    for _ in $(seq 100); do H status >/dev/null 2>&1 && break; sleep 0.2; done
    H status >/dev/null || die "the app didn't come back"
    echo "restarted: pid $new" ;;
  env) need_live; cat "$DEV/env" ;;
  # --- the app's own control (herdr-app do/status/ls/check) -----------------------------
  do) need_live; H do "$@" ;;
  status) need_live; H status ;;
  ls) need_live; H ls ;;
  check) # check <mod>: load a mod once and report what's wrong (Herdr's rule: after every change)
    need_live; H check "$HERDR_APP_HOME/mods/${1:?mod name}" ;;
  sync) # the snapshot's mods into the live app again (hot reload)
    need_live; DEV_DIR=$DEV "$SRC/tests/e2e/dev-ctl.sh" sync ;;
  chat) # chat <scenario> [name]: a chat tab on tests/fake-pi/scenarios/<scenario>.json
    need_live; DEV_DIR=$DEV "$SRC/tests/e2e/dev-ctl.sh" open "${1:-tools}" "${2:-chat}" ;;
  dbg) # dbg [python expr over d]: the newest chat's debug dump (nothing until it's written)
    need_live; DEV_DIR=$DEV "$SRC/tests/e2e/dev-ctl.sh" dbg "${1:-d}" 2>/dev/null || true ;;
  hc) need_live; hc "$@" ;;
  # --- seeing ------------------------------------------------------------------------------
  shot) # shot <file in /proof>: the app's current frame
    need_live; H shot "${1:?file}" ;;
  opened) need_live; cat /tmp/opened.log 2>/dev/null || true ;;
  log) need_live; tail -n "${1:-60}" "$DEV/dev.log" ;;
  clip) # clip get | clip set <text>: the box's X clipboard
    case ${1:-get} in
      get) xclip -selection clipboard -o 2>/dev/null || true ;;
      set) shift; printf '%s' "$*" | xclip -selection clipboard -i ;;
      *) die "clip get | clip set <text>" ;;
    esac ;;
  # --- input (real X events, in window px) -----------------------------------------------------
  move|click|drag|scroll|type|key|hold|release|sequence)
    need_live; python3 /opt/box/input.py "$verb" "$@" ;;
  # --- probes ----------------------------------------------------------------------------------
  wait) # wait <terminal> <text> [seconds]: until the terminal's screen shows text; else dump and exit 1
    need_live; t=${1:?terminal}; want=${2:?text}; secs=${3:-10}
    for _ in $(seq $((secs * 10))); do hc read "$t" --lines 0 2>/dev/null | grep -Fq -- "$want" && { echo "found: $want"; exit 0; }; sleep 0.1; done
    echo "missing from $t: $want" >&2; echo "--- $t" >&2; hc read "$t" --lines 30 >&2 || true
    echo "--- status" >&2; H status >&2 || true; exit 1 ;;
  record) # record <scene> <out dir in /proof> [seconds]
    need_live; python3 /opt/box/record.py "$@" ;;
  *) die "unknown verb ${verb:-<none>}" ;;
esac
