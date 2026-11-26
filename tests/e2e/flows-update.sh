# The update flow, sourced by run.sh after flows-subagent.sh (it needs the layout's
# floating new-chat block, which owns the update questions: install/layout.ts).

# Shared by both flows: config.json as install writes it, a host's build.
CFGF="$HERDR_APP_HOME/mods/chat/config.json"
# setcfg k=v…: set keys in config.json; `installed` also stamps installedAt (an install happened now).
setcfg() { python3 - "$CFGF" "$@" <<'PY'
import json, sys, time
p = sys.argv[1]; c = json.load(open(p))
for kv in sys.argv[2:]:
    if kv == "installed": c["installedAt"] = int(time.time() * 1000); continue
    k, v = kv.split("=", 1); c[k] = v
json.dump(c, open(p, "w"), indent=1)
PY
}
build_of() { "$1" build | python3 -c 'import json,sys; print(json.load(sys.stdin)["build"])'; }

# --- flow `update`: an install with new host code, under open chats ----------------------------
# Nothing restarts until the person answers. Restart: each chat (not a sub-agent)
# restarts its host on the same session, a working one once its turn ends. Later:
# a bar in each chat, its own Restart, and /reload.
if want update; then
  step "update: chats on older host code restart on the same session when the person says so"
  # What install.sh does to a running app: new mod files (the app reloads them), config.json naming the new host.
  reload_mods() { for m in chat new-chat; do printf '\n// e2e reload %s\n' "$RANDOM" >>"$HERDR_APP_HOME/mods/$m/main.js"; done; }
  # A release with new host code: this checkout's host, one line changed (so another build).
  new_host() {
    local dir="$BASE/host-$1"
    mkdir -p "$dir"; cp -R "$REPO/bin" "$REPO/host" "$REPO/package.json" "$dir/"; ln -sfn "$REPO/node_modules" "$dir/node_modules"
    printf '\n// e2e: version %s\n' "$1" >>"$dir/host/build.ts"
    echo "$dir/bin/herdr-chat-host"
  }
  show_tab() { do_ tab.select --id "$(dbg "$1" 'd["place"]["tab"]')"; sleep 0.5; }

  "$NODE" "$REPO/install/layout.ts" install "$HERDR_APP_HOME" --app "$APP" >>"$LOG" 2>&1 || fail "install/layout.ts install (the floating new-chat block)"
  V1_BUILD=$(build_of "$REPO/bin/herdr-chat-host")
  setcfg build="$V1_BUILD" version=0.2.0 installed
  sleep 1

  # A: idle with a conversation. B: working (a bash that runs until stopped). S: a sub-agent's chat.
  # A's Pi takes 3 s to read its history (slow-history.json), as a long session's does.
  A=$(open_chat upd-idle slow-history); CHAT=$A; ready
  send_text "quick: hello before the update"
  expect '[ "$(phase)" = idle ]' "A: the first turn ended" 15
  A_SESSION=$(reg "$A" sessionFile); A_PID=$(reg "$A" pid); A_USERS=$(count_kind user)
  # The person pinned A in the agents list: the pin is its host terminal's.
  A_OLD_HOST=$(reg "$A" terminal)
  do_ terminal.pin --terminal "$A_OLD_HOST" --pinned true
  expect '[ "$(d "d[\"hostAgent\"][\"pinned\"]")" = true ]' "A: pinned in the agents list" 10
  B=$(open_chat upd-busy abort); CHAT=$B; ready
  B_SESSION=$(reg "$B" sessionFile)
  RUN=$(hc run --bg --json --parent "$SHELL_T" --name upd-sub --cwd "$PROJ" -- env FAKE_PI_SCENARIO="$SCEN/abort.json" "$REPO/bin/herdr-chat-subagent" --provider pi 2>>"$LOG") || fail "hc run the sub-agent"
  SUB=$(echo "$RUN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["address"])')
  until_ '[ -n "$(term_field "$SUB" "t[\"labels\"].get(\"herdr-chat.chat\")")" ]' 10 || fail "the sub-agent labeled itself"
  SUBCHAT=$(term_field "$SUB" 't["labels"]["herdr-chat.chat"]')
  until_ '[ -n "$(reg "$SUBCHAT" port)" ]' 10 || fail "the sub-agent's host registered"
  SUB_PID=$(reg "$SUBCHAT" pid)
  [ "$(reg "$A" build)" = "$V1_BUILD" ] && ok "the registry records the host's build" || fail "registry build $(reg "$A" build), want $V1_BUILD"
  CHAT=$B; show_tab "$B"
  send_text "build it"
  expect '[ "$(phase)" = working ]' "B: working (a long bash)" 15
  [ "$(dbg "$A" 'd["update"]["outdated"]')" = false ] && ok "same build: nothing to update" || fail "A outdated before any install"

  step "update: install 0.3.0 (new host code): one question, and nothing restarts before the answer"
  V2_HOST=$(new_host 0.3.0); V2_BUILD=$(build_of "$V2_HOST")
  [ "$V2_BUILD" != "$V1_BUILD" ] && ok "the changed host has another build ($V2_BUILD)" || fail "same build after a change"
  setcfg host="$V2_HOST" build="$V2_BUILD" version=0.3.0 installed
  reload_mods
  expect 'overlay_open new-chat' "the question opens (new-chat's floating block, after the reload)" 15
  expect '[ "$(dbg "$A" "d[\"update\"][\"outdated\"]")" = true ] && [ "$(dbg "$B" "d[\"update\"][\"outdated\"]")" = true ]' "A and B know their host is older" 10
  shot update-1-question 0.5
  # The person works in a terminal; the install reloads the mods again, so the question is asked again
  # (about 3 s after the reload) while the terminal has the keys. Then they type and press Enter.
  do_ pane.focus --terminal "$SHELL_T"; sleep 0.5
  reload_mods; sleep 5
  [ "$(overlay_count new-chat)" = 1 ] && ok "asked again by a reload: still one question" || fail "the question stacked after a reload ($(overlay_count new-chat))"
  keys "text:echo typed-in-terminal" enter
  sleep 3
  shot update-1b-typed-in-terminal 0.3
  screen "$SHELL_T" | grep -q '^typed-in-terminal' && ok "the keys went to the terminal, not the question" || fail "the terminal didn't get the typed line"
  overlay_open new-chat && [ "$(reg "$A" pid)" = "$A_PID" ] && ok "unanswered: the question is open and A's host still runs" || fail "the question was answered before the person did (open: $(overlay_count new-chat), A pid $(reg "$A" pid))"
  # Every debug dump of A from the answer on, until its new host has the history: what the person
  # saw of the conversation during the restart (the artifact: update-restart-frames.tsv).
  FRAMES="$ART/update-restart-frames.tsv"
  printf 'ms\twrites\tconnection\tphase\theld\tusers\n' >"$FRAMES"
  ( last=; end=$((SECONDS + 40)); while [ $SECONDS -lt $end ]; do
      f=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print("\t".join(str(x) for x in [d["at"], d["writes"], d["connection"]["status"], d["phase"], d.get("held"), len([i for i in d["items"] if i["kind"] == "user"])]))' "$STATE/debug/$A.json" 2>/dev/null) || continue
      [ "$f" = "$last" ] || { echo "$f" >>"$FRAMES"; last=$f; }
      sleep 0.05
    done ) &
  FRAMES_PID=$!
  do_ new-chat.update:restart
  expect '! overlay_open new-chat' "Restart closes the question" 5

  step "update: an idle chat restarts now, on the same session; a working one waits; the sub-agent never"
  CHAT=$A
  expect '[ "$(reg "$A" pid)" != "$A_PID" ] && [ "$(d "d[\"held\"]")" = true ]' "A: the new host is reading the history; the chat keeps showing the conversation" 30
  [ "$(count_kind user)" = "$A_USERS" ] && ok "A: all $A_USERS messages on screen while the history loads" || fail "A: $(count_kind user) messages while the history loads, want $A_USERS"
  show_tab "$A"; shot update-2a-history-loading 0.2
  expect '[ "$(reg "$A" pid)" != "$A_PID" ] && [ "$(dbg "$A" "d[\"update\"][\"outdated\"]")" = false ] && connected' "A: a new host, on the new build" 30
  [ "$(reg "$A" sessionFile)" = "$A_SESSION" ] && ok "A: the same session" || fail "A's session changed: $(reg "$A" sessionFile)"
  expect '[ "$(count_kind user)" = "$A_USERS" ] && [ "$(d "d[\"held\"]")" = false ]' "A: the conversation is still there ($A_USERS messages), now the new host's" 10
  kill "$FRAMES_PID" 2>/dev/null || true; wait "$FRAMES_PID" 2>/dev/null || true
  BLANK=$(awk -F'\t' -v n="$A_USERS" 'NR > 1 && $6 != n' "$FRAMES" | wc -l | tr -d ' ')
  [ "$BLANK" = 0 ] && [ "$(wc -l <"$FRAMES" | tr -d ' ')" -gt 3 ] && ok "A: every frame of the restart showed all $A_USERS messages ($(($(wc -l <"$FRAMES") - 1)) frames, update-restart-frames.tsv)" ||
    fail "A: $BLANK frames of the restart showed fewer messages (update-restart-frames.tsv)"
  A_NEW_HOST=$(reg "$A" terminal)
  [ "$A_NEW_HOST" != "$A_OLD_HOST" ] && ok "A: a new host terminal ($A_NEW_HOST)" || fail "A: the same host terminal after a restart"
  expect '[ "$(d "d[\"hostAgent\"][\"pinned\"]")" = true ]' "A: still pinned (the new host has the old one's pin)" 10
  expect '[ "$(d "d[\"flash\"]")" = "Restarted on herdr-chat 0.3.0" ]' "A: says it restarted on 0.3.0" 10
  [ "$(d 'd["byeAt"]')" = null ] && ok "A: not shown as closed by another chat" || fail "A byeAt $(d 'd["byeAt"]')"
  A_TAB=$(d 'd["place"]["tab"]'); A_HOST=$(d 'd["host"]["address"]')
  expect '[ "$(tab_panes "$A_TAB" | wc -l | tr -d " ")" = 2 ] && hidden_in "$A_TAB" "$A_HOST"' "A's tab: the chat and its new host, hidden (no pane left from the old one)" 15
  CHAT=$B
  [ "$(phase)" = working ] && [ "$(dbg "$B" 'd["update"]["outdated"]')" = true ] && [ "$(dbg "$B" 'd["update"]["wanted"]')" = true ] &&
    ok "B: still working on its old host, the restart waits for the turn" || fail "B: phase $(phase), update $(dbg "$B" 'd["update"]')"
  show_tab "$B"; shot update-2-waiting 0.5
  cmd click:stop
  expect '[ "$(dbg "$B" "d[\"update\"][\"outdated\"]")" = false ] && connected' "B: restarted once its turn stopped" 30
  [ "$(reg "$B" sessionFile)" = "$B_SESSION" ] && ok "B: the same session" || fail "B's session changed"
  [ "$(reg "$SUBCHAT" pid)" = "$SUB_PID" ] && [ "$(term_field "$SUB" 't["state"]')" = live ] && ok "the sub-agent's host is untouched (its parent's)" || fail "the sub-agent was restarted"
  A_PID=$(reg "$A" pid); sleep 3
  [ "$(reg "$A" pid)" = "$A_PID" ] && ok "no second restart (A's host stays)" || fail "A restarted again"

  step "update: 0.4.0, Later: no restart, a bar in each chat; its Restart, and /reload"
  V3_HOST=$(new_host 0.4.0); V3_BUILD=$(build_of "$V3_HOST")
  setcfg host="$V3_HOST" build="$V3_BUILD" version=0.4.0 installed
  reload_mods
  expect 'overlay_open new-chat' "the question for 0.4.0" 15
  do_ new-chat.update:later
  expect '! overlay_open new-chat' "Later closes it" 5
  A_PID=$(reg "$A" pid); B_PID=$(reg "$B" pid)
  sleep 3
  [ "$(reg "$A" pid)" = "$A_PID" ] && [ "$(reg "$B" pid)" = "$B_PID" ] && ok "Later: nothing restarts" || fail "a chat restarted after Later"
  [ "$(dbg "$A" 'd["update"]["outdated"]')" = true ] && [ "$(dbg "$A" 'd["update"]["wanted"]')" = false ] && ok "A: outdated, its bar offers the restart" || fail "A update $(dbg "$A" 'd["update"]')"
  reload_mods; sleep 6
  ! overlay_open new-chat && ok "Later holds: no question again for 0.4.0" || fail "asked again after Later"
  CHAT=$A; show_tab "$A"; shot update-3-bar 0.3
  cmd click:update:restart
  expect '[ "$(reg "$A" pid)" != "$A_PID" ] && [ "$(dbg "$A" "d[\"update\"][\"outdated\"]")" = false ]' "A: the bar's Restart" 30
  CHAT=$B; show_tab "$B"; ready
  send_text "/reload"
  expect '[ "$(reg "$B" pid)" != "$B_PID" ] && [ "$(dbg "$B" "d[\"update\"][\"outdated\"]")" = false ]' "B: /reload restarts the outdated host" 30
  [ "$(reg "$B" sessionFile)" = "$B_SESSION" ] && ok "B: still the same session" || fail "B's session changed"
  hc kill "$SUB" >>"$LOG" 2>&1 || true
  # Its chats go (their hosts end with their tabs): the next flow installs other builds.
  for c in "$A" "$B"; do do_ tab.close --id "$(dbg "$c" 'd["place"]["tab"]')"; done
  until_ '[ -z "$(reg "$A" pid)" ] && [ -z "$(reg "$B" pid)" ]' 15 || note "a chat's host outlived its tab"
fi

# --- flow `update-release`: a newer release, asked once, installed from the question -------------
# The feed is a local file server (settings.json "updates.feed"); the update command
# (config.json "update", the one-liner in a release) is a stand-in that does what
# the install does: a host with new code in config.json, new mod files.
if want update-release; then
  step "update-release: a newer release is offered once; Update installs it, then the restart question"
  "$NODE" "$REPO/install/layout.ts" install "$HERDR_APP_HOME" --app "$APP" >>"$LOG" 2>&1 || fail "install/layout.ts install"
  FEED="$BASE/feed"; mkdir -p "$FEED"
  printf '{"tag_name": "v0.9.0", "html_url": "https://github.com/ChmaraX/herdr-chat/releases/tag/v0.9.0"}' >"$FEED/latest.json"
  PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
  (cd "$FEED" && exec python3 -m http.server "$PORT" --bind 127.0.0.1) >>"$LOG" 2>&1 &
  FEED_PID=$!
  python3 - "$STATE/settings.json" "http://127.0.0.1:$PORT/latest.json" <<'PY'
import json, sys
p = sys.argv[1]; s = json.load(open(p)); s["updates"] = {"feed": sys.argv[2]}; json.dump(s, open(p, "w"), indent=1)
PY
  # The stand-in install: what install.sh does to a running app, for --version <v>.
  UPD="$BASE/fake-update.sh"
  cat >"$UPD" <<SH
#!/bin/sh
set -e
v=\$2
[ -z "\${FAKE_UPDATE_FAIL:-}" ] || { echo "download failed"; exit 7; }
echo "installing \$v"; sleep 1
d="$BASE/release-\$v"; mkdir -p "\$d"; cp -R "$REPO/bin" "$REPO/host" "$REPO/package.json" "\$d/"; ln -sfn "$REPO/node_modules" "\$d/node_modules"
printf '\n// e2e release %s\n' "\$v" >>"\$d/host/build.ts"
b=\$("\$d/bin/herdr-chat-host" build | python3 -c 'import json,sys; print(json.load(sys.stdin)["build"])')
python3 - "$CFGF" "\$d/bin/herdr-chat-host" "\$b" "\$v" <<'PY'
import json, sys
import time
p, host, build, v = sys.argv[1:]; c = json.load(open(p)); c.update(host=host, build=build, version=v, installedAt=int(time.time() * 1000)); json.dump(c, open(p, "w"), indent=1)
PY
for m in chat new-chat; do printf '\n// e2e reload %s\n' "\$v" >>"$HERDR_APP_HOME/mods/\$m/main.js"; done
echo "installed \$v"
SH
  chmod +x "$UPD"
  setcfg host="$REPO/bin/herdr-chat-host" build="$(build_of "$REPO/bin/herdr-chat-host")" version=0.8.0 channel=release update="FAKE_UPDATE_FAIL=1 $UPD" installed
  CHAT=$(open_chat upd-release); ready
  send_text "quick: hello"
  expect '[ "$(phase)" = idle ]' "the chat answered" 15
  OLD_PID=$(reg "$CHAT" pid)
  do_ new-chat.update-check
  expect 'overlay_open new-chat' "0.9.0 is offered (the feed's latest, newer than 0.8.0)" 10
  shot update-release-1-offer 0.5
  do_ new-chat.update:update
  sleep 7 # the floating block sees the end (every 3 s), the dialog follows (every 1 s)
  overlay_open new-chat && ok "a failed update keeps the question open (it says so, Show output)" || fail "the question closed on a failed update"
  shot update-release-2-failed 0.3
  do_ new-chat.update:later
  expect '! overlay_open new-chat' "Close" 5
  [ "$(reg "$CHAT" pid)" = "$OLD_PID" ] && ok "a failed update changes nothing" || fail "the chat restarted after a failed update"
  # Another install or an app start reloads new-chat: its lookup waits for the day to pass.
  for m in chat new-chat; do printf '\n// e2e reload\n' >>"$HERDR_APP_HOME/mods/$m/main.js"; done
  sleep 6
  ! overlay_open new-chat && ok "once a day: a reload doesn't ask again" || fail "asked again after a reload"

  step "update-release: Update, then the restart question; the chat restarts on 0.9.0"
  setcfg update="$UPD"
  do_ new-chat.update-check # the person's own check: any time
  expect 'overlay_open new-chat' "0.9.0 offered again on a check the person asked for" 10
  do_ new-chat.update:update
  expect '[ "$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))[\"version\"])" "$CFGF")" = 0.9.0 ]' "the update ran (config.json: 0.9.0)" 20
  # The Updating… dialog closes once the update terminal has ended; the restart question opens 1.5 s later.
  sleep 8
  expect 'overlay_open new-chat' "then the question: restart the chat on 0.9.0" 15
  shot update-release-3-restart 0.5
  do_ new-chat.update:restart
  expect '[ "$(reg "$CHAT" pid)" != "$OLD_PID" ] && [ "$(dbg "$CHAT" "d[\"update\"][\"outdated\"]")" = false ]' "the chat restarted on 0.9.0" 30
  expect '[ "$(d "d[\"flash\"]")" = "Restarted on herdr-chat 0.9.0" ]' "it says so" 10
  kill "$FEED_PID" 2>/dev/null || true
fi
