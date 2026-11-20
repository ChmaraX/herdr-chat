# Sourced by run.sh: flow `zoom` (#28). With the app's UI zoom other than 1,
# on_size_change reports zoomed px while the timeline places rows in layout px.
# At zoom 1.2 and 1, a chat longer than the host's 200-item snapshot is
# scrolled up in equal steps (chat.scroll:by:<dy>, what one wheel event of dy
# does), with a frame after each step. shift.py measures how far the transcript
# moved on screen: every step must move it dy × zoom pt, including
#   - bottom: the first steps away from the bottom (the first unstick, rows
#     measured for the first time, measures from before the zoom probe reported);
#   - history: the step where older history pages in, whose first row splits a
#     tool group (the group's row id changes; another row on screen holds the view).
# Then, at 1.2 only: the zoom changed while scrolled up keeps the row at the
# viewport's top where it was; and after an answer streamed while at the
# bottom, the steps up from it are even (its stored height kept up with it).

if want zoom; then
  ZSTEP=40
  ZSCEN="$BASE/zoom-scenario.json"
  python3 "$E2E/zoom/scenario.py" "$ZSCEN"
  set_zoom() {
    python3 - "$HERDR_APP_HOME/settings.json" "$1" <<'PY'
import json, sys
p = sys.argv[1]; s = json.load(open(p)); s["zoom"] = float(sys.argv[2]); json.dump(s, open(p, "w"))
PY
    ZWANT=$(python3 -c "print(round(float($1), 3))")
    expect '[ "$("$APP" status | python3 -c "import json,sys; print(round(json.load(sys.stdin)[\"zoom\"], 3))")" = "$ZWANT" ]' "the app's UI zoom is $1 (settings.json, live)" 10
  }
  # The dump is written after a render: a hover forces one, then wait for it.
  settle() { local w; w=$(d 'd["writes"]'); cmd hover:; until_ '[ "$(d "d[\"writes\"]")" -gt "$w" ]' 2 || true; }
  zstate() { d 'json.dumps({"top": d["top"], "sticky": d["sticky"], "items": len(d["items"]), "first": d["shown"][0] if d["shown"] else None, "scale": d["scale"], "atTop": d["atTop"]})'; }
  # Frames dir $1: frame 0 where it is, then $2 steps of ZSTEP; shift.py checks them (want: ZSTEP × zoom $3).
  zsteps() {
    local dir="$ART/zoom-z$3-$4" i
    rm -rf "$dir"; mkdir -p "$dir"
    for i in $(seq 0 "$2"); do
      [ "$i" = 0 ] || cmd "scroll:by:$ZSTEP"
      sleep 0.3; "$APP" shot "$dir/$(printf %03d "$i").png" >/dev/null 2>>"$LOG"
      settle; zstate >>"$dir/steps.jsonl"
    done
    local want; want=$(python3 -c "print($ZSTEP * $3)")
    if "$PY" "$E2E/shift.py" "$dir" "$want" "$ART/zoom-z$3-$4.json" >"$dir/shift.txt"; then
      ok "zoom $3, $4: every $ZSTEP px step moved the transcript $want pt ($(tail -1 "$dir/shift.txt"))"
    else
      cat "$dir/shift.txt" >>"$LOG"
      fail "zoom $3, $4: $(tail -1 "$dir/shift.txt") (zoom-z$3-$4.json, $dir/)"
    fi
  }

  for Z in 1.2 1; do
    step "zoom $Z: a long chat scrolled up in equal $ZSTEP px steps (#28)"
    set_zoom "$Z"
    CHAT=$(open_chat "zoom$Z" "$ZSCEN")
    ready
    expect '[ "$(d "len(d[\"items\"])")" = 200 ] && [ "$(d "d[\"hasOlder\"]")" = true ]' "200 items shown, older history to page in" 10
    # The snapshot's first row is a tool whose group starts before it: paging in splits it.
    [ "$(d 'd["items"][0]["kind"]')" = tool ] && ok "the snapshot starts inside a tool group ($(d 'd["items"][0]["id"]'))" || note "the snapshot starts with a $(d 'd["items"][0]["kind"]'), not inside a tool group"
    visible
    if needs_frames "zoom $Z: the scroll steps"; then
      ZWANT=$(python3 -c "print(round(float($Z), 3))")
      expect '[ "$(d "round(d[\"scale\"], 3)")" = "$ZWANT" ]' "the timeline measured the zoom ($Z)" 5
      zsteps bottom 20 "$Z" bottom
      if [ "$Z" = 1.2 ]; then
        step "zoom 1.2 → 1 → 1.5 → 1.2 while scrolled up: the row at the top stays"
        settle; A0=$(d 'json.dumps(d["atTop"])')
        for Z2 in 1 1.5 1.2; do
          set_zoom "$Z2"; sleep 0.8; settle; settle
          A1=$(d 'json.dumps(d["atTop"])')
          [ "$A1" = "$A0" ] && [ "$(d 'd["sticky"]')" = false ] && ok "zoom $Z2: the row at the top is still $A1" || fail "zoom $Z2: the row at the top was $A0, now $A1 (sticky $(d 'd["sticky"]'))"
        done
        shot zoom-z1.2-after-zoom-changes 0.2
      fi
      # Near the top of the 200 items, then across the history load (top < 300 pages it in).
      for _ in $(seq 1 60); do t=$(d 'd["top"]'); [ "$t" -gt 1500 ] || break; cmd "scroll:by:$(( t - 1300 < 3000 ? t - 1300 : 3000 ))"; sleep 0.2; settle; done
      sleep 0.5
      zsteps history 30 "$Z" history
      [ "$(d 'len(d["items"])')" -gt 200 ] && ok "zoom $Z: older history paged in during the steps ($(d 'len(d["items"])') items)" || fail "zoom $Z: no history paged in"
      if [ "$Z" = 1.2 ]; then
        step "zoom 1.2: an answer streamed at the bottom, then equal steps up from it"
        cmd click:latest; sleep 0.5
        expect '[ "$(d "d[\"sticky\"]")" = true ]' "back at the bottom" 5
        cmd focus; send_text "stream please"
        expect '[ "$(phase)" = working ]' "the answer streams" 10
        expect '[ "$(phase)" = idle ]' "the answer ends" 40
        sleep 0.6; settle
        # A stale stored height for the grown answer would put the first step up off by the difference.
        zsteps after-stream 12 "$Z" after-stream
      fi
    fi
    hidden
    do_ tab.close --id "$(d 'd["place"]["tab"]')"
  done
  set_zoom 1
fi
