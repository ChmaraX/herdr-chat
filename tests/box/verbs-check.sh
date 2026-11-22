#!/usr/bin/env bash
# Checks the box's live-app verbs against the real app: each verb, then what the
# app's state says it did. `tests/box/verbs-check.sh <item>` (a box that's up).
# Prints PASS/FAIL lines; exit 1 on any FAIL. It brings the live app up and down.
set -uo pipefail
B="$(cd "$(dirname "$0")" && pwd)/box"
item=${1:?item}
fails=0
ok() { echo "PASS $*"; }
no() { echo "FAIL $*"; fails=$((fails + 1)); }
check() { local name=$1; shift; if "$@" >/dev/null 2>&1; then ok "$name"; else no "$name"; fi; }
until_() { for _ in $(seq 60); do eval "$1" >/dev/null 2>&1 && return 0; sleep 0.25; done; return 1; }
d() { "$B" dbg "$item" "$1"; }

"$B" app down "$item" >/dev/null 2>&1
"$B" app up "$item" >/dev/null || { echo "FAIL the live app didn't start"; exit 1; }
T=$("$B" app env "$item" | sed -n 's/.*SHELL_T=\([^ ]*\).*/\1/p')

# Keys and text, in a terminal.
"$B" do "$item" pane.focus --terminal "$T" >/dev/null
# (quoted: the shell would expand ~ and the braces)
"$B" type "$item" "echo 'a=1&b=[x] {ok} 50% ~ é→ #!'"
"$B" key "$item" Return
check "type: every printable character, and beyond ASCII, reaches the terminal" "$B" wait "$item" "$T" 'a=1&b=[x] {ok} 50% ~ é→ #!' 5

# Drag selects, terminal.copy and Ctrl+Shift+C copy, Ctrl+Shift+V pastes. After `clear` the
# printed line is the terminal's first row: y 108 in the window (the pane's text starts there).
ROW1=108
"$B" type "$item" "clear; echo DRAG-ME-PLEASE"; "$B" key "$item" Return
"$B" wait "$item" "$T" "DRAG-ME-PLEASE" 5 >/dev/null; sleep 0.4
"$B" clip "$item" set stale
"$B" drag "$item" 293 $ROW1 404 $ROW1; "$B" do "$item" terminal.copy >/dev/null 2>&1
until_ '[ "$("$B" clip "$item" get)" = DRAG-ME-PLEASE ]' && ok "drag selects the line; terminal.copy copies it" || no "drag + copy: clipboard '$("$B" clip "$item" get)'"
"$B" clip "$item" set stale
"$B" drag "$item" 293 $ROW1 404 $ROW1; "$B" key "$item" C Control_L Shift_L
until_ '[ "$("$B" clip "$item" get)" = DRAG-ME-PLEASE ]' && ok "Ctrl+Shift+C copies the selection" || no "Ctrl+Shift+C: clipboard '$("$B" clip "$item" get)'"
"$B" clip "$item" set PASTED-FROM-CLIP; "$B" key "$item" V Control_L Shift_L
check "clip set, then Ctrl+Shift+V pastes it" "$B" wait "$item" "$T" PASTED-FROM-CLIP 5
"$B" key "$item" u Control_L

# A Ctrl-click on a link, as a sequence (Ctrl held across the click): the app opens it.
"$B" type "$item" "clear; echo https://example.com/box-check"; "$B" key "$item" Return
"$B" wait "$item" "$T" "https://example.com/box-check" 5 >/dev/null; sleep 0.4
"$B" sequence "$item" '[["move",700,400,360,'$ROW1',20],["hold","Control_L"],["sleep",0.3],["click",360,'$ROW1'],["release","Control_L"],["sleep",0.5]]'
until_ '"$B" opened "$item" | grep -q "https://example.com/box-check"' && ok "sequence: Ctrl-click opens the link (box opened)" || no "Ctrl-click: opened '$("$B" opened "$item")'"

# Mouse in a chat: a click opens the model picker, Esc closes it, a right-click opens a menu.
"$B" chat "$item" tools verbs >/dev/null
until_ '[ "$(d "d[\"connection\"][\"status\"]")" = connected ] && [ "$(d "d[\"phase\"]")" = idle ]'
"$B" do "$item" chat.focus >/dev/null; sleep 0.3
"$B" type "$item" "look around"; "$B" key "$item" Return
until_ '[ "$(d "d[\"phase\"]")" = idle ] && [ "$(d "len(d[\"items\"])")" -gt 3 ]' && ok "type + Return sends a prompt; the agent answers" || no "the prompt: phase $(d 'd["phase"]')"
"$B" click "$item" 480 700
until_ '[ "$(d "(d[\"picker\"] or {}).get(\"kind\")")" = model ]' && ok "click: the model chip opens the model picker" || no "click: picker $(d 'd["picker"]')"
"$B" key "$item" Escape
until_ '[ "$(d "d[\"picker\"]")" = null ]' && ok "key Escape closes it" || no "Escape: picker $(d 'd["picker"]')"
"$B" click "$item" 310 20 3
until_ '"$B" status "$item" | grep -q "\"menu\""' && ok "click button 3: a right-click opens the tab menu" || no "right-click: overlays $("$B" status "$item" | tr -d '\n ' | grep -o '"overlays":[^]]*]')"
"$B" key "$item" Escape

# Scroll: a long chat, wheel notches up unstick it, down moves it back.
"$B" exec "$item" -- sh -c 'python3 tests/e2e/zoom/scenario.py tests/fake-pi/scenarios/_long.json' >/dev/null
"$B" chat "$item" _long long >/dev/null
until_ '[ "$(d "len(d[\"items\"])")" = 200 ] && [ "$(d "d[\"top\"]")" -gt 0 ]'
t0=$(d 'd["top"]')
"$B" scroll "$item" 700 300 5; sleep 0.8
t1=$(d 'd["top"]'); s1=$(d 'd["sticky"]')
[ "$s1" = false ] && [ "$t1" -lt "$t0" ] && ok "scroll up 5 notches: the view leaves the bottom ($t0 → $t1)" || no "scroll up: sticky $s1 top $t0 → $t1"
"$B" scroll "$item" 700 300 -2; sleep 0.8
t2=$(d 'd["top"]')
[ "$t2" -gt "$t1" ] && ok "scroll down 2: it moves back ($t1 → $t2)" || no "scroll down: $t1 → $t2"
"$B" exec "$item" -- rm -f tests/fake-pi/scenarios/_long.json

# The app's own checks, restart, shot.
check "check: the chat mod passes" "$B" check "$item" chat
"$B" exec "$item" -- bash -c '. /home/box/live/env; mkdir -p $HERDR_APP_HOME/mods/broken; echo "export default class { render( { return null } }" > $HERDR_APP_HOME/mods/broken/main.js'
if "$B" check "$item" broken >/dev/null 2>&1; then no "check: a broken mod passed"; else ok "check: a broken mod fails"; fi
"$B" exec "$item" -- bash -c '. /home/box/live/env; rm -rf $HERDR_APP_HOME/mods/broken'
"$B" type "$item" "x" >/dev/null 2>&1
"$B" do "$item" pane.focus --terminal "$T" >/dev/null
"$B" type "$item" "echo survives-restart"; "$B" key "$item" Return
"$B" wait "$item" "$T" survives-restart 5 >/dev/null
p0=$("$B" app env "$item" | sed -n 's/.*APP_PID=\([0-9]*\).*/\1/p')
"$B" app restart "$item" >/dev/null
p1=$("$B" app env "$item" | sed -n 's/.*APP_PID=\([0-9]*\).*/\1/p')
[ -n "$p1" ] && [ "$p1" != "$p0" ] && "$B" wait "$item" "$T" survives-restart 5 >/dev/null && ok "app restart: a new window ($p0 → $p1), the terminal and its output kept" || no "restart: $p0 → $p1"
f=$(mktemp -t boxcheck).png
"$B" shot "$item" "$f" >/dev/null && [ "$(head -c 8 "$f" | od -An -tx1 | tr -d ' \n')" = 89504e470d0a1a0a ] && ok "shot: a PNG of the current frame" || no "shot"
rm -f "$f"
if "$B" wait "$item" "$T" "never-printed-text" 1 >/dev/null 2>&1; then no "wait found text that isn't there"; else ok "wait: a missing text fails (exit 1, with a dump)"; fi

"$B" app down "$item" >/dev/null
echo "$([ $fails = 0 ] && echo "all passed" || echo "$fails failed")"
exit $((fails > 0))
