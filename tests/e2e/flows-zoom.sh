# Sourced by run.sh: flow `zoom` (#28). Elements take layout px; the window
# reports sizes and wheel deltas in window pt (layout px × the UI zoom). At zoom
# 1.2 and 1, a chat longer than the host's 200-item snapshot is scrolled up in
# equal steps with a frame after each; shift.py measures how far the transcript
# moved on screen. Every check here is on frames:
#   - bottom: chat.scroll:by:<dy> steps from the bottom move it dy × zoom pt (the
#     first unstick, rows measured for the first time);
#   - wheel: real wheel events. macOS (E2E_WHEEL=1): 48 pt each (wheel.py, at the session's event tap; moves the
#     pointer for a moment). Linux test box (always): one notch each on the box's own pointer (wheel_x11.py)
#     move it 48 pt at any zoom: the content follows the finger;
#   - history: the step where older history pages in, whose first row splits a
#     tool group (the group's row id changes; another row on screen holds the view).
# At 1.2 only:
#   - the zoom changed while scrolled up (to 1, 1.5, 0.9 and back to 1.2 each
#     time) leaves the transcript where it was: the frame back at 1.2 matches the
#     one before, row for row, and the mod kept the same row at the top meanwhile;
#   - a tool group opened grows to its height with no overshoot (its open
#     animation takes its measured height in layout px);
#   - after an answer streamed at the bottom, the steps up from it are even.
# An app that draws no frames for the chat: every pixel check is then a SKIP
# that says so (not a pass).

if want zoom; then
  ZSTEP=40         # one scroll:by step, layout px
  ZWHEEL=48        # one real wheel event, window pt
  ZBACK="1 1.5 0.9" # the zooms visited, scrolled up at 1.2, each and back
  ZSCEN="$BASE/zoom-scenario.json"
  python3 "$E2E/zoom/scenario.py" "$ZSCEN"
  set_zoom() {
    python3 - "$HERDR_APP_HOME/settings.json" "$1" <<'PY'
import json, sys
p = sys.argv[1]; s = json.load(open(p)); s["zoom"] = float(sys.argv[2]); json.dump(s, open(p, "w"))
PY
    local want; want=$(python3 -c "print(round(float($1), 3))")
    expect '[ "$("$APP" status | python3 -c "import json,sys; print(round(json.load(sys.stdin)[\"zoom\"], 3))")" = "$want" ]' "the app's UI zoom is $1 (settings.json, live)" 10
  }
  # The dump is written after a render: a hover forces one, then wait for it.
  settle() { local w; w=$(d 'd["writes"]'); cmd hover:; draw; until_ '[ "$(d "d[\"writes\"]")" -gt "$w" ]' 2 || true; }
  zstate() { d 'json.dumps({"top": d["top"], "sticky": d["sticky"], "items": len(d["items"]), "first": d["shown"][0] if d["shown"] else None, "scale": d["scale"], "atTop": next((r for r in reversed(d["rowsAt"]) if r["y"] <= 0), None)})'; }
  top_row() { d 'json.dumps(next((r for r in reversed(d["rowsAt"]) if r["y"] <= 0), None))'; }
  # The first row wholly in view: what a person sees at the top. The row cut by the top edge can
  # change height with the zoom (on Linux text lays out a few px taller or shorter at some zooms);
  # the mod then keeps the rows below it still, so this one is the stable reference.
  view_row() { d 'json.dumps(next((r for r in d["rowsAt"] if r["y"] >= 0), None))'; }
  # A frame once the view is steady: renders forced until top and the items stop
  # changing (a history page in flight has landed, and rows first measured have
  # corrected top). The frame in which a row above the screen is first measured
  # draws it at its estimate for that one frame (#28's item 3, not this flow's
  # claim); macOS may not paint the next one by itself while the private window
  # isn't frontmost, so the shot waits for it.
  view_now() { d 'json.dumps([d["top"], len(d["items"]), d["loadingOlder"]])'; }
  frame() {
    local a b k
    sleep 0.3; settle; a=$(view_now)
    for k in 1 2 3 4 5 6; do settle; sleep 0.1; b=$(view_now); [ "$b" != "$a" ] || [[ "$b" == *true* ]] || break; a=$b; done
    [ "$b" = "$a" ] || note "the view was still moving after 6 renders ($b)"
    "$APP" shot "$1/$(printf %03d "$2").png" >/dev/null 2>>"$LOG"; zstate >>"$1/steps.jsonl"
  }
  # zsteps CASE N WANT MOVE: frame 0 where it is, then N steps of MOVE (a command line), a frame
  # after each; every step must move the transcript WANT pt.
  zsteps() {
    local dir="$ART/zoom-z$Z-$1" i
    rm -rf "$dir"; mkdir -p "$dir"
    frame "$dir" 0
    for i in $(seq 1 "$2"); do eval "$4" || fail "zoom $Z, $1: step $i couldn't be made ($4)"; frame "$dir" "$i"; done
    if "$PY" "$E2E/shift.py" steps "$dir" "$3" "$ART/zoom-z$Z-$1.json" >"$dir/shift.txt"; then
      ok "zoom $Z, $1: every step moved the transcript $3 pt ($(tail -1 "$dir/shift.txt"))"
    else
      cat "$dir/shift.txt" >>"$LOG"
      fail "zoom $Z, $1: $(tail -1 "$dir/shift.txt") (zoom-z$Z-$1.json, $dir/)"
    fi
  }
  by() { cmd "scroll:by:$ZSTEP"; }
  # Over the transcript column (shift.py's box: left of x 420 is the pane's margin, which doesn't scroll), at the first point no other window covers (exit 2: all covered).
  wheel_up() { "$PY" "$E2E/wheel.py" "$APP_PID" 420:1180 300 "$ZWHEEL" >>"$LOG"; }
  # In the test box (Linux), real wheel events go through the box's own X pointer (wheel_x11.py), so
  # they run by default: they move nobody's pointer. X11's wheel has notches, not pixels: one notch a
  # step, and every step must move the transcript what the first one did (WHEEL_PT, measured).
  if [ "$OS" != Darwin ]; then
    E2E_WHEEL=1
    wheel_up() { python3 "$E2E/wheel_x11.py" 420:1180 300 1 >>"$LOG"; }
  fi
  # How far one wheel step moves the transcript here: ZWHEEL pt on macOS (pixel deltas); on X11,
  # measured once from one notch (shift.py over two frames).
  wheel_pt() {
    if [ "$OS" = Darwin ]; then echo "$ZWHEEL"; return; fi
    local dir="$ART/zoom-z$Z-wheel-notch"; rm -rf "$dir"; mkdir -p "$dir"
    frame "$dir" 0; wheel_up; frame "$dir" 1
    "$PY" "$E2E/shift.py" steps "$dir" 0 "$dir.json" >/dev/null 2>&1
    python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["perStep"][0]["moved"])' "$dir.json"
  }

  for Z in 1.2 1; do
    step "zoom $Z: a long chat scrolled up in equal steps (#28)"
    set_zoom "$Z"
    CHAT=$(open_chat "zoom$Z" "$ZSCEN")
    ready
    expect '[ "$(d "len(d[\"items\"])")" = 200 ] && [ "$(d "d[\"hasOlder\"]")" = true ]' "200 items shown, older history to page in" 10
    # The history case pages in across a split tool group: the scenario is built for it.
    [ "$(d 'd["items"][0]["kind"]')" = tool ] && ok "the snapshot starts inside a tool group ($(d 'd["items"][0]["id"]'))" \
      || fail "the snapshot starts with a $(d 'd["items"][0]["kind"]'), not inside a tool group: the history case would test nothing (zoom/scenario.py)"
    if needs_frames "zoom $Z: every pixel check (scroll and wheel steps, zoom changes, group open, history) NOT checked"; then
      expect '[ "$(d "abs(d[\"scale\"] - $Z) < 0.001")" = true ]' "the mod's UI scale is the zoom ($Z)" 5
      zsteps bottom 20 "$(python3 -c "print($ZSTEP * $Z)")" by
      if [ -z "${E2E_WHEEL:-}" ]; then
        skip "zoom $Z, wheel: real wheel events move your pointer for a moment; E2E_WHEEL=1 runs them (NOT checked)"
      elif WPT=$(wheel_pt) && [ -n "$WPT" ] && [ "$WPT" != 0 ]; then
        note "zoom $Z: one wheel step moves the transcript $WPT pt"
        zsteps wheel 10 "$WPT" wheel_up
      else
        skip "zoom $Z, wheel: other windows cover the whole transcript row, so no real wheel event was posted (NOT checked)"
      fi

      if [ "$Z" = 1.2 ]; then
        step "zoom 1.2 → $ZBACK, back to 1.2 after each, while scrolled up: the transcript stays"
        dir="$ART/zoom-z1.2-zoom-changes"; rm -rf "$dir"; mkdir -p "$dir"
        settle; T0=$(view_row); frame "$dir" 0; n=0
        for Z2 in $ZBACK; do
          set_zoom "$Z2"; sleep 0.8; settle; settle
          T1=$(view_row)
          # The same row, within 1 layout px: rowsAt rounds offset - top, and top is fractional (a wheel
          # step, a row's first measure at the new zoom), so a still view can round 1 px either way. The
          # pixel check below (shift.py, 2 pt) says whether anything moved on screen.
          same_top() { python3 -c 'import json,sys; a,b=json.loads(sys.argv[1]),json.loads(sys.argv[2]); sys.exit(0 if a and b and a["id"]==b["id"] and abs(a["y"]-b["y"])<=1 else 1)' "$1" "$2"; }
          same_top "$T0" "$T1" && [ "$(d 'd["sticky"]')" = false ] && ok "zoom $Z2: the first row in view stays: $T1 (was $T0)" || fail "zoom $Z2: the first row in view was $T0, now $T1 (sticky $(d 'd["sticky"]'))"
          "$APP" shot "$dir/at-$Z2.png" >/dev/null 2>>"$LOG"
          set_zoom 1.2; sleep 0.8; settle; n=$((n + 1)); frame "$dir" "$n"
        done
        if "$PY" "$E2E/shift.py" steps "$dir" 0 "$ART/zoom-z1.2-zoom-changes.json" >"$dir/shift.txt"; then
          ok "back at 1.2 after each zoom, the transcript is where it was, row for row ($(tail -1 "$dir/shift.txt"))"
        else
          cat "$dir/shift.txt" >>"$LOG"; fail "the zoom changes moved the transcript: $(tail -1 "$dir/shift.txt") ($dir/)"
        fi

        step "zoom 1.2: a tool group opens to its height, with no overshoot"
        # A closed group near the viewport's top, so the rows below it stay in the frames.
        G=
        for _ in $(seq 1 40); do
          G=$(d 'next((r["id"] for r in d["rowsAt"] if r["id"].startswith("g-") and 10 <= r["y"] <= 110), "")')
          [ -z "$G" ] || break
          by; sleep 0.15; settle
        done
        [ -n "$G" ] || fail "no tool group came near the top in 40 steps"
        dir="$ART/zoom-z1.2-group-open"; rm -rf "$dir"; mkdir -p "$dir"
        "$APP" shot "$dir/000.png" >/dev/null 2>>"$LOG"
        cmd "toggle:$G"
        for i in $(seq 1 14); do "$APP" shot "$dir/$(printf %03d "$i").png" >/dev/null 2>>"$LOG"; sleep 0.02; done
        sleep 0.6; "$APP" shot "$dir/015.png" >/dev/null 2>>"$LOG"
        if "$PY" "$E2E/shift.py" grow "$dir" "$ART/zoom-z1.2-group-open.json" >"$dir/shift.txt"; then
          ok "group $G: $(tail -1 "$dir/shift.txt")"
        else
          cat "$dir/shift.txt" >>"$LOG"; fail "group $G: $(tail -1 "$dir/shift.txt") ($dir/)"
        fi
        cmd "toggle:$G"; sleep 0.5; settle
      fi

      # Into a band near the top of the 200 items (first measures move top as it goes),
      # then enough steps to cross the history load (top < 300 pages it in) and go on a bit.
      for _ in $(seq 1 60); do
        t=$(d 'd["top"]')
        if [ "$t" -gt 1300 ]; then cmd "scroll:by:$(( t - 1200 < 3000 ? t - 1200 : 3000 ))"
        elif [ "$t" -lt 1100 ]; then cmd "scroll:by:-$(( 1200 - t ))"
        else break; fi
        sleep 0.2; settle
      done
      t=$(d 'd["top"]')
      [ "$t" -ge 1100 ] && [ "$t" -le 1300 ] || fail "zoom $Z: couldn't settle near the top of the snapshot (top $t)"
      sleep 0.5
      zsteps history $(( (t - 250 + ZSTEP - 1) / ZSTEP + 5 )) "$(python3 -c "print($ZSTEP * $Z)")" by
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
        zsteps after-stream 12 "$(python3 -c "print($ZSTEP * $Z)")" by
      fi
    fi
    do_ tab.close --id "$(d 'd["place"]["tab"]')"
  done
  set_zoom 1
fi
