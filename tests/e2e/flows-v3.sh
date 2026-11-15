# Providers (docs/dev/providers.md, protocol v3), sourced by run.sh: flows
# `claude` and `codex` (and `v3` = both, plus the launcher). Each runs the
# real host with its fake agent (tests/fake-claude, tests/fake-codex) on a
# scenario in tests/e2e/<provider>/e2e.json, and checks what the mod shows
# (debug dump) and what reached the agent (the fake's log of what the host
# sent). Every key step has a fallback (a dropped key while the window
# isn't drawn): retried keys are noted in run.log, and a step done by the
# mod's command instead makes its check a SKIP (by_command).

# A key for the open card ($1: text:<digit>, enter, esc) until $2 holds, the check $3 (keys_or:
# else the key's action by command, chat.key:<action>, and $3 is a SKIP).
ask_key() {
  local a
  case "$1" in text:*) a="digit_${1#text:}" ;; esc) a=escape ;; *) a="$1" ;; esac
  keys_or "$1" "$2" "key:$a" "$3"
}
agent_log() { cat "$BASE/fake-$1.log" 2>/dev/null; }
# The answers in Claude's last control_response (fake-claude's log), one per line.
claude_answers() { agent_log claude | grep control_response | tail -1 | python3 -c 'import json,sys
r=json.loads(sys.stdin.read())["response"].get("response") or {}
for v in ((r.get("updatedInput") or {}).get("answers") or {}).values(): print(v)'; }
qcursor() { d "'%s:%s' % (d['dialog']['cursor']['q'], d['dialog']['cursor']['i'])"; }
nothing_picked() { [ "$(d "not any(d['dialog']['picked'].values())")" = true ]; }
other_focus() { d "d['dialog']['otherFocus']"; }
other_text() { d "d['dialog']['others']['$1']"; }
# The last key action the mod took (its log), e.g. herdrchat_space.
last_action() { d "([l.split(' action ')[-1] for l in d['log'] if ' action ' in l] or [''])[-1]"; }
# The newest chat (by dump) of provider $1.
chat_of() { python3 -c 'import glob,json,os,sys; L=[]
for f in glob.glob(sys.argv[1] + "/c-*.json"):
    try: d=json.load(open(f))
    except Exception: continue
    if d.get("provider") == sys.argv[2]: L.append((os.path.getctime(f), d["chat"]))
print(max(L)[1] if L else "")' "$STATE/debug" "$1"; }
last_tool() { d "[i['$1'] for i in d['items'] if i['kind']=='tool' and not i.get('parent')][-1]"; }
open_dialog() { expect '[ "$(d "d[\"dialog\"][\"method\"]")" = '"$1"' ]' "${2:-a $1 card}" 10; }
# The mode picker, then ↓/↑ to the mode $1 and Enter (else the picker's own code: by_command).
pick_mode() {
  cmd click:chip:permission
  expect '[ "$(d "d[\"picker\"][\"kind\"]")" = permission ]' "the permission-mode chip opens its picker" 5
  local from to
  MODE_WANT=$1 # (until_ evals its condition with its own $1)
  from=$(d "d['picker']['sel']"); to=$(d "d['picker']['items'].index('$1')")
  cmd focus; sleep 0.3; keys 56:shift
  if [ "$to" -gt "$from" ]; then for _ in $(seq 1 $((to - from))); do keys down; done
  else for _ in $(seq 1 $((from - to))); do keys up; done; fi
  [ "$to" = "$from" ] || true
  keys enter
  until_ '[ "$(d "d[\"permissionMode\"]")" = "$MODE_WANT" ]' 3 || { by_command "the picker keys didn't land"; [ "$(d 'd["picker"]')" = null ] && cmd click:chip:permission; cmd "click:picker:$to"; }
  expect '[ "$(d "d[\"permissionMode\"]")" = "$MODE_WANT" ]' "mode $1, from the chip's picker" 8
}

if want v3 || want launcher; then
  step "launcher: cmd-j shift-p asks which agent; 2 = Claude Code; the choice is the default next time"
  open_launcher "the chooser opens"
  shot v3-7-launcher 0.5
  keys "text:2"
  until_ '! overlay_open new-chat' 3 || { by_command "2 didn't land"; do_ new-chat.pick:claude; }
  expect '! overlay_open new-chat' "2 picks Claude Code (the chooser closes)" 3
  expect '[ -n "$(chat_of claude)" ]' "a Claude Code chat opened" 15
  CHAT=$(chat_of claude)
  expect '[ "$(reg "$CHAT" provider)" = claude ]' "the host runs it as provider claude (registry)" 20
  [ "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["last"])' "$STATE/launcher.json")" = claude ] && ok "the launcher remembers Claude Code" || fail "launcher.json"
  expect '[ "$(phase)" = idle ]' "fake-claude is up (idle)" 20
  [ "$(d 'd["paneTitle"]')" = chat ] && ok "the pane header reads \"chat\", not \"pi\"" || fail "pane title $(d 'd["paneTitle"]')"
  open_launcher "the chooser opens again"
  shot v3-7-launcher-default 0.5
  keys esc
  until_ '! overlay_open new-chat' 3 || { note "Esc didn't land: again, primed"; keys 56:shift esc; until_ '! overlay_open new-chat' 3; } ||
    { by_command "Esc dropped twice"; do_ overlay.close; }
  expect '! overlay_open new-chat' "Esc closes the chooser" 3
  FIRST=$CHAT
  launch_pick enter
  expect '[ -n "$(chat_of claude)" ] && [ "$(chat_of claude)" != "$FIRST" ]' "Enter opens the default, the last choice: another Claude Code chat" 15
fi

# --- Claude Code (real host, fake-claude) ------------------------------------------------
if want v3 || want claude; then
  step "claude: identity and the footer from its capabilities"
  CHAT=$(open_chat_p claude claude e2e)
  ready
  [ "$(d '[d["provider"], d["providerName"]]')" = '["claude", "Claude Code"]' ] && ok "provider Claude Code" || fail "provider $(d '[d["provider"], d["providerName"]]')"
  [ "$(d 'd["permissionMode"]')" = default ] && ok "permission mode default" || fail "mode $(d 'd["permissionMode"]')"
  if needs_frames "the footer's chips (drawn)"; then
    expect '[ "$(d "[c for c in d[\"footerChips\"] if c in (\"thinking\", \"permission\")]")" = "[\"thinking\", \"permission\"]" ]' "the footer draws the effort and permission-mode chips ($(d 'd["footerChips"]'))" 5
  fi
  shot v3-6-empty-claude 0.5
  cmd click:chip:thinking
  expect '[ "$(d "d[\"picker\"][\"items\"] == d[\"capabilities\"][\"thinkingLevels\"] and \"off\" not in d[\"picker\"][\"items\"]")" = true ]' "the effort picker lists Claude's levels ($(d 'd["capabilities"]["thinkingLevels"]'))" 5
  cmd focus; sleep 0.3
  keys_or "down enter" '[ "$(d "d[\"picker\"]")" = null ]' "key:down;key:enter" "↓ Enter picks the next level (the picker closes)"
  expect 'agent_log claude | grep -q "\"apply_flag_settings\""' "apply_flag_settings reached Claude" 8
  cmd click:chip:model
  expect '[ "$(d "d[\"picker\"][\"kind\"]")" = model ] && [ "$(d "len(d[\"picker\"][\"items\"])")" -ge 2 ]' "the model picker lists Claude's models" 10
  shot v3-1-claude-models 0.4
  WANT=$(d "d['picker']['items'][1]")
  cmd click:picker:1
  expect 'agent_log claude | grep -q "\"set_model\""' "set_model reached Claude ($WANT)" 8

  step "claude: the prompt shows before the answer starts (the CLI echoes it only then)"
  send_text "slow start please"
  expect '[ "$(d "[d[\"items\"][-1][\"kind\"], d[\"items\"][-1].get(\"text\")]")" = '\''["user", "slow start please"]'\'' ]' "the prompt is the last item while Claude hasn't started" 2
  expect '[ "$(phase)" = idle ] && [ "$(d "[d[\"items\"][-1][\"kind\"], d[\"items\"][-1].get(\"len\")]")" = "[\"assistant\", 15]" ]' "then the answer (\"Started slowly.\")" 10
  [ "$(d "[i.get('text') for i in d['items'] if i['kind'] == 'user'].count('slow start please')")" = 1 ] && ok "one user item: the echo confirmed it" || fail "user items $(d "[i.get('text') for i in d['items'] if i['kind'] == 'user']")"

  step "claude: a command's permission card, allowed with 1"
  send_text "run the tests"
  open_dialog permission "Claude asks before the command"
  note "titled \"$(d 'd["dialog"]["title"]')\"" # (the mapping: tests/host/claude-asks.test.ts)
  shot v3-2-claude-permission 0.4
  keys 56:shift space
  until_ '[ "$(d "d[\"composer\"][\"text\"]")" = " " ]' 3 || { note "space didn't land: again, primed"; cmd focus; sleep 0.3; keys 56:shift space; until_ '[ "$(d "d[\"composer\"][\"text\"]")" = " " ]' 3 || true; }
  if [ "$(d 'd["composer"]["text"]')" = " " ]; then ok "Space on a permission card types a space (no card key takes it)"
  elif [ "$(last_action)" = herdrchat_space ]; then fail "the permission card took Space"
  else skip "Space on a permission card (the key didn't land)"; fi
  cmd clear
  ask_key "text:1" '[ "$(d "d[\"lastAnswer\"][\"choice\"]")" = allow ]' "1 answers Allow once"
  expect 'agent_log claude | grep "control_response" | tail -1 | grep -q "\"behavior\":\"allow\""' "Claude got behavior allow" 5
  expect '[ "$(phase)" = idle ] && [ "$(last_tool status)" = done ]' "the command ran" 15
  if needs_frames "the footer's cost (drawn)"; then
    expect '[ "$(d "\"cost\" in d[\"footerChips\"]")" = true ]' "the footer shows the run's cost ($(d 'd["footerChips"]'))" 5
  fi

  step "claude: Always allow, then the same command runs without asking"
  send_text "run the tests"
  open_dialog permission "asked again"
  ask_key "text:2" '[ "$(d "d[\"lastAnswer\"][\"choice\"]")" = always ]' "2 answers Always allow"
  expect '[ "$(phase)" = idle ]' "done" 15
  N=$(agent_log claude | grep -c '"can_use_tool"\|control_response' || true)
  send_text "run the tests"
  expect '[ "$(phase)" = idle ] && [ "$(last_tool status)" = done ]' "the third run settles" 15
  [ "$(agent_log claude | grep -c '"can_use_tool"\|control_response' || true)" = "$N" ] && [ "$(d 'd["dialog"]')" = null ] && ok "no card the third time (the rule holds)" || fail "asked again after Always"

  step "claude: Deny with a reason (Esc); the card shows declined"
  send_text "clean the build"
  open_dialog permission "a card for rm -rf build"
  cmd "click:dialog:reason:keep the build, it's cached"
  ask_key esc '[ "$(d "d[\"lastAnswer\"][\"choice\"]")" = deny ]' "Esc answers Deny"
  expect 'agent_log claude | grep "control_response" | tail -1 | grep -q "keep the build"' "the deny's reason reached Claude" 5
  expect '[ "$(phase)" = idle ] && [ "$(last_tool status)" = declined ]' "the tool card is declined" 15
  shot v3-2-claude-declined 0.4

  step "claude: Accept edits mode (the chip) skips the edit's card"
  pick_mode acceptEdits
  expect 'agent_log claude | grep "set_permission_mode" | tail -1 | grep -q acceptEdits' "set_permission_mode acceptEdits reached Claude" 5
  send_text "edit the file"
  expect '[ "$(phase)" = idle ] && [ "$(last_tool name)" = Edit ] && [ "$(last_tool status)" = done ]' "the edit ran without a card" 15
  pick_mode default

  step "claude: questions (AskUserQuestion): number keys, Other, Enter"
  send_text "ask me"
  open_dialog questions "a questions card"
  ask_key "text:1" '[ "$(d "list(d[\"dialog\"][\"picked\"].values())[0]")" = "[\"Postgres\"]" ]' "1 picks Postgres"
  ask_key "text:3" '[ "$(d "\"Lint\" in list(d[\"dialog\"][\"picked\"].values())[1]")" = true ]' "3 toggles Lint in the next question"
  shot v3-3-claude-questions 0.4
  ask_key enter '[ "$(d "d[\"dialog\"]")" = null ]' "Enter submits the answers"
  expect 'agent_log claude | grep "control_response" | tail -1 | grep -q "Postgres"' "the answers reached Claude" 5
  expect '[ "$(phase)" = idle ]' "done" 15

  step "claude: a questions card by keys alone: the recommended option starts highlighted, ↑↓ move, Enter answers"
  send_text "a drink, please"
  open_dialog questions "a one-question card"
  [ "$(qcursor)" = 0:1 ] && ok "the highlight starts on Tea (Recommended), not the first option" || fail "cursor $(qcursor)"
  nothing_picked && ok "a highlight is not an answer: nothing is picked yet" || fail "picked on open"
  ask_key space '[ "$(last_action)" = herdrchat_space ]' "Space reaches the card"
  nothing_picked && [ "$(qcursor)" = 0:1 ] && ok "Space on a single-select question picks nothing and keeps the highlight" || fail "Space: picked $(d "d['dialog']['picked']"), cursor $(qcursor)"
  ask_key enter '[ "$(d "d[\"dialog\"]")" = null ]' "Enter answers the card"
  expect '[ "$(claude_answers)" = "Tea (Recommended)" ]' "Claude got the highlighted option, its label as Claude wrote it" 5
  expect '[ "$(phase)" = idle ]' "done" 15
  send_text "a drink, please"
  open_dialog questions "the card again"
  ask_key down '[ "$(qcursor)" = 0:2 ]' "↓ moves the highlight to Water"
  nothing_picked && ok "moving the highlight picks nothing" || fail "↓ picked"
  ask_key down '[ "$(qcursor)" = 0:3 ]' "↓ moves on to the Other field"
  ask_key up '[ "$(qcursor)" = 0:2 ]' "↑ comes back to Water"
  ask_key enter '[ "$(d "d[\"dialog\"]")" = null ]' "Enter answers the card"
  expect '[ "$(claude_answers)" = Water ]' "Claude got Water" 5
  expect '[ "$(phase)" = idle ]' "done" 15

  step "claude: two questions by keys alone: Enter answers one and moves on, Space ticks a multi-select"
  send_text "ask me"
  open_dialog questions "a questions card"
  ask_key down '[ "$(qcursor)" = 0:1 ]' "↓ highlights SQLite"
  ask_key enter '[ "$(qcursor)" = 1:0 ]' "Enter picks it and moves on to the checks"
  [ "$(d "list(d['dialog']['picked'].values())[0]")" = '["SQLite"]' ] && ok "SQLite is picked" || fail "picked $(d "d['dialog']['picked']")"
  ask_key space '[ "$(d "list(d[\"dialog\"][\"picked\"].values())[1]")" = "[\"Unit tests\"]" ]' "Space ticks Unit tests"
  ask_key down '[ "$(qcursor)" = 1:1 ]' "↓ highlights Type check"
  ask_key down '[ "$(qcursor)" = 1:2 ]' "↓ highlights Lint"
  ask_key space '[ "$(d "\"Lint\" in list(d[\"dialog\"][\"picked\"].values())[1]")" = true ]' "Space ticks Lint too"
  shot v3-3-claude-questions-keys 0.4
  ask_key enter '[ "$(d "d[\"dialog\"]")" = null ]' "Enter submits: nothing is left unanswered"
  expect '[ "$(claude_answers | tr "\n" "|")" = "SQLite|Unit tests, Lint|" ]' "Claude got SQLite and the two checks" 5
  expect '[ "$(phase)" = idle ]' "done" 15

  step "claude: on a single-select question an option and Other text exclude each other: the card sends what it shows"
  send_text "ask me"
  open_dialog questions "a questions card"
  ask_key enter '[ "$(qcursor)" = 1:0 ]' "Enter picks Postgres and moves on to the checks"
  ask_key up '[ "$(qcursor)" = 0:2 ]' "↑ goes back to the database question's Other field"
  ask_key enter '[ "$(last_action)" = herdrchat_enter ] && [ "$(d "d[\"dialog\"] is not None")" = true ]' "Enter on the empty field: the card stays open"
  keys "text:mysql"
  until_ '[ "$(other_text q0)" = mysql ]' 3 || { by_command "the field didn't get the text"; cmd "click:dialog:other:0:mysql"; }
  expect '[ "$(other_text q0)" = mysql ] && [ "$(d "d[\"dialog\"][\"picked\"][\"q0\"]")" = "[]" ]' "typing Other clears the pick: the card shows only mysql" 3
  keys enter
  until_ '[ "$(qcursor)" = 1:0 ]' 3 || { by_command "Enter in the field didn't land"; cmd focus; sleep 0.3; cmd key:enter; }
  expect '[ "$(qcursor)" = 1:0 ]' "Enter in the field answers mysql and moves on to the checks" 5
  ask_key up '[ "$(qcursor)" = 0:2 ]' "↑ back to the Other field"
  ask_key up '[ "$(qcursor)" = 0:1 ]' "↑ highlights SQLite"
  ask_key enter '[ "$(qcursor)" = 1:0 ]' "Enter picks SQLite and moves on"
  [ "$(d "[d['dialog']['picked']['q0'], d['dialog']['others']['q0']]")" = '[["SQLite"], ""]' ] && ok "picking SQLite cleared the Other text" || fail "q0: $(d "[d['dialog']['picked']['q0'], d['dialog']['others']['q0']]")"
  ask_key space '[ "$(d "d[\"dialog\"][\"picked\"][\"q1\"]")" = "[\"Unit tests\"]" ]' "Space ticks Unit tests"
  ask_key enter '[ "$(d "d[\"dialog\"]")" = null ]' "Enter submits"
  expect '[ "$(claude_answers | tr "\n" "|")" = "SQLite|Unit tests|" ]' "Claude got SQLite, the option the card showed, not the old Other text" 5
  expect '[ "$(phase)" = idle ]' "done" 15

  step "claude: plan approval (ExitPlanMode): the plan as markdown, Approve, accept edits"
  send_text "make a plan"
  open_dialog permission "the plan is ready"
  shot v3-4-claude-plan 0.4
  cmd click:dialog:choice:approve_edits
  expect '[ "$(phase)" = idle ] && [ "$(d "d[\"permissionMode\"]")" = acceptEdits ]' "approved: the mode chip follows (acceptEdits)" 15
  pick_mode default

  step "claude: a subagent's steps nested in its card; the todo list as a plan card"
  send_text "use an agent"
  expect '[ "$(phase)" = idle ]' "the agent run settles" 20
  AG=$(d "[i['id'] for i in d['items'] if i['kind']=='tool' and i.get('name') in ('Agent','Task')][-1]")
  [ -n "$AG" ] && ok "an agent card ($AG)" || fail "no agent tool"
  NESTED=$(d "len([i for i in d['items'] if i.get('parent') == '$AG'])")
  ROWS=$(d "len([r for r in d['rows'] if r['kind']=='item' and r['id'] in [i['id'] for i in d['items'] if i.get('parent')]])")
  [ "$NESTED" -ge 1 ] && [ "$ROWS" = 0 ] && ok "$NESTED nested items, none a row of its own" || fail "nested $NESTED rows $ROWS"
  [ "$(count_kind plan)" -ge 1 ] && ok "TodoWrite → a plan card" || fail "no plan item"
  G=$(d "[r['id'] for r in d['rows'] if r['kind']=='group'][-1]" 2>/dev/null || true)
  [ -z "$G" ] || cmd "toggle:$G"
  cmd "toggle:kids:$AG"
  sleep 0.4; shot v3-5-claude-agent 0.4

  step "claude: a steer mid-run, then Esc on a stalled run"
  send_text "run the long job"
  expect '[ "$(phase)" = working ]' "working" 5
  sleep 0.5
  send_text "also check the logs"
  expect 'agent_log claude | grep -q "\"priority\":\"next\""' "Enter while working steers (priority next)" 8
  expect '[ "$(phase)" = idle ]' "the run settles" 20
  [ "$(d "[i['len'] for i in d['items'] if i['kind']=='assistant'][-1]")" -gt 0 ] && ok "answered" || fail "no answer"
  [ "$(d "[i['text'] for i in d['items'] if i['kind']=='user'][-1]")" = "also check the logs" ] && [ "$(d "d['items'][-1]['kind']")" = assistant ] \
    && ok "the steer shows in the timeline, answered in the run" || fail "steer: $(d "[(i['kind'], i.get('text')) for i in d['items'][-4:]]")"
  send_text "stall"
  expect '[ "$(phase)" = working ]' "a stalled run" 8
  cmd focus; sleep 0.3; keys 56:shift esc
  until_ '[ "$(phase)" = idle ]' 5 || { by_command "Esc didn't land: Stop"; cmd click:stop; }
  expect '[ "$(phase)" = idle ]' "Esc stops the stalled run" 10
  expect 'agent_log claude | grep -q "\"interrupt\""' "the interrupt reached Claude" 5

  step "claude: the TUI hand-off runs claude --resume <id>; back after it quits"
  SID=$(host | python3 -c 'import json,sys; f=json.load(sys.stdin)["state"]["sessionFile"]; print(f.rsplit("/",1)[-1].removesuffix(".jsonl"))')
  : >"$FAKE_TUI_LOG"
  send_text "/tui"
  expect 'grep -q -- "--resume $SID" "$FAKE_TUI_LOG"' "the hand-off argv: --resume $SID" 15
  handoff_tui
  hc send "$TUI" q >>"$LOG" 2>&1 || hc send --force "$TUI" q >>"$LOG" 2>&1
  expect '[ "$(d "d[\"handoff\"]")" = null ] && [ "$(phase)" = idle ]' "back in the chat, Claude resumed" 20

  step "claude: the built-ins are Claude's: /login runs its argv (claude auth login), then resumes"
  [ "$(d '"login" in d["commandNames"] and "tree" not in d["commandNames"] and "scoped-models" not in d["commandNames"]')" = true ] \
    && ok "the menu has /login, no Pi-only /tree or /scoped-models" || fail "commands $(d 'd["commandNames"]')"
  : >"$FAKE_TUI_LOG"
  send_text "/login"
  expect 'grep -q -- "auth login" "$FAKE_TUI_LOG"' "/login runs the built-in's argv: $(tail -1 "$FAKE_TUI_LOG" 2>/dev/null)" 15
  handoff_tui
  expect 'overlay_open layout && ! term_panes | grep -q " $TUI$"' "in a dialog over the chat, no pane" 10
  hc send "$TUI" q >>"$LOG" 2>&1 || hc send --force "$TUI" q >>"$LOG" 2>&1
  expect '[ "$(d "d[\"handoff\"]")" = null ] && [ "$(phase)" = idle ] && [ "$(d "d[\"zoomed\"]")" = false ] && [ "$(d "d[\"hostHidden\"]")" = true ]' "back: Claude resumed, the chat alone (no zoom), its host hidden" 20

  step "claude: the host restarts on the same session (resume from the transcript)"
  BEFORE=$(d "len([i for i in d['items'] if i['kind'] in ('user','assistant','tool')])")
  hc kill "$(d 'd["host"]["address"]')" >>"$LOG" 2>&1
  expect '[ "$(d "d[\"connection\"][\"status\"]")" = stopped ]' "host stopped" 15
  cmd click:restart
  expect connected "restarted" 25
  expect '[ "$(d "d[\"hostHidden\"]")" = true ] && [ "$(d "d[\"hostNodePane\"]")" = "$(d "d[\"hostPane\"]")" ]' "the new host's pane is hidden too" 15
  expect '[ "$(phase)" = idle ] && [ "$(d "len([i for i in d[\"items\"] if i[\"kind\"] in (\"user\",\"assistant\",\"tool\")])")" -ge "$BEFORE" ]' "the timeline came back from Claude's transcript ($BEFORE items)" 20
  shot v3-6-claude-resumed 0.4
fi

# --- Codex (real host, fake-codex) ---------------------------------------------------------
if want v3 || want codex; then
  step "codex: identity and the footer (no cost, no 'off' effort, the presets)"
  CHAT=$(open_chat_p codex codex e2e)
  ready
  [ "$(d '[d["provider"], d["providerName"]]')" = '["codex", "Codex"]' ] && ok "provider Codex" || fail "provider $(d '[d["provider"], d["providerName"]]')"
  [ "$(d 'd["permissionMode"]')" = untrusted ] && ok "the permission preset is the user's (Ask first)" || fail "mode $(d 'd["permissionMode"]')"
  expect '[ "$(d "\"off\" not in d[\"capabilities\"][\"thinkingLevels\"] and len(d[\"capabilities\"][\"thinkingLevels\"]) > 0")" = true ]' "effort levels from the model, without off ($(d 'd["capabilities"]["thinkingLevels"]'))" 10
  shot v3-6-empty-codex 0.5
  cmd click:chip:thinking
  expect '[ "$(d "d[\"picker\"][\"kind\"]")" = thinking ]' "the effort picker" 5
  cmd focus; sleep 0.3
  keys_or "down enter" '[ "$(d "d[\"picker\"]")" = null ]' "key:down;key:enter" "↓ Enter picks the next level (the picker closes)"
  expect 'agent_log codex | grep -q "thread/settings/update\|\"effort\""' "the effort reached Codex" 8

  step "codex: a command approval (1 = allow), for the session (2), decline with a reason (Esc)"
  send_text "run the tests"
  open_dialog permission "Codex asks before the command"
  shot v3-2-codex-permission 0.4
  ask_key "text:1" '[ "$(d "d[\"dialog\"] is None and d[\"lastAnswer\"] is not None")" = true ]' "1 answers the command's card"
  expect '[ "$(phase)" = idle ] && [ "$(last_tool status)" = done ]' "the command ran" 15
  if needs_frames "the footer's chips (drawn)"; then
    expect '[ "$(d "[c for c in d[\"footerChips\"] if c in (\"thinking\", \"permission\", \"cost\")]")" = "[\"thinking\", \"permission\"]" ]' "the footer draws the effort and preset chips, no cost ($(d 'd["footerChips"]'))" 5
  fi
  send_text "clean the build"
  open_dialog permission "a card for rm -rf build"
  cmd "click:dialog:reason:keep the build, it's cached"
  ask_key esc '[ "$(d "d[\"dialog\"] is None and (d[\"lastAnswer\"] or {}).get(\"choice\") is not None")" = true ]' "Esc declines"
  expect '[ "$(phase)" = idle ] && [ "$(last_tool status)" = declined ]' "declined: the card says so" 15
  expect 'host | grep -q "Left the build folder alone\|keep the build"' "Codex went on without it (its reply, or the reason as a steer)" 10
  shot v3-2-codex-declined 0.4

  step "codex: a file change approval and a permissions grant"
  send_text "edit the file"
  open_dialog permission "a card for the file change"
  shot v3-2-codex-filechange 0.4
  ask_key "text:1" '[ "$(d "d[\"dialog\"]")" = null ]' "1 accepts the file change"
  expect '[ "$(phase)" = idle ] && [ "$(last_tool status)" = done ]' "the edit applied" 15
  send_text "use the network"
  open_dialog permission "a permissions grant card"
  shot v3-2-codex-grant 0.4
  ask_key "text:1" '[ "$(d "d[\"dialog\"]")" = null ]' "1 grants the permissions"
  expect '[ "$(phase)" = idle ] && host | grep -q "Network granted"' "granted" 15

  step "codex: requestUserInput questions (an option, a free-text answer)"
  send_text "ask me"
  open_dialog questions "a questions card"
  ask_key "text:1" '[ "$(d "list(d[\"dialog\"][\"picked\"].values())[0]")" = "[\"Postgres\"]" ]' "1 picks Postgres"
  QN=$(d "len(d['dialog']['picked'])")
  cmd "click:dialog:other:1:billing"
  shot v3-3-codex-questions 0.4
  ask_key enter '[ "$(d "d[\"dialog\"]")" = null ]' "Enter submits the answers"
  expect '[ "$(phase)" = idle ] && host | grep -q "Using Postgres"' "answered: Codex used Postgres" 15

  step "codex: the card goes away while its Other field has the keyboard: the composer gets it back"
  send_text "ask me"
  open_dialog questions "a questions card"
  ask_key enter '[ "$(qcursor)" = 1:0 ]' "Enter picks Postgres and moves on to the free-text question"
  keys enter; sleep 0.4; keys "text:x"
  until_ '[ "$(other_text name)" = x ]' 3 || { note "Enter or x didn't land: again, primed"; keys 56:shift enter; sleep 0.4; keys "text:x"; until_ '[ "$(other_text name)" = x ]' 3 || true; }
  [ "$(other_text name)" = x ] && ok "Enter on the empty field gave it the keyboard: x landed there" || fail "the field didn't take the keyboard: others $(d "d['dialog']['others']"), composer \"$(d 'd["composer"]["text"]')\""
  DLG=$(d 'd["dialog"]["id"]')
  "$REPO/bin/herdr-chat-host" op --chat "$CHAT" --state-dir "$STATE" dialog_answer "{\"dialog\": \"$DLG\", \"cancelled\": true}" >>"$LOG" 2>&1 || fail "another client's answer"
  expect '[ "$(d "d[\"dialog\"]")" = null ]' "another client cancels the card: it goes" 5
  keys "text:hi"
  until_ '[ "$(d "\"hi\" in d[\"composer\"][\"text\"]")" = true ]' 3 || { note "hi didn't land: again, primed"; keys 56:shift "text:hi"; until_ '[ "$(d "\"hi\" in d[\"composer\"][\"text\"]")" = true ]' 3 || true; }
  [ "$(d '"hi" in d["composer"]["text"]')" = true ] && ok "the keyboard is back in the composer: typing lands there" || fail "typed into nothing: the composer has \"$(d 'd["composer"]["text"]')\""
  cmd clear
  expect '[ "$(phase)" = idle ]' "done" 15

  step "codex: the same card by keys alone, a free-text question included"
  send_text "ask me"
  open_dialog questions "a questions card"
  ask_key enter '[ "$(qcursor)" = 1:0 ]' "Enter picks Postgres and moves on to the free-text question"
  ask_key enter '[ "$(other_focus)" = name ]' "Enter on its empty field takes the keyboard there"
  [ "$(d 'd["dialog"] is not None')" = true ] && ok "an empty field doesn't answer" || fail "the card closed"
  keys "text:billing"
  until_ '[ "$(d "list(d[\"dialog\"][\"others\"].values())[1]")" = billing ]' 3 || { by_command "the field didn't get the text"; cmd "click:dialog:other:1:billing"; }
  expect '[ "$(d "list(d[\"dialog\"][\"others\"].values())[1]")" = billing ]' "typed into the field" 3
  shot v3-3-codex-other-typed 0.4
  keys enter
  until_ '[ "$(d "d[\"dialog\"]")" = null ]' 3 || { by_command "Enter in the field didn't land"; cmd focus; sleep 0.3; cmd key:enter; }
  expect '[ "$(d "d[\"dialog\"]")" = null ]' "Enter in the field submits: nothing is left unanswered" 5
  expect '[ "$(phase)" = idle ] && agent_log codex | grep -q "\"billing\""' "Codex got Postgres and billing" 15

  step "codex: Esc in an Other field hands the keyboard back; Esc in the composer cancels the card"
  send_text "ask me"
  open_dialog questions "a questions card"
  ask_key enter '[ "$(qcursor)" = 1:0 ]' "Enter picks Postgres and moves on to the free-text question"
  ask_key enter '[ "$(other_focus)" = name ]' "Enter on its empty field takes the keyboard there"
  keys esc
  until_ '[ "$(other_focus)" = null ]' 3 || { note "esc didn't land: again, primed"; keys 56:shift esc; until_ '[ "$(other_focus)" = null ]' 3 || true; }
  [ "$(d 'd["dialog"] is not None and d["dialog"]["otherFocus"] is None')" = true ] && ok "Esc in the field hands the keyboard back; the card stays open" || fail "after Esc: dialog $(d 'd["dialog"]')"
  ask_key esc '[ "$(d "d[\"dialog\"]")" = null ]' "Esc in the composer cancels the card"
  expect '[ "$(phase)" = idle ]' "done" 15

  step "codex: an MCP form with no fields: Space does nothing, Enter accepts it"
  send_text "check the server"
  open_dialog questions "a card with no questions"
  ask_key space '[ "$(last_action)" = herdrchat_space ]' "Space reaches the card"
  [ "$(d 'd["dialog"] is not None')" = true ] && ok "Space leaves it open" || fail "Space closed it"
  ask_key enter '[ "$(d "d[\"dialog\"]")" = null ]' "Enter accepts it"
  expect '[ "$(phase)" = idle ] && host | grep -q "Figma went on"' "the MCP server got accept" 15

  step "codex: a todo list (plan card) and a plan; a subagent nested in its card"
  send_text "make a plan"
  expect '[ "$(phase)" = idle ]' "done" 15
  [ "$(count_kind plan)" -ge 1 ] && ok "turn/plan/updated → a plan card" || fail "no plan card"
  shot v3-4-codex-plan 0.4
  send_text "use an agent"
  expect '[ "$(phase)" = idle ]' "the agent run settles" 20
  AG=$(d "[i['id'] for i in d['items'] if i['kind']=='tool' and (i.get('name') or '').lower().find('agent') >= 0 or i.get('title','').lower().startswith('agent')][-1]" 2>/dev/null || true)
  NESTED=$(d "len([i for i in d['items'] if i.get('parent')])")
  ROWS=$(d "len([r for r in d['rows'] if r['kind']=='item' and r['id'] in [i['id'] for i in d['items'] if i.get('parent')]])")
  [ "$NESTED" -ge 1 ] && [ "$ROWS" = 0 ] && ok "$NESTED nested items, none a row of its own" || fail "nested $NESTED rows $ROWS"
  [ -z "$AG" ] || cmd "toggle:kids:$AG"
  G=$(d "[r['id'] for r in d['rows'] if r['kind']=='group'][-1]" 2>/dev/null || true)
  [ -z "$G" ] || cmd "toggle:$G"
  sleep 0.4; shot v3-5-codex-agent 0.4

  step "codex: a thinking counts its seconds in one place at any depth: its row, or the live row of the folded card it's in"
  # A streaming thinking at depth $1 (0: top level, 1: a subagent's, 2: a nested subagent's): its id.
  thinking_at() { d "(lambda pa: next((i['id'] for i in d['items'] if i['kind']=='thinking' and i.get('streaming') and $1 == (0 if not i.get('parent') else 1 if not pa.get(i['parent']) else 2)), ''))({i['id']: i.get('parent') for i in d['items']})"; }
  parent_of() { d "next(i.get('parent') or '' for i in d['items'] if i['id']=='$1')"; }
  group_of() { d "next((r['id'] for r in d['rows'] if r['kind']=='group' and '$1' in r['items']), '')"; }
  # The open state of group $1 and of agent card $2, as "<true|false> <true|false>".
  opened() { d "str(next(r['open'] for r in d['rows'] if r['id']=='$1')).lower() + ' ' + str('kids:$2' in d['expanded']).lower()"; }
  # The activity line: "<text> <· Ns, or - for no timer>".
  line() { d "(lambda a: a['text'] + ' ' + ('-' if a.get('since') is None else 'Ns'))(d['activity'] or {'text': 'none'})"; }
  # Where item $1 is drawn, from the dump's rows: "row" (a row, or a card its group shows), "open card <parent>"
  # (inside its open agent cards), "live row of <card>" (the live row of the nearest folded card), or "nowhere".
  shown() { python3 - "$STATE/debug/$CHAT.json" "$1" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
items = {i["id"]: i for i in d["items"]}
def where(x):
    p = items[x].get("parent")
    if not p:
        return "row" if any(r["id"] == x or x in r.get("cards", []) for r in d["rows"]) else "nowhere"
    a = p
    while a and f"kids:{a}" in d["expanded"]:
        a = items[a].get("parent")
    if a is None:
        root = p
        while items[root].get("parent"):
            root = items[root]["parent"]
        return f"open card {p}" if where(root) != "nowhere" else "nowhere"
    return f"live row of {a}" if x in items[a].get("live", []) and where(a) != "nowhere" else "nowhere"
print(where(sys.argv[2]))
PY
  }
  # Thinking $T shows as $1 and the activity line says Working with no timer: one counter on screen.
  counts_once() { local want=$1; until_ '[ "$(shown $T)" = "$want" ] && [ "$(line)" = "Working -" ]' 3 && ok "$2" || fail "$2: $T $(shown $T), the line $(line)"; }
  send_text "think it over"
  until_ 'T=$(thinking_at 0); [ -n "$T" ]' 10 || fail "no top-level thinking streamed"
  counts_once row "top level: its row is on screen; the activity line says Working, no timer"
  shot v3-6-codex-thinking 0.2
  until_ 'T=$(thinking_at 1); [ -n "$T" ]' 15 || fail "no subagent thinking streamed"
  P=$(parent_of "$T"); G=$(group_of "$P")
  [ -n "$G" ] || fail "the subagent's card isn't in a work group"
  counts_once "live row of $P" "a subagent's thinking, its card folded in a closed group: the card's live row counts, the line says Working"
  shot v3-6-codex-thinking-folded-agent 0.2
  cmd "toggle:$G"; cmd "toggle:kids:$P"
  until_ '[ "$(opened $G $P)" = "true true" ]' 3 || fail "the group and the card didn't open: $(opened $G $P)"
  counts_once "open card $P" "the group and the card opened: its row in the card counts, the line says Working"
  cmd "toggle:$G"
  until_ '[ "$(opened $G $P)" = "false true" ]' 3 || fail "the group didn't close: $(opened $G $P)"
  counts_once "open card $P" "the group closed, the card left open: the group still shows the card, its row counts"
  shot v3-6-codex-thinking-open-card-closed-group 0.2
  cmd "toggle:kids:$P"
  until_ 'T=$(thinking_at 2); [ -n "$T" ]' 20 || fail "no nested subagent thinking streamed"
  P2=$(parent_of "$T")
  cmd "toggle:kids:$P2"
  until_ '[ "$(opened $G $P)" = "false false" ] && [ "$(opened $G $P2)" = "false true" ]' 3 || fail "the outer card didn't fold, or the inner one open: $(opened $G $P), $(opened $G $P2)"
  counts_once "live row of $P" "a nested subagent's thinking, its card open in a folded card: the outer card's live row counts"
  shot v3-6-codex-thinking-nested 0.2
  cmd "toggle:kids:$P2"
  expect '[ "$(phase)" = idle ]' "the run settles" 30

  step "codex: a steer mid-run, an interrupt"
  send_text "run the long job"
  expect '[ "$(phase)" = working ]' "working" 5
  sleep 0.6
  send_text "also check the logs"
  expect 'agent_log codex | grep -q "turn/steer\|\"turn/start\".*also check"' "Enter while working steers" 8
  expect '[ "$(phase)" = idle ] && host | grep -q "Checked the logs too"' "the steer ran in the turn" 20
  send_text "stall"
  expect '[ "$(phase)" = working ]' "a stalled run" 8
  cmd focus; sleep 0.3; keys 56:shift esc
  until_ '[ "$(phase)" = idle ]' 5 || { by_command "Esc didn't land: Stop"; cmd click:stop; }
  expect '[ "$(phase)" = idle ]' "Esc stops the stalled turn" 10
  expect 'agent_log codex | grep -q "turn/interrupt"' "turn/interrupt reached Codex" 5

  step "codex: /login runs codex login; there's no /settings"
  [ "$(d '"login" in d["commandNames"] and "settings" not in d["commandNames"] and "tree" not in d["commandNames"]')" = true ] \
    && ok "the menu has /login, no /settings or /tree" || fail "commands $(d 'd["commandNames"]')"
  : >"$FAKE_TUI_LOG"
  send_text "/login"
  expect 'grep -qx -- "login" "$FAKE_TUI_LOG"' "/login runs the built-in's argv: $(tail -1 "$FAKE_TUI_LOG" 2>/dev/null)" 15
  handoff_tui
  hc send "$TUI" q >>"$LOG" 2>&1 || hc send --force "$TUI" q >>"$LOG" 2>&1
  expect '[ "$(d "d[\"handoff\"]")" = null ] && [ "$(phase)" = idle ]' "back, Codex resumed" 20

  step "codex: a preset from the chip; the TUI hand-off; resume after the host restarts"
  pick_mode auto
  expect 'agent_log codex | grep -q "thread/settings/update"' "the preset reached Codex (thread/settings/update)" 8
  : >"$FAKE_TUI_LOG"
  send_text "/tui"
  expect 'grep -q -- "resume --no-daemon " "$FAKE_TUI_LOG"' "the hand-off argv: resume --no-daemon <thread> ($(tail -1 "$FAKE_TUI_LOG" 2>/dev/null))" 15
  handoff_tui
  hc send "$TUI" q >>"$LOG" 2>&1 || hc send --force "$TUI" q >>"$LOG" 2>&1
  expect '[ "$(d "d[\"handoff\"]")" = null ] && [ "$(phase)" = idle ]' "back in the chat, Codex resumed" 20
  BEFORE=$(d "len([i for i in d['items'] if i['kind'] in ('user','assistant','tool')])")
  hc kill "$(d 'd["host"]["address"]')" >>"$LOG" 2>&1
  expect '[ "$(d "d[\"connection\"][\"status\"]")" = stopped ]' "host stopped" 15
  cmd click:restart
  expect connected "restarted" 25
  expect '[ "$(d "d[\"hostHidden\"]")" = true ] && [ "$(d "d[\"hostNodePane\"]")" = "$(d "d[\"hostPane\"]")" ]' "the new host's pane is hidden too" 15
  expect '[ "$(phase)" = idle ] && [ "$(d "len([i for i in d[\"items\"] if i[\"kind\"] in (\"user\",\"assistant\",\"tool\")])")" -ge "$BEFORE" ]' "the thread came back ($BEFORE items)" 20
fi

# --- LIVE=1 PROVIDER=claude|codex: the real agent, through the launcher --------------------
# A temp project (the run's), the person's own login. The agent is asked to run
# `touch live-ok.txt && ls` (ls alone is read-only: it runs without asking);
# the permission card is answered Allow once from the keyboard.
live_provider() { # $1 provider, $2 the launcher's key
  step "live $1: the launcher → $1, a bash call through the permission card (keys), the answer"
  open_launcher "the chooser"
  keys "text:$2"
  until_ '! overlay_open new-chat' 3 || { by_command "$2 didn't land"; do_ "new-chat.pick:$1"; }
  expect '! overlay_open new-chat' "$2 picks $1 (the chooser closes)" 3
  expect '[ -n "$(chat_of '"$1"')" ]' "a $1 chat opened" 15
  CHAT=$(chat_of "$1")
  ready
  shot "live-$1-1-open" 0.5
  [ "$(d 'd["provider"]')" = "$1" ] && ok "provider $1 ($(d 'd["providerName"]'), model $(d 'd["model"]'))" || fail "provider $(d 'd["provider"]')"
}

if want live-claude && [ -n "${LIVE:-}" ]; then
  live_provider claude 2
  send_text "Run this exact bash command: touch live-ok.txt && ls. Then reply with just the word done."
  open_dialog permission "Claude asks before the command" 
  shot live-claude-2-permission 0.4
  ask_key "text:1" '[ "$(d "d[\"lastAnswer\"][\"choice\"]")" = allow ]' "1 = Allow once"
  expect '[ "$(phase)" = idle ]' "Claude settled" 120
  host >"$ART/live-claude-host.json"
  python3 - "$ART/live-claude-host.json" <<'PY' && ok "a bash card (live-ok.txt made and listed), then the answer" || fail "live claude"
import json, sys
d = json.load(open(sys.argv[1]))
tools = [i for i in d["items"] if i["kind"] == "tool" and i["detail"]["type"] == "bash"]
ans = [i for i in d["items"] if i["kind"] == "assistant" and i["text"].strip()]
sys.exit(0 if tools and tools[-1]["status"] == "done" and "live-ok.txt" in tools[-1]["output"] and ans else 1)
PY
  cmd "toggle:$(d "[i['id'] for i in d['items'] if i['kind']=='tool'][-1]")"
  shot live-claude-3-answered 0.6
fi

if want live-codex && [ -n "${LIVE:-}" ]; then
  live_provider codex 3
  step "live codex: the cheapest model (luna), effort low, Ask first: set from the chips"
  cmd click:chip:model
  expect '[ "$(d "d[\"picker\"][\"kind\"]")" = model ]' "the model picker" 15
  IDX=$(d "[i for i, v in enumerate(d['picker']['items']) if v.endswith('gpt-5.6-luna')][0]")
  cmd "click:picker:$IDX"
  expect '[ "$(d "d[\"model\"]")" = openai/gpt-5.6-luna ] || [ "$(d "d[\"model\"].endswith(\"gpt-5.6-luna\")")" = true ]' "model gpt-5.6-luna" 15
  cmd click:chip:thinking
  expect '[ "$(d "d[\"picker\"][\"kind\"]")" = thinking ]' "the effort picker" 5
  cmd "click:picker:$(d "d['picker']['items'].index('low')")"
  expect '[ "$(d "d[\"thinking\"]")" = low ]' "effort low" 10
  pick_mode untrusted
  send_text "Run this exact shell command: touch live-ok.txt && ls. Then reply with just the word done."
  open_dialog permission "Codex asks before the command"
  shot live-codex-2-permission 0.4
  ask_key "text:1" '[ "$(d "d[\"dialog\"]")" = null ]' "1 answers the card"
  expect '[ "$(phase)" = idle ]' "Codex settled" 180
  host >"$ART/live-codex-host.json"
  python3 - "$ART/live-codex-host.json" <<'PY' && ok "a command card (live-ok.txt made and listed), then the answer" || fail "live codex"
import json, sys
d = json.load(open(sys.argv[1]))
tools = [i for i in d["items"] if i["kind"] == "tool" and i["detail"]["type"] in ("bash", "search", "read")]
ans = [i for i in d["items"] if i["kind"] == "assistant" and i["text"].strip()]
sys.exit(0 if tools and tools[-1]["status"] == "done" and "live-ok.txt" in (tools[-1].get("output") or "") and ans else 1)
PY
  cmd "toggle:$(d "[i['id'] for i in d['items'] if i['kind']=='tool'][-1]")"
  shot live-codex-3-answered 0.6
fi
