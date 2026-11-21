# Sub-agent chats (docs/dev/research/subagent-chat.md), sourced by run.sh last (it
# switches the private app to a clone of `main`): flow `subagent`. A parent (the
# project's shell terminal) starts a chat host with `hc run … pi-chat "<task>"`
# (an hc template running bin/herdr-chat-subagent, as install.sh writes it); the
# layout's agents list is chat-agents and its terminal_menu chat-menu
# (install/layout.ts, as install.sh runs it). A sub-agent row's click is
# `chat-agents.peek:<address>` (the code the row's on_click runs: this.peek),
# the dialog's buttons `chat.click:peek:tab|close`, a right-click menu item
# `chat-menu.pick:<n>`. Checks read the dumps (data/herdr-chat/debug/<chat>.peek.json
# for the dialog, <chat>.json for its tab), `hc get`/`hc read` of the sub-agent,
# and the app's status and layout document.

# Any overlay whose status entry mentions $1 (a mod name, an id, "layout").
has_overlay() { "$APP" status | python3 -c 'import json,sys; o=json.load(sys.stdin)["overlays"]; sys.exit(0 if any(sys.argv[1] in json.dumps(x) for x in o) else 1)' "$1"; }
term_field() { hc get "$1" --json | python3 -c 'import json,sys; t=json.load(sys.stdin); v=eval(sys.argv[1]); print("" if v is None else v)' "$2"; }
answers() { screen "$1" | grep -c '^Quick answer\.$'; }
# The tab whose chat pane has props.subagent = $1.
subtab() { mod_panes | python3 -c 'import json,sys
for l in sys.stdin:
    tab, pane, mod, props = l.rstrip("\n").split(" ", 3)
    if mod == "chat" and json.loads(props).get("subagent") == sys.argv[1]: print(tab); break' "$1"; }

if want subagent; then
  step "sub-agents: the layout routes a chat sub-agent's click to the chat (install/layout.ts, as install.sh runs it)"
  "$NODE" "$REPO/install/layout.ts" install "$HERDR_APP_HOME" --app "$APP" >>"$LOG" 2>&1 || fail "install/layout.ts install"
  expect '[ "$("$APP" status | python3 -c "import json,sys; print(json.load(sys.stdin)[\"layout\"])")" = main-copy ]' "Herdr's own main on screen: cloned as main-copy and shown" 10
  python3 - "$HERDR_APP_HOME/layouts/main-copy.json" <<'EOF' && ok "main-copy: the agents block shows chat-agents (main's agents list kept in replaces), terminal_menu is chat-menu" || fail "main-copy wasn't patched"
import json, sys
l = json.load(open(sys.argv[1]))
found = []
def walk(n):
    if (n.get("content") or {}).get("mod") == "chat-agents": found.append(n["content"])
    for c in n.get("children", []): walk(c)
walk(l)
sys.exit(0 if l.get("terminal_menu") == "chat-menu" and found and found[0]["props"]["replaces"]["mod"] == "agents" else 1)
EOF
  sleep 1
  # Another chat's view, open the whole time in a tab behind: its sweepOrphans runs every 30 s.
  SWEEPER=$(open_chat sweeper)
  until_ '[ "$(dbg "$SWEEPER" "d[\"connection\"][\"status\"]")" = connected ]' 25 || fail "the sweeper chat connected"
  do_ pane.focus --terminal "$SHELL_T" # its tab behind: chat commands then reach only the dialog

  step "the parent starts a chat sub-agent with the hc template: hc run --parent <shell> --name review pi-chat \"<task>\""
  mkdir -p "$XDG_CONFIG_HOME/herdr-core/templates"
  # install.sh's template, with the fake agent's quick-answer scenario in front.
  cat >"$XDG_CONFIG_HOME/herdr-core/templates/pi-chat.md" <<EOF
---
description: Pi as a sub-agent the person can open as a chat in Herdr (its row in the agents list). Give it the task in hc run.
command: env FAKE_PI_SCENARIO='$SCEN/abort.json' '$REPO/bin/herdr-chat-subagent' --provider pi
installed-by: herdr-chat
---
You are a sub-agent: another agent started you with hc run and gave you the task below. Stay within it. The person may also write to you here.
EOF
  RUN=$(hc run --bg --json --parent "$SHELL_T" --name review --cwd "$PROJ" pi-chat "quick: review src/a.ts only" 2>>"$LOG") || fail "hc run pi-chat"
  echo "hc run: $RUN" >>"$LOG"
  SUB=$(echo "$RUN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["address"])')
  [ "$(echo "$RUN" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("first_message", {}).get("sent"))')" = True ] && ok "the core sent the template's first message (first_message.sent)" || fail "first_message not sent: $RUN"
  expect '[ "$(term_field "$SUB" "t[\"labels\"].get(\"herdr-chat.role\")")" = subagent ] && [ -n "$(term_field "$SUB" "t[\"labels\"].get(\"herdr-chat.chat\")")" ]' "the launcher labeled its terminal (herdr-chat.chat, herdr-chat.role=subagent)" 10
  SUBCHAT=$(term_field "$SUB" 't["labels"]["herdr-chat.chat"]')
  [ "$(term_field "$SUB" 't.get("parent")')" = "$SHELL_T" ] && ok "its parent is the shell ($SHELL_T): a tree row under it, no pane" || fail "parent $(term_field "$SUB" 't.get("parent")')"
  expect '[ "$(answers "$SUB")" -ge 1 ]' "hc read: the task's answer (Quick answer.)" 20
  screen "$SUB" | grep -q 'right-click → Open as chat' && ok "hc read: the transcript's hint line" || fail "no hint line"

  step "its row's click (chat-agents peek): the chat in a dialog where the peek opens"
  CHAT="$SUBCHAT.peek" # d(), cmd, type_text and press read and drive the dialog's copy
  do_ "chat-agents.peek:$SUB"
  expect 'overlay_open chat' "a dialog overlay with the chat mod" 8
  "$APP" status | python3 -c 'import json,sys; print("overlays:", json.dumps(json.load(sys.stdin)["overlays"]))' >>"$LOG"
  has_overlay terminal-peek && fail "the Rust peek opened too" || ok "no Rust peek (the TUI transcript) opened"
  expect connected "the dialog's chat connected to the sub-agent's host (by its herdr-chat.chat label)" 15
  [ "$(d 'd["peekMode"]')" = true ] && [ "$(d 'd["sub"]')" = "$SUB" ] && ok "peek mode, for $SUB" || fail "peek mode"
  [ "$(d 'd["placeFrom"]')" = null ] && [ "$(d 'd["hideWrites"]')" = 0 ] && [ "$(d 'd["host"]["address"]')" = "$SUB" ] && ok "no place, no layout-document writes; its host is the sub-agent" || fail "place $(d 'd["placeFrom"]') writes $(d 'd["hideWrites"]')"
  expect '[ "$(d "[i[\"text\"] for i in d[\"items\"] if i[\"kind\"]==\"user\"][0].endswith(\"quick: review src/a.ts only\")")" = true ] && [ "$(count_kind assistant)" -ge 1 ]' "the dialog shows the task (template body + task) and its answer" 10
  # The keyboard is the composer's on open: a key typed now lands there (no focus command first).
  keys "text:x"
  until_ '[ "$(d "d[\"composer\"][\"text\"]")" = x ]' 3 && ok "the composer has the keyboard on open (a typed key lands there)" || skip "a key typed on open didn't land (the window $(drawn && echo "is drawn" || echo "isn't drawn"))"
  cmd clear
  until_ '[ "$(d "d[\"composer\"][\"text\"]")" = "" ]' 3 || fail "chat.clear didn't empty the composer"

  step "type in the dialog, Enter: the sub-agent answers, and the parent's hc read shows it"
  send_text "quick: second pass"
  expect '[ "$(count_kind assistant)" -ge 2 ] && [ "$(phase)" = idle ]' "the dialog shows the second answer" 20
  expect '[ "$(answers "$SUB")" -ge 2 ] && screen "$SUB" | grep -q "^> quick: second pass"' "hc read: the prompt typed in the dialog and its answer" 10

  step "Esc (idle) closes the dialog"
  cmd focus; sleep 0.3
  press esc '! overlay_open chat'
  expect '! overlay_open chat' "the dialog closed" 5
  sleep 4 # (the old close() killed the host 2 s after a chat view closed: place.js reapLater)
  [ "$(term_field "$SUB" 't["state"]')" = live ] && ok "the sub-agent's host lives on after its dialog closed" || fail "the host ended when its dialog closed"

  step "90 s with the sweeper chat's sweepOrphans running (every 30 s): the host is never taken for an orphan"
  sleep 86
  [ "$(term_field "$SUB" 't["state"]')" = live ] && ok "still live after 90 s" || fail "the host was ended"
  dbg "$SWEEPER" 'd["log"]' | grep -q "orphan host $SUB" && fail "the sweeper called it an orphan" || ok "the sweeper's log names no orphan"
  hc send review "quick: still there" >>"$LOG" 2>&1 || fail "hc send review"
  expect '[ "$(answers "$SUB")" -ge 3 ]' "hc send still answered" 20

  step "reopen the dialog: the whole chat is there"
  do_ "chat-agents.peek:$SUB"
  expect 'overlay_open chat' "the dialog opened again" 8
  expect 'connected && [ "$(count_kind assistant)" -ge 3 ]' "connected, with all three answers" 15

  step "↗ Open as tab (the dialog's header): a tab in the parent's space; the host stays under its parent"
  cmd click:peek:tab
  expect '! overlay_open chat' "the dialog closed" 5
  expect '[ -n "$(subtab "$SUB")" ]' "a chat pane with props.subagent = $SUB in the layout document" 10
  SUBTAB=$(subtab "$SUB")
  "$APP" ls | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if any(t["id"] == sys.argv[1] for s in d["spaces"] if s["id"] == sys.argv[2] for t in s["tabs"]) else 1)' "$SUBTAB" "$SPACE" &&
    ok "the tab is in the parent's space ($SPACE)" || fail "tab $SUBTAB isn't in $SPACE"
  CHAT="$SUBCHAT"
  expect connected "the tab's chat connected" 15
  [ "$(tab_panes "$SUBTAB" | wc -l | tr -d ' ')" = 1 ] && [ "$(d 'd["hideWrites"]')" = 0 ] && ok "the tab holds the chat alone: the host isn't adopted as its pane" || fail "tab panes: $(tab_panes "$SUBTAB" | tr '\n' ' ')"
  [ -z "$(term_field "$SUB" 't["labels"].get("herdr.tab")')" ] && [ "$(term_field "$SUB" 't.get("parent")')" = "$SHELL_T" ] && ok "the host keeps no tab label and its parent" || fail "the host was moved"

  step "close the tab: the host stays (parked under its parent), still answering hc send"
  do_ tab.close --id "$SUBTAB"
  expect '[ -z "$(subtab "$SUB")" ]' "the tab is gone" 8
  sleep 4
  [ "$(term_field "$SUB" 't["state"]')" = live ] && [ -z "$(term_field "$SUB" 't["labels"].get("herdr.space")')" ] && [ "$(term_field "$SUB" 't.get("parent")')" = "$SHELL_T" ] &&
    ok "live, paneless, under $SHELL_T" || fail "the host after the tab closed: $(hc get "$SUB" --json)"
  hc send review "quick: after the tab" >>"$LOG" 2>&1 || fail "hc send review"
  expect '[ "$(answers "$SUB")" -ge 4 ]' "hc send answered" 20

  step "the Rust peek's right-click menu (chat-menu): Open as chat replaces it"
  do_ terminal.peek --terminal "$SUB"
  expect 'has_overlay terminal-peek || has_overlay layout' "the Rust peek (the host's transcript) opened" 5
  do_ "chat-agents.menu:$SUB"
  expect 'overlay_open chat-menu' "the right-click menu for that terminal" 5
  do_ chat-menu.pick:0
  CHAT="$SUBCHAT.peek"
  expect 'overlay_open chat && ! overlay_open chat-menu && ! has_overlay terminal-peek' "Open as chat: the chat dialog, the peek and the menu closed" 8
  expect connected "connected" 15
  cmd click:peek:close
  expect '! overlay_open chat' "✕ closed it" 5

  step "the parent ends it: hc kill"
  hc kill "$SUB" >>"$LOG" 2>&1
  expect '[ "$(term_field "$SUB" "t[\"state\"]" 2>/dev/null)" != live ]' "the sub-agent ended" 10
  expect '[ "$(reg "$SUBCHAT" pid)" = "" ]' "its registry entry is cleared (pid null)" 10
  shot subagent-end 0.3
fi

# --- flow `journey`: new-chat's commands and keys, the launcher's letters, Continue as chat ----------
# new-chat.<agent> reach the layout's floating new-chat copy (install/layout.ts); the person's global
# keys go through install/keys.ts; Continue as chat hands a Pi TUI sub-agent (a fake that reports
# idle as pi, its session labeled as herdr-chat-lock labels a real one) over to a chat host.
chat_dumps() { ls "$STATE/debug/" 2>/dev/null | { grep -E '^c-[0-9a-f]{8}\.json$' || true; } | sed 's/\.json$//' | sort; }
# The chat whose dump appeared after the list $1 was taken.
new_chat_since() { comm -13 <(printf '%s\n' $1 | sort) <(chat_dumps) | head -1 || true; }
chat_tab() { mod_panes | python3 -c 'import json,sys
for l in sys.stdin:
    tab, pane, mod, props = l.rstrip("\n").split(" ", 3)
    if mod == "chat" and json.loads(props).get("chat") == sys.argv[1]: print(tab); break' "$1"; }
close_chat() { local t; t=$(chat_tab "$1"); [ -z "$t" ] || do_ tab.close --id "$t" --confirmed true; }

if want journey; then
  step "journey: the layout gets new-chat's floating copy (install/layout.ts), the keys come from data/herdr-chat/keys.json (install/keys.ts)"
  "$NODE" "$REPO/install/layout.ts" install "$HERDR_APP_HOME" --app "$APP" >>"$LOG" 2>&1 || fail "install/layout.ts install"
  sleep 1
  LNAME=$("$APP" status | python3 -c 'import json,sys; print(json.load(sys.stdin)["layout"])')
  python3 -c 'import json,sys
l = json.load(open(sys.argv[1]))
sys.exit(0 if any((f.get("content") or {}).get("mod") == "new-chat" and f["content"]["props"]["role"] == "commands" for f in l.get("floating", [])) else 1)' "$HERDR_APP_HOME/layouts/$LNAME.json" &&
    ok "layout $LNAME: an empty floating block with new-chat (props.role commands)" || fail "no new-chat floating block in $LNAME"
  mkdir -p "$STATE"
  echo '{"global": {"claude": "cmd-alt-k"}}' >"$STATE/keys.json"
  "$NODE" "$REPO/install/keys.ts" install "$HERDR_APP_HOME" --platform darwin >"$ART/journey-keys.txt" 2>&1 || fail "install/keys.ts install: $(cat "$ART/journey-keys.txt")"
  [ "$(tail -1 "$ART/journey-keys.txt")" = "New chat: ⌘I · Claude Code chat: ⌥⌘K" ] && ok "install/keys.ts: \"$(tail -1 "$ART/journey-keys.txt")\"" || fail "keys summary: $(cat "$ART/journey-keys.txt")"
  python3 -c 'import json,sys; g=json.load(open(sys.argv[1]))["global"]; sys.exit(0 if g.get("cmd-i") == "mod.open:new-chat" and g.get("cmd-alt-k") == "new-chat.claude" else 1)' "$HERDR_APP_HOME/keys.json" &&
    ok "keys.json: cmd-i → mod.open:new-chat, cmd-alt-k → new-chat.claude" || fail "keys.json global"
  sleep 1

  step "new-chat.open toggles the launcher; new-chat.pi opens a Pi chat tab at once"
  do_ pane.focus --terminal "$SHELL_T"
  do_ new-chat.open
  expect 'overlay_open new-chat' "new-chat.open: the launcher" 5
  do_ new-chat.open
  expect '! overlay_open new-chat' "new-chat.open again: it closes" 5
  BEFORE=$(chat_dumps)
  do_ new-chat.pi
  expect '[ -n "$(new_chat_since "$BEFORE")" ]' "new-chat.pi: a new chat tab (its dump appeared)" 15
  J=$(new_chat_since "$BEFORE")
  expect '[ "$(dbg "$J" "d[\"provider\"]")" = pi ] && [ "$(dbg "$J" "d[\"connection\"][\"status\"]")" = connected ]' "it is a Pi chat, connected" 25
  [ "$(dbg "$J" 'd["cwd"]')" = "$PROJ" ] && ok "in the focused terminal's folder" || fail "cwd $(dbg "$J" 'd["cwd"]')"
  close_chat "$J"

  step "the person's key ⌥⌘K (new-chat.claude): a Claude Code chat tab"
  BEFORE=$(chat_dumps)
  do_ pane.focus --terminal "$SHELL_T"; sleep 0.4; keys 56:shift 40:cmd,alt
  until_ '[ -n "$(new_chat_since "$BEFORE")" ]' 5 || { by_command "⌥⌘K didn't land"; do_ new-chat.claude; }
  expect '[ -n "$(new_chat_since "$BEFORE")" ]' "⌥⌘K opened a chat tab" 15
  J=$(new_chat_since "$BEFORE")
  expect '[ "$(dbg "$J" "d[\"provider\"]")" = claude ]' "a Claude Code chat" 15
  close_chat "$J"

  step "the launcher's letters: X picks Codex"
  BEFORE=$(chat_dumps)
  open_launcher "the launcher (cmd-alt-p)"
  keys "text:x"
  until_ '! overlay_open new-chat' 3 || { by_command "x didn't land (or knownAgents says Codex isn't installed)"; do_ new-chat.pick:codex; }
  expect '! overlay_open new-chat' "x picked (the launcher closed)" 3
  expect '[ -n "$(new_chat_since "$BEFORE")" ] && [ "$(dbg "$(new_chat_since "$BEFORE")" "d[\"provider\"]")" = codex ]' "a Codex chat tab" 15
  close_chat "$(new_chat_since "$BEFORE")"

  step "Continue as chat: a Pi TUI sub-agent, idle, its session labeled (as herdr-chat-lock does)"
  TS="$BASE/tui-session.jsonl"
  python3 - "$TS" "$PROJ" <<'PY'
import json, sys
path, cwd = sys.argv[1:]
ts = "2026-11-05T12:00:00.000Z"
u = {"role": "user", "content": [{"type": "text", "text": "check the README (asked in the TUI)"}], "timestamp": 1}
a = {"role": "assistant", "content": [{"type": "text", "text": "The README has one heading."}], "api": "fake", "provider": "fake", "model": "fake",
     "usage": {"input": 1, "output": 1, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 2, "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}}, "stopReason": "stop", "timestamp": 2}
with open(path, "w") as f:
    f.write(json.dumps({"type": "session", "version": 3, "id": "tui-1", "timestamp": ts, "cwd": cwd}) + "\n")
    f.write(json.dumps({"type": "message", "id": "m0", "parentId": None, "timestamp": ts, "message": u}) + "\n")
    f.write(json.dumps({"type": "message", "id": "m1", "parentId": "m0", "timestamp": ts, "message": a}) + "\n")
PY
  # A fake Pi TUI: a script named pi (the agent's program is found by its name), its status
  # reported again and again (one report at start can go before the core reads the terminal).
  mkdir -p "$BASE/tuibin"
  cat >"$BASE/tuibin/pi" <<'JS'
process.title = "pi";
const report = () => process.stdout.write("\x1b]7501;state=idle:app=pi\x1b\\");
report(); setInterval(report, 500);
console.log("fake Pi TUI");
JS
  TRUN=$(hc run --bg --json --parent "$SHELL_T" --name tuisub --cwd "$PROJ" -- "$NODE" "$BASE/tuibin/pi" 2>>"$LOG") || fail "hc run the fake TUI"
  TUI=$(echo "$TRUN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["address"])')
  hc label "$TUI" "herdr-chat.session=$TS" >>"$LOG" 2>&1 || fail "hc label"
  expect '[ "$(term_field "$TUI" "(t.get(\"status\") or {}).get(\"state\")")" = idle ] && [ "$(term_field "$TUI" "(t.get(\"status\") or {}).get(\"app\")")" = pi ]' "the TUI reports idle, as pi, under $SHELL_T" 10
  # The app learns the TUI's status a moment after the core: the menu offers Continue as chat once it has.
  menu_offers() {
    rm -f "$STATE/debug/chat-menu.json"
    do_ "chat-agents.menu:$TUI"
    until_ '[ -f "$STATE/debug/chat-menu.json" ]' 3 && python3 -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1])).get("cantContinue") is None else 1)' "$STATE/debug/chat-menu.json"
  }
  for _ in 1 2 3 4 5; do menu_offers && break; do_ overlay.close; sleep 1; done
  expect 'overlay_open chat-menu' "its right-click menu (chat-menu)" 5
  python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print("chat-menu:", json.dumps({"cantContinue": d.get("cantContinue"), "terminal": {k: (d.get("terminal") or {}).get(k) for k in ("address","state","status","parent","program","app","agent","report","labels")}}))' "$STATE/debug/chat-menu.json" >>"$LOG" 2>&1 || true
  do_ chat-menu.pick:0
  expect '[ "$(term_field "$TUI" "t[\"state\"]" 2>/dev/null)" != live ]' "Continue as chat ended the TUI (hc kill)" 10
  expect '[ -n "$(term_field tuisub "t[\"labels\"].get(\"herdr-chat.chat\")" 2>/dev/null)" ]' "a chat host answers to the same name (tuisub), labeled herdr-chat.chat" 15
  NT=$(term_field tuisub 't["address"]')
  [ "$NT" != "$TUI" ] && [ "$(term_field "$NT" 't.get("parent")')" = "$SHELL_T" ] && [ "$(term_field "$NT" 't["labels"].get("herdr-chat.role")')" = subagent ] &&
    ok "the host $NT: the TUI's parent ($SHELL_T), role subagent" || fail "the host: $(hc get tuisub --json)"
  CHAT="$(term_field "$NT" 't["labels"]["herdr-chat.chat"]').peek"
  expect 'overlay_open chat' "the chat dialog opened for it" 10
  expect connected "the dialog connected" 15
  expect '[ "$(d "[i[\"text\"] for i in d[\"items\"] if i[\"kind\"]==\"user\"][0]")" = "check the README (asked in the TUI)" ] && [ "$(d "[i[\"len\"] for i in d[\"items\"] if i[\"kind\"]==\"assistant\"][0]")" = 27 ]' "the dialog shows the TUI session's history (its question, and its 27-character answer)" 10
  inspect_chat "${CHAT%.peek}" | grep -q '"The README has one heading."' && ok "the host has the TUI's answer (herdr-chat-host inspect)" || fail "the host's items: $(inspect_chat "${CHAT%.peek}" | head -c 600)"
  hc send tuisub "after the hand-over" >>"$LOG" 2>&1 || fail "hc send tuisub"
  expect '[ "$(d "[i[\"text\"] for i in d[\"items\"] if i[\"kind\"]==\"user\"][-1].endswith(\"after the hand-over\")")" = true ]' "hc send tuisub reached the new host (the dialog shows it)" 10
  expect '[ "$(phase)" = idle ] && [ "$(count_kind assistant)" -ge 2 ]' "and it answered" 40
  grep -q "after the hand-over" "$TS" && ok "the host writes on in the TUI's session file" || fail "the session file didn't grow"
  screen "$SHELL_T" | tail -8 >"$ART/journey-parent-screen.txt"
  note "the parent's screen after the hand-over: $(tr '\n' '|' <"$ART/journey-parent-screen.txt")"
  cmd click:peek:close
  hc kill tuisub >>"$LOG" 2>&1 || true
  shot journey-end 0.3
fi

# --- flow `tui-in-place`: Continue as chat on a top-level Pi TUI (a shell's foreground program) -------
# A fake Pi (node, process.title "pi", reports idle as pi, quits 0.3 s after SIGTERM) runs from a shell
# in its own tab, its session labeled as herdr-chat-lock labels a real one. Continue as chat
# (new-chat.continue:<t>, what chat-menu's item runs): the chat opens in that tab, the host waits for
# the pid (--after-pid), the shell's pane closes, the chat has the history and the session's model.
if want tui-in-place; then
  step "tui-in-place: a Pi TUI in a shell, in its own tab, idle, its session labeled"
  "$NODE" "$REPO/install/layout.ts" install "$HERDR_APP_HOME" --app "$APP" >>"$LOG" 2>&1 || fail "install/layout.ts install"
  sleep 1
  TS="$BASE/tip-session.jsonl"
  python3 - "$TS" "$PROJ" <<'PY'
import json, sys
path, cwd = sys.argv[1:]
ts = "2026-11-05T12:00:00.000Z"
u = {"role": "user", "content": [{"type": "text", "text": "asked in the top-level TUI"}], "timestamp": 1}
a = {"role": "assistant", "content": [{"type": "text", "text": "Answered in the TUI."}], "api": "fake", "provider": "fake", "model": "fake",
     "usage": {"input": 1, "output": 1, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 2, "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}}, "stopReason": "stop", "timestamp": 2}
with open(path, "w") as f:
    f.write(json.dumps({"type": "session", "version": 3, "id": "tip-1", "timestamp": ts, "cwd": cwd}) + "\n")
    f.write(json.dumps({"type": "model_change", "id": "x0", "parentId": None, "timestamp": ts, "provider": "openai-codex", "modelId": "gpt-5.6-luna"}) + "\n")
    f.write(json.dumps({"type": "thinking_level_change", "id": "x1", "parentId": "x0", "timestamp": ts, "thinkingLevel": "high"}) + "\n")
    f.write(json.dumps({"type": "message", "id": "m0", "parentId": "x1", "timestamp": ts, "message": u}) + "\n")
    f.write(json.dumps({"type": "message", "id": "m1", "parentId": "m0", "timestamp": ts, "message": a}) + "\n")
PY
  cat >"$BASE/fake-pi-shell-tui.mjs" <<'JS'
process.title = "pi";
// Reported again and again: one report at start can go before the core reads the terminal.
const report = () => process.stdout.write("\x1b]7501;state=idle:app=pi\x1b\\");
report(); const every = setInterval(report, 500);
console.log("fake Pi TUI (in a shell)");
process.on("SIGTERM", () => { clearInterval(every); console.log("SIGTERM: quitting"); setTimeout(() => process.exit(0), 300); });
JS
  # Through the core, as a new tab of the active space (herdr.space/herdr.tab labels; a tab id the app
  # doesn't know becomes a new tab), the shell running it as a person's would (zsh -lic "pi; exec zsh").
  SP=$(app_ls | python3 -c 'import json,sys; print([s["id"] for s in json.load(sys.stdin)["spaces"] if s["active"]][0])')
  OUT=$(hc run --bg --json --keep --no-parent --cwd "$PROJ" --label "herdr.space=$SP" --label herdr.tab=tbtip0000 -- /bin/zsh -lic "$NODE $BASE/fake-pi-shell-tui.mjs; exec /bin/zsh -li" 2>>"$LOG") || fail "hc run the TUI"
  note "hc run: $OUT"
  TIP=$(echo "$OUT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["address"])')
  hc label "$TIP" "herdr-chat.session=$TS" >>"$LOG" 2>&1 || fail "hc label"
  expect '[ "$(term_field "$TIP" "(t.get(\"foreground\") or {}).get(\"argv\",[None])[0]")" = pi ] && [ "$(term_field "$TIP" "(t.get(\"status\") or {}).get(\"state\")")" = idle ]' "the shell's foreground is pi, idle" 10
  TIPTAB=$(app_ls | python3 -c 'import json,sys; d=json.load(sys.stdin); print([t["id"] for s in d["spaces"] for t in s["tabs"] if any(x["terminal"]==sys.argv[1] for x in t["terminals"])][0])' "$TIP")
  PIPID=$(term_field "$TIP" 't["foreground"]["pid"]')
  BEFORE=$(chat_dumps)
  step "Continue as chat (new-chat.continue:$TIP)"
  do_ "new-chat.continue:$TIP"
  expect '[ -n "$(new_chat_since "$BEFORE")" ]' "a chat opened (its dump appeared)" 15
  J=$(new_chat_since "$BEFORE")
  expect '[ "$(chat_tab "$J")" = "$TIPTAB" ]' "in the TUI's tab" 10
  expect '! kill -0 '"$PIPID"' 2>/dev/null' "Pi (pid $PIPID) quit on SIGTERM" 10
  expect '[ "$(term_field "$TIP" "t[\"state\"]" 2>/dev/null)" != live ]' "the TUI's terminal (its shell) is gone: its pane closed" 10
  expect '[ "$(tab_panes "$TIPTAB" | wc -l | tr -d " ")" -ge 1 ] && ! tab_panes "$TIPTAB" | grep -q "$TIP"' "the tab holds the chat, not the TUI" 5
  expect '[ "$(dbg "$J" "d[\"connection\"][\"status\"]")" = connected ]' "the chat connected" 25
  expect 'inspect_chat "$J" | grep -q "Answered in the TUI."' "the chat has the TUI session's history" 15
  inspect_chat "$J" | python3 -c 'import json,sys; s=json.load(sys.stdin)["state"]; print("model", (s.get("model") or {}).get("id"), "thinking", s.get("thinking")); sys.exit(0 if s["phase"] != "conflict" and (s.get("model") or {}).get("id") == "gpt-5.6-luna" and s.get("thinking") == "high" else 1)' >>"$LOG" 2>&1 &&
    ok "no conflict; the session's model (gpt-5.6-luna) and thinking (high)" || fail "the host's state: $(inspect_chat "$J" | head -c 800)"
  grep -q "after-pid $PIPID\|waiting up to" "$STATE/logs/$J.log" && note "host log: $(grep 'waiting up to' "$STATE/logs/$J.log" | head -1)"
  FP=$("$APP" status | python3 -c 'import json,sys; s=json.load(sys.stdin); print(s["tab"], s["focused_pane"])')
  [ "$FP" = "$TIPTAB $(tab_panes "$TIPTAB" | awk '$2 == "mod:chat" {print $1}')" ] && ok "the chat is focused, in that tab" || fail "focus: $FP; the tab: $(tab_panes "$TIPTAB" | tr '\n' '|')"
  close_chat "$J"
fi

# --- flow `tui-under-command`: Continue as chat on a Pi its terminal's own command started -------------
# A session restorer or a space's start command opens a terminal as `fish -ic 'claude --resume …; exec fish -i'`:
# a shell without job control, so Herdr reports the shell as the foreground and the agent runs under it, in the
# shell's process group. The host finds it there (herdr-chat-host tui-session). The fake Pi sets
# process.title "pi", as real Pi does. new-chat's debug toast log is kept (artifact tuc-toasts.jsonl).
# 1. Two Pis under one command (`pi & pi`): refused, with the reason in a toast, and neither is signalled.
# 2. One Pi two levels down (zsh -c → sh -c → "My Tools/pi", a path with a space): the chat takes its place as
#    in tui-in-place, and the shell's `exec zsh -i` leaves the pane to close.
# 3. The command goes on after Pi quits (`…; sleep 5; exec zsh -i`): the pane stays while `sleep` runs (a toast
#    says so), and the shell's prompt is still there after it.
# 4. The shell after `exec zsh -i` starts a helper of its own (its rc runs `sleep 600 &`, a job in a group of its
#    own, as a prompt's daemon): the shell is idle at its prompt, so the pane closes.
if want tui-under-command; then
  step "tui-under-command: Pi TUIs started by their terminal's own command (zsh -c '…; exec zsh -i')"
  "$NODE" "$REPO/install/layout.ts" install "$HERDR_APP_HOME" --app "$APP" >>"$LOG" 2>&1 || fail "install/layout.ts install"
  # The app keeps no list of its toasts: with debug/enabled (lib.sh), new-chat appends each of its own to
  # debug/new-chat-toasts.jsonl ({title, body, level}, one JSON line).
  TOASTS="$STATE/debug/new-chat-toasts.jsonl"; : >"$TOASTS"
  toasts_since() { tail -n +"$(($1 + 1))" "$TOASTS"; }
  toast_mark() { wc -l <"$TOASTS" | tr -d ' '; }
  # The layout's new-chat block takes commands once the app has reloaded it.
  M=$(toast_mark)
  until_ '"$APP" do new-chat.continue:t999' 10 || fail "the layout's new-chat block takes no commands"
  expect 'toasts_since "$M" | grep -q "not live"' "the toast log records Continue as chat's errors (probe: no terminal t999)" 8
  TS="$BASE/tuc-session.jsonl"
  python3 - "$TS" "$PROJ" <<'PY2'
import json, sys
path, cwd = sys.argv[1:]
ts = "2026-11-05T12:00:00.000Z"
u = {"role": "user", "content": [{"type": "text", "text": "asked in the restored TUI"}], "timestamp": 1}
a = {"role": "assistant", "content": [{"type": "text", "text": "Answered in the restored TUI."}], "api": "fake", "provider": "fake", "model": "fake",
     "usage": {"input": 1, "output": 1, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 2, "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}}, "stopReason": "stop", "timestamp": 2}
with open(path, "w") as f:
    f.write(json.dumps({"type": "session", "version": 3, "id": "tuc-1", "timestamp": ts, "cwd": cwd}) + "\n")
    f.write(json.dumps({"type": "message", "id": "m0", "parentId": None, "timestamp": ts, "message": u}) + "\n")
    f.write(json.dumps({"type": "message", "id": "m1", "parentId": "m0", "timestamp": ts, "message": a}) + "\n")
PY2
  # "…/My Tools/pi", a link to node: a Pi run by a path with a space. It writes its pid to $PIDS (the test's own
  # record of which processes are Pi, not a rule like the host's).
  mkdir -p "$BASE/My Tools"
  ln -sf "$NODE" "$BASE/My Tools/pi"
  PIBIN="$BASE/My Tools/pi"
  PIDS="$BASE/tuc-pids"
  cat >"$BASE/fake-pi-under-cmd.mjs" <<'JS'
import { appendFileSync } from "node:fs";
process.title = "pi";
appendFileSync(process.env.TUC_PIDS, `${process.env.TUC_TAG} ${process.pid}\n`);
const report = () => process.stdout.write("\x1b]7501;state=idle:app=pi\x1b\\");
report(); const every = setInterval(report, 500);
console.log("fake Pi TUI (started by its terminal's command)");
process.on("SIGTERM", () => { clearInterval(every); console.log("SIGTERM: quitting"); setTimeout(() => process.exit(0), 300); });
JS
  : >"$PIDS"
  pis_of() { awk -v t="$1" '$1 == t {print $2}' "$PIDS"; }
  SP=$(app_ls | python3 -c 'import json,sys; print([s["id"] for s in json.load(sys.stdin)["spaces"] if s["active"]][0])')
  tab_of() { app_ls | python3 -c 'import json,sys; d=json.load(sys.stdin); print(next((t["id"] for s in d["spaces"] for t in s["tabs"] if any(x["terminal"]==sys.argv[1] for x in t["terminals"])), ""))' "$1"; }
  idle_pi() { [ "$(term_field "$1" "(t.get(\"status\") or {}).get(\"state\")")" = idle ] && [ "$(term_field "$1" "t.get(\"agent\") or (t.get(\"status\") or {}).get(\"app\")")" = pi ]; }
  # A terminal (new tab tbtuc000$2) running zsh -c "$3", its Pis tagged $1 in $PIDS, labeled with the session.
  start_tuc() {
    local out
    out=$(hc run --bg --json --keep --no-parent --cwd "$PROJ" --label "herdr.space=$SP" --label "herdr.tab=tbtuc000$2" \
      -- /bin/zsh -c "export TUC_PIDS='$PIDS' TUC_TAG=$1; $3" 2>>"$LOG") || fail "hc run ($1)"
    note "hc run ($1): $out"
    TERMADDR=$(echo "$out" | python3 -c 'import json,sys; print(json.load(sys.stdin)["address"])')
    hc label "$TERMADDR" "herdr-chat.session=$TS" >>"$LOG" 2>&1 || fail "hc label"
  }

  step "two Pis under one terminal's command: Continue as chat refuses, says why, and signals neither"
  start_tuc two 1 "'$PIBIN' $BASE/fake-pi-under-cmd.mjs & '$PIBIN' $BASE/fake-pi-under-cmd.mjs; exec /bin/zsh -i"
  AMBIG=$TERMADDR
  expect 'idle_pi "$AMBIG" && [ "$(pis_of two | wc -l | tr -d " ")" = 2 ]' "Herdr reports an idle Pi; two Pis run under the terminal's shell" 10
  AMBIGPIS=$(pis_of two | tr '\n' ' ')
  expect '[ -n "$(tab_of "$AMBIG")" ]' "the app shows the terminal in a tab" 10
  expect '[ "$(basename "$(term_field "$AMBIG" "(t.get(\"foreground\") or {}).get(\"argv\",[\"\"])[0]")")" = zsh ]' "its foreground is the shell" 5
  BEFORE=$(chat_dumps); M=$(toast_mark)
  do_ "new-chat.continue:$AMBIG"
  until_ '[ -n "$(toasts_since "$M")" ]' 10 || true
  toasts_since "$M" >"$ART/tuc-refusal-toast.jsonl"
  note "toast: $(tr '\n' ' ' <"$ART/tuc-refusal-toast.jsonl")"
  grep -q "2 Pi processes under the terminal's command (pids [0-9]*, [0-9]*): not sure which is the TUI, so none is stopped" "$ART/tuc-refusal-toast.jsonl" &&
    ok "the toast says two Pis run under its command, so none is stopped" || fail "the refusal's toast: $(cat "$ART/tuc-refusal-toast.jsonl")"
  [ -z "$(new_chat_since "$BEFORE")" ] && ok "no chat opened" || fail "a chat opened for an ambiguous terminal"
  for p in $AMBIGPIS; do kill -0 "$p" 2>/dev/null && ok "Pi $p still runs (no SIGTERM)" || fail "Pi $p was signalled"; done
  hc kill "$AMBIG" >>"$LOG" 2>&1 || true
  for p in $AMBIGPIS; do kill "$p" 2>/dev/null || true; done

  step "one Pi two levels under the terminal's command (zsh -c → sh -c → \"My Tools/pi\")"
  # `; true` keeps sh from exec'ing pi, so pi is the shell's grandchild.
  start_tuc one 2 "/bin/sh -c \"'$PIBIN' $BASE/fake-pi-under-cmd.mjs; true\"; exec /bin/zsh -i"
  TUC=$TERMADDR
  expect 'idle_pi "$TUC" && [ -n "$(pis_of one)" ] && [ -n "$(term_field "$TUC" "(t.get(\"foreground\") or {}).get(\"pid\")")" ]' "Herdr reports an idle Pi and the terminal's foreground; a Pi runs under the terminal's shell" 10
  hc get "$TUC" --json >"$ART/tuc-term-before.json"
  SHPID=$(term_field "$TUC" '(t.get("foreground") or {}).get("pid")')
  PIPID=$(pis_of one)
  [ "$(basename "$(term_field "$TUC" '(t.get("foreground") or {}).get("argv",[None])[0]')")" = zsh ] && [ "$SHPID" = "$(term_field "$TUC" 't["pid"]')" ] &&
    ok "its foreground is the terminal's own shell (pid $SHPID)" || fail "foreground: $(term_field "$TUC" 't.get("foreground")')"
  [ "$(ps -o ppid= -p "$(ps -o ppid= -p "$PIPID" | tr -d ' ')" | tr -d ' ')" = "$SHPID" ] && ok "Pi ($PIPID, $(ps -o args= -p "$PIPID")) is the shell's grandchild" || fail "Pi $PIPID isn't the shell's grandchild"
  expect '[ -n "$(tab_of "$TUC")" ]' "the app shows the terminal in a tab" 10
  TUCTAB=$(tab_of "$TUC")
  do_ pane.focus --terminal "$TUC"
  shot tuc-1-tui-under-command 1
  BEFORE=$(chat_dumps)
  step "Continue as chat (new-chat.continue:$TUC)"
  do_ "new-chat.continue:$TUC"
  expect '[ -n "$(new_chat_since "$BEFORE")" ]' "a chat opened (its dump appeared)" 15
  J=$(new_chat_since "$BEFORE")
  expect '[ "$(chat_tab "$J")" = "$TUCTAB" ]' "in the TUI's tab" 10
  expect '! kill -0 '"$PIPID"' 2>/dev/null' "Pi (pid $PIPID) quit on SIGTERM" 10
  expect '[ "$(term_field "$TUC" "t[\"state\"]" 2>/dev/null)" != live ] || [ "$(term_field "$TUC" "t[\"foreground\"][\"pid\"]")" = "$(term_field "$TUC" "t[\"pid\"]")" ]' "the TUI's shell is at its prompt (exec zsh -i) or gone" 10
  expect '! tab_panes "$TUCTAB" | grep -q "$TUC"' "the TUI's pane closed: the tab holds the chat" 10
  expect '[ "$(dbg "$J" "d[\"connection\"][\"status\"]")" = connected ]' "the chat connected" 25
  expect 'inspect_chat "$J" | grep -q "Answered in the restored TUI."' "the chat has the TUI session's history" 15
  shot tuc-2-chat-in-place 0.6
  close_chat "$J"
  [ "$(term_field "$TUC" 't["state"]' 2>/dev/null)" != live ] || hc kill "$TUC" >>"$LOG" 2>&1 || true

  step "the command goes on after Pi quits (…; sleep 5; exec zsh -i): the pane stays while it runs, and says so"
  start_tuc slow 3 "'$PIBIN' $BASE/fake-pi-under-cmd.mjs; /bin/sleep 5; exec /bin/zsh -i"
  SLOW=$TERMADDR
  expect 'idle_pi "$SLOW" && [ -n "$(pis_of slow)" ]' "Herdr reports an idle Pi under the terminal's shell" 10
  PIPID=$(pis_of slow)
  expect '[ -n "$(tab_of "$SLOW")" ]' "the app shows the terminal in a tab" 10
  SLOWTAB=$(tab_of "$SLOW")
  BEFORE=$(chat_dumps); M=$(toast_mark)
  do_ "new-chat.continue:$SLOW"
  expect '[ -n "$(new_chat_since "$BEFORE")" ]' "a chat opened" 15
  J=$(new_chat_since "$BEFORE")
  expect '! kill -0 '"$PIPID"' 2>/dev/null' "Pi (pid $PIPID) quit on SIGTERM" 10
  until_ '[ -n "$(toasts_since "$M")" ]' 8 || true
  toasts_since "$M" >"$ART/tuc-slow-toast.jsonl"
  note "toast: $(tr '\n' ' ' <"$ART/tuc-slow-toast.jsonl")"
  grep -q "now runs [^:]*sleep: its pane stays" "$ART/tuc-slow-toast.jsonl" && ok "a toast says the terminal now runs sleep, so its pane stays" || fail "the toast: $(cat "$ART/tuc-slow-toast.jsonl")"
  pgrep -f "^/bin/sleep 5$" >/dev/null && ok "sleep still runs" || note "sleep already ended"
  tab_panes "$SLOWTAB" | grep -q "$SLOW" && ok "the TUI's pane stays beside the chat (sleep wasn't cut short)" || fail "the TUI's pane closed while its command ran: $(tab_panes "$SLOWTAB" | tr '\n' '|')"
  shot tuc-3-pane-stays 0.6
  expect '[ "$(term_field "$SLOW" "t[\"foreground\"][\"pid\"]")" = "$(term_field "$SLOW" "t[\"pid\"]")" ] && ! pgrep -g "$(ps -o pgid= -p "$(term_field "$SLOW" "t[\"pid\"]")" | tr -d " ")" -f "^/bin/sleep" >/dev/null' "then sleep ends and the shell is at its prompt (exec zsh -i)" 10
  close_chat "$J"
  hc kill "$SLOW" >>"$LOG" 2>&1 || true

  step "the interactive shell after Pi starts a helper (its rc: sleep 600 &): the shell is idle, so the pane closes"
  ZD="$BASE/tuc-zdotdir"; mkdir -p "$ZD"
  printf '/bin/sleep 600 &\n' >"$ZD/.zshrc"
  start_tuc helper 4 "'$PIBIN' $BASE/fake-pi-under-cmd.mjs; ZDOTDIR='$ZD' exec /bin/zsh -i"
  HELP=$TERMADDR
  expect 'idle_pi "$HELP" && [ -n "$(pis_of helper)" ]' "Herdr reports an idle Pi under the terminal's shell" 10
  PIPID=$(pis_of helper)
  expect '[ -n "$(tab_of "$HELP")" ]' "the app shows the terminal in a tab" 10
  HELPTAB=$(tab_of "$HELP")
  HSH=$(term_field "$HELP" 't["pid"]')
  BEFORE=$(chat_dumps); M=$(toast_mark)
  do_ "new-chat.continue:$HELP"
  until_ '[ -n "$(new_chat_since "$BEFORE")" ] || [ -n "$(toasts_since "$M")" ]' 15 || true
  [ -z "$(toasts_since "$M")" ] || note "toast: $(toasts_since "$M" | tr '\n' ' ')"
  expect '[ -n "$(new_chat_since "$BEFORE")" ]' "a chat opened" 5
  J=$(new_chat_since "$BEFORE")
  expect '! kill -0 '"$PIPID"' 2>/dev/null' "Pi (pid $PIPID) quit on SIGTERM" 10
  expect 'pgrep -P "$HSH" -f "^/bin/sleep 600$" >/dev/null' "the shell's rc started its helper (sleep 600, the shell's child)" 10
  HPID=$(pgrep -P "$HSH" -f "^/bin/sleep 600$" | head -1)
  note "helper $HPID: pgid $(ps -o pgid= -p "$HPID" | tr -d ' '); the shell $HSH: pgid $(ps -o pgid= -p "$HSH" | tr -d ' ')"
  expect '! tab_panes "$HELPTAB" | grep -q "$HELP"' "the TUI's pane closed: the helper doesn't keep it" 10
  [ -z "$(toasts_since "$M")" ] && ok "no toast" || fail "a toast: $(toasts_since "$M")"
  close_chat "$J"
  hc kill "$HELP" >>"$LOG" 2>&1 || true
  [ -n "$HPID" ] && kill "$HPID" 2>/dev/null || true
  cp "$TOASTS" "$ART/tuc-toasts.jsonl"
fi
