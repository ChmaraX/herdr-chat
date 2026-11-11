# The update flow, sourced by run.sh after flows-subagent.sh (it needs the layout's
# floating new-chat block, which owns the update questions: install/layout.ts).

# --- flow `update`: an install with new host code, under open chats ----------------------------
# Nothing restarts until the person answers. Restart: each chat (not a sub-agent)
# restarts its host on the same session, a working one once its turn ends. Later:
# a bar in each chat, its own Restart, and /reload.
if want update; then
  step "update: chats on older host code restart on the same session when the person says so"
  CFGF="$HERDR_APP_HOME/mods/chat/config.json"
  setcfg() { python3 - "$CFGF" "$@" <<'EOF'
import json, sys
p = sys.argv[1]; c = json.load(open(p))
for kv in sys.argv[2:]:
    k, v = kv.split("=", 1); c[k] = v
json.dump(c, open(p, "w"), indent=1)
EOF
  }
  build_of() { "$1" build | python3 -c 'import json,sys; print(json.load(sys.stdin)["build"])'; }
  # What install.sh does to a running app: new mod files (the app reloads them), config.json naming the new host.
  reload_mods() { for m in chat new-chat; do printf '\n// e2e reload %s\n' "$RANDOM" >>"$HERDR_APP_HOME/mods/$m/main.js"; done; }
  # A release with new host code: this checkout's host, one line changed (so another build).
  new_host() {
    local dir="$BASE/host-$1"
    mkdir -p "$dir"; cp -R "$REPO/bin" "$REPO/host" "$REPO/package.json" "$dir/"; ln -sfn "$REPO/node_modules" "$dir/node_modules"
    printf '\n// e2e: version %s\n' "$1" >>"$dir/host/build.ts"
    echo "$dir/bin/herdr-chat-host"
  }
  dc() { dbg "$1" "$2"; }
  show_tab() { do_ tab.select --id "$(dc "$1" 'd["place"]["tab"]')"; sleep 0.5; }

  "$NODE" "$REPO/install/layout.ts" install "$HERDR_APP_HOME" --app "$APP" >>"$LOG" 2>&1 || fail "install/layout.ts install (the floating new-chat block)"
  V1_BUILD=$(build_of "$REPO/bin/herdr-chat-host")
  setcfg build="$V1_BUILD" version=0.2.0
  sleep 1

  # A: idle with a conversation. B: working (a bash that runs until stopped). S: a sub-agent's chat.
  A=$(open_chat upd-idle); CHAT=$A; ready
  send_text "quick: hello before the update"
  expect '[ "$(phase)" = idle ]' "A: the first turn ended" 15
  A_SESSION=$(reg "$A" sessionFile); A_PID=$(reg "$A" pid); A_USERS=$(count_kind user)
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
  [ "$(dc "$A" 'd["update"]["outdated"]')" = false ] && ok "same build: nothing to update" || fail "A outdated before any install"

  step "update: install 0.3.0 (new host code): one question, and nothing restarts before the answer"
  V2_HOST=$(new_host 0.3.0); V2_BUILD=$(build_of "$V2_HOST")
  [ "$V2_BUILD" != "$V1_BUILD" ] && ok "the changed host has another build ($V2_BUILD)" || fail "same build after a change"
  setcfg host="$V2_HOST" build="$V2_BUILD" version=0.3.0
  reload_mods
  expect 'overlay_open new-chat' "the question opens (new-chat's floating block, after the reload)" 15
  expect '[ "$(dc "$A" "d[\"update\"][\"outdated\"]")" = true ] && [ "$(dc "$B" "d[\"update\"][\"outdated\"]")" = true ]' "A and B know their host is older" 10
  shot update-1-question 0.5
  sleep 3
  [ "$(reg "$A" pid)" = "$A_PID" ] && ok "unanswered: A's host still runs (no restart without the person)" || fail "A restarted before the answer"
  do_ new-chat.update:restart
  expect '! overlay_open new-chat' "Restart closes the question" 5

  step "update: an idle chat restarts now, on the same session; a working one waits; the sub-agent never"
  CHAT=$A
  expect '[ "$(reg "$A" pid)" != "$A_PID" ] && [ "$(dc "$A" "d[\"update\"][\"outdated\"]")" = false ] && connected' "A: a new host, on the new build" 30
  [ "$(reg "$A" sessionFile)" = "$A_SESSION" ] && ok "A: the same session" || fail "A's session changed: $(reg "$A" sessionFile)"
  expect '[ "$(count_kind user)" = "$A_USERS" ]' "A: the conversation is still there ($A_USERS messages)" 10
  expect '[ "$(d "d[\"flash\"]")" = "Restarted on herdr-chat 0.3.0" ]' "A: says it restarted on 0.3.0" 10
  [ "$(d 'd["byeAt"]')" = null ] && ok "A: not shown as closed by another chat" || fail "A byeAt $(d 'd["byeAt"]')"
  A_TAB=$(d 'd["place"]["tab"]'); A_HOST=$(d 'd["host"]["address"]')
  expect '[ "$(tab_panes "$A_TAB" | wc -l | tr -d " ")" = 2 ] && hidden_in "$A_TAB" "$A_HOST"' "A's tab: the chat and its new host, hidden (no pane left from the old one)" 15
  CHAT=$B
  [ "$(phase)" = working ] && [ "$(dc "$B" 'd["update"]["outdated"]')" = true ] && [ "$(dc "$B" 'd["update"]["wanted"]')" = true ] &&
    ok "B: still working on its old host, the restart waits for the turn" || fail "B: phase $(phase), update $(dc "$B" 'd["update"]')"
  show_tab "$B"; shot update-2-waiting 0.5
  cmd click:stop
  expect '[ "$(dc "$B" "d[\"update\"][\"outdated\"]")" = false ] && connected' "B: restarted once its turn stopped" 30
  [ "$(reg "$B" sessionFile)" = "$B_SESSION" ] && ok "B: the same session" || fail "B's session changed"
  [ "$(reg "$SUBCHAT" pid)" = "$SUB_PID" ] && [ "$(term_field "$SUB" 't["state"]')" = live ] && ok "the sub-agent's host is untouched (its parent's)" || fail "the sub-agent was restarted"
  A_PID=$(reg "$A" pid); sleep 3
  [ "$(reg "$A" pid)" = "$A_PID" ] && ok "no second restart (A's host stays)" || fail "A restarted again"

  step "update: 0.4.0, Later: no restart, a bar in each chat; its Restart, and /reload"
  V3_HOST=$(new_host 0.4.0); V3_BUILD=$(build_of "$V3_HOST")
  setcfg host="$V3_HOST" build="$V3_BUILD" version=0.4.0
  reload_mods
  expect 'overlay_open new-chat' "the question for 0.4.0" 15
  do_ new-chat.update:later
  expect '! overlay_open new-chat' "Later closes it" 5
  A_PID=$(reg "$A" pid); B_PID=$(reg "$B" pid)
  sleep 3
  [ "$(reg "$A" pid)" = "$A_PID" ] && [ "$(reg "$B" pid)" = "$B_PID" ] && ok "Later: nothing restarts" || fail "a chat restarted after Later"
  [ "$(dc "$A" 'd["update"]["outdated"]')" = true ] && [ "$(dc "$A" 'd["update"]["wanted"]')" = false ] && ok "A: outdated, its bar offers the restart" || fail "A update $(dc "$A" 'd["update"]')"
  reload_mods; sleep 6
  ! overlay_open new-chat && ok "Later holds: no question again for 0.4.0" || fail "asked again after Later"
  CHAT=$A; show_tab "$A"; shot update-3-bar 0.3
  cmd click:update:restart
  expect '[ "$(reg "$A" pid)" != "$A_PID" ] && [ "$(dc "$A" "d[\"update\"][\"outdated\"]")" = false ]' "A: the bar's Restart" 30
  CHAT=$B; show_tab "$B"; ready
  send_text "/reload"
  expect '[ "$(reg "$B" pid)" != "$B_PID" ] && [ "$(dc "$B" "d[\"update\"][\"outdated\"]")" = false ]' "B: /reload restarts the outdated host" 30
  [ "$(reg "$B" sessionFile)" = "$B_SESSION" ] && ok "B: still the same session" || fail "B's session changed"
  hc kill "$SUB" >>"$LOG" 2>&1 || true
  # Its chats go (their hosts end with their tabs): the next flow installs other builds.
  for c in "$A" "$B"; do do_ tab.close --id "$(dc "$c" 'd["place"]["tab"]')"; done
  until_ '[ -z "$(reg "$A" pid)" ] && [ -z "$(reg "$B" pid)" ]' 15 || note "a chat's host outlived its tab"
fi

# --- flow `update-release`: a newer release, asked once, installed from the question -------------
# The feed is a local file server (settings.json "updates.feed"); the update command
# (config.json "update", the one-liner in a release) is a stand-in that does what
# the install does: a host with new code in config.json, new mod files.
if want update-release; then
  step "update-release: a newer release is offered once; Update installs it, then the restart question"
  CFGF="$HERDR_APP_HOME/mods/chat/config.json"
  setcfg() { python3 - "$CFGF" "$@" <<'PY'
import json, sys
p = sys.argv[1]; c = json.load(open(p))
for kv in sys.argv[2:]:
    k, v = kv.split("=", 1); c[k] = v
json.dump(c, open(p, "w"), indent=1)
PY
  }
  build_of() { "$1" build | python3 -c 'import json,sys; print(json.load(sys.stdin)["build"])'; }
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
p, host, build, v = sys.argv[1:]; c = json.load(open(p)); c.update(host=host, build=build, version=v); json.dump(c, open(p, "w"), indent=1)
PY
for m in chat new-chat; do printf '\n// e2e reload %s\n' "\$v" >>"$HERDR_APP_HOME/mods/\$m/main.js"; done
echo "installed \$v"
SH
  chmod +x "$UPD"
  setcfg host="$REPO/bin/herdr-chat-host" build="$(build_of "$REPO/bin/herdr-chat-host")" version=0.8.0 channel=release update="FAKE_UPDATE_FAIL=1 $UPD"
  CHAT=$(open_chat upd-release); ready
  send_text "quick: hello"
  expect '[ "$(phase)" = idle ]' "the chat answered" 15
  OLD_PID=$(reg "$CHAT" pid)
  do_ new-chat.update-check
  expect 'overlay_open new-chat' "0.9.0 is offered (the feed's latest, newer than 0.8.0)" 10
  shot update-release-1-offer 0.5
  do_ new-chat.update:update
  sleep 4
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
  expect '! overlay_open new-chat' "the Updating… question closes once the install is in" 15
  expect 'overlay_open new-chat' "then the question: restart the chat on 0.9.0" 20
  shot update-release-3-restart 0.5
  do_ new-chat.update:restart
  expect '[ "$(reg "$CHAT" pid)" != "$OLD_PID" ] && [ "$(dbg "$CHAT" "d[\"update\"][\"outdated\"]")" = false ]' "the chat restarted on 0.9.0" 30
  expect '[ "$(d "d[\"flash\"]")" = "Restarted on herdr-chat 0.9.0" ]' "it says so" 10
  kill "$FEED_PID" 2>/dev/null || true
fi
