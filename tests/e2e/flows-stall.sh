if want stall; then
  step "stall: a chat streams while another mod keeps the app's JS thread busy"
  STALL_LOG="$ART/stall.txt"; : >"$STALL_LOG"
  mkdir -p "$HERDR_APP_HOME/mods/staller"; cp "$E2E/stall/main.js" "$E2E/stall/mod.json" "$HERDR_APP_HOME/mods/staller/"
  sleep 2
  STALLER=$("$APP" do tab.new "{\"name\":\"staller\",\"space\":\"$SPACE\",\"mod\":\"staller\",\"props\":{}}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["tab"])') ||
    fail "tab.new staller"
  do_ tab.select --id "$STALLER"
  STALLS=0
  stall_for() {
    STALLS=$((STALLS + 1))
    echo "$1" >"$HERDR_APP_HOME/stall-$STALLS"
    until_ '[ -f "$HERDR_APP_HOME/stalled-$STALLS" ]' 20 || fail "the staller never ran stall $STALLS ($1 ms)"
  }
  link_of() { [ -n "$(reg "$1" wsPort)" ] && echo websocket || echo tcp; }
  stall_row() {
    local label=$1 chat=$2 when=$3 ms=$4 c0 c1 s0 s1 ph row
    c0=$(dbg "$chat" 'd["connection"]["connects"]'); s0=$(dbg "$chat" 'd["snapshots"]')
    stall_for "$ms"; sleep 2
    c1=$(dbg "$chat" 'd["connection"]["connects"]'); s1=$(dbg "$chat" 'd["snapshots"]'); ph=$(dbg "$chat" 'd["phase"]')
    row="$label ($(link_of "$chat")): $when stall ${ms}ms: connects $c0->$c1 snapshots $s0->$s1 phase $ph"
    printf '%s\n' "$row" >>"$STALL_LOG"
    [ "$c0" = "$c1" ] && [ "$s0" = "$s1" ] || fail "$row: the link dropped"
    [ "$when" = idle ] || [ "$ph" = working ] || fail "$row: the turn ended before the stall did"
    ok "$row"
  }
  stall_case() {
    local label=$1 ms
    CHAT=$2; ready
    stall_row "$label" "$CHAT" idle 3200
    send_text "stream please"
    expect '[ "$(phase)" = working ]' "$label: the answer streams" 10
    sleep 2
    for ms in 400 800 1600 3200; do stall_row "$label" "$CHAT" streaming "$ms"; done
    cmd click:stop
    expect '[ "$(phase)" = idle ]' "$label: stopped" 10
    do_ tab.close --id "$(d 'd["place"]["tab"]')"
  }

  stall_case "this host" "$(open_chat stall-new "$SCEN/long-stream.json")"
  OLD_TAG=v0.3.0
  if git -C "$REPO" rev-parse -q --verify "refs/tags/$OLD_TAG" >/dev/null; then
    OLD_DIR="$BASE/host-$OLD_TAG"; mkdir -p "$OLD_DIR"
    git -C "$REPO" archive "$OLD_TAG" bin host package.json | tar -x -C "$OLD_DIR"
    ln -sfn "$REPO/node_modules" "$OLD_DIR/node_modules"
    CFGF="$HERDR_APP_HOME/mods/chat/config.json"; cp "$CFGF" "$BASE/config.stall.json"
    python3 - "$CFGF" "$OLD_DIR/bin/herdr-chat-host" <<'PY'
import json, sys
c = json.load(open(sys.argv[1])); c["host"] = sys.argv[2]; json.dump(c, open(sys.argv[1], "w"), indent=1)
PY
    stall_case "the $OLD_TAG host" "$(open_chat stall-old "$SCEN/long-stream.json")"
    cp "$BASE/config.stall.json" "$CFGF"
  else
    skip "no $OLD_TAG tag in $REPO: the old-host stall needs it"
  fi
  do_ tab.close --id "$STALLER"
  rm -rf "$HERDR_APP_HOME/mods/staller"
  cat "$STALL_LOG"
fi
