if want sockets; then
  step "sockets: two chats"
  SOCK_LOG="$ART/sockets.txt"; : >"$SOCK_LOG"
  port_pattern() { echo "$(reg "$1" port)|$(reg "$1" wsPort)" | sed 's/|$//'; }
  held() { lsof -nP -a -p "$APP_PID" -iTCP -F n 2>/dev/null | grep -E -- "->127\.0\.0\.1:($1)\$" | sort -u | wc -l | tr -d ' '; }
  sock_note() { printf '%s\t%s\n' "$1" "$2" >>"$SOCK_LOG"; note "$1: $2"; }
  reconnected() { [ "$(dbg "$1" "d['at'] > $2 and d['connection']['status'] == 'connected'")" = true ]; }
  reload_chat_mod() { printf '\n// e2e sockets reload %s\n' "$RANDOM" >>"$HERDR_APP_HOME/mods/chat/main.js"; }

  SA=$(open_chat sock-a); CHAT=$SA; ready
  SB=$(open_chat sock-b); CHAT=$SB; ready
  PA=$(port_pattern "$SA"); PB=$(port_pattern "$SB")
  expect '[ "$(held "$PA")" = 1 ] && [ "$(held "$PB")" = 1 ]' "Herdr holds one connection per chat" 5
  sock_note "open" "A=$(held "$PA") B=$(held "$PB")"

  step "sockets: three mod reloads (what an install does to a running app)"
  for i in 1 2 3; do
    T0=$(python3 -c 'import time; print(int(time.time() * 1000))')
    reload_chat_mod
    expect 'reconnected "$SA" "$T0" && reconnected "$SB" "$T0"' "reload $i: both chats connected again" 20
    sock_note "reload $i" "A=$(held "$PA") B=$(held "$PB")"
    expect '[ "$(held "$PA")" = 1 ] && [ "$(held "$PB")" = 1 ]' "reload $i: still one connection per chat (the old build's are released)" 10
  done
  CHAT=$SA; do_ tab.select --id "$(d 'd["place"]["tab"]')"; ready
  USERS=$(count_kind user)
  send_text "quick: still there after the reloads?"
  expect '[ "$(phase)" = idle ] && [ "$(count_kind user)" -gt "$USERS" ]' "A still chats after the reloads" 15

  step "sockets: a closed chat tab releases its connection"
  do_ tab.close --id "$(dbg "$SB" 'd["place"]["tab"]')"
  sock_note "B closed" "A=$(held "$PA") B=$(held "$PB")"
  expect '[ "$(held "$PB")" = 0 ]' "B's tab closed: Herdr holds nothing to its host" 10

  do_ tab.close --id "$(dbg "$SA" 'd["place"]["tab"]')"
fi
