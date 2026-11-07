#!/usr/bin/env bash
# End-to-end run of the herdr-chat mod in a private Herdr app (see lib.sh): its
# own app home and herdr-core session, the real herdr-chat-host, and fake-pi
# scenarios (tests/fake-pi) in place of Pi. LIVE=1 runs one flow on real Pi
# (anthropic/claude-haiku-4-5) instead.
#
#   tests/e2e/run.sh [artifacts dir] [flows...]     (default: every flow)
#
# Flows drive the chat as a person does: the launcher key, typing (keys.py
# posts keys to the private app only), Enter, Esc; clicks go through the
# mod's own commands (`chat.click:<control>`, `chat.toggle:<id>`),
# which run the click handlers' code. Checks read the host (`herdr-chat-host
# inspect`) and the mod's debug dump (data/herdr-chat/debug/<chat>.json), never
# the screen. Screenshots are taken in short visual passes (lib.sh visible).
set -euo pipefail
ART_ARG="${1:-}"
shift || true
FLOWS="${*:-}"
# LIVE=1 [PROVIDER=pi|claude|codex]: one flow on that real agent (live, live-claude, live-codex).
[ -z "${LIVE:-}" ] || FLOWS="${FLOWS:-live$([ "${PROVIDER:-pi}" = pi ] || echo "-$PROVIDER")}"
. "$(dirname "$0")/lib.sh" "$ART_ARG"
FAKE="$REPO/tests/fake-pi"
SCEN="$FAKE/scenarios"
# E2E_VISUAL=1: the whole run in visual passes (the private window in
# front, the person's app given back every VISIBLE_MAX s and at the end).
[ -z "${E2E_VISUAL:-}" ] || visible
want() { [ -z "$FLOWS" ] || [[ " $FLOWS " == *" $1 "* ]]; }

# The fake TUI for hand-offs: prints its argv, then waits for "q".
# (Its terminal gets the core's environment, so the log path is written in.)
export FAKE_TUI_LOG="$BASE/fake-tui.log"
cat >"$BASE/fake-tui.sh" <<EOF
#!/bin/sh
echo "fake pi TUI: \$*"
echo "\$*" >>"$FAKE_TUI_LOG"
while IFS= read -r line; do [ "\$line" = q ] && exit 0; echo "> \$line"; done
EOF
chmod +x "$BASE/fake-tui.sh"
if [ -n "${LIVE:-}" ]; then
  # Real agents with the person's own logins: Pi and Claude on their cheapest models, Codex picked in the chat (luna, low).
  TUI='"tui": ["'"$BASE"'/fake-tui.sh"]'
  CONFIG='{"pi": {'"$TUI"', "args": ["--model", "anthropic/claude-haiku-4-5", "--session-dir", "'"$BASE"'/pi-sessions"]},
    "claude": {"args": ["--model", "haiku"]}}'
else
  # Every provider runs on the real host, with a fake agent: fake-pi, fake-claude, fake-codex.
  # Each TUI hand-off runs the fake TUI with the adapter's arguments (`--session <f>`, `--resume <id>`, `resume --no-daemon <id>`).
  TUI='"tui": ["'"$BASE"'/fake-tui.sh"]'
  CONFIG='{"pi": {"command": "'"$FAKE"'/fake-pi.mjs", '"$TUI"'}, "claude": {"command": "'"$REPO"'/tests/fake-claude/fake-claude.mjs", '"$TUI"'},
    "codex": {"command": "'"$REPO"'/tests/fake-codex/fake-codex.mjs", '"$TUI"'},
    "env": {"CLAUDE_CONFIG_DIR": "'"$BASE"'/claude-config", "FAKE_CLAUDE_LOG": "'"$BASE"'/fake-claude.log", "FAKE_CLAUDE_SPEED": "2", "HERDR_CHAT_CLAUDE_POLL_MS": "150",
            "FAKE_CODEX_HOME": "'"$BASE"'/codex-home", "FAKE_CODEX_LOG": "'"$BASE"'/fake-codex.log", "FAKE_CODEX_SPEED": "2", "FAKE_PI_SPEED": "2", "FAKE_PI_SCENARIO": "'"$SCEN"'/tools.json", "FAKE_PI_LOG": "'"$BASE"'/fake-pi.log"}}'
fi
install_mods "$CONFIG"
cp "$HERDR_APP_HOME/mods/chat/config.json" "$ART/config.json"; cp "$STATE/settings.json" "$ART/settings.json"
sleep 1.5

PROJ="$BASE/project"
mkdir -p "$PROJ/src"
PROJ="$(cd "$PROJ" && pwd -P)"
printf '# Fake project\n' >"$PROJ/README.md"
printf 'export const a = 1;\n' >"$PROJ/src/a.ts"
printf 'export const b = 2;\n' >"$PROJ/src/b.ts"
git -C "$PROJ" init -q && git -C "$PROJ" add -A && git -C "$PROJ" -c user.email=e@x -c user.name=e commit -qm init
MADE=$("$APP" do space.new --name project --folder "$PROJ")
SPACE=$(echo "$MADE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["space"])')
SHELL_T=$(echo "$MADE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["terminal"])')
# The app matches script key bindings (the composer's Enter) only after it
# has taken a key event with a pane focused: a lone Shift primes it.
sleep 1; do_ pane.focus --terminal "$SHELL_T"; sleep 0.3; keys 56:shift

# E2E_NO_FRAMES=1: minimize the private window, so nothing renders (as with a
# locked screen): the frame checks must SKIP and the rest still pass.
if [ -n "${E2E_NO_FRAMES:-}" ]; then do_ window.minimize; note "E2E_NO_FRAMES: the window is minimized (no frames)"; fi

# Bind the launcher to a key in the private keys.json.
python3 - "$HERDR_APP_HOME/keys.json" <<'EOF'
import json, os, sys
p = sys.argv[1]
k = json.load(open(p)) if os.path.exists(p) else {}
k.setdefault("global", {})["cmd-alt-p"] = "mod.open:new-chat"
json.dump(k, open(p, "w"), indent=1)
EOF

# --- helpers over the chat ------------------------------------------------------------------
# Open a chat with tab.new directly (scenario $2): prints the chat id.
open_chat() {
  local chat="c-$(openssl rand -hex 4)" env="{}"
  do_ pane.focus --terminal "$SHELL_T"; keys 56:shift # see "primes it" above
  case "${2:-}" in "") ;; /*) env="{\"FAKE_PI_SCENARIO\": \"$2\"}" ;; *) env="{\"FAKE_PI_SCENARIO\": \"$SCEN/$2.json\"}" ;; esac
  "$APP" do tab.new "{\"name\":\"$1\",\"space\":\"$SPACE\",\"mod\":\"chat\",\"props\":{\"chat\":\"$chat\",\"cwd\":\"$PROJ\",\"hostEnv\":$env}}" >>"$LOG" 2>&1 || fail "tab.new $1"
  echo "$chat"
}
# Open a chat as provider $2 (claude|codex) on its fake agent, scenario $3 (tests/e2e/<provider>/<name>.json).
open_chat_p() {
  local chat="c-$(openssl rand -hex 4)" env="{}" var
  do_ pane.focus --terminal "$SHELL_T"; keys 56:shift
  var=$(echo "FAKE_$2_SCENARIO" | tr a-z A-Z)
  [ -z "${3:-}" ] || env="{\"$var\": \"$E2E/$2/$3.json\"}"
  "$APP" do tab.new "{\"name\":\"$1\",\"space\":\"$SPACE\",\"mod\":\"chat\",\"props\":{\"chat\":\"$chat\",\"provider\":\"$2\",\"cwd\":\"$PROJ\",\"hostEnv\":$env}}" >>"$LOG" 2>&1 || fail "tab.new $1"
  echo "$chat"
}
# The launcher key (cmd-alt-p) opens the chooser, checked as $1; a dropped key: mod.open by command
# (by_command: that check is a SKIP).
open_launcher() {
  do_ pane.focus --terminal "$SHELL_T"; sleep 0.4; keys 56:shift 35:cmd,alt
  until_ 'overlay_open new-chat' 4 || { by_command "the launcher key didn't land"; do_ mod.open --name new-chat; }
  expect 'overlay_open new-chat' "$1" 8
}
# The launcher's chooser, then choose with a key ($1: enter, or a digit), else (a dropped key) by its
# command, and the next check is a SKIP (by_command).
launch_pick() {
  open_launcher "the launcher shows its chooser (Pi / Claude Code / Codex)"
  if [ "$1" = enter ]; then keys enter; else keys "text:$1"; fi
  until_ '! overlay_open new-chat' 3 || { by_command "the chooser didn't take $1"; do_ new-chat.enter; }
  expect '! overlay_open new-chat' "the chooser took $1 (it closes)" 3
}
# The newest chat id the launcher made (from the debug dumps).
newest_chat() { ls -t "$STATE/debug/" 2>/dev/null | grep -E '^c-[0-9a-f]{8}\.json$' | head -1 | sed 's/\.json$//'; }
d() { dbg "$CHAT" "$1"; }
host() { inspect_chat "$CHAT" "$@"; }
connected() { [ "$(d 'd["connection"]["status"]')" = connected ]; }
phase() { d 'd["phase"]'; }
items_of() { d "[i['kind'] for i in d['items']]"; }
count_kind() { d "len([i for i in d['items'] if i['kind']=='$1'])"; }
cmd() { do_ "chat.$1"; }
# Connected, the agent idle, its host's pane hidden in the chat's tab, the composer focused.
ready() {
  expect connected "connected" 25
  expect '[ "$(phase)" = idle ]' "the agent is idle" 15
  until_ '[ "$(d "d[\"hostHidden\"]")" = true ]' 10 || note "the host's pane isn't hidden yet"
  sleep 0.6
  cmd focus
  until_ '[ "$(d "d[\"composer\"][\"focused\"]")" = true ]' 5 || note "the composer didn't report focus"
}
# Type a prompt and press Enter, checked: the composer empties once it's sent
# (a dropped Enter is pressed again, after a Shift to prime the bindings).
# Setup: whatever it took to send, the checks after it are about the prompt.
send_text() {
  type_text "$1"; BYCMD_NEXT=
  sleep 0.3
  keys enter
  until_ '[ "$(d "d[\"composer\"][\"text\"]")" = "" ]' 3 && return 0
  note "Enter didn't send \"$1\": again"
  cmd focus; sleep 0.3; keys 56:shift enter
  until_ '[ "$(d "d[\"composer\"][\"text\"]")" = "" ]' 3 && return 0
  note "Enter dropped again: the send button's code (chat.click:send)"
  cmd click:send
  until_ '[ "$(d "d[\"composer\"][\"text\"]")" = "" ]' 3 || true
}
# Press a key ($1: enter, esc, down…) and wait for $2 (a condition); a key the
# undrawn window dropped is pressed again (primed), then run as the mod's key command
# (and the next check is a SKIP: by_command).
press() {
  local k="$1" want="$2"
  keys "$k"
  until_ "$want" 3 && return 0
  note "$k didn't land: again, primed"; cmd focus; sleep 0.3; keys 56:shift "$k"
  until_ "$want" 3 && return 0
  by_command "$k dropped twice: chat.key:$k"; cmd "key:$([ "$k" = esc ] && echo escape || echo "$k")"
  until_ "$want" 3 || true
}
# Keys ($1, keys.py specs) for the open picker or card, until $2 holds: the check $4. Dropped keys
# are pressed again (primed), then the same actions run by command ($3: chat commands, ";"
# between): $4 is then a SKIP (by_command), and the checks after it (what reached the agent) count.
# $5 = quick: one try of 1 s, no second press (a dialog that times out soon).
keys_or() {
  local c
  keys 56:shift $1
  if [ "${5:-}" = quick ]; then until_ "$2" 1; else until_ "$2" 3; fi ||
    { [ "${5:-}" != quick ] && note "$1 didn't land: again, primed" && cmd focus && sleep 0.3 && keys 56:shift $1 && until_ "$2" 3; } ||
    { by_command "$1 dropped twice: $3"; IFS=';' read -ra c <<<"$3"; for x in "${c[@]}"; do cmd "$x"; done; }
  expect "$2" "$4" 5
}
# TUI: the hand-off's terminal, once the dump shows it. The TUI can start (and log its argv)
# before the mod's next dump is written, so a read right after the argv check can see null.
handoff_tui() {
  until_ '[ "$(d "(d[\"handoff\"] or {}).get(\"terminal\") is not None")" = true ]' 10 || fail "the dump never showed the hand-off's terminal"
  TUI=$(d 'd["handoff"]["terminal"]')
}
# Whether the chat renders frames now. A locked screen or an undrawn window
# renders nothing (keys, records and the debug dump still work), so checks of
# render-time behaviour (the measured scroller, paging on scroll, sizes read
# while drawing) can't run: they SKIP with the reason instead (needs_frames).
# The probe: two commands (each makes the view notify); its render count must move.
frames() {
  screen_locked && return 1
  local r0; r0=$(d 'd["renders"]')
  cmd hover:; sleep 0.6; cmd hover:
  until_ '[ "$(d "d[\"renders\"]")" -gt "$r0" ]' 3
}
needs_frames() {
  frames && return 0
  skip "$1 (no frames: $(screen_locked && echo "the screen is locked" || echo "the window isn't drawn"))"
  return 1
}
# One key at a time, a beat apart (a window that isn't drawn drops fast bursts).
type_slow() { local s="$1" i; for ((i = 0; i < ${#s}; i++)); do keys "text:${s:i:1}"; sleep 0.08; done; }
# Type into the composer, checked: a keystroke the app drops (rare, while
# the window isn't drawn) is retyped once, with a note in the log.
type_text() {
  local before want
  before=$(d 'd["composer"]["text"]' 2>/dev/null || true)
  keys "text:$1"
  want="$before$1"
  until_ '[ "$(d "d[\"composer\"][\"text\"]")" = "$want" ]' 3 && return 0
  note "composer had \"$(d 'd["composer"]["text"]')\" after typing \"$1\": retyping"
  cmd clear; cmd focus; sleep 0.3; keys 56:shift; type_slow "$want" # shift primes the bindings (see "primes it")
  until_ '[ "$(d "d[\"composer\"][\"text\"]")" = "$want" ]' 3 && return 0
  # Still dropped (the undrawn window took no keys at all): put the text in by the mod's command.
  by_command "retyping didn't land either: chat.type"
  cmd clear; cmd "type:$want"; cmd focus; sleep 0.3; keys 56:shift
  until_ '[ "$(d "d[\"composer\"][\"text\"]")" = "$want" ]' 3 || true
}

# --- flow: open with the launcher key, send by typing, stream, tools -------------------------
if want basic; then
  step "open a chat with the launcher key (cmd-alt-p), in the focused terminal's folder"
  launch_pick enter # the default, Pi (nothing chosen before)
  expect '[ -n "$(newest_chat)" ]' "the launcher opened a chat tab (its debug dump appeared)" 15
  CHAT=$(newest_chat)
  echo "chat $CHAT" >>"$LOG"
  expect connected "the mod started the host and connected" 25
  expect '[ "$(reg "$CHAT" port)" != "" ]' "the host wrote its registry entry"
  expect '[ "$(d "d[\"host\"][\"address\"]")" != "" ] && [ "$(d "d[\"hostPane\"] is not None")" = true ]' "the host terminal is a pane of the chat's tab" 10
  expect '[ "$(d "d[\"hostHidden\"]")" = true ] && [ "$(d "d[\"hostNodePane\"]")" = "$(d "d[\"hostPane\"]")" ]' "that pane is hidden in the layout document" 10
  [ "$(d 'd["zoomed"]')" = false ] && ok "the chat isn't zoomed (no \"Z\": nothing to hide behind a zoom)" || fail "the chat is zoomed"
  [ "$(d 'd["cwd"]')" = "$PROJ" ] && ok "the chat runs in the focused terminal's folder" || fail "cwd $(d 'd["cwd"]')"
  expect '[ "$(phase)" = idle ]' "Pi (fake) is idle" 15
  expect '[ "$(d "len(d[\"statuses\"])")" -ge 2 ]' "extension statuses arrived (ANSI → spans)"
  d 'd["statuses"]' >>"$LOG"

  step "type a prompt and press Enter"
  cmd focus
  sleep 0.3
  type_text "look around the repo"
  expect '[ "$(d "d[\"composer\"][\"text\"]")" = "look around the repo" ]' "the composer holds the typed text"
  press enter '[ "$(d "d[\"composer\"][\"text\"]")" = "" ]'
  expect '[ "$(d "d[\"composer\"][\"text\"]")" = "" ]' "Enter sent it and cleared the composer (no newline left)"
  expect '[ "$(d "[i[\"text\"] for i in d[\"items\"] if i[\"kind\"]==\"user\"][-1]")" = "look around the repo" ]' "the user message is in the timeline"
  expect '[ "$(phase)" = working ] || [ "$(count_kind tool)" -ge 1 ]' "Pi works" 5
  expect '[ "$(phase)" = idle ]' "the run settles" 30
  [ "$(count_kind tool)" -ge 9 ] && ok "9 tool cards ($(count_kind tool))" || fail "tool cards: $(items_of)"
  [ "$(d "len([i for i in d['items'] if i['kind']=='tool' and i['status']=='error'])")" = 1 ] && ok "one failed tool" || fail "failed tools"
  [ "$(count_kind thinking)" -ge 1 ] && ok "a thinking item" || fail "thinking"
  d 'd["items"]' >"$ART/basic-items.json"
  host >"$ART/basic-host.json"
  python3 - "$ART/basic-host.json" "$STATE/debug/$CHAT.json" <<'EOF' && ok "the mod's items match the host's (ids and kinds, in order)" || fail "mod/host items differ"
import json, sys
h = json.load(open(sys.argv[1])); m = json.load(open(sys.argv[2]))
hi = [(i["id"], i["kind"]) for i in h["items"]]; mi = [(i["id"], i["kind"]) for i in m["items"]]
sys.exit(0 if hi == mi else 1)
EOF
  EDIT=$(d "[i['id'] for i in d['items'] if i['kind']=='tool' and i['name']=='edit'][0]")
  BASH=$(d "[i['id'] for i in d['items'] if i['kind']=='tool' and i['name']=='bash'][0]")
  cmd "toggle:$EDIT"
  cmd "toggle:$BASH"
  expect '[ "$(d "sorted(d[\"expanded\"])")" = "$(python3 -c "import json; print(json.dumps(sorted([\"$EDIT\",\"$BASH\"])))")" ]' "toggle expands the edit and bash cards"
  expect '[ "$(d "d[\"tabName\"]")" = "$(d "d[\"name\"]")" ] && [ "$(d "d[\"name\"]")" != "New chat" ]' "the launcher's tab \"pi\" took the chat's name ($(d 'd["name"]'))" 5
  shot basic-1-cards-expanded 0.6
fi

. "$E2E/flows.sh"
. "$E2E/flows-v2.sh"
. "$E2E/flows-v3.sh"
. "$E2E/flows-fix1.sh"
. "$E2E/flows-spacing.sh"
. "$E2E/flows-skills.sh"
. "$E2E/flows-subagent.sh" # last: it switches the app to a clone of main
expect no_mod_errors "no mod errors: none in the app's status, no chat's last render threw (run.log)" 3
hidden
passed
