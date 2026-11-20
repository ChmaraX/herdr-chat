# One host process per chat, sourced by run.sh.
#
# --- flow `one-host`: restarts never leave a chat two hosts; a second host from before is ended ----
# The live bug (0.5.0): an install reloads the mod, the person says Restart, and the restart's two
# paths each start a host, in the same millisecond. Both served the chat and opened its session.
# Checks: every host terminal a chat ever had (`hc ls --all --label`), how many served it (their
# "serve" log lines) and how many refused, and that the registry names the one that runs.
if want one-host; then
  step "one-host: restarts under mod reloads, the way an install does them"
  OH_ART="$ART/one-host.json"
  # Every host terminal of chat $1 the core knows (live or finished): address, state.
  hosts_of() { hc ls --all --json --label "herdr-chat.chat=$1" | python3 -c 'import json,sys; [print(t["address"], t["state"]) for t in json.load(sys.stdin)["terminals"]]'; }
  live_hosts() { hosts_of "$1" | awk '$2 == "live"' | wc -l | tr -d ' '; }
  served() { grep -c " serve chat=$1 " "$STATE/logs/$1.log" || true; }
  refused() { grep -c " refused: chat $1 already has a host" "$STATE/logs/$1.log" || true; }
  reload_chat_mod() { printf '\n// e2e one-host reload %s\n' "$RANDOM" >>"$HERDR_APP_HOME/mods/chat/main.js"; }
  # An install: config.json names another build, installed now (so the running host is older).
  CFGF="$HERDR_APP_HOME/mods/chat/config.json"
  install_build() { python3 - "$CFGF" "$1" <<'PY'
import json, sys, time
p = sys.argv[1]; c = json.load(open(p)); c["build"] = sys.argv[2]; c["installedAt"] = int(time.time() * 1000); json.dump(c, open(p, "w"), indent=1)
PY
  }
  OH=$(open_chat one-host); CHAT=$OH; ready
  send_text "quick: before the restarts"
  expect '[ "$(phase)" = idle ]' "the first turn ended" 15
  SESSION=$(reg "$OH" sessionFile)
  ROUNDS=6
  for i in $(seq 1 $ROUNDS); do
    OLD_PID=$(reg "$OH" pid)
    # What an install does: another build, new mod files (a reload); then the chat's Restart (its update bar).
    install_build "e2e-one-host-$i"
    reload_chat_mod
    expect '[ "$(d "d[\"update\"][\"canRestart\"]")" = true ] && connected' "restart $i: the reloaded chat offers its restart" 20
    cmd click:update:restart
    expect '[ -n "$(reg "$OH" pid)" ] && [ "$(reg "$OH" pid)" != "$OLD_PID" ] && connected' "restart $i: a new host serves the chat" 30
    sleep 3 # a second start, if any, has registered or refused by now
    [ "$(live_hosts "$OH")" = 1 ] && ok "restart $i: one live host terminal" || fail "restart $i: live hosts: $(hosts_of "$OH" | tr '\n' ' ')"
    [ "$(d 'd["host"]["address"]')" = "$(reg "$OH" terminal)" ] && ok "restart $i: the chat's host is the registry's" ||
      fail "restart $i: the dump's host $(d 'd["host"]') vs the registry's $(reg "$OH" terminal)"
  done
  [ "$(reg "$OH" sessionFile)" = "$SESSION" ] && ok "the same session through the restarts" || fail "the session changed"
  USERS=$(count_kind user)
  send_text "quick: after the restarts"
  expect '[ "$(phase)" = idle ] && [ "$(count_kind user)" -gt "$USERS" ]' "the chat still answers" 15
  N_SERVED=$(served "$OH"); N_REFUSED=$(refused "$OH")
  [ "$N_SERVED" = $((ROUNDS + 1)) ] && ok "one host served each start: $N_SERVED serve lines for $ROUNDS restarts" ||
    fail "$N_SERVED hosts served $ROUNDS restarts (want $((ROUNDS + 1))); $N_REFUSED refused"
  # A restart starts one host: its two paths (the old host's bye, then its terminal's end) never start a second one,
  # which the host would refuse (a wasted process). (Two windows on one core still can: the host refuses it.)
  [ "$N_REFUSED" = 0 ] && ok "no restart started a second host (none refused)" || fail "$N_REFUSED second hosts started and refused"

  step "one-host: a second host of the chat, as one from before the fix left it, is ended"
  # A host that makes no claim (host/claim.ts): 0.5.0's own, started the way its mod started one.
  OLD_TAG=v0.5.0
  git -C "$REPO" rev-parse -q --verify "refs/tags/$OLD_TAG" >/dev/null || fail "no $OLD_TAG tag in $REPO: the duplicate needs it"
  OLDHOST="$BASE/host-$OLD_TAG"; mkdir -p "$OLDHOST"
  git -C "$REPO" archive "$OLD_TAG" bin host package.json | tar -x -C "$OLDHOST"
  ln -sfn "$REPO/node_modules" "$OLDHOST/node_modules"
  REG_TERM=$(reg "$OH" terminal)
  DUP=$(hc run --bg --json --keep --no-parent --cwd "$PROJ" --label "herdr-chat.chat=$OH" --label herdr-chat.role=host -- \
    /usr/bin/env HERDR_CHAT_NODE="$NODE" "$OLDHOST/bin/herdr-chat-host" serve --chat "$OH" --cwd "$PROJ" --state-dir "$STATE" --app-home "$HERDR_APP_HOME" --provider pi \
    --pi "$REPO/tests/fake-pi/fake-pi.mjs" 2>>"$LOG" | python3 -c 'import json,sys; print(json.load(sys.stdin)["address"])') || fail "start the duplicate"
  # It overwrites the registry (last writer wins, as 0.5.0's did): the registry names it now.
  until_ '[ "$(reg "$OH" terminal)" = "$DUP" ]' 10 || note "the duplicate didn't write the registry"
  [ "$(live_hosts "$OH")" = 2 ] && ok "setup: two live hosts of one chat ($REG_TERM, $DUP)" || fail "setup: $(hosts_of "$OH" | tr '\n' ' ')"
  # The registry names the duplicate; the original is the second host now. The sweep ends whichever
  # isn't the registry's (two sweeps 30 s apart), and the chat goes on with the one left.
  expect '[ "$(live_hosts "$OH")" = 1 ]' "the sweep ends the host the registry doesn't name" 75
  LEFT=$(hosts_of "$OH" | awk '$2 == "live" {print $1}')
  [ "$LEFT" = "$(reg "$OH" terminal)" ] && ok "the one left is the registry's ($LEFT)" || fail "left $LEFT, registry $(reg "$OH" terminal)"
  expect connected "the chat is connected to it" 20
  python3 - "$OH_ART" "$OH" "$STATE" "$ROUNDS" "$N_SERVED" "$N_REFUSED" "$LEFT" "$(hosts_of "$OH" | tr '\n' ';')" <<'PY'
import json, sys
out, chat, state, rounds, served, refused, left, hosts = sys.argv[1:]
log = [l.rstrip("\n") for l in open(f"{state}/logs/{chat}.log") if " serve " in l or "refused" in l or "shutting" in l or "took over" in l]
json.dump({"chat": chat, "restarts": int(rounds), "served": int(served), "refused": int(refused), "left": left,
           "hosts": [h for h in hosts.split(";") if h], "log": log}, open(out, "w"), indent=1)
PY
  note "artifact: $OH_ART"
  do_ tab.close --id "$(d 'd["place"]["tab"]')"
fi
