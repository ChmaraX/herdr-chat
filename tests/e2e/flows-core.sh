# The core-restart flow, sourced last by run.sh (it restarts the private core).

# --- flow `core`: herdr-core restarts (an update, a reboot) under an open chat ------------------
# The core brings a kept terminal back as a login shell with its labels: the
# chat must not take that shell for its host and wait on it ("Starting Pi…").
if want core; then
  step "core: herdr-core restarts under an open chat; it comes back on a new host, same session"
  CHAT=$(open_chat core)
  ready
  send_text "hello before the restart"
  expect '[ "$(phase)" = idle ]' "the first turn ended" 15
  OLD=$(d 'd["host"]["address"]')
  SESSION=$(reg "$CHAT" sessionFile)
  [ -n "$OLD" ] && [ -n "$SESSION" ] && ok "the host ($OLD) and its session" || fail "no host or session"
  hc server stop >>"$LOG" 2>&1
  hc server start >>"$LOG" 2>&1
  restart_app
  argv0() { hc get "$1" --json 2>/dev/null | python3 -c 'import json,sys; t=json.load(sys.stdin); print(t["state"], t["argv"][0])'; }
  # Setup: what the core restores in the host's place.
  until_ '[[ "$(argv0 "$OLD")" == "live "*sh ]]' 15 || note "the core didn't restore $OLD as a shell ($(argv0 "$OLD"))"
  expect connected "the chat reconnects" 40
  expect '[ "$(d "d[\"host\"][\"address\"]")" != "$OLD" ]' "on a new host, not the restored shell" 10
  [ "$(reg "$CHAT" sessionFile)" = "$SESSION" ] && ok "the same session" || fail "the session changed"
  send_text "hello after the restart"
  expect '[ "$(phase)" = idle ]' "it answers" 15
  expect '[[ "$(argv0 "$OLD")" != live* ]]' "the restored shell is ended (two orphan sweeps, 30 s apart)" 75
  shot core-1-after-restart 0.3
fi
