# Skills as pills, sourced by run.sh: flow `skills`. fake-pi's scenario
# skills.json expands `/skill:diagnose` like Pi does. Typing goes through the
# keys (keys.py); a dropped key falls back to the mod's command (press).
#
# What could go wrong: picking a skill sends it at once (no room for the
# message); "/" inside the text opens nothing, or offers commands that need
# the whole message; the pill's text isn't the command, so the agent gets a
# label; a pill inside the text is sent mid-sentence, where no agent runs a
# skill; two skills go out (an agent runs one); Edit and resend loses the pill.

pills() { d 'len(d["composer"]["pills"])'; }
message() { d 'd["composer"]["message"]'; }
last_user() { d "[i['$1'] for i in d['items'] if i['kind']=='user'][-1]"; }
# Empty the composer as a person does (⌘A, Backspace): the state's set_value
# (chat.clear) waits for a drawn frame, and keys typed before it land first.
empty() {
  keys 0:cmd backspace
  until_ '[ "$(d "d[\"composer\"][\"text\"]")" = "" ]' 3 || { keys 0:cmd backspace; until_ '[ "$(d "d[\"composer\"][\"text\"]")" = "" ]' 3; } || fail "the composer didn't empty"
}

if want skills; then
  step "skills: a skill picked from / is a pill in the composer; the message goes on after it"
  CHAT=$(open_chat skills skills)
  ready
  type_text "/dia"
  expect '[ "$(d "d[\"menu\"][\"items\"]")" = "[\"skill:diagnose\"]" ]' "/dia offers the skill" 5
  press enter '[ "$(pills)" = 1 ]'
  expect '[ "$(pills)" = 1 ] && [ "$(d "d[\"composer\"][\"text\"]")" = "/skill:diagnose " ] && [ "$(d "d[\"menu\"]")" = null ]' "Enter puts a pill (its text the command) and a space; the menu closes" 5
  [ "$(count_kind user)" = 0 ] && ok "nothing sent yet" || fail "the pick sent the skill"
  type_text "the crash"
  [ "$(message)" = "/skill:diagnose the crash" ] && ok "what it sends: /skill:diagnose the crash" || fail "message: $(message)"
  shot skills-1-composer-pill 0.4
  send_text_keys() { keys enter; until_ '[ "$(d "d[\"composer\"][\"text\"]")" = "" ]' 3 || { by_command "Enter dropped: chat.click:send"; cmd click:send; }; }
  send_text_keys
  expect '[ "$(phase)" = idle ] && [ "$(count_kind assistant)" -ge 1 ]' "answered" 15
  [ "$(last_user text)" = "the crash" ] && [ "$(d "[i.get('skill') for i in d['items'] if i['kind']=='user'][-1]")" = diagnose ] \
    && ok "the sent message: the diagnose pill, then \"the crash\"" || fail "the message: $(last_user text) / $(d "[i.get('skill') for i in d['items'] if i['kind']=='user'][-1]")"

  step "skills: / inside the text offers skills only; the pill moves to the front when sent"
  cmd focus; sleep 0.3
  type_text "please use /"
  expect '[ "$(d "d[\"menu\"][\"start\"]")" = 11 ] && [ "$(d "set(d[\"menu\"][\"items\"]) == {\"skill:diagnose\"}")" = true ]' "a / after a space: the skills only (no /model, /tui…)" 5
  type_text "dia"
  press enter '[ "$(pills)" = 1 ]'
  expect '[ "$(d "d[\"composer\"][\"pills\"][0][\"start\"]")" = 11 ]' "the pill stands where the / was" 5
  type_text "on it"
  [ "$(message)" = "/skill:diagnose please use diagnose on it" ] && ok "sent with the skill first, its name left in the sentence" || fail "message: $(message)"
  shot skills-2-pill-mid-text 0.4
  type_text " /dia"
  press enter '[ "$(pills)" = 2 ]'
  keys enter; sleep 1
  [ "$(count_kind user)" = 1 ] && [ "$(pills)" = 2 ] && [ "$(message)" = null ] && ok "two skills: not sent (one skill per message), the text kept" \
    || fail "two skills: users $(count_kind user), pills $(pills), message $(message)"
  empty
  type_text "a path src/x and x /mod"
  [ "$(d 'd["menu"]')" = null ] && ok "src/x opens nothing, and /mod mid-text matches no skill" || fail "menu: $(d 'd["menu"]')"
  empty

  step "skills: typed out in full, a skill command becomes a pill; Edit and resend brings the pill back"
  type_text "/skill:diagnose "
  expect '[ "$(pills)" = 1 ]' "/skill:diagnose and a space: a pill" 5
  empty
  U=$(d "[i['id'] for i in d['items'] if i['kind']=='user'][-1]")
  cmd "click:edit:$U"
  expect '[ "$(d "d[\"composer\"][\"text\"]")" = "/skill:diagnose the crash" ] && [ "$(pills)" = 1 ]' "Edit and resend: the pill and the text" 5
  shot skills-3-edit-resend 0.4
  empty
fi
