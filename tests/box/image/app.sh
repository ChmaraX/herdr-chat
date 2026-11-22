#!/usr/bin/env bash
# The box's live app, from inside the box: `/opt/box/app.sh <verb> [args...]`.
# tests/box/box forwards every verb it doesn't own to this file, so the verbs and
# their help live here only (`app.sh help`).
#
# The live app is tests/e2e/dev.sh, kept running: a private Herdr app with the
# mods, herdr-core on its own session, a fake project space and the fake agents.
# dev-ctl.sh drives it; its environment is $DEV/env. It runs from its own copy of
# the snapshot (~/live/src, made at `up`), so a sync doesn't pull its files away,
# and it holds the box's display (exclusive.sh): no run starts while it's up.
#
# Herdr's own scripts/sandbox (herdr-app, Apache-2.0) has the same input verbs;
# they run tests/e2e/x11input.py, adapted from its sandbox-input.py.
set -euo pipefail
DEV=/home/box/live
SRC=$DEV/src
. /tmp/display.env
die() { echo "box: $*" >&2; exit 1; }
ctl() { DEV_DIR=$DEV "$SRC/tests/e2e/dev-ctl.sh" "$@"; }
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

help() {
  cat <<'EOF'
The live app (one per box, kept running: explore a bug by hand, then film it)
  box app up|down|restart|env <item>  start / stop it; restart: the window only (terminals live on)
  box do <item> <command> [json]    herdr-app do (app and mod commands), e.g. chat.focus
  box status|ls <item>              herdr-app status | ls (box ls with no item: the boxes)
  box check <item> <mod>            herdr-app check: load a mod once, report what's wrong
  box sync-mods <item>              the snapshot's mods into the live app (after box sync)
  box chat <item> [scenario] [name] a chat tab on tests/fake-pi/scenarios/<scenario>.json
  box dbg <item> [expr]             the newest chat's debug dump (a python expr over d)
  box hc <item> <args...>           hc on the live app's core
  box shot <item> <file.png>        the app's current frame
  box opened <item>                 the links the app tried to open (logged, never opened)
  box clip <item> get|set <text>    the box's clipboard
  box log <item> [lines]            the live app's log
  box wait <item> <terminal> <text> [s]
                                    until the terminal shows text; else dump it and exit 1

Input: real X events, in the Herdr window's pixels (Herdr's scripts/sandbox verbs)
  box move <item> x0 y0 x1 y1 [steps]   box click <item> x y [button: 1 left, 3 right]
  box drag <item> x0 y0 x1 y1 [steps]   box scroll <item> x y notches (+ up, - down)
  box type <item> <text>                box key <item> <keysym> [mods...]  (key l Control_L)
  box hold|release <item> <keysym>...   box sequence <item> '<json>'  (a scene, one connection)
EOF
}

verb=${1:-}; shift || true
case $verb in
  help) help ;;
  up)
    live && { echo "the live app is up (pid $APP_PID): box app down first for a new one"; exit 0; }
    /opt/box/exclusive.sh --free display && /opt/box/exclusive.sh --free src || exit 75
    rm -rf "$DEV"; mkdir -p "$DEV"
    cp -a /home/box/src "$SRC"
    (cd "$SRC" && DEV_DIR=$DEV setsid /opt/box/exclusive.sh display "live app" tests/e2e/dev.sh >"$DEV/dev.log" 2>&1 </dev/null &)
    for _ in $(seq 150); do [ -f "$DEV/env" ] && break; sleep 0.2; done
    live || { tail -30 "$DEV/dev.log" >&2; die "the live app didn't start (log above)"; }
    echo "live app up: pid $APP_PID, space $SPACE (project $PROJ), terminal $SHELL_T"
    echo "home $HERDR_APP_HOME, core session $HC_SESSION"
    ;;
  down) # dev.sh's own cleanup ends the app, the core and the hosts; dev-ctl.sh stop waits for it
    if [ -f "$DEV/env" ]; then ctl stop; fi
    rm -rf "$DEV"; echo "live app down" ;;
  restart) need_live; ctl restart ;;
  env) need_live; cat "$DEV/env" ;;
  do) need_live; H do "$@" ;;
  status) need_live; H status ;;
  ls) need_live; H ls ;;
  check) need_live; H check "$HERDR_APP_HOME/mods/${1:?mod name}" ;;
  sync) # the snapshot's mods (after box sync) into the live app's copy, then into the app (hot reload)
    need_live; rm -rf "$SRC/herdr-app/mods"; cp -a /home/box/src/herdr-app/mods "$SRC/herdr-app/mods"; ctl sync ;;
  chat) need_live; ctl open "${1:-tools}" "${2:-chat}" ;;
  dbg) need_live; ctl dbg "${1:-d}" 2>/dev/null || true ;; # (nothing until a chat wrote its dump)
  hc) need_live; hc "$@" ;;
  shot) need_live; H shot "${1:?file}" ;;
  opened) need_live; cat /tmp/opened.log 2>/dev/null || true ;;
  log) need_live; tail -n "${1:-60}" "$DEV/dev.log" ;;
  clip)
    case ${1:-get} in
      get) xclip -selection clipboard -o 2>/dev/null || true ;;
      set) shift; printf '%s' "$*" | xclip -selection clipboard -i ;;
      *) die "clip get | clip set <text>" ;;
    esac ;;
  move|click|drag|scroll|type|key|hold|release|sequence)
    need_live; python3 "$SRC/tests/e2e/x11input.py" "$verb" "$@" ;;
  wait)
    need_live; t=${1:?terminal}; want=${2:?text}; secs=${3:-10}
    for _ in $(seq $((secs * 10))); do hc read "$t" --lines 0 2>/dev/null | grep -Fq -- "$want" && { echo "found: $want"; exit 0; }; sleep 0.1; done
    echo "missing from $t: $want" >&2; echo "--- $t" >&2; hc read "$t" --lines 30 >&2 || true
    echo "--- status" >&2; H status >&2 || true; exit 1 ;;
  record) # record <scene> <out dir> [seconds]: out is emptied first
    need_live; rm -rf "${2:?out}"; mkdir -p "$2"; python3 /opt/box/record.py "$@" ;;
  *) die "unknown verb ${verb:-<none>} (box --help)" ;;
esac
