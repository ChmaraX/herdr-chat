# Feedback round 1 (docs/dev/feedback-1.md), sourced by run.sh: flows
# `overlays` (pickers and menus over the composer: wheel, Esc, a press
# outside, the layout unmoved), `keys` (chat-scoped shortcuts, the person's
# overrides), `reports` (hc send reports as cards, the queue chip), `handoff2`
# (Return to chat, a reload during the hand-off, the host resuming by itself),
# `conflict` (two chats on one session: Go to that chat, Take over), `tabs`
# (row 12: Pi, Claude, Pi opened quickly with focus moving, each host in its
# own chat's tab), `split` (row 11: the host's pane hidden in the chat's tab
# through right, down and root splits, a restart, Herdr's own focus routes and
# toasts; closing the chat's pane ends the host), `migrate` (an older mod's
# zoomed and parked hosts, once this mod is installed), `fallback` (a client
# that keeps dropping the flag: a 0 px pane), `race` (a tab opened right
# after a chat writes its host's hidden pane: the app keeps it), `narrow` (the composer footer at
# 240–600 px).
#
# Synthetic mouse events posted to the private app aren't taken (spike), so
# the wheel and a press outside run their handlers' code by command
# (chat.wheel:<dy>, chat.outside), as clicks do (chat.click:<control>).

host_of() { dbg "$1" 'd["host"]["address"]' || true; }
# The mod as of an older checkout ($1: a mod/chat folder) into the private home (a hot reload).
put_mod() { (cd "$1" && find . -type f ! -name '*.d.ts' ! -name 'jsconfig.json' ! -name 'config.json' | while read -r f; do
  mkdir -p "$HERDR_APP_HOME/mods/chat/$(dirname "$f")"; cp "$f" "$HERDR_APP_HOME/mods/chat/$f"; done); }
# The last mod that zoomed the chat over its host and parked it (migrate).
OLD_MOD_REV=c6852bf
# Set terminal $1's pane `hidden` ($2: true|false) in the layout document, as another client could.
set_hidden() {
  local r v
  r=$(printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"hello","params":{"generation":1}}' \
    '{"jsonrpc":"2.0","id":2,"method":"doc.get","params":{"name":"herdr-app"}}' | hc connect | tail -1)
  printf '%s' "$r" | python3 -c '
import json, sys
res = json.load(sys.stdin)["result"]; doc = res["value"]; term, hidden = sys.argv[1], sys.argv[2] == "true"
def walk(n):
    if (n.get("content") or {}).get("terminal") == term:
        if hidden: n["hidden"] = True
        else: n.pop("hidden", None)
    for c in n.get("children", []): walk(c)
for s in doc["spaces"]:
    for t in s["tabs"]: walk(t["root"])
print(json.dumps({"jsonrpc": "2.0", "id": 2, "method": "doc.set", "params": {"name": "herdr-app", "version": res["version"], "value": doc}}))' "$1" "$2" >"$BASE/doc-set.json"
  { echo '{"jsonrpc":"2.0","id":1,"method":"hello","params":{"generation":1}}'; cat "$BASE/doc-set.json"; } | hc connect | tail -1
}
# Cancel the dialogs scenario's three questions from the chat, until the agent is idle.
cancel_dialogs() {
  for _ in 1 2 3 4 5; do [ "$(d 'd["dialog"]')" = null ] && [ "$(phase)" = idle ] && break; [ "$(d 'd["dialog"]')" = null ] || cmd click:dialog:cancel; sleep 0.8; done
  expect '[ "$(d "d[\"dialog\"]")" = null ] && [ "$(phase)" = idle ]' "answered from the chat" 15
}
# The probe layout: the private home's main layout with its pane header replaced by
# tests/e2e/probe (one copy per drawn pane, each counting its renders in <home>/probe/).
use_probe_layout() {
  mkdir -p "$HERDR_APP_HOME/mods/header-probe" "$HERDR_APP_HOME/probe"
  cp "$E2E/probe/main.js" "$E2E/probe/mod.json" "$HERDR_APP_HOME/mods/header-probe/"
  python3 - "$HERDR_APP_HOME/layouts/main.json" "$HERDR_APP_HOME/layouts/probe.json" <<'PY' || fail "no pane header in the main layout"
import json, sys
d = json.load(open(sys.argv[1])); n = 0
def walk(x):
    global n
    c = x.get("content") or {}
    if c.get("tab") and (c.get("pane") or {}).get("header"):
        c["pane"]["header"]["content"] = {"mod": "header-probe"}; n += 1
    for ch in x.get("children", []): walk(ch)
walk(d)
json.dump(d, open(sys.argv[2], "w"), indent=1)
sys.exit(0 if n else 1)
PY
  sleep 1.5
  do_ layout.switch --name probe
  expect '"$APP" status | grep -q "\"layout\": *\"probe\""' "the probe layout shows (a header probe per drawn pane)" 10
}
# How often pane $1's header rendered (0: never drawn).
header_renders() { python3 -c 'import json,sys
try: print(json.load(open(sys.argv[1])).get("renders", 0))
except Exception: print(0)' "$HERDR_APP_HOME/probe/header-$1.json"; }
label_of() { hc get "$1" --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["labels"].get(sys.argv[1], ""))' "$2"; }
# Reload the chat mod (a save of main.js: every chat's view starts again, hosts run on).
reload_mod() { touch "$HERDR_APP_HOME/mods/chat/main.js"; sleep 2.5; }
# A shortcut's key ($1, keys.py spec) for action $2, until $3 holds; a dropped key is pressed
# again (primed), then run as the mod's shortcut command (the same code the binding runs,
# but not the binding: the next check is a SKIP, by_command).
press_sc() {
  keys "$1"
  until_ "$3" 3 && return 0
  note "$1 ($2) didn't land: again, primed"; cmd focus; sleep 0.3; keys 56:shift "$1"
  until_ "$3" 3 && return 0
  by_command "$1 dropped twice: chat.shortcut:$2"; cmd "shortcut:$2"
  until_ "$3" 3 || true
}

if want overlays; then
  step "pickers and menus are overlays above the composer: the layout doesn't move"
  CHAT=$(open_chat overlays)
  ready
  H0=$(d 'd["bottomH"]')
  keys_or "text:/" '[ "$(d "d[\"menu\"][\"kind\"]")" = slash ] && [ "$(d "d[\"menu\"][\"count\"]")" -gt 8 ]' "clear;type:/" "/ opens the menu (more commands than its 8 rows)"
  sleep 0.4
  if needs_frames "the open menu leaves the composer's block as tall as before (an overlay)"; then
    [ "$(d 'd["bottomH"]')" = "$H0" ] && ok "the composer block is $H0 px with the menu open, as without it" || fail "bottomH $H0 → $(d 'd["bottomH"]')"
  fi
  shot fix1-1-slash-overlay 0.3
  step "the mouse wheel scrolls the menu; the keys bring the selection back"
  cmd wheel:-84
  expect '[ "$(d "d[\"menu\"][\"top\"]")" = 3 ] && [ "$(d "d[\"menu\"][\"sel\"]")" = 0 ]' "3 rows down (84 px), the selection stays" 5
  [ "$(d 'd["sticky"]')" = true ] && [ "$(d 'd["top"]')" = 0 ] && ok "the timeline under it didn't scroll" || fail "timeline moved: top $(d 'd["top"]')"
  shot fix1-2-slash-wheeled 0.3
  cmd wheel:999
  expect '[ "$(d "d[\"menu\"][\"top\"]")" = 0 ]' "wheel up: back to the first row" 5
  for _ in 1 2 3 4 5 6 7 8 9; do keys down; sleep 0.05; done
  until_ '[ "$(d "d[\"menu\"][\"sel\"]")" = 9 ]' 3 || { by_command "↓ didn't land"; for _ in $(seq "$(d 'd["menu"]["sel"]')" 8); do cmd key:down; done; }
  expect '[ "$(d "d[\"menu\"][\"sel\"]")" = 9 ] && [ "$(d "d[\"menu\"][\"top\"]")" = 2 ]' "↓ ×9: the window follows the selection (rows 2–9)" 5
  cmd outside
  expect '[ "$(d "d[\"menu\"]")" = null ] && [ "$(d "d[\"composer\"][\"text\"]")" = / ] && [ "$(d "d[\"closedBy\"]")" = outside ]' "a press outside closes the menu; the text stays" 5
  cmd clear
  step "the model picker: Esc closes it, a press outside too"
  cmd click:chip:model
  expect '[ "$(d "d[\"picker\"][\"kind\"]")" = model ]' "the model chip opens the picker" 8
  if needs_frames "the open picker leaves the composer's block as tall as before"; then
    [ "$(d 'd["bottomH"]')" = "$H0" ] && ok "the layout didn't move ($H0 px)" || fail "bottomH $H0 → $(d 'd["bottomH"]')"
  fi
  shot fix1-3-model-picker 0.4
  cmd focus; sleep 0.3
  press esc '[ "$(d "d[\"picker\"]")" = null ]'
  expect '[ "$(d "d[\"picker\"]")" = null ]' "Esc closes the model picker (row 3)" 5
  cmd click:chip:thinking
  expect '[ "$(d "d[\"picker\"][\"kind\"]")" = thinking ]' "the thinking picker" 5
  # A press outside that lands on the picker's own chip: the close and the click arrive together (well within 350 ms).
  cmd outside; cmd click:chip:thinking
  sleep 1 # (both handled)
  expect '[ "$(d "d[\"picker\"]")" = null ] && [ "$(d "d[\"closedBy\"]")" = outside ]' "a press outside closes it; landing on its chip doesn't reopen it (a toggle)" 5
  cmd click:chip:thinking
  expect '[ "$(d "d[\"picker\"][\"kind\"]")" = thinking ]' "a later click on the chip opens it again" 5
  cmd outside
fi

if want keys; then
  step "chat-scoped shortcuts: defaults (keys.default.json)"
  CHAT=$(open_chat keys abort) # (a tool that runs until stopped: ⌃C has time, even by command)
  ready
  expect '[ "$(d "d[\"shortcuts\"][\"model\"]")" = "[\"cmd-shift-m\"]" ]' "the defaults are loaded (model ⇧⌘M)" 5
  [ "$(d 'd["keyErrors"]')" = "[]" ] && ok "no key errors" || fail "key errors $(d 'd["keyErrors"]')"
  press_sc 46:cmd,shift model '[ "$(d "d[\"picker\"][\"kind\"]")" = model ]'
  expect '[ "$(d "d[\"picker\"][\"kind\"]")" = model ] && [ "$(d "d[\"picker\"][\"hint\"]")" = "⇧⌘M" ]' "⇧⌘M opens the model picker (its title shows the key)" 5
  shot fix1-4-model-shortcut 0.3
  press_sc 46:cmd,shift model '[ "$(d "d[\"picker\"]")" = null ]'
  expect '[ "$(d "d[\"picker\"]")" = null ]' "⇧⌘M again closes it" 5
  press_sc 17:cmd,shift effort '[ "$(d "d[\"picker\"][\"kind\"]")" = thinking ]'
  expect '[ "$(d "d[\"picker\"][\"kind\"]")" = thinking ]' "⇧⌘T opens the thinking (effort) picker" 5
  keys esc; until_ '[ "$(d "d[\"picker\"]")" = null ]' 3 || cmd key:escape # (setup)
  press_sc 0:cmd,shift mode '[ "$(d "d[\"flash\"] is not None")" = true ]'
  expect '[ "$(d "d[\"flash\"]")" = "Pi has no permission modes" ]' "⇧⌘A: Pi has no permission modes, said in the hint line" 5
  send_text "sleep a while"
  expect '[ "$(phase)" = working ]' "Pi works" 8
  press_sc 8:ctrl stop '[ "$(phase)" = idle ]'
  expect '[ "$(phase)" = idle ] && [ "$(d "d[\"lastShortcut\"][\"action\"]")" = stop ]' "⌃C stops it" 10
  cmd click:chip:model; sleep 0.5
  press_sc 37:cmd focusComposer '[ "$(d "d[\"picker\"]")" = null ]'
  expect '[ "$(d "d[\"picker\"]")" = null ] && [ "$(d "d[\"lastShortcut\"][\"action\"]")" = focusComposer ]' "⌘L: back in the composer" 5
  TABS0=$(app_ls | python3 -c 'import json,sys; print(sum(len(s["tabs"]) for s in json.load(sys.stdin)["spaces"]))')
  press_sc 45:cmd,shift newChat '[ "$(d "d[\"lastNewChat\"] is not None")" = true ]'
  NEW=$(d 'd["lastNewChat"]')
  expect '[ -n "$NEW" ] && [ -f "$STATE/debug/$NEW.json" ]' "⇧⌘N opens a new chat ($NEW) in a new tab" 10
  expect '[ "$(dbg "$NEW" "d[\"cwd\"]")" = "$PROJ" ] && [ "$(dbg "$NEW" "d[\"provider\"]")" = pi ]' "same folder, same agent" 15
  step "the person's keys.json overrides a default and unbinds one (null)"
  echo '{"model": "cmd-shift-y", "stop": null}' >"$STATE/keys.json"
  reload_mod
  expect '[ "$(d "d[\"shortcuts\"][\"model\"]")" = "[\"cmd-shift-y\"]" ] && [ "$(d "d[\"shortcuts\"][\"stop\"]")" = "[]" ]' "the reloaded chat reads data/pi-chat/keys.json" 15
  do_ tab.select --id "$(d 'd["place"]["tab"]')"; sleep 0.5; cmd focus; sleep 0.3
  press_sc 16:cmd,shift model '[ "$(d "d[\"picker\"][\"kind\"]")" = model ]'
  expect '[ "$(d "d[\"picker\"][\"kind\"]")" = model ] && [ "$(d "d[\"picker\"][\"hint\"]")" = "⇧⌘Y" ]' "⇧⌘Y now opens the model picker" 5
  keys esc; until_ '[ "$(d "d[\"picker\"]")" = null ]' 3 || cmd key:escape # (setup)
  rm -f "$STATE/keys.json"
  step "Claude Code: Shift+Tab cycles the permission mode"
  CHAT=$(open_chat_p claude-keys claude e2e)
  ready
  M0=$(d 'd["permissionMode"]')
  press_sc tab:shift cycleMode '[ "$(d "d[\"permissionMode\"]")" != "$M0" ]'
  M1=$(d 'd["permissionMode"]')
  expect '[ "$M1" != "$M0" ] && [ "$(d "d[\"lastShortcut\"][\"action\"]")" = cycleMode ]' "⇧⇥: $M0 → $M1" 8
  shot fix1-5-shift-tab-mode 0.3
  keys "text:/"
  # A negative check: it means something only while keys land (here: "/" did).
  if until_ '[ "$(d "d[\"menu\"][\"kind\"]")" = slash ]' 5; then
    keys tab:shift; sleep 0.6
    [ "$(d 'd["permissionMode"]')" = "$M1" ] && ok "⇧⇥ doesn't change the mode while a menu is open" || fail "mode changed under the menu"
  else
    BYCMD=$((BYCMD + 1)); skip "⇧⇥ doesn't change the mode while a menu is open (by command: the key didn't land)"
  fi
  cmd clear
fi

if want reports; then
  step "hc send reports: the queue chip says Report from, then a report card"
  CHAT=$(open_chat reports "$E2E/fix1/slow-steer.json")
  ready
  HOST_T=$(d 'd["host"]["address"]')
  send_text "sleep first"
  expect '[ "$(phase)" = working ]' "Pi works (a 10 s tool)" 8
  hc send "$HOST_T" '<hc from="t9 tests">all green</hc>' >>"$LOG" 2>&1
  expect '[ "$(d "d[\"queueLabels\"]")" = "[\"Report from t9 tests\"]" ]' "the queued report's chip reads Report from t9 tests (not Steer)" 10
  shot fix1-8-queue-report 0.2
  expect '[ "$(phase)" = idle ] && [ "$(d "len(d[\"reports\"])")" = 1 ]' "delivered: a report card, not a user bubble" 20
  R=$(d 'd["reports"][0]')
  [ "$(d "[i['from'] for i in d['items'] if i['id']=='$R'][0]")" = "t9 tests" ] && ok "from t9 tests" || fail "from"
  step "a long report folds to its first lines; Show all opens it"
  hc send "$HOST_T" "<hc from=\"t7 review\">$(printf 'Review done.\n\n%.0s- point\n' $(seq 1 16))</hc>" >>"$LOG" 2>&1
  expect '[ "$(d "len(d[\"reports\"])")" = 2 ]' "a second report card (from t7 review)" 15
  R=$(d 'd["reports"][1]')
  expect '[ "$(phase)" = idle ]' "answered" 20
  shot fix1-6-report-card 0.4
  cmd "toggle:report:$R"
  expect '[ "$(d "\"report:$R\" in d[\"expanded\"]")" = true ]' "Show all opens the long report" 5
  shot fix1-7-report-open 0.4
fi

if want handoff2; then
  step "the hand-off banner: Return to chat (closes the TUI after a confirm)"
  CHAT=$(open_chat handoff2)
  ready
  send_text "hello"
  expect '[ "$(phase)" = idle ] && [ "$(count_kind assistant)" -ge 1 ]' "a first answer" 15
  send_text "/tui"
  expect '[ "$(phase)" = handoff ]' "phase handoff" 10
  handoff_tui
  expect '[ "$(d "d[\"hostHandoff\"][\"terminal\"]")" = "$TUI" ]' "the host knows the TUI's terminal (handoff_started $TUI)" 10
  grep -q "^env PI_CHAT_HANDOFF=" <(hc get "$TUI" --json | python3 -c 'import json,sys; print(" ".join(json.load(sys.stdin)["argv"]))') \
    && ok "the tui override kept the env prefix (PI_CHAT_HANDOFF=…)" || fail "TUI argv: $(hc get "$TUI" --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["argv"])')"
  HT=$(host_of "$CHAT"); TAB=$(d 'd["place"]["tab"]')
  expect 'overlay_open layout && ! tab_panes "$TAB" | grep -q " $TUI$" && hidden_in "$TAB" "$HT"' "the TUI in a dialog (no pane in the tab), the host's pane still hidden" 10
  # The dialog's own way back is its bar (flows.sh handoff); here the banner's, once the dialog is closed.
  do_ overlay.close
  expect '! overlay_open layout' "the dialog closed: the TUI runs on, out of sight" 5
  cmd click:handoff:show
  expect 'overlay_open layout' "the banner's Show it opens the dialog again" 5
  do_ overlay.close
  cmd click:handoff:return
  expect '[ "$(d "d[\"confirmClose\"]")" = true ]' "Return to chat asks first (the TUI still runs)" 5
  shot fix1-9-return-confirm 0.4
  cmd click:handoff:close
  expect '! hc get "$TUI" --json 2>/dev/null | grep -q "\"state\": *\"live\""' "Close it ends the TUI" 10
  expect '[ "$(phase)" = idle ] && [ "$(d "d[\"hostHandoff\"]")" = null ]' "back in the chat, the agent resumed" 15
  expect '[ "$(d "d[\"zoomed\"]")" = false ] && [ "$(tab_panes "$TAB" | wc -l | tr -d " ")" = 2 ] && hidden_in "$TAB" "$HT"' "the chat alone again (no zoom), the host hidden" 10
  python3 - "$STATE/debug/$CHAT.json" <<'PY' && ok "a notify repeated by the resume shows once (the first)" || fail "repeated notify notices in the rows"
import json, sys
d = json.load(open(sys.argv[1]))
rows = {r["id"] for r in d["rows"]}
seen, dup = {}, 0
for i in d["items"]:
    if i["kind"] != "notice" or i.get("source") != "notify": continue
    k = (i["level"], i["text"])
    if k in seen: dup += 1; assert i["id"] not in rows, i
    else: seen[k] = i["id"]; assert i["id"] in rows or i["level"] == "info", i
sys.exit(0 if dup else 1)  # the resume did repeat one (else nothing was checked)
PY
  step "a reload during the hand-off: the host resumes by itself when the TUI quits"
  cmd focus; sleep 0.3
  send_text "/tui"
  expect '[ "$(phase)" = handoff ] && [ "$(d "(d[\"hostHandoff\"] or {}).get(\"terminal\") is not None")" = true ]' "handing off again" 10
  TUI=$(d 'd["hostHandoff"]["terminal"]')
  reload_mod
  expect '[ "$(d "d[\"connection\"][\"status\"]")" = connected ] && [ "$(d "d[\"handoff\"]")" = null ] && [ "$(phase)" = handoff ]' "the reloaded chat shows the hand-off from the host's state" 15
  shot fix1-10-handoff-banner 0.4
  overlay_open layout && ok "the dialog outlives the mod's reload" || fail "the dialog went with the reload"
  hc send "$TUI" q >>"$LOG" 2>&1 || hc send --force "$TUI" q >>"$LOG" 2>&1
  expect '[ "$(phase)" = idle ]' "the TUI quit: the host resumed on its own (the mod no longer watches)" 20
  expect '! overlay_open layout' "the dialog closed with its terminal" 5
  expect '[ "$(d "d[\"zoomed\"]")" = false ] && [ "$(tab_panes "$TAB" | wc -l | tr -d " ")" = 2 ] && hidden_in "$TAB" "$HT"' "the chat alone again, the host hidden" 10
fi

if want conflict; then
  step "two chats on one session: a conflict banner; Go to that chat; Take over"
  A=$(open_chat conflict-a)
  CHAT=$A; ready
  send_text "hello"
  expect '[ "$(phase)" = idle ] && [ "$(count_kind assistant)" -ge 1 ]' "chat A answered (its session has a file)" 15
  S=$(d 'd["sessionFile"]')
  B="c-$(openssl rand -hex 4)"
  do_ pane.focus --terminal "$SHELL_T"
  "$APP" do tab.new "{\"name\":\"conflict-b\",\"space\":\"$SPACE\",\"mod\":\"chat\",\"props\":{\"chat\":\"$B\",\"cwd\":\"$PROJ\",\"session\":\"$S\"}}" >>"$LOG" 2>&1
  CHAT=$B
  expect '[ "$(phase)" = conflict ] && [ "$(d "d[\"conflict\"][\"chat\"]")" = "$A" ]' "chat B on A's session: phase conflict, held by $A" 25
  shot fix1-11-conflict 0.4
  cmd click:conflict:go
  expect '[ "$(dbg "$A" "d[\"focusedPane\"]")" = "$(dbg "$A" "d[\"place\"][\"pane\"]")" ]' "Go to that chat focuses chat A's pane" 8
  do_ tab.select --id "$(d 'd["place"]["tab"]')"; sleep 0.8 # (a mod command goes to the shown chat)
  cmd click:conflict:take
  expect '[ "$(phase)" = idle ] && [ "$(d "d[\"sessionFile\"]")" = "$S" ]' "Take over: chat B runs the session" 25
  expect '[ "$(dbg "$A" "d[\"connection\"][\"status\"]")" = stopped ] && [ "$(dbg "$A" "d[\"byeAt\"]")" != null ]' "chat A was closed on purpose (bye shutdown), not restarted" 15
  CHAT=$A; do_ tab.select --id "$(d 'd["place"]["tab"]')"; shot fix1-12-taken-over 0.6
fi

if want tabs; then
  step "row 12: Pi, Claude, Pi opened quickly, focus moving: each host in its own chat's tab"
  do_ pane.focus --terminal "$SHELL_T"; keys 56:shift
  T1=$(active_tab)
  C1="c-$(openssl rand -hex 4)"; C2="c-$(openssl rand -hex 4)"; C3="c-$(openssl rand -hex 4)"
  "$APP" do tab.new "{\"name\":\"pi\",\"space\":\"$SPACE\",\"mod\":\"chat\",\"props\":{\"chat\":\"$C1\",\"provider\":\"pi\",\"cwd\":\"$PROJ\"}}" >>"$LOG"
  do_ tab.select --id "$T1"
  "$APP" do tab.new "{\"name\":\"claude\",\"space\":\"$SPACE\",\"mod\":\"chat\",\"props\":{\"chat\":\"$C2\",\"provider\":\"claude\",\"cwd\":\"$PROJ\",\"hostEnv\":{\"FAKE_CLAUDE_SCENARIO\":\"$E2E/claude/e2e.json\"}}}" >>"$LOG"
  sleep 0.2; do_ tab.select --id "$T1"; sleep 0.2
  "$APP" do tab.new "{\"name\":\"pi\",\"space\":\"$SPACE\",\"mod\":\"chat\",\"props\":{\"chat\":\"$C3\",\"provider\":\"pi\",\"cwd\":\"$PROJ\"}}" >>"$LOG"
  do_ tab.select --id "$T1"
  for c in $C1 $C2 $C3; do
    expect '[ "$(dbg "$c" "d[\"connection\"][\"status\"]")" = connected ] && [ "$(dbg "$c" "d[\"placeFrom\"]")" = doc ]' "$c: connected, its place from the layout document" 30
  done
  for c in $C1 $C2 $C3; do
    until_ '[ -n "$(dbg "$c" "d[\"host\"][\"address\"]")" ]' 10 || true # (a dump read mid-write fails: wait for a whole one)
    TAB=$(dbg "$c" 'd["place"]["tab"]' || true); H=$(host_of "$c" || true)
    expect '[ "$(label_of "$H" herdr.tab)" = "$TAB" ]' "$c ($(dbg "$c" 'd["provider"]')): its host $H is labeled for its own tab" 15
    expect '[ "$(tab_panes "$TAB" | grep -cv mod:)" = 1 ] && tab_panes "$TAB" | grep -q " $H$"' "$c's tab holds one terminal pane: its own host" 15
  done
  [ "$(printf '%s\n' "$(dbg "$C1" 'd["place"]["tab"]')" "$(dbg "$C2" 'd["place"]["tab"]')" "$(dbg "$C3" 'd["place"]["tab"]')" | sort -u | wc -l | tr -d ' ')" = 3 ] \
    && ok "three chats, three tabs" || fail "tabs not distinct"
  step "self-heal: a host labeled for another tab is restarted in its own, on the same session"
  CHAT=$C1
  WRONG=$(dbg "$C3" 'd["place"]["tab"]'); H=$(host_of "$C1"); S1=$(reg "$C1" sessionFile)
  hc label "$H" "herdr.tab=$WRONG" >>"$LOG" 2>&1
  expect '[ "$(dbg "$C1" "d[\"healed\"]")" -ge 1 ]' "chat $C1 notices its host in another tab" 15
  expect '[ "$(host_of "$C1")" != "$H" ] && [ "$(label_of "$(host_of "$C1")" herdr.tab)" = "$(dbg "$C1" "d[\"place\"][\"tab\"]")" ]' "a new host runs in $C1's own tab" 30
  [ "$(reg "$C1" sessionFile)" = "$S1" ] && ok "on the same session" || fail "session $(reg "$C1" sessionFile) != $S1"
fi

if want split; then
  step "row 11: the host's pane is hidden in the chat's tab: a split is one reflow, the chat stays an agent"
  use_probe_layout
  CHAT=$(open_chat split dialogs)
  ready
  TAB=$(d 'd["place"]["tab"]'); ME=$(d 'd["place"]["pane"]'); H=$(d 'd["host"]["address"]')
  expect 'hidden_in "$TAB" "$H"' "the host's pane is in the chat's tab, hidden (layout document: $(node_of "$H"))" 10
  HP=$(node_of "$H" | awk '{print $2}')
  [ "$(node_of "$H" | wc -l | tr -d ' ')" = 1 ] && ok "one pane for the host" || fail "host panes: $(node_of "$H")"
  expect '[ "$(d "d[\"zoomed\"]")" = false ] && [ "$(d "d[\"zoomedPane\"]")" = null ]' "nothing is zoomed (no \"Z\")" 5
  expect '[ "$(d "d[\"hostAgent\"]")" = "{\"pane\": \"$HP\", \"tab\": \"$TAB\", \"status\": \"idle\"}" ]' "Herdr lists the host as an agent, with its pane in the chat's tab ($(d 'd["hostAgent"]'))" 10
  [ "$(label_of "$H" herdr.tab)" = "$TAB" ] && [ "$(label_of "$H" herdr.space)" = "$SPACE" ] && ok "labeled for the chat's tab once hidden" || fail "labels $(label_of "$H" herdr.space) $(label_of "$H" herdr.tab)"
  FRAMES=; needs_frames "the chat's widths and the drawn panes (measured while drawing)" && FRAMES=1
  if [ -n "$FRAMES" ]; then
    W0=$(d 'd["width"]')
    expect '[ "$(header_renders "$ME")" -gt 0 ] && [ "$(header_renders "$HP")" = 0 ]' "the chat's pane header draws ($(header_renders "$ME") renders), the host's never did" 5
  fi
  for dir in right down; do
    step "a $dir split: one reflow, the host still hidden and listed"
    N0=$(d 'len(d["widths"])')
    R=$("$APP" do pane.split --direction $dir --pane "$ME") || fail "pane.split $dir"
    NEW=$(echo "$R" | python3 -c 'import json,sys; print(json.load(sys.stdin)["pane"])')
    expect 'tab_panes "$TAB" | grep -q "^$NEW " && hidden_in "$TAB" "$H"' "the new pane beside the chat, the host's still hidden ($(tab_panes "$TAB" | tr '\n' ' '))" 10
    sleep 1.5
    hidden_in "$TAB" "$H" && [ "$(d 'd["zoomed"]')" = false ] && ok "after the split settled: hidden, nothing zoomed" || fail "after the split: $(node_of "$H") zoomed $(d 'd["zoomed"]')"
    [ "$(d 'd["hostAgent"]["pane"]')" = "$HP" ] && ok "still in Herdr's agents list with its pane ($(d 'd["hostAgent"]'))" || fail "agents: $(d 'd["hostAgent"]')"
    if [ -n "$FRAMES" ]; then
      W=$(d 'd["width"]')
      if [ $dir = right ]; then
        [ "$(d "len(d['widths']) - $N0")" = 1 ] && [ "$(python3 -c "print(abs(2 * $W + 8 - $W0) <= 12)")" = True ] \
          && ok "one reflow: the chat went from $W0 to $W px, nothing between ($(d "d['widths'][$N0 - 1:]"))" || fail "widths since the split: $(d "d['widths'][$N0 - 1:]") (alone $W0)"
      else
        [ "$(d "len(d['widths']) - $N0")" = 0 ] && ok "a down split leaves the chat's width alone ($W px, no reflow across)" || fail "widths since the split: $(d "d['widths'][$N0 - 1:]")"
      fi
      [ "$(header_renders "$HP")" = 0 ] && [ "$(header_renders "$NEW")" -gt 0 ] && ok "the host's pane was never drawn (its header never rendered; the new pane's did)" || fail "the host's header rendered $(header_renders "$HP") times"
      shot "fix1-13-split-$dir" 0.4
    fi
    if [ $dir = right ]; then
      step "while split, the hidden host blocks: Herdr's own toast and dots"
      do_ pane.focus --terminal "$SHELL_T" # the person looks at another tab
      hc send "$H" "clean the build" >>"$LOG" 2>&1
      # (Any of its three: the first two time out in 10 s and 5 s, and hc send can take seconds to return.)
      expect '[ "$(d "d[\"dialog\"] is not None")" = true ]' "the agent blocks on a dialog (sent from outside)" 20
      expect '[ "$(d "d[\"hostAgent\"][\"status\"]")" = blocked ] && [ "$(d "d[\"tabStatus\"]")" = blocked ]' "Herdr's agents list and the chat's tab dot say blocked" 5
      expect 'overlay_open toast' "Herdr shows its own toast for it" 5
      shot fix1-14-hidden-toast 0.3
      do_ tab.select --id "$TAB"; sleep 0.8
      cancel_dialogs
      if [ "$(d 'd["windowActive"]')" = true ]; then
        expect '[ "$(d "d[\"hostAgent\"][\"status\"]")" = idle ] && [ "$(label_of "$H" herdr.seen)" != "" ]' "looked at, the host's turn is seen (herdr.seen=$(label_of "$H" herdr.seen)): idle, not done" 8
      else
        skip "done → idle while looking at the chat (the private window is never active)"
      fi
    fi
    N1=$(d 'len(d["widths"])')
    do_ pane.close --pane "$NEW"
    expect '! tab_panes "$TAB" | grep -q "^$NEW " && [ "$(tab_panes "$TAB" | wc -l | tr -d " ")" = 2 ] && hidden_in "$TAB" "$H"' "the split closed: the chat and the hidden host, as before" 10
    sleep 1
    if [ -n "$FRAMES" ]; then
      [ "$(d 'd["width"]')" = "$W0" ] && [ "$(d "len(d['widths']) - $N1")" -le 1 ] && ok "back to full width ($W0 px) in one step" || fail "widths since the close: $(d "d['widths'][$N1 - 1:]") (alone $W0)"
    fi
    [ "$(d 'd["zoomed"]')" = false ] && ok "not zoomed" || fail "zoomed after the close"
  done
  step "a split of the tab's root (herdr-nvim's cmd-e): the host stays hidden"
  ROOT=$(app_doc | python3 -c 'import json,sys; d=json.load(sys.stdin); print([t["root"]["id"] for s in d["spaces"] for t in s["tabs"] if t["id"]==sys.argv[1]][0])' "$TAB")
  R=$("$APP" do pane.split --direction right --pane "$ROOT") || fail "pane.split on the root"
  NEW=$(echo "$R" | python3 -c 'import json,sys; print(json.load(sys.stdin)["pane"])')
  expect 'tab_panes "$TAB" | grep -q "^$NEW " && hidden_in "$TAB" "$H"' "split off the root, the host's pane still hidden" 10
  sleep 1.2
  hidden_in "$TAB" "$H" && [ "$(d 'd["hostAgent"]["pane"]')" = "$HP" ] && ok "and still listed" || fail "root split: $(node_of "$H") $(d 'd["hostAgent"]')"
  [ -z "$FRAMES" ] || { [ "$(header_renders "$HP")" = 0 ] && ok "the host's pane wasn't drawn" || fail "the host's header rendered"; }
  do_ pane.close --pane "$NEW"
  expect '[ "$(tab_panes "$TAB" | wc -l | tr -d " ")" = 2 ] && hidden_in "$TAB" "$H"' "closed: the chat and the hidden host" 10

  step "Herdr's routes to the agent land on the hidden pane: the chat takes the focus back"
  R0=$(d 'd["redirects"]')
  do_ agent.focus --terminal "$H"
  expect '[ "$(d "d[\"focusedPane\"]")" = "$ME" ] && [ "$(d "d[\"redirects\"]")" -gt "$R0" ]' "agent.focus on the host: the chat has the focus again (it redirected)" 3
  note "redirects $(d 'd["redirects"]'), from render $(d 'd["redirectsFromRender"]')"
  R0=$(d 'd["redirects"]')
  do_ pane.focus --pane "$HP" # what an agents-list click runs
  expect '[ "$(d "d[\"focusedPane\"]")" = "$ME" ] && [ "$(d "d[\"redirects\"]")" -gt "$R0" ]' "an agents-list click (pane.focus on the host's pane): back on the chat" 3

  step "the app restarts: the host's pane is still hidden"
  restart_app
  expect '[ "$(d "d[\"connection\"][\"status\"]")" = connected ] && [ "$(d "d[\"hostHidden\"]")" = true ]' "the chat came back, its host hidden" 30
  hidden_in "$TAB" "$H" && [ "$(node_of "$H" | awk '{print $2}')" = "$HP" ] && ok "the same pane, still hidden ($(node_of "$H"))" || fail "after the restart: $(node_of "$H")"
  expect '[ "$(d "d[\"zoomed\"]")" = false ] && [ "$(d "d[\"hostAgent\"][\"pane\"]")" = "$HP" ]' "not zoomed, still listed" 10

  step "closing the chat's pane ends the host, and its tab closes at once (no black tab while the host exits)"
  T0=$(now_s)
  do_ pane.close --pane "$ME"
  until_ '! app_ls | grep -q "\"$TAB\""' 15 || fail "the tab never closed ($(tab_panes "$TAB" | tr '\n' ' '))"
  GONE=$(python3 -c "print(round($(now_s) - $T0, 2))")
  note "pane.close → tab gone: $GONE s"
  [ "$(python3 -c "print($GONE < 1.5)")" = True ] && ok "the tab closed $GONE s after the chat's pane (< 1.5 s)" || fail "the tab stayed $GONE s after the chat's pane closed (a black tab; want < 1.5 s)"
  expect '! hc ls --json | grep -q "\"address\": *\"$H\""' "the host ended with its chat's pane" 15
  [ "$(reg "$CHAT" pid)" = "" ] && ok "it shut down cleanly (its registry entry has no pid)" || fail "registry pid $(reg "$CHAT" pid) after the host ended"
  do_ layout.switch --name main
fi

if want migrate; then
  step "chats open when this mod is installed: an older mod's zoomed host and parked host become hidden panes"
  OLD="$BASE/old-mod"; mkdir -p "$OLD"
  git -C "$REPO" archive "$OLD_MOD_REV" mod/chat | tar -x -C "$OLD" || fail "git archive $OLD_MOD_REV"
  put_mod "$OLD/mod/chat"; sleep 2.5
  A=$(open_chat migrate-zoomed); CHAT=$A
  expect connected "an older mod's chat (zoom and park, $OLD_MOD_REV)" 25
  TA=$(d 'd["place"]["tab"]'); MA=$(d 'd["place"]["pane"]')
  expect 'HA=$(host_of "$A") && [ -n "$HA" ] && node_of "$HA" | grep -q "^$TA .* shown$" && [ "$(d "d[\"zoomedPane\"]")" = "$MA" ]' "its host's pane shows, the chat zoomed over it" 15
  HA=$(host_of "$A")
  B=$(open_chat migrate-parked); CHAT=$B
  expect connected "a second older chat" 25
  TB=$(d 'd["place"]["tab"]'); MB=$(d 'd["place"]["pane"]')
  expect 'HB=$(host_of "$B") && [ -n "$HB" ] && node_of "$HB" | grep -q "^$TB "' "its host adopted" 15
  HB=$(host_of "$B")
  do_ pane.split --direction right --pane "$MB"
  expect '[ -z "$(node_of "$HB")" ] && [ -z "$(label_of "$HB" herdr.tab)" ]' "split: the older mod parked its host (no pane, no tab label)" 15
  do_ tab.select --id "$TA"; sleep 0.8
  step "the new mod is installed (hot reload)"
  put_mod "$REPO/mod/chat"; sleep 2.5
  CHAT=$A
  expect 'hidden_in "$TA" "$HA"' "the zoomed chat's host: its pane is hidden ($(node_of "$HA"))" 15
  expect '[ "$(d "d[\"zoomed\"]")" = false ] && [ "$(d "d[\"hostAgent\"][\"pane\"]")" = "$(node_of "$HA" | awk "{print \$2}")" ]' "the zoom went, the host still listed with its pane" 10
  CHAT=$B
  expect 'hidden_in "$TB" "$HB"' "the parked host: a hidden pane in its chat's tab ($(node_of "$HB"))" 15
  expect '[ "$(label_of "$HB" herdr.tab)" = "$TB" ] && [ "$(d "d[\"hostAgent\"][\"pane\"]")" = "$(node_of "$HB" | awk "{print \$2}")" ]' "labeled for its tab, back in Herdr's agents list" 10
  [ "$(tab_panes "$TB" | wc -l | tr -d ' ')" = 3 ] && ok "the split stays: chat, shell and the hidden host ($(tab_panes "$TB" | tr '\n' ' '))" || fail "tab $TB: $(tab_panes "$TB" | tr '\n' ' ')"
  do_ tab.close --id "$TA"; do_ tab.close --id "$TB"
  expect '! hc ls --json | grep -qE "\"address\": *\"($HA|$HB)\""' "closing their tabs ends both hosts" 15
fi

if want fallback; then
  step "a client that keeps dropping the hidden flag: the mod falls back to a 0 px pane, never parks"
  CHAT=$(open_chat fallback)
  ready
  TAB=$(d 'd["place"]["tab"]'); H=$(d 'd["host"]["address"]')
  expect 'hidden_in "$TAB" "$H"' "hidden" 10
  set_hidden "$H" false >>"$LOG"
  expect 'hidden_in "$TAB" "$H"' "the flag dropped once: the mod writes it again" 10
  [ "$(d 'd["fallback"]')" = null ] && ok "no fallback for one drop" || fail "fallback $(d 'd["fallback"]')"
  ( while :; do set_hidden "$H" false >/dev/null 2>&1; sleep 0.3; done ) &
  DROPPER=$!; EXTRA_PIDS="$EXTRA_PIDS $DROPPER"
  expect '[ "$(d "d[\"fallback\"][\"terminal\"]")" = "$H" ]' "it doesn't stick: the mod falls back" 40
  kill "$DROPPER" 2>/dev/null
  note "fallback: $(d 'd["fallback"]')"
  expect '[ "$(app_doc | python3 -c "import json,sys
d=json.load(sys.stdin)
def walk(n):
    if (n.get(\"content\") or {}).get(\"terminal\") == sys.argv[1]: print((n.get(\"size\") or {}).get(\"px\") == 0)
    for c in n.get(\"children\", []): walk(c)
[walk(t[\"root\"]) for s in d[\"spaces\"] for t in s[\"tabs\"]]" "$H")" = True ]' "the host's pane is 0 px wide (layout.resize)" 10
  [ "$(label_of "$H" herdr.tab)" = "$TAB" ] && [ "$(d 'd["hostAgent"]["tab"]')" = "$TAB" ] && ok "still a pane of the chat's tab, still listed (not parked)" || fail "host $(node_of "$H") $(d 'd["hostAgent"]')"
  do_ tab.close --id "$TAB"
fi

if want race; then
  step "a tab opened right after a chat writes its host's hidden pane: the app keeps it"
  # The app reads the layout document once per loop (500 ms apart); a change it makes before it
  # has read another writer's version is lost (it takes that document). The chat times its write
  # to just before the app's read, and waits for the layout to be still. Each round: a new host
  # (Restart), and 0.15 s after the core has the chat's write, a tab with a mod pane (what loses).
  # (Measured: untimed, a tab 0.15 s after the write was lost in 4 rounds of 6, and 0.3 s after in 1 of 6;
  # timed, none of 16 at 0.15 s. Within the first ~0.1 s some still are: the app's own race, see the README.)
  CHAT=$(open_chat race)
  ready
  TAB=$(d 'd["place"]["tab"]')
  doc_version() { printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"hello","params":{"generation":1}}' \
    '{"jsonrpc":"2.0","id":2,"method":"doc.get","params":{"name":"herdr-app"}}' | hc connect | tail -1 | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["version"])'; }
  MADE_TABS= LOST=
  for round in 1 2 3 4; do
    H=$(d 'd["host"]["address"]')
    hc kill "$H" >>"$LOG" 2>&1
    expect '[ "$(d "d[\"connection\"][\"status\"]")" = stopped ] && ! tab_panes "$TAB" | grep -q " $H$"' "round $round: the host stopped, its pane gone" 15
    sleep 1.5; V=$(doc_version)
    cmd click:restart
    until_ '[ "$(doc_version)" -gt "$V" ]' 15 || fail "round $round: no write of the new host's pane"
    sleep 0.15
    T=$("$APP" do tab.new "{\"name\":\"race-$round\",\"space\":\"$SPACE\",\"mod\":\"pane\"}" 2>>"$LOG" | python3 -c 'import json,sys; print(json.load(sys.stdin)["tab"])') || fail "tab.new race-$round"
    MADE_TABS="$MADE_TABS $T"
    sleep 1.5
    app_ls | grep -q "\"$T\"" || LOST="$LOST $round"
    do_ tab.select --id "$TAB"
    expect 'hidden_in "$TAB" "$(d "d[\"host\"][\"address\"]")"' "round $round: the new host's pane is hidden" 20
  done
  [ -z "$LOST" ] && ok "every tab opened 0.15 s after the chat's write is still there (4 rounds)" || fail "tabs lost in round(s)$LOST"
  note "the chat timed $(d 'd["hidePhased"]') write(s) to the app's read ($(d 'd["hideUnphased"]') without an echo), waited $(d 'd["hideWaits"]') time(s)"
  for T in $MADE_TABS; do "$APP" do tab.close --id "$T" >>"$LOG" 2>&1 || true; done
  do_ tab.close --id "$TAB"
fi

if want narrow; then
  step "a narrow chat: the composer footer steps down (240 / 320 / 420 / 600 px), never under the send button"
  CHAT=$(open_chat narrow)
  ready
  do_ layout.toggle --id sidebar
  resize() { osascript -e "tell application \"System Events\" to tell (first process whose unix id is $APP_PID) to set size of window 1 to {$1, 820}" >/dev/null 2>&1; }
  if needs_frames "the footer's size steps (measured while drawing)" && resize 900; then
    for spec in 262:xs 342:sm 442:md 622:md 1280:full; do
      W=${spec%%:*}; T=${spec##*:}
      resize "$W"; sleep 1.2; cmd hover:
      expect '[ "$(d "d[\"footerTier\"]")" = "$T" ]' "a $((W - 18)) px chat: footer \"$T\" (width $(d 'd["width"]'))" 8
      case $T in xs|sm) expect '[ "$(d "d[\"footerStatuses\"][\"shown\"]")" = "[]" ] && [ "$(d "d[\"footerStatuses\"][\"extra\"]")" -ge 2 ]' "every status is in \"+N\" ($(d 'd["footerStatuses"]'))" 5 ;; esac
      shot "fix1-16-footer-$W" 0.4
    done
  fi
  resize 1280 || true; do_ layout.toggle --id sidebar # (a minimized window has nothing to resize)
fi
