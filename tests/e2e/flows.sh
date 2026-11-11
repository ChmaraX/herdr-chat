# The E2E flows after `basic`, sourced by run.sh (its helpers and variables).

# --- flow: a select, a confirm and an input dialog ------------------------------------------
if want dialogs; then
  step "dialogs: select → confirm → input, answered in the dialog card"
  CHAT=$(open_chat dialogs dialogs)
  ready
  send_text "clean the build"
  expect '[ "$(d "d[\"dialog\"][\"method\"]")" = select ]' "a select dialog is open" 10
  [ "$(d 'd["dialog"]["title"]')" = "Allow dangerous command?" ] && ok "its title" || fail "title"
  shot dialogs-1-select 0.3
  cmd focus; sleep 0.3 # (keys_or primes the bindings: the window may not be drawn)
  keys_or "down up enter" '[ "$(d "d[\"lastAnswer\"][\"value\"]")" = Allow ]' "key:down;key:up;key:enter" "↓ ↑ Enter answered Allow, from the keyboard (not the timeout)" quick
  expect '[ "$(d "d[\"dialog\"][\"method\"]")" = confirm ]' "Allow → the confirm comes next" 8
  cmd focus
  keys_or enter '[ "$(d "d[\"lastAnswer\"][\"confirmed\"]")" = true ]' "key:enter" "Enter answered Yes (selected first; not the timeout)" quick
  expect '[ "$(d "d[\"dialog\"][\"method\"]")" = input ]' "Yes → the input comes next" 8
  sleep 0.5
  keys "text:nightly"
  for _ in 1 2; do # a window that isn't drawn can drop keys: check the field, retype slowly
    until_ '[ "$(d "d[\"dialog\"][\"value\"]")" = nightly ]' 3 && break
    note "the dialog field had \"$(d 'd["dialog"]["value"]')\": retyping"
    cmd focus; sleep 0.3; keys 0:cmd backspace; type_slow nightly
  done
  until_ '[ "$(d "d[\"dialog\"][\"value\"]")" = nightly ]' 1 || { by_command "the dialog's field took no keys"; cmd "click:dialog:reason:nightly"; }
  shot dialogs-2-input 0.3
  [ "$(d 'd["composer"]["text"]')" = "" ] && ok "typing went to the dialog's field, not the composer" || fail "composer got: $(d 'd["composer"]["text"]')"
  cmd click:dialog:submit
  expect '[ "$(d "d[\"dialog\"]")" = null ] && [ "$(phase)" = idle ]' "the dialogs closed and the run settled" 10
  host >"$ART/dialogs-host.json"
  python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); t=[i["text"] for i in d["items"] if i["kind"]=="assistant"][-1]; sys.exit(0 if "nightly" in t else 1)' "$ART/dialogs-host.json" \
    && ok "Pi got the typed name (\"Backup saved as nightly.\")" || fail "input answer not delivered"
  python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if any(i["kind"]=="notice" and "Cache cleared" in i["text"] for i in d["items"]) else 1)' "$ART/dialogs-host.json" \
    && ok "the confirm's Yes reached Pi (\"Cache cleared\")" || fail "confirm"
  step "dialogs: /rpc-input outside a run, cancelled with Esc"
  cmd focus; sleep 0.3
  send_text "/rpc-input"
  expect '[ "$(d "d[\"dialog\"][\"method\"]")" = input ]' "an extension command's dialog outside a run" 8
  cmd focus; sleep 0.3
  keys_or esc '[ "$(d "d[\"dialog\"]")" = null ]' "key:escape" "Esc cancels it"
  [ "$(d 'd["lastAnswer"]["cancelled"]')" = true ] && ok "sent cancelled: true" || fail "cancel"
fi

# --- flow: Esc mid-tool, with a steer queued ---------------------------------------------------
if want abort; then
  step "abort: Esc while a tool runs puts the queued steer back in the composer"
  CHAT=$(open_chat abort abort)
  ready
  send_text "run the long job"
  expect '[ "$(d "len([i for i in d[\"items\"] if i[\"kind\"]==\"tool\" and i[\"status\"]==\"running\"])")" = 1 ]' "a tool runs" 10
  send_text "quick also check the logs"
  expect '[ "$(d "len(d[\"queue\"][\"steering\"]) + len(d[\"queue\"][\"followUp\"])")" -ge 1 ]' "Enter while working queues a steer" 8
  shot abort-1-queued 0.3
  keys_or esc '[ "$(phase)" = idle ]' "key:escape" "Esc stopped the run"
  expect '[ "$(d "d[\"composer\"][\"text\"]")" = "quick also check the logs" ]' "the queued text is back in the composer" 5
  [ "$(d "[i['status'] for i in d['items'] if i['kind']=='tool'][-1]")" = error ] && ok "the tool card ends as failed (aborted)" || fail "tool status"
  note "last answer's stop reason: $(d "[i['stopReason'] for i in d['items'] if i['kind']=='assistant'][-1]")" # (tests/host/steer-abort.test.ts owns it)
  shot abort-2-stopped 0.3
  step "history: Up on an empty composer recalls earlier prompts"
  cmd click:send # sends the restored text
  expect '[ "$(phase)" = idle ] && [ "$(d "d[\"composer\"][\"text\"]")" = "" ]' "sent the restored text" 10
  cmd focus; sleep 0.3
  keys_or up '[ "$(d "d[\"composer\"][\"text\"]")" = "quick also check the logs" ]' "key:up" "Up: the last prompt"
  keys_or up '[ "$(d "d[\"composer\"][\"text\"]")" = "run the long job" ]' "key:up" "Up again: the one before"
  keys_or "down down" '[ "$(d "d[\"composer\"][\"text\"]")" = "" ]' "key:down;key:down" "Down twice: back to the empty draft"
fi

# --- flow: slash menu, model and thinking pickers, @ files ------------------------------------
if want commands; then
  step "the / menu, the model picker, /thinking, @ files"
  CHAT=$(open_chat commands)
  ready
  N=$(d 'd["commands"]')
  [ "$N" -ge 15 ] && ok "$N commands in the menu (built-ins first)" || fail "commands: $N"
  keys_or "text:/" '[ "$(d "d[\"menu\"][\"kind\"]")" = slash ] && [ "$(d "d[\"menu\"][\"count\"]")" = "$N" ]' "clear;type:/" "/ opens the menu with every command"
  keys_or "text:mo" '[ "$(d "d[\"menu\"][\"query\"]")" = mo ] && [ "$(d "d[\"menu\"][\"items\"][0]")" = model ]' "clear;type:/mo" "/mo: model first"
  shot commands-1-slash 0.3
  press enter '[ "$(d "d[\"picker\"][\"kind\"]")" = model ]'
  expect '[ "$(d "d[\"picker\"][\"kind\"]")" = model ]' "Enter on /model opens the model picker" 8
  FIRST=$(d 'd["model"]')
  sleep 0.3
  S0=$(d 'd["picker"]["sel"]')
  keys_or down '[ "$(d "d[\"picker\"][\"sel\"]")" != "$S0" ]' "key:down" "↓ moves the selection"
  shot commands-2-model-picker 0.3
  TARGET=$(d 'd["picker"]["items"][d["picker"]["sel"]]')
  press enter '[ "$(d "d[\"picker\"]")" = null ]'
  expect '[ "$(d "d[\"model\"]")" = "$TARGET" ] && [ "$TARGET" != "$FIRST" ]' "↓ Enter switched the model to $TARGET" 8
  [ "$(d 'd["picker"]')" = null ] && ok "the picker closed" || fail "picker open"
  cmd focus; sleep 0.3
  send_text "/thinking high"
  expect '[ "$(d "d[\"thinking\"]")" = high ]' "/thinking high" 8
  type_text "/re"
  expect '[ "$(d "\"resume\" in d[\"menu\"][\"items\"] and \"reload\" in d[\"menu\"][\"items\"]")" = true ]' "/re: resume and reload" 5
  press esc '[ "$(d "d[\"menu\"]")" = null ]'
  expect '[ "$(d "d[\"menu\"]")" = null ] && [ "$(d "d[\"composer\"][\"text\"]")" = /re ]' "Esc closes the menu, the text stays" 5
  keys backspace backspace backspace; until_ '[ "$(d "d[\"composer\"][\"text\"]")" = "" ]' 3 || { cmd clear; until_ '[ "$(d "d[\"composer\"][\"text\"]")" = "" ]' 3; } # (setup)
  type_text "see @READ"
  expect '[ "$(d "d[\"menu\"][\"kind\"]")" = files ] && [ "$(d "d[\"menu\"][\"items\"][0]")" = README.md ]' "@READ lists README.md" 8
  press enter '[ "$(d "d[\"composer\"][\"text\"]")" = "see @README.md " ]'
  expect '[ "$(d "d[\"composer\"][\"text\"]")" = "see @README.md " ]' "Enter inserts @README.md" 5
fi

# --- flow: messages from outside (hc send), with the sender shown -------------------------------
if want external; then
  step "hc send from another terminal reaches the chat, tagged with the sender"
  CHAT=$(open_chat external)
  ready
  HOST_T=$(d 'd["host"]["address"]')
  hc run --bg --no-parent --name sender -- sh -c "hc send $HOST_T 'please summarise'; sleep 3" >>"$LOG" 2>&1
  expect '[ "$(d "[i[\"source\"] for i in d[\"items\"] if i[\"kind\"]==\"user\"][-1]")" = external ]' "a user item with source external" 15
  FROM=$(d "[i['from'] for i in d['items'] if i['kind']=='user'][-1]")
  note "from: $FROM" # (the attribution: extras' envelope and fix1 reports)
  expect '[ "$(phase)" = idle ] && [ "$(count_kind assistant)" -ge 1 ]' "Pi answered it" 15
  shot external-1-from 0.3
fi

# --- flow: Pi's TUI hand-off and back ---------------------------------------------------------------
if want handoff; then
  step "/tui: Pi's TUI in a dialog over the chat (no pane: the tab stays as it is), then back"
  CHAT=$(open_chat handoff)
  ready
  send_text "hello"
  expect '[ "$(phase)" = idle ] && [ "$(count_kind assistant)" -ge 1 ]' "a first answer (the session has a file now)" 15
  SESSION=$(d 'd["sessionFile"]')
  TAB=$(d 'd["place"]["tab"]'); H=$(d 'd["host"]["address"]')
  : >"$FAKE_TUI_LOG"
  send_text "/tui"
  expect '[ "$(phase)" = handoff ]' "the host handed the session off (phase handoff)" 10
  expect 'grep -q -- "--session $SESSION" "$FAKE_TUI_LOG"' "the TUI runs with --session <the chat's file>" 10
  handoff_tui
  expect 'overlay_open layout && [ -n "$(d "d[\"handoff\"][\"overlay\"]")" ]' "the TUI shows in a dialog over the chat" 10
  ! term_panes | grep -q " $TUI$" && ok "the TUI has no pane" || fail "the TUI got a pane: $(term_panes | grep " $TUI$")"
  [ "$(tab_panes "$TAB" | wc -l | tr -d " ")" = 2 ] && hidden_in "$TAB" "$H" && [ "$(d 'd["zoomed"]')" = false ] \
    && ok "the chat's tab is untouched: the chat, its hidden host, no zoom" || fail "the tab: $(tab_panes "$TAB") zoomed $(d 'd["zoomed"]')"
  shot handoff-1-tui 0.6
  hc send "$TUI" q >>"$LOG" 2>&1 || hc send --force "$TUI" q >>"$LOG" 2>&1
  expect '[ "$(d "d[\"handoff\"]")" = null ]' "quitting the TUI ends the hand-off" 15
  expect '! overlay_open layout' "the dialog closed with it" 5
  expect '[ "$(phase)" = idle ]' "the chat resumed Pi (phase idle)" 15
  [ "$(d 'd["sessionFile"]')" = "$SESSION" ] && ok "on the same session" || fail "session changed"
  step "/login runs pi --no-session in a dialog; Done ends it and Pi restarts"
  : >"$FAKE_TUI_LOG"
  cmd focus; sleep 0.3
  send_text "/login"
  expect 'grep -q -- "--no-session" "$FAKE_TUI_LOG"' "pi --no-session in a terminal" 10
  handoff_tui
  expect 'overlay_open layout' "in a dialog over the chat" 10
  ! term_panes | grep -q " $TUI$" && ok "no pane" || fail "the utility got a pane"
  shot handoff-2-login 0.6
  do_ chat.termbar:done # the dialog bar's Done (termbar.js), by its command
  expect '! hc get "$TUI" --json 2>/dev/null | grep -q "\"state\": *\"live\""' "Done ends the terminal" 10
  expect '[ "$(d "d[\"handoff\"]")" = null ] && [ "$(phase)" = idle ] && ! overlay_open layout' "back, Pi restarted, the dialog gone" 15
fi

# --- flow: /fork from a picker of the person's messages -----------------------------------------
if want fork; then
  step "/fork: a picker of the messages (newest first); the pick makes a new session up to it, the message back in the composer"
  CHAT=$(open_chat fork skills)
  ready
  users_text() { d "[i['text'] for i in d['items'] if i['kind']=='user']"; }
  send_text "first"
  expect '[ "$(phase)" = idle ] && [ "$(count_kind assistant)" = 1 ]' "answered" 15
  send_text "/skill:diagnose second"
  expect '[ "$(phase)" = idle ] && [ "$(count_kind assistant)" = 2 ]' "answered" 15
  send_text "third"
  expect '[ "$(phase)" = idle ] && [ "$(count_kind assistant)" = 3 ]' "answered" 15
  SESSION=$(d 'd["sessionFile"]')
  send_text "/fork"
  expect '[ "$(d "d[\"picker\"][\"kind\"]")" = fork ] && [ "$(d "d[\"picker\"][\"count\"]")" = 3 ]' "/fork lists the three messages" 8
  keys_or down '[ "$(d "d[\"picker\"][\"sel\"]")" = 1 ]' "key:down" "↓ to the second message (the skill)"
  shot fork-1-picker 0.3
  press enter '[ "$(d "d[\"picker\"]")" = null ]'
  expect '[ "$(d "d[\"sessionFile\"]")" != "$SESSION" ] && [ "$(users_text)" = "[\"first\"]" ]' "a new session holding the first message only" 10
  expect '[ "$(d "d[\"composer\"][\"text\"]")" = "/skill:diagnose second" ] && [ "$(d "len(d[\"composer\"][\"pills\"])")" = 1 ]' "the message back in the composer, its skill a pill" 5
  shot fork-2-forked 0.3
  keys enter; until_ '[ "$(d "d[\"composer\"][\"text\"]")" = "" ]' 3 || { by_command "Enter dropped: chat.click:send"; cmd click:send; }
  expect '[ "$(phase)" = idle ] && [ "$(count_kind assistant)" = 2 ] && [ "$(users_text)" = "[\"first\", \"second\"]" ]' "sent again on the fork" 15
  grep -q '"third"' "$SESSION" && ok "the original session still has its third message" || fail "the original session changed"
fi

# --- flow: the agents list lands on the chat; the transcript on purpose; host stopped ---------
if want agent; then
  step "agent routes land on the chat; Transcript shows the host on purpose"
  CHAT=$(open_chat agent)
  expect connected "connected" 25
  expect '[ "$(d "d[\"hostHidden\"]")" = true ]' "the host's pane is hidden" 10
  MYPANE=$(d 'd["place"]["pane"]'); HOSTPANE=$(d 'd["hostPane"]')
  do_ pane.focus --pane "$HOSTPANE" # what an agents-list click runs
  expect '[ "$(d "d[\"focusedPane\"]")" = "$MYPANE" ]' "focus on the host's pane is sent back to the chat" 5
  cmd focus; sleep 0.3
  send_text "/transcript"
  expect '[ "$(d "d[\"transcript\"]")" = peek ] && overlay_open layout' "/transcript peeks at the host's terminal over the tab (its pane is hidden)" 5
  # Herdr 0.1.14+: the open overlay has the focus (no pane focused); before, the chat's pane kept it.
  [[ "$(d 'd["focusedPane"]')" =~ ^($MYPANE|None|null)$ ]] && [ "$(d 'd["zoomed"]')" = false ] && ok "the layout didn't move for it (no zoom, no other pane focused)" || fail "focus $(d 'd["focusedPane"]') zoomed $(d 'd["zoomed"]')"
  shot agent-1-transcript 0.3
  do_ overlay.close
  expect '[ "$(d "d[\"focusedPane\"]")" = "$MYPANE" ]' "closed: the focus is back on the chat" 5
  step "the host stops: the chat says so and restarts it on the same session"
  cmd focus; sleep 0.3; send_text "remember this"
  expect '[ "$(phase)" = idle ] && [ "$(count_kind assistant)" -ge 1 ]' "an answer" 15
  BEFORE=$(d 'len(d["items"])'); SESSION=$(d 'd["sessionFile"]')
  hc kill "$(d 'd["host"]["address"]')" >>"$LOG" 2>&1
  expect '[ "$(d "d[\"connection\"][\"status\"]")" = stopped ]' "host stopped (no silent restart)" 15
  shot agent-2-stopped 0.3
  cmd click:restart
  expect connected "Restart: a new host, connected" 25
  expect '[ "$(d "d[\"hostHidden\"]")" = true ] && [ "$(d "d[\"hostNodePane\"]")" = "$(d "d[\"hostPane\"]")" ]' "the new host's pane is hidden too" 15
  expect '[ "$(phase)" = idle ] && [ "$(d "len(d[\"items\"])")" -ge "$BEFORE" ]' "the timeline came back from the session ($BEFORE items)" 15
  [ "$(d 'd["sessionFile"]')" = "$SESSION" ] && ok "same session file" || fail "session $(d 'd["sessionFile"]') != $SESSION"
fi

# --- flow: a long streamed answer; scroll up; the window closes and comes back ---------------
if want stream; then
  step "a long streamed answer: stick to the bottom, scroll up, ↓ Latest"
  CHAT=$(open_chat stream long-markdown)
  ready
  send_text "write the long answer"
  expect '[ "$(d "any(i.get(\"streaming\") for i in d[\"items\"] if i[\"kind\"]==\"assistant\")")" = true ]' "the answer streams" 10
  # Pinned: the streaming answer stays in the rows drawn, and the view's top moves down as it grows.
  # (Its top read at once: the frames probe takes a second or two, and the answer streams for a few.)
  A=$(d "[i['id'] for i in d['items'] if i['kind']=='assistant' and i.get('streaming')][0]")
  T1=$(d 'd["top"]')
  shot stream-1-streaming 0.2
  if needs_frames "the view follows the streaming answer (rows and top, while drawing)"; then
    expect '[ "$(d "\"$A\" in d[\"shown\"] and d[\"top\"] > $T1")" = true ]' "the view follows the streaming answer: drawn, its top moving down (from $T1 px)" 8
  fi
  if needs_frames "scrolling up unsticks, ↓ Latest sticks again"; then
    cmd scroll:up
    expect '[ "$(d "d[\"sticky\"]")" = false ]' "scrolling up unsticks (the ↓ Latest pill shows)" 5
    shot stream-2-scrolled-up 0.2
    cmd click:latest
    expect '[ "$(d "d[\"sticky\"]")" = true ]' "↓ Latest sticks again" 5
  fi
  step "the window closes mid-stream and comes back: it catches up"
  PID_BEFORE=$(reg "$CHAT" pid)
  restart_app
  expect connected "the reopened chat reconnects" 30
  expect '[ "$(phase)" = idle ]' "the run finished meanwhile" 30
  [ "$(reg "$CHAT" pid)" = "$PID_BEFORE" ] && ok "the same host all along (pid $PID_BEFORE)" || fail "the host changed"
  host >"$ART/stream-host.json"
  python3 - "$ART/stream-host.json" "$STATE/debug/$CHAT.json" <<'EOF' && ok "after reopening, the mod's items equal the host's" || fail "items differ after reopen"
import json, sys, time
for _ in range(20):
    h = json.load(open(sys.argv[1])); m = json.load(open(sys.argv[2]))
    hi = [(i["id"], i["kind"], len(i.get("text", "")) if i["kind"] == "assistant" else 0) for i in h["items"]]
    mi = [(i["id"], i["kind"], i.get("len", 0) if i["kind"] == "assistant" else 0) for i in m["items"]]
    if hi == mi: sys.exit(0)
    time.sleep(0.3)
sys.exit(1)
EOF
  shot stream-3-reopened 0.5
fi

# --- flow: an image, /resume, /copy, Pi crashing ------------------------------------------------
if want misc; then
  step "a dropped image goes with the prompt (and shows as a thumbnail)"
  CHAT=$(open_chat misc crash)
  ready
  python3 -c 'import base64,sys; open(sys.argv[1],"wb").write(base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="))' "$PROJ/shot.png"
  cmd "drop:$PROJ/shot.png"
  expect '[ "$(d "d[\"composer\"][\"chips\"]")" = "[\"$PROJ/shot.png\"]" ]' "the drop made an image chip" 5
  send_text "what is in this picture"
  expect '[ "$(phase)" = idle ] && [ "$(count_kind assistant)" -ge 1 ]' "answered" 15
  host >"$ART/misc-host.json"
  python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); u=[i for i in d["items"] if i["kind"]=="user"][-1]; print(u.get("images"), u.get("imagePaths")); sys.exit(0 if u.get("images")==1 else 1)' "$ART/misc-host.json" >>"$LOG" \
    && ok "the user item carries the image" || fail "no image on the user item"
  shot misc-1-image 0.3
  step "/copy and /resume"
  cmd focus; sleep 0.3
  send_text "/copy"
  expect '[ "$(d "d[\"copied\"]")" -gt 0 ]' "/copy put the last answer on the clipboard" 5
  send_text "/resume"
  expect '[ "$(d "d[\"picker\"][\"kind\"]")" = sessions ]' "/resume opens the sessions picker" 8
  shot misc-2-resume 0.3
  keys_or esc '[ "$(d "d[\"picker\"]")" = null ]' "key:escape" "Esc closes it"
  step "Pi crashes mid-run: the chat says so; Restart Pi resumes"
  cmd focus; sleep 0.3
  send_text "Run the tests"
  expect '[ "$(phase)" = exited ]' "phase exited" 15
  shot misc-3-crashed 0.3
  cmd click:restart
  expect '[ "$(phase)" = idle ]' "Restart Pi: idle again" 15
fi

# --- flow: a chat whose folder is gone (a space on a deleted worktree) ------------------------
if want folder; then
  step "folder: a chat in a folder that doesn't exist says so, and starts on Retry once it does"
  GONE="$BASE/deleted-worktree"
  CHAT="c-$(openssl rand -hex 4)"
  do_ tab.new "{\"name\":\"gone\",\"space\":\"$SPACE\",\"mod\":\"chat\",\"props\":{\"chat\":\"$CHAT\",\"cwd\":\"$GONE\"}}"
  expect '[ "$(d "d[\"connection\"][\"status\"]")" = failed ]' "the start fails" 15
  d 'd["connection"]["error"]' | grep -qF "folder $GONE doesn't exist" && ok "the error names the missing folder" || fail "error: $(d 'd["connection"]["error"]')"
  # It used to retry every ~10 s, back to "Starting Pi…" each time.
  T=$SECONDS; steady=1
  while [ $((SECONDS - T)) -lt 12 ]; do [ "$(d 'd["connection"]["status"]')" = failed ] || steady=0; sleep 0.5; done
  [ "$steady" = 1 ] && ok "it stays failed, no retry loop (12 s)" || fail "it went back to starting"
  shot folder-1-missing 0.3
  mkdir -p "$GONE"
  cmd click:restart
  expect connected "Retry, once the folder exists: connected" 25
fi

# --- flow: the branch under the composer -------------------------------------------------------
if want branch; then
  step "branch: the folder's branch at the hint line's end; it follows a switch made in another terminal"
  FIRST=$(git -C "$PROJ" branch --show-current)
  CHAT=$(open_chat branch)
  ready
  expect '[ "$(d "d[\"branch\"]")" = "$FIRST" ]' "the chat shows $FIRST" 10
  git -C "$PROJ" checkout -qb e2e/branch-chip
  expect '[ "$(d "d[\"branch\"]")" = e2e/branch-chip ]' "a switch outside the chat shows without a turn" 5
  cmd click:branch
  expect '[ "$(d "d[\"flash\"]")" = "Copied e2e/branch-chip" ]' "a click copies the name" 3
  shot branch-1-switched 3
  git -C "$PROJ" checkout -q "$FIRST"; git -C "$PROJ" branch -qD e2e/branch-chip
  expect '[ "$(d "d[\"branch\"]")" = "$FIRST" ]' "back on $FIRST" 5
fi

# --- flow: a tool-result image, an extension's draft, an hc envelope, a long history -------
if want extras; then
  step "a tool result's image shows as a thumbnail"
  CHAT=$(open_chat extras mod-extras)
  ready
  send_text "take a screenshot"
  expect '[ "$(phase)" = idle ] && [ "$(d "len([i for i in d[\"items\"] if i[\"kind\"]==\"tool\" and i[\"images\"]])")" = 1 ]' "the tool item carries a saved image" 15
  IMG=$(d "[i['images'][0] for i in d['items'] if i['kind']=='tool' and i['images']][0]")
  [[ "$IMG" == "$STATE"/images/* ]] && [ -s "$IMG" ] && ok "saved under the app home ($IMG): image() can show it" || fail "image path $IMG"
  TOOL=$(d "[i['id'] for i in d['items'] if i['kind']=='tool'][0]")
  shot extras-1-tool-image 0.4
  cmd "click:enlarge:$TOOL:0"
  expect 'overlay_open chat && [ "$(d "d[\"enlarged\"]")" = "$IMG" ]' "a click on the thumbnail enlarges it (a dialog over the window)" 5
  shot extras-1b-enlarged 0.4
  do_ overlay.close
  step "an extension's set_editor_text fills the composer"
  cmd focus; sleep 0.3
  type_text "make a draft"; BYCMD_NEXT= # (setup; not send_text: the draft refills the composer)
  keys enter; until_ '[ "$(d "d[\"composer\"][\"text\"]")" != "make a draft" ]' 3 || cmd click:send
  expect '[ "$(d "d[\"composer\"][\"text\"]")" = "drafted by an extension: please review" ]' "the draft is in the composer" 10
  expect '[ "$(host | python3 -c "import json,sys; print(json.load(sys.stdin)[\"state\"][\"editorText\"])")" = None ]' "and acknowledged (the host cleared editorText)" 10
  keys 0:cmd backspace; until_ '[ "$(d "d[\"composer\"][\"text\"]")" = "" ]' 3 || { cmd clear; until_ '[ "$(d "d[\"composer\"][\"text\"]")" = "" ]' 3; } # select all, delete (setup)
  step "an <hc from> envelope shows as the sender, without the envelope"
  hc send "$(d 'd["host"]["address"]')" '<hc from="t9 reviewer">please summarise</hc>' >>"$LOG" 2>&1
  expect '[ "$(d "[i[\"from\"] for i in d[\"items\"] if i[\"kind\"]==\"user\"][-1]")" = "t9 reviewer" ]' "from: t9 reviewer" 15
  expect '[ "$(phase)" = idle ]' "answered" 15
  shot extras-2-from-badge 0.4
  step "a long conversation: the reopened chat pages older items in"
  cmd focus; sleep 0.3
  send_text "many answers please"
  expect '[ "$(phase)" = idle ] && [ "$(count_kind assistant)" -ge 230 ]' "230 answers" 40
  TOTAL=$(d 'len(d["items"])')
  restart_app
  expect connected "reconnected after the window came back" 30
  expect '[ "$(d "d[\"hasOlder\"]")" = true ] && [ "$(d "len(d[\"items\"])")" -le 200 ]' "the snapshot holds the newest 200, with more older" 10
  if needs_frames "scrolling up pages older items in, none twice"; then
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do cmd scroll:up; sleep 0.3; done
    for _ in $(seq 1 40); do [ "$(d 'd["hasOlder"]')" = false ] && break; cmd scroll:up; sleep 0.25; done
    expect '[ "$(d "len(d[\"items\"])")" = "$TOTAL" ] && [ "$(d "d[\"hasOlder\"]")" = false ]' "scrolling up paged every older item in ($TOTAL)" 10
    python3 - "$STATE/debug/$CHAT.json" <<'EOF' && ok "no item twice, none lost" || fail "paging lost or repeated items"
import json, sys
ids = [i["id"] for i in json.load(open(sys.argv[1]))["items"]]
sys.exit(0 if len(ids) == len(set(ids)) else 1)
EOF
  fi
fi

# --- LIVE=1: one real Pi chat (anthropic/claude-haiku-4-5, temp session dir) ------------------
if want live && [ -n "${LIVE:-}" ]; then
  step "real Pi: a prompt with a bash call, through the launcher"
  launch_pick 1
  expect '[ -n "$(newest_chat)" ]' "the launcher opened a chat" 15
  CHAT=$(newest_chat)
  ready
  [ "$(d 'd["model"]')" = anthropic/claude-haiku-4-5 ] && ok "model haiku" || note "model $(d 'd["model"]')"
  shot live-1-open 0.4
  send_text "Run the bash command: echo hello from herdr-chat. Then reply with just the word done."
  expect '[ "$(phase)" = working ]' "Pi works" 20
  expect '[ "$(phase)" = idle ]' "Pi settled" 120
  host >"$ART/live-host.json"
  python3 - "$ART/live-host.json" <<'EOF' && ok "a bash card with the output, then an answer" || fail "live run"
import json, sys
d = json.load(open(sys.argv[1]))
tools = [i for i in d["items"] if i["kind"] == "tool" and i["detail"]["type"] == "bash"]
ans = [i for i in d["items"] if i["kind"] == "assistant" and i["text"].strip()]
sys.exit(0 if tools and "hello from herdr-chat" in tools[-1]["output"] and tools[-1]["status"] == "done" and ans else 1)
EOF
  BASH_ID=$(d "[i['id'] for i in d['items'] if i['kind']=='tool'][-1]")
  cmd "toggle:$BASH_ID"
  shot live-2-answered 0.6
  [ "$(d 'd["usage"]["percent"]')" != null ] && ok "context % known ($(d 'd["usage"]["percent"]'))" || note "no context %"
fi
