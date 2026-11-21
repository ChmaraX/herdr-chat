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
    cmd focus; sleep 0.3; keys 0:$PK backspace; type_slow nightly
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
  [ "$(d "d['picker']['scope'] == 0 and d['picker']['scopeLabels'][0] == 'All' and len(d['picker']['scopeLabels']) >= 3 and d['picker']['scopeLabels'][1:] == sorted(d['picker']['scopeLabels'][1:])")" = true ] \
    && ok "a tab per account, All first, the rest in order: $(d "d['picker']['scopeLabels']")" || fail "tabs: $(d "d['picker']['scopeLabels']")"
  [ "$(d "len({i.split('/')[0] for i in d['picker']['items']}) > 1")" = true ] && ok "All lists every account's models" || fail "all: $(d 'd["picker"]["items"]')"
  keys_or tab '[ "$(d "d[\"picker\"][\"scope\"]")" = 1 ]' "click:picker:scope:1" "Tab: the next account"
  [ "$(d "len(d['picker']['items']) > 0 and len({i.split('/')[0] for i in d['picker']['items']}) == 1")" = true ] \
    && ok "that tab lists only its own account's models ($(d "d['picker']['scopeLabels'][1]"))" || fail "scoped: $(d 'd["picker"]["items"]')"
  shot commands-2a-model-tabs 0.3
  cmd "click:picker:scope:0"
  expect '[ "$(d "d[\"picker\"][\"scope\"]")" = 0 ]' "back to All" 5
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
  # Six providers, two of them Claude Code logins that serve the same model id: the
  # widest strip the picker draws, and the case the tabs exist for. The tab names are
  # the agent's provider ids with the dashes out: checked by count and order, not by word.
  CHAT=$(open_chat accounts accounts)
  ready
  cmd "shortcut:model"
  expect '[ "$(d "d[\"picker\"][\"kind\"]")" = model ]' "the model picker on six accounts" 8
  [ "$(d "len(d['picker']['scopeLabels']) == 7 and d['picker']['scopeLabels'][0] == 'All'")" = true ] \
    && ok "seven tabs, All first: $(d "d['picker']['scopeLabels']")" || fail "tabs: $(d "d['picker']['scopeLabels']")"
  cmd "click:picker:scope:3"
  expect '[ "$(d "d[\"picker\"][\"items\"] == [\"claude-code-2/claude-opus-5-5\"]")" = true ]' "the second login's tab lists only its own model" 5
  shot commands-2b-six-accounts 0.3
  press enter '[ "$(d "d[\"picker\"]")" = null ]'
  expect '[ "$(d "d[\"model\"]")" = claude-code-2/claude-opus-5-5 ]' "Enter there picks the second login's Opus, not the first's" 8
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
  step "dropped images go with the prompt, appear whole in the frame that makes room for them, at their own aspect ratio (#16)"
  CHAT=$(open_chat misc crash)
  ready
  send_text "fill the pane"
  expect '[ "$(phase)" = idle ] && [ "$(count_kind assistant)" -ge 1 ]' "a long answer: the transcript overflows, pinned to the bottom" 15
  # Flat colour blocks (appears.py finds the images on screen by these colours).
  python3 - "$PROJ" <<'EOF'
import struct, sys, zlib
def png(path, w, h, a, b):
    rows = b"".join(b"\0" + b"".join(bytes(b if (x * 6 // w + y * 4 // h) % 2 else a) for x in range(w)) for y in range(h))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
    open(path, "wb").write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                           + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))
png(sys.argv[1] + "/wide.png", 600, 200, (40, 110, 220), (190, 110, 100))
png(sys.argv[1] + "/tall.png", 400, 900, (60, 200, 90), (220, 200, 60))
EOF
  cmd "drop:$PROJ/wide.png,$PROJ/tall.png"
  expect '[ "$(d "len(d[\"composer\"][\"chips\"])")" = 2 ] && [ "$(d "d[\"composer\"][\"pending\"]")" = 0 ] && cmp -s "$(d "d[\"composer\"][\"chips\"][0]")" "$PROJ/wide.png" && cmp -s "$(d "d[\"composer\"][\"chips\"][1]")" "$PROJ/tall.png"' "the drop made two image chips (the chat's copies of the files)" 5
  [ "$(d 'd["composer"].get("chipSizes") == [{"w": 600, "h": 200}, {"w": 400, "h": 900}]')" = true ] && ok "the chips carry the images' sizes, for the viewer" \
    || fail "chip sizes: $(d 'd["composer"].get("chipSizes")')"
  type_text "what is in this picture"
  # The app's own frames (herdr-app shot draws each one) from just before Enter until 2 s after.
  FR="$ART/misc-send-frames"; rm -rf "$FR"; mkdir -p "$FR"
  ( end=$(( $(date +%s) + 3 )); while [ "$(date +%s)" -lt "$end" ]; do
      "$APP" shot "$FR/$(perl -MTime::HiRes=time -e 'printf "%d", time*1000').png" >/dev/null 2>&1 || true; done ) &
  BURST=$!
  sleep 0.3
  keys enter
  until_ '[ "$(d "d[\"composer\"][\"text\"]")" = "" ]' 2 || { note "Enter dropped: chat.click:send"; cmd click:send; }
  wait "$BURST" || true
  SENT_DRAWN=; [ "$(ls "$FR" | wc -l)" -gt 1 ] && [ "$(shasum "$FR"/*.png | cut -c1-40 | sort -u | wc -l)" -gt 1 ] && SENT_DRAWN=1
  expect '[ "$(phase)" = idle ] && [ "$(count_kind assistant)" -ge 2 ]' "answered" 15
  host >"$ART/misc-host.json"
  python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); u=[i for i in d["items"] if i["kind"]=="user"][-1]; print(u.get("images"), u.get("imagePaths")); sys.exit(0 if u.get("images")==2 else 1)' "$ART/misc-host.json" >>"$LOG" \
    && ok "the user item carries the images" || fail "no images on the user item"
  if [ -n "$SENT_DRAWN" ] && [ "$(ls "$FR" | wc -l)" -gt 10 ]; then
    RC=0; "$PY" "$E2E/appears.py" "$FR" "$ART/misc-appears.json" 40,110,220 190,110,100 60,200,90 220,200,60 >>"$LOG" || RC=$?
    case $RC in
      0) ok "the new row is whole (its text drawn) in the frame its place on screen first changes: no hole, no fade-in ($(ls "$FR" | wc -l | tr -d ' ') frames: misc-appears.json)" ;;
      2) skip "the new row's first frames (too few frames: $(tail -1 "$LOG"))" ;;
      *) fail "the new row: $(tail -1 "$LOG") (misc-appears.json, misc-send-frames/)" ;;
    esac
  else
    skip "the new row's first frames (no frames: every shot was the same frame)"
  fi
  if needs_frames "the thumbnails' boxes and the new row's height (measured while drawing)"; then
    python3 - "$ART/misc-host.json" "$STATE/debug/$CHAT.json" <<'EOF' >>"$LOG" && ok "the new row is measured at one height; wide 600x200 and tall 400x900 (under the 320 pt cap) keep their aspect ratio" || fail "thumbnails: $(tail -1 "$LOG")"
import json, sys
u = [i for i in json.load(open(sys.argv[1]))["items"] if i["kind"] == "user"][-1]
d = json.load(open(sys.argv[2]))
heights = d["heightsSeen"].get(u["id"], [])
boxes = [d["thumbsSeen"].get(p, []) for p in u["imagePaths"]]
print("heights", heights, "boxes", boxes)
ratio = lambda b: b[1] / b[2]
ok = len(heights) == 1 and all(len(b) == 1 for b in boxes) \
  and abs(ratio(boxes[0][0]) / 3 - 1) < 0.03 and abs(ratio(boxes[1][0]) / (400 / 900) - 1) < 0.03 and boxes[1][0][2] == 320
sys.exit(0 if ok else 1)
EOF
  fi
  shot misc-1-image 0.3
  step "/copy and /resume"
  cmd focus; sleep 0.3
  send_text "/copy"
  expect '[ "$(d "d[\"copied\"]")" -gt 0 ]' "/copy put the last answer on the clipboard" 5
  # Another folder's session, as `pi @brief.task.md` leaves it: the brief inline, lines and all.
  OTHER="$BASE/other-project"; mkdir -p "$OTHER"; OTHER=$(cd "$OTHER" && pwd -P)
  OTHER_DIR="$PI_CODING_AGENT_DIR/sessions/--$(printf %s "$OTHER" | sed 's#^/##; s#[/:]#-#g')--"
  OTHER_SESSION="$OTHER_DIR/2026-01-01T00-00-00-000Z_e2e-other.jsonl"
  mkdir -p "$OTHER_DIR"
  python3 - "$OTHER_SESSION" "$OTHER" <<'PY'
import json, sys
brief = '<file name="/tmp/e2e/brief.task.md">\nRead the diff.\nReport back.\n</file>\nGo now: check every finding in the review against the code itself, then write the report to the file the brief names, and say when it is done'
rows = [{"type": "session", "version": 3, "id": "e2e-other", "timestamp": "2026-01-01T00:00:00.000Z", "cwd": sys.argv[2]},
        {"type": "message", "id": "u1", "parentId": None, "timestamp": "2026-01-01T00:00:01.000Z", "message": {"role": "user", "content": [{"type": "text", "text": brief}], "timestamp": 1}},
        {"type": "message", "id": "a1", "parentId": "u1", "timestamp": "2026-01-01T00:00:02.000Z", "message": {"role": "assistant", "content": [{"type": "text", "text": "Reviewed."}], "timestamp": 2}}]
open(sys.argv[1], "w").write("".join(json.dumps(r) + "\n" for r in rows))
PY
  MINE=$(d 'd["sessionFile"]')
  send_text "/resume"
  expect '[ "$(d "d[\"picker\"][\"kind\"]")" = sessions ] && [ "$(d "d[\"picker\"][\"loading\"]")" = false ]' "/resume opens the sessions picker" 8
  [ "$(d "d['picker']['scope'] == 0 and '$MINE' in d['picker']['items'] and '$OTHER_SESSION' not in d['picker']['items']")" = true ] \
    && ok "This folder: this chat's session, not the other folder's" || fail "this folder's list: $(d 'd["picker"]["items"]')"
  shot misc-2-resume 0.3
  keys_or tab '[ "$(d "d[\"picker\"][\"scope\"]")" = 1 ] && [ "$(d "d[\"picker\"][\"loading\"]")" = false ]' "click:picker:scope:1" "Tab: All folders"
  I=$(d "d['picker']['items'].index('$OTHER_SESSION') if '$OTHER_SESSION' in d['picker']['items'] else -1")
  [ "$I" -ge 0 ] && ok "All folders lists the other folder's session" || fail "all: $(d 'd["picker"]["items"]')"
  d "d['picker']['labels'][$I]" | grep -qF "@/tmp/e2e/brief.task.md Go now: check every finding" && ok "its row is one line, as typed: @/tmp/e2e/brief.task.md Go now: …" || fail "label: $(d "d['picker']['labels'][$I]")"
  [ "$(d "any(chr(10) in l for l in d['picker']['labels'])")" = false ] && ok "no row carries a line break" || fail "multi-line labels: $(d 'd["picker"]["labels"]')"
  d "d['picker']['metas'][$I]" | grep -qF 'other-project · 2 messages · ' && ok "its meta: the folder, 2 messages, when ($(d "d['picker']['metas'][$I]"))" || fail "meta: $(d "d['picker']['metas'][$I]")"
  shot misc-2b-resume-all 0.3
  cmd "click:picker:$I"
  expect '[ "$(d "d[\"picker\"]")" = null ] && [ "$(d "d[\"lastNewChat\"] is not None")" = true ]' "picking it opens a new chat tab" 8
  NEW=$(d 'd["lastNewChat"]')
  expect '[ "$(dbg "$NEW" "d[\"cwd\"]")" = "$OTHER" ] && [ "$(dbg "$NEW" "d[\"sessionFile\"]")" = "$OTHER_SESSION" ] && [ "$(dbg "$NEW" "d[\"phase\"]")" = idle ]' "the new chat runs in the other folder, on that session" 25
  [ "$(dbg "$NEW" "[(i['kind'], i.get('len')) for i in d['items']]")" = '[["user", null], ["assistant", 9]]' ] && ok "its history shows (the brief, then Reviewed.)" || fail "new chat items: $(dbg "$NEW" "[(i['kind'], i.get('len')) for i in d['items']]")"
  [ "$(d 'd["sessionFile"]')" = "$MINE" ] && ok "this chat stays on its own session" || fail "this chat switched to $(d 'd["sessionFile"]')"
  do_ tab.close --id "$(dbg "$NEW" 'd["place"]["tab"]')" --confirmed true
  do_ tab.select --id "$(d 'd["place"]["tab"]')"; sleep 0.5
  step "Pi crashes mid-run: the chat says so; Restart Pi resumes"
  cmd focus; sleep 0.3
  send_text "Run the tests"
  expect '[ "$(phase)" = exited ]' "phase exited" 15
  shot misc-3-crashed 0.3
  cmd click:restart
  expect '[ "$(phase)" = idle ]' "Restart Pi: idle again" 15
fi

# --- flow: an image in the composer shows as a thumbnail before it's sent ----------------------
if want thumb; then
  step "thumb: a dropped image (outside the app home, as a pasted one is) shows its chip at once, while the host copies it"
  CHAT=$(open_chat thumb tools)
  ready
  python3 - "$PROJ/thumb.png" <<'EOF'
# 400x240: magenta, a black bar, lime. No theme has these colours, so they show in a shot only from this picture.
import struct, sys, zlib
row = b"\0" + b"".join(bytes((255, 0, 255) if x < 190 else (0, 0, 0) if x < 210 else (0, 255, 0)) for x in range(400))
chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
open(sys.argv[1], "wb").write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 400, 240, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(row * 240)) + chunk(b"IEND", b""))
EOF
  attachments() { ls "$STATE/attachments/$CHAT" 2>/dev/null | wc -l | tr -d ' '; }
  pending() { d 'd["composer"].get("pending", 0)'; }
  HPID=$(reg "$CHAT" pid)
  H0=$(d 'd["bottomH"]')
  # SIGSTOP: a host busy copying a large file, for as long as the checks need.
  kill -STOP "$HPID"
  cmd "drop:$PROJ/thumb.png"
  until_ '[ "$(d "len(d[\"composer\"][\"chips\"])")" = 1 ]' 3 && ok "the chip is there at once, before the host has copied the file" \
    || { kill -CONT "$HPID"; fail "no chip while the host copies the file"; }
  H1=null
  if [ "$H0" != null ] && until_ '[ "$(d "d[\"bottomH\"]")" != "$H0" ]' 3; then H1=$(d 'd["bottomH"]'); fi
  shot thumb-0-copying 0.4
  kill -CONT "$HPID"
  expect '[ "$(pending)" = 0 ] && [ "$(d "d[\"composer\"][\"chipImages\"][0]")" != null ]' "the chat's copy replaced the dropped file in the chip" 5
  ATT=$(d 'd["composer"]["chips"][0]')
  REL=$(d 'd["composer"]["chipImages"][0]')
  cmp -s "$HERDR_APP_HOME/$REL" "$PROJ/thumb.png" && ok "its thumbnail draws a copy of the file under the app home ($REL)" \
    || fail "the chip draws no image: chipImages $(d 'd["composer"].get("chipImages")')"
  shot thumb-1-chip 1.2
  H2=$(d 'd["bottomH"]')
  if [ "$H1" = null ]; then skip "the composer's height (no frames)"
  else [ "$H1" = "$H2" ] && ok "the composer keeps its height from the drop until the image is drawn ($H1 px)" || fail "the composer's height moved: $H1 → $H2 px"; fi

  step "thumb: a click on the thumbnail enlarges it, and the chip stays"
  cmd "click:enlarge:chip:0"
  expect '[ "$(d "d[\"enlarged\"]")" = "$ATT" ] && overlay_open chat' "the viewer shows the chip's image" 5
  shot thumb-2-enlarged 0.8
  do_ overlay.close
  [ "$(d 'd["composer"]["chips"]')" = "[\"$ATT\"]" ] && ok "the chip is still in the composer" || fail "chips after the click: $(d 'd["composer"]["chips"]')"

  step "thumb: ✕ removes the chip and its copy, never the dropped file"
  cmd "click:chip-x:0"
  expect '[ "$(d "d[\"composer\"][\"chips\"]")" = "[]" ]' "✕ removed the chip" 5
  expect '[ ! -e "$ATT" ]' "and its copy" 5
  [ -e "$PROJ/thumb.png" ] && ok "the dropped file is untouched" || fail "the dropped file is gone"

  step "thumb: a file the host refuses says why when it's dropped, and makes no chip"
  printf 'not a png' >"$PROJ/fake.png"
  cmd "drop:$PROJ/fake.png"
  expect '[[ "$(d "d[\"flash\"]")" == *"Not a valid PNG"* ]] && [ "$(d "d[\"composer\"][\"chips\"]")" = "[]" ]' "the drop flashes the host's reason, no chip" 5

  step "thumb: drop, then Enter before the copy is made: the message carries the image"
  N0=$(attachments)
  kill -STOP "$HPID"
  cmd "type:what is in this picture"
  cmd "drop:$PROJ/thumb.png"
  cmd click:send
  kill -CONT "$HPID"
  expect '[ "$(phase)" = idle ] && [ "$(count_kind assistant)" -ge 1 ]' "answered" 15
  host >"$ART/thumb-quick-host.json"
  python3 -c 'import json,sys; u=[i for i in json.load(open(sys.argv[1]))["items"] if i["kind"]=="user"][-1]; sys.exit(0 if u.get("images")==1 else 1)' "$ART/thumb-quick-host.json" \
    && ok "the message carries the image" || fail "the message went without the image"
  expect '[ "$(d "d[\"composer\"][\"chips\"]")" = "[]" ] && [ "$(pending)" = 0 ]' "the composer stays empty once the copy is made" 5
  expect '[ "$(attachments)" = "$N0" ]' "and the copy the message didn't need is removed" 5

  step "thumb: a host killed with an image in the composer (a restart's fallback) keeps it; Restart sends it"
  cmd "drop:$PROJ/thumb.png"
  expect '[ "$(d "len(d[\"composer\"][\"chips\"])")" = 1 ] && [ "$(pending)" = 0 ]' "dropped again" 5
  ATT=$(d 'd["composer"]["chips"][0]')
  hc kill "$(d 'd["host"]["address"]')" >>"$LOG" 2>&1
  expect '[ "$(d "d[\"connection\"][\"status\"]")" = stopped ]' "the host stopped" 15
  [ -e "$ATT" ] && ok "the killed host left the chip's image" || fail "the killed host removed the chip's image $ATT"
  cmd click:restart
  expect connected "Restart: a new host, connected" 25
  expect '[ "$(phase)" = idle ]' "idle again" 15
  BEFORE=$(count_kind assistant)
  cmd focus; sleep 0.3; send_text "and this one"
  expect '[ "$(phase)" = idle ] && [ "$(count_kind assistant)" -gt "$BEFORE" ]' "answered" 15
  host >"$ART/thumb-host.json"
  python3 -c 'import json,sys; u=[i for i in json.load(open(sys.argv[1]))["items"] if i["kind"]=="user"][-1]; sys.exit(0 if u.get("images")==1 else 1)' "$ART/thumb-host.json" \
    && ok "the restarted chat sends the chip's image" || fail "no image on the message after the restart"
  [ -e "$ATT" ] && ok "its copy stays after sending (a queued edit takes it back)" || fail "the copy is gone after sending"

  step "thumb: a chat closed while its host was down: another chat's sweep removes its attachments"
  B=$(open_chat thumb-b tools)
  until_ '[ "$(dbg "$B" "d[\"connection\"][\"status\"]")" = connected ]' 25 || fail "chat B connected"
  cmd "drop:$PROJ/thumb.png"
  until_ '[ "$(dbg "$B" "len(d[\"composer\"][\"chips\"])")" = 1 ] && [ "$(dbg "$B" "d[\"composer\"][\"pending\"]")" = 0 ]' 5 || fail "chat B: an image in its composer"
  hc kill "$(dbg "$B" 'd["host"]["address"]')" >>"$LOG" 2>&1
  until_ '[ "$(dbg "$B" "d[\"connection\"][\"status\"]")" = stopped ]' 15 || fail "chat B's host stopped"
  do_ pane.close --pane "$(dbg "$B" 'd["place"]["pane"]')"
  [ -d "$STATE/attachments/$B" ] && ok "chat B's pane closed with no host to remove its attachments" || fail "chat B's attachments are already gone"
  expect '[ ! -e "$STATE/attachments/$B" ]' "chat A's sweep removed them (two sweeps 30 s apart agree)" 75
  [ -e "$ATT" ] && ok "and kept chat A's, whose pane is open" || fail "the sweep removed chat A's attachment $ATT"

  step "thumb: closing the chat removes its attachments"
  ME=$(d 'd["place"]["pane"]'); H=$(d 'd["host"]["address"]')
  do_ pane.close --pane "$ME"
  expect '! hc ls --json | grep -q "\"address\": *\"$H\""' "closing the chat ends its host" 15
  expect '[ ! -e "$STATE/attachments/$CHAT" ]' "and removes its attachments" 5
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
  expect '[ "$(d "d[\"lastCopy\"][\"text\"]")" = e2e/branch-chip ]' "the clipboard has the branch" 3
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
  keys 0:$PK backspace; until_ '[ "$(d "d[\"composer\"][\"text\"]")" = "" ]' 3 || { cmd clear; until_ '[ "$(d "d[\"composer\"][\"text\"]")" = "" ]' 3; } # select all, delete (setup)
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
