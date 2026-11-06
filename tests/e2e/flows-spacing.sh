# The timeline's spacing (sourced by run.sh): flow `spacing`. One chat per
# case on tests/fake-pi/scenarios/spacing.json, a screenshot each
# (spacing-<n>-<case>.png); tests/e2e/spacing-sheet.sh puts a before and an
# after run side by side.

if want spacing; then
  SP="$SCEN/spacing.json"
  run_prompt() { send_text "$1"; expect '[ "$(phase)" = idle ] && [ "$(count_kind user)" = "'"$2"'" ]' "\"$1\" settles" 20; }

  step "spacing 1: a user message, then an answer with headings, paragraphs, a list and a code block"
  CHAT=$(open_chat sp-answer "$SP"); ready
  run_prompt "write the answer" 1
  sleep 0.6; shot spacing-1-answer 0.4

  step "spacing 2: a run with prose, a tool group, then prose"
  CHAT=$(open_chat sp-tools "$SP"); ready
  run_prompt "use the tools" 1
  [ "$(d "[r['kind'] for r in d['rows']]")" = '["item", "item", "group", "item"]' ] && ok "user, prose, a group of three tools, prose" || fail "rows $(d 'd["rows"]')"
  sleep 0.6; shot spacing-2-tools 0.4
  A=$(d "[i['id'] for i in d['items'] if i['kind']=='assistant' and i.get('len',0) > 0][0]")
  cmd "hover:$A"; sleep 0.4; shot spacing-5b-hover-mid-run 0.3; cmd hover:

  step "spacing 3: two consecutive turns"
  CHAT=$(open_chat sp-turns "$SP"); ready
  run_prompt "the first one" 1
  run_prompt "the second one" 2
  sleep 0.6; shot spacing-3-turns 0.4
  A=$(d "[i['id'] for i in d['items'] if i['kind']=='assistant'][0]")
  cmd "hover:$A"; sleep 0.4; shot spacing-5-hover 0.3; cmd hover:
  HOST_T=$(d 'd["host"]["address"]')
  hc send "$HOST_T" '<hc from="t9 tests">all green: 42 passed</hc>' >>"$LOG" 2>&1
  expect '[ "$(phase)" = idle ] && [ "$(d "len(d[\"reports\"])")" = 1 ] && [ "$(count_kind assistant)" = 3 ]' "a report card, then its answer" 20
  R=$(d 'd["reports"][0]')
  cmd "hover:$R"; sleep 0.4; shot spacing-3b-report 0.3; cmd hover:

  step "spacing 4: a notice, then the next user message"
  CHAT=$(open_chat sp-notice "$SP"); ready
  run_prompt "warn me" 1
  expect '[ "$(d "\" \".join(r[\"kind\"] if r[\"kind\"]!=\"item\" else r[\"item\"] for r in d[\"rows\"][-3:])")" = "assistant notice footer" ]' "the warning is a notice row after the answer, then the run's footer" 5
  run_prompt "after the warning" 2
  sleep 0.6; shot spacing-4-notice 0.4

  step "spacing 6: a narrow column (12 px side padding): nothing overflows"
  CHAT=$(open_chat sp-narrow "$SP"); ready
  run_prompt "use the tools" 1
  run_prompt "write the answer" 2
  # A terminal beside the chat halves its width (no window resize: that needs System Events).
  do_ pane.split --direction right --pane "$(d 'd["place"]["pane"]')" --argv '["sleep", "600"]'
  expect '[ "$(d "d[\"width\"] < 600")" = true ]' "the chat is narrower than 600 px ($(d 'd["width"]'))" 8
  for _ in 1 2 3; do cmd scroll:up; done
  sleep 0.6; shot spacing-6-narrow 0.4
fi

# Asked for by name only (it switches the app's layout to main-copy, as the
# subagent flow does): a sub-agent's chat in the agents list's peek dialog.
if [[ " $FLOWS " == *" spacing-peek "* ]]; then
  step "spacing 7: a sub-agent's chat in the peek dialog"
  "$NODE" "$REPO/install/layout.ts" install "$HERDR_APP_HOME" --app "$APP" >>"$LOG" 2>&1 || fail "install/layout.ts install"
  mkdir -p "$XDG_CONFIG_HOME/herdr-core/templates"
  cat >"$XDG_CONFIG_HOME/herdr-core/templates/pi-chat.md" <<TPL
---
description: Pi as a sub-agent (spacing e2e)
command: env FAKE_PI_SCENARIO='$SCEN/spacing.json' '$REPO/bin/pi-chat-subagent' --provider pi
---
TPL
  RUN=$(hc run --bg --json --parent "$SHELL_T" --name review --cwd "$PROJ" pi-chat "use the tools" 2>>"$LOG") || fail "hc run pi-chat"
  SUB=$(echo "$RUN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["address"])')
  until_ '[ -n "$(hc get "$SUB" --json | python3 -c "import json,sys; print(json.load(sys.stdin)[\"labels\"].get(\"pi-chat.chat\", \"\"))")" ]' 10 || fail "no pi-chat.chat label"
  CHAT="$(hc get "$SUB" --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["labels"]["pi-chat.chat"])').peek"
  do_ "chat-agents.peek:$SUB"
  expect 'overlay_open chat' "the peek dialog opened" 8
  expect '[ "$(d "d[\"peekMode\"]")" = true ] && [ "$(phase)" = idle ] && [ "$(count_kind assistant)" -ge 2 ]' "peek mode, the run settled" 25
  send_text "write the answer"
  expect '[ "$(phase)" = idle ] && [ "$(count_kind user)" = 2 ]' "\"write the answer\" settles in the dialog" 20
  for _ in 1 2 3; do cmd scroll:up; done
  sleep 0.6; shot spacing-7-peek 0.4
  cmd click:peek:close
fi
