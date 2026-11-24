#!/usr/bin/env bash
# Scene: in a chat with a turn behind it, open the model picker from the
# composer's chip with the mouse, filter it by typing, pick a model with the keys.
#   tests/box/box record <item> tests/box/scenes/model-picker.sh
# A scene has three parts (as Herdr's scripts/notes-clips): setup builds the
# state (not filmed), play is filmed, crop is the region (width:height:x:y in
# window px). It runs in the box; `app <verb>` is the live app's verbs.
set -euo pipefail
app() { /opt/box/app.sh "$@"; }
until_() { for _ in $(seq 100); do eval "$1" && return 0; sleep 0.1; done; return 1; }
case ${1:?setup, play or crop} in
  setup)
    app chat tools picker >/dev/null
    until_ '[ "$(app dbg "d[\"connection\"][\"status\"]")" = connected ] && [ "$(app dbg "d[\"phase\"]")" = idle ]'
    # One turn first: the composer then sits at the bottom, where the chip is filmed.
    app do chat.focus >/dev/null; sleep 0.3
    app type "look around"; app key Return
    until_ '[ "$(app dbg "d[\"phase\"]")" = idle ] && [ "$(app dbg "len(d[\"items\"])")" -gt 3 ]'
    app move 900 400 900 400
    sleep 0.5
    ;;
  play)
    app sequence '[["move",900,400,480,700,30],["sleep",0.4],["click",480,700],["sleep",0.6]]'
    app type "son"
    sleep 0.6
    app key Return
    sleep 1
    ;;
  crop) echo '900:420:330:380' ;;
esac
