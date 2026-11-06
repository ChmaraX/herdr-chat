#!/usr/bin/env bash
# The pi-chat spike, in a private Herdr app (see ../lib.sh):
#   (a) a mod net socket reading JSONL for 3+ minutes, with a server restart
#   (b) list() vs ordinary elements vs an own measured scroller, streaming
#   (c) a stand-in host terminal: adoption, park, agent status, notifications
#   (d) Textarea: Enter, Shift+Enter, auto-grow, key interception
#   tests/e2e/spike/run.sh [artifacts dir] [sections: a b c d]
set -euo pipefail
ART_ARG="${1:-}"
shift || true
SECTIONS="${*:-a b c d}"
E2E_NO_INSTALL=1 . "$(dirname "$0")/../lib.sh" "${ART_ARG:-$(cd "$(dirname "$0")" && pwd)/artifacts}"
SPIKE="$E2E/spike"
DATA="$HERDR_APP_HOME/data/spike"
mkdir -p "$DATA" "$HERDR_APP_HOME/mods"
cp -R "$SPIKE/mod/pi-chat-spike" "$HERDR_APP_HOME/mods/"
net_field() { j "$DATA/net.json" "d['net']['$1']" 2>/dev/null; }
has() { [[ " $SECTIONS " == *" $1 "* ]]; }
j() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); v=eval(sys.argv[2]); print(v if isinstance(v,str) else json.dumps(v))' "$1" "$2"; }

MADE=$("$APP" do space.new --name spike --folder "$BASE")
SPACE=$(echo "$MADE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["space"])')
echo "space $SPACE" >>"$LOG"
open_tab() { # $1 name, $2 props json → prints the tab id
  "$APP" do tab.new "{\"name\":\"$1\",\"space\":\"$SPACE\",\"mod\":\"pi-chat-spike\",\"props\":$2}" >>"$LOG" 2>&1 || fail "tab.new $1"
  sleep 0.5
  active_tab
}
until_ drawn 20 && ok "the private window is drawn" || note "the window is covered: key presses and screenshots won't work"

# --- (a) net, started first: it runs under everything else -------------------------
if has a; then
  step "(a) a mod net socket reading a JSONL stream"
  node "$SPIKE/stream-server.mjs" "$DATA/port" >>"$LOG" 2>&1 &
  SERVER=$!; EXTRA_PIDS="$EXTRA_PIDS $SERVER"
  until_ '[ -s "$DATA/port" ]' 5 || fail "server"
  NET_TAB=$(open_tab net '{"mode":"net"}')
  A_START=$SECONDS
  until_ '[ "$(net_field connects)" = 1 ]' 10 && ok "the mod connected" || { j "$DATA/net.json" 'd["net"]["events"][:3]' | tee -a "$LOG"; fail "the mod connected"; }
fi

# --- (d) textarea --------------------------------------------------------------------
if has d; then
  step "(d) Textarea: Enter, Shift+Enter, auto-grow, interception"
  TA_TAB=$(open_tab textarea '{"mode":"textarea"}')
  sleep 1
  do_ pi-chat-spike.focus
  sleep 0.5
  keys "text:hello"
  shot d1-typed
  keys enter; sleep 0.4; shot d2-after-enter
  keys enter:shift; sleep 0.4
  keys "text:second"; keys enter:cmd; sleep 0.3; keys enter:alt; sleep 0.3; keys enter:ctrl; sleep 0.3
  for i in 1 2 3 4 5 6 7 8 9 10; do keys "text:line $i" enter:shift; done
  shot d3-grown
  do_ pi-chat-spike.menu:on; sleep 0.5
  keys up down tab enter esc; sleep 0.3
  shot d4-menu-keys
  do_ pi-chat-spike.menu:off; sleep 0.5
  keys up down tab esc; sleep 0.3
  shot d5-plain-keys
  do_ pi-chat-spike.dump; sleep 1.2
  cp "$DATA/textarea.json" "$ART/textarea.json"
  ok "textarea results in textarea.json"
fi

# --- (c) a stand-in host terminal ------------------------------------------------------
if has c; then
  step "(c) a stand-in host terminal next to a chat tab"
  CHAT_TAB=$(open_tab chat '{"mode":"list","tag":"c"}')
  echo "chat tab $CHAT_TAB" >>"$LOG"
  hc run --bg --json --no-parent --name standin --label herdr.space="$SPACE" --label herdr.tab="$CHAT_TAB" --label pi-chat.chat=c-spike \
    -- python3 "$SPIKE/standin-host.py" >"$ART/c-run.json" 2>>"$LOG"
  ST=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["address"])' "$ART/c-run.json")
  echo "standin $ST" >>"$LOG"
  expect 'term_panes | grep -q " $ST$"' "the labelled terminal is adopted as a pane" 10
  term_panes | grep " $ST$" >>"$LOG"
  expect '"$APP" ls | grep -q "$ST"' "app ls lists it"
  shot c1-adopted
  "$APP" ls >"$ART/c1-ls.json"
  hc send standin "working" >/dev/null
  sleep 1; shot c2-working-pane
  do_ terminal.park --terminal "$ST"
  expect '! term_panes | grep -q " $ST$"' "terminal.park removes its pane" 10
  sleep 1
  term_json "$ST" >"$ART/c3-parked-get.json"
  "$APP" ls >"$ART/c3-parked-ls.json"
  do_ pi-chat-spike.dump; sleep 1.2; cp "$DATA/list-c.json" "$ART/c3-parked-live.json"
  shot c3-parked-working
  hc send --force standin "blocked Allow rm -rf?" >/dev/null
  sleep 1.5; do_ pi-chat-spike.dump; sleep 1.2; cp "$DATA/list-c.json" "$ART/c4-parked-blocked-live.json"
  shot c4-parked-blocked 0.3

  step "(c') the alternative: keep the host as a pane, zoom the chat pane"
  CHAT2_TAB=$(open_tab chat2 '{"mode":"list","tag":"z"}')
  CHAT2_PANE=$(mod_panes | awk -v t="$CHAT2_TAB" '$1==t && $3=="pi-chat-spike"{print $2}')
  hc run --bg --json --no-parent --name standin2 --label herdr.space="$SPACE" --label herdr.tab="$CHAT2_TAB" \
    -- python3 "$SPIKE/standin-host.py" >"$ART/c-run2.json" 2>>"$LOG"
  ST2=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["address"])' "$ART/c-run2.json")
  expect 'term_panes | grep -q " $ST2$"' "the second stand-in is adopted into chat2" 10
  HOST2_PANE=$(term_panes | awk -v t="$ST2" '$3==t{print $2}')
  do_ pane.zoom --pane "$CHAT2_PANE"
  do_ pane.focus --pane "$CHAT2_PANE"
  hc send standin2 "working" >/dev/null
  sleep 1.5; do_ pi-chat-spike.dump; sleep 1.2; cp "$DATA/list-z.json" "$ART/c5-zoom-working-live.json"
  shot c5-zoom-working 0.3
  hc send standin2 "blocked Allow rm -rf?" >/dev/null
  sleep 1.5; do_ pi-chat-spike.dump; sleep 1.2; cp "$DATA/list-z.json" "$ART/c6-zoom-blocked-live.json"
  "$APP" status >"$ART/c6-status.json"
  shot c6-zoom-blocked 0.3
  # Done while the person looks at another tab: a toast?
  do_ tab.select --id "$CHAT_TAB"
  hc send --force standin2 "done" >/dev/null
  sleep 1.2; "$APP" status >"$ART/c7-status.json"
  shot c7-done-elsewhere 0.2
  # What an agents-list click does (the stock agents mod: pane.focus {pane: a.pane}).
  do_ pane.focus --pane "$HOST2_PANE"
  sleep 1; "$APP" status >"$ART/c8-agentclick-status.json"; "$APP" ls >"$ART/c8-ls.json"
  shot c8-agents-click
  do_ agent.focus --terminal "$ST2"
  sleep 1; "$APP" status >"$ART/c9-agentfocus-status.json"
  shot c9-agent-focus
  ok "agent integration artifacts: c*.json, c*.png"
fi

# --- (b) list variants ----------------------------------------------------------------
if has b; then
  step "(b) 150 markdown items, the last streaming at 50 ms flushes"
  visible
  for mode in list flex measured; do
    B_TAB=$(open_tab "$mode" "{\"mode\":\"$mode\",\"fps\":true}")
    sleep 2
    c0=$(cpu_secs); sleep 8; c1=$(cpu_secs)
    idle=$(python3 -c "print(round(($c1-$c0)/8*100,1))")
    do_ pi-chat-spike.stream
    sleep 3
    shot "b-$mode-1-streaming" 0.1
    c0=$(cpu_secs); sleep 15; c1=$(cpu_secs)
    busy=$(python3 -c "print(round(($c1-$c0)/15*100,1))")
    shot "b-$mode-2-streaming" 0.1
    do_ pi-chat-spike.dump; sleep 1.2
    cp "$DATA/$mode.json" "$ART/b-$mode-stats.json"
    echo "$mode cpu idle ${idle}% streaming ${busy}%" | tee -a "$LOG" >>"$ART/b-cpu.txt"
    # Expand a tool card: by a click (if the app takes posted clicks), else a command.
    do_ pi-chat-spike.up; sleep 1
    shot "b-$mode-3-scrolled-up" 0.3
    do_ pi-chat-spike.stop
    do_ pi-chat-spike.bottom; sleep 1
    shot "b-$mode-4-bottom" 0.3
    do_ pi-chat-spike.expand:t147; sleep 1
    shot "b-$mode-5-expanded" 0.3
    do_ pi-chat-spike.dump; sleep 1.2; cp "$DATA/$mode.json" "$ART/b-$mode-final.json"
  done
  hidden
  ok "list variants measured: b-*.json, b-cpu.txt"
fi

# --- (a) end -----------------------------------------------------------------------------
if has a; then
  step "(a) restart the server, then keep reading to 3+ minutes"
  kill "$SERVER"; rm -f "$DATA/port"
  sleep 5
  node "$SPIKE/stream-server.mjs" "$DATA/port" >>"$LOG" 2>&1 &
  SERVER=$!; EXTRA_PIDS="$EXTRA_PIDS $SERVER"
  expect '[ "$(net_field connects)" = 2 ]' "the mod reconnected after the restart" 15
  while [ $((SECONDS - A_START)) -lt 200 ]; do sleep 5; done
  do_ tab.select --id "$NET_TAB"; sleep 1.5
  cp "$DATA/net.json" "$ART/a-net.json"
  python3 - "$ART/a-net.json" <<'EOF' | tee -a "$LOG" >"$ART/a-summary.txt"
import json, sys
d = json.load(open(sys.argv[1]))["net"]
lat = sorted(d["lat"])
q = lambda p: lat[min(len(lat) - 1, int(p * len(lat)))] if lat else None
print(json.dumps({k: d[k] for k in ("connects", "failures", "records", "bytes", "gaps", "dupes", "bad", "big", "unicodeOk", "unicodeBad", "latMax")}))
print("per connection:", json.dumps(d["byConn"]))
print("latency ms p50", q(0.5), "p95", q(0.95), "p99", q(0.99), "max", d["latMax"])
print("events:", json.dumps(d["events"][:12]))
EOF
  shot a-net
fi
passed
