# The visual pass (docs/dev/visual-v2.md), sourced by run.sh: flow `v2`.
# Each step checks the mod's debug dump and takes the screenshot for its
# section of the spec (v2-<section>-<what>.png).

if want v2; then
  step "v2 §6 empty state: Pi, the folder (no suggestion chips); startup notices"
  CHAT=$(open_chat v2 mod-v2)
  ready
  expect '[ "$(d "d[\"empty\"]")" = true ]' "a new chat shows the empty state" 5
  [ "$(d "[r['item'] for r in d['rows'] if r['kind']=='item']")" = '["notice"]' ] && ok "the warning notify is a notice row; the info one isn't" || fail "rows: $(d 'd["rows"]')"
  [ "$(d 'd["statusesShown"]')" = '["mcp", "git", "plannotator"]' ] && ok "statuses in key order, the empty one hidden" || fail "statuses $(d 'd["statusesShown"]')"
  expect '[ "$(d "d[\"themeOk\"]")" = true ]' "set_theme sent after welcome and accepted" 5
  shot v2-6-empty-state 0.5

  step "v2 §1 composer footer: model, thinking, context (no ⋯ menu: /tui, /transcript, /resume, /copy)"
  [ "$(d 'd["model"]')" != null ] && ok "model chip ($(d 'd["model"]'))" || fail "no model"
  cmd type:/trans
  expect '[ "$(d "d[\"menu\"][\"items\"][0]")" = transcript ]' "/trans: /transcript in the menu (the ⋯ menu's Transcript)" 5
  cmd clear
  cmd click:chip:thinking
  expect '[ "$(d "d[\"picker\"][\"kind\"]")" = thinking ]' "the thinking chip opens its picker" 5
  shot v2-1-thinking-picker 0.4
  cmd key:escape
  expect '[ "$(d "d[\"picker\"]")" = null ]' "Esc closes it" 5

  step "v2 §4 extension status: hide one from its popover, the widget tray"
  cmd click:statuses # the popover, for the screenshot
  cmd click:status:hide:git
  expect '[ "$(d "\"git\" not in d[\"statusesShown\"] and d[\"statusesHidden\"] == [\"git\"]")" = true ]' "hidden from the footer (kept per key)" 5
  shot v2-4-statuses-popover 0.5
  cmd click:status:show:git
  cmd click:statuses
  expect '[ "$(d "\"git\" in d[\"statusesShown\"]")" = true ]' "shown again" 5
  cmd click:widget:todo
  expect '[ "$(d "d[\"widgetsOpen\"].get(\"todo\")")" = true ]' "the todo widget opens in the tray" 5
  shot v2-4-widget-open 0.5
  cmd click:widget:todo
  expect '[ "$(d "d[\"widgetsOpen\"].get(\"todo\")")" = false ]' "and folds back to one quiet line" 5

  step "v2 §6 a long answer streams: work group, thinking, activity line"
  cmd focus; sleep 0.3
  send_text "write the long answer"
  expect '[ "$(d "d[\"activity\"] is not None and any(r[\"kind\"]==\"activity\" for r in d[\"rows\"])")" = true ]' "the activity line shows while Pi works" 8
  expect '[ "$(d "any(i.get(\"streaming\") for i in d[\"items\"] if i[\"kind\"]==\"assistant\")")" = true ]' "the answer streams" 15
  shot v2-6-streaming 0.2
  expect '[ "$(phase)" = idle ]' "the run settles" 40
  expect '[ "$(d "any(r[\"kind\"]==\"activity\" for r in d[\"rows\"])")" = false ]' "the activity line goes" 5
  G=$(d "[r['id'] for r in d['rows'] if r['kind']=='group'][0]")
  [ "$(d "[r['items'] for r in d['rows'] if r['kind']=='group'][0]")" = "$(d "[i['id'] for i in d['items'] if i['kind'] in ('thinking','tool')][:3]")" ] \
    && ok "thinking and two tools fold into one group ($G)" || fail "group $(d 'd["rows"]')"
  [ "$(d "[r['open'] for r in d['rows'] if r['kind']=='group'][0]")" = false ] && ok "the finished group is closed" || fail "group open"
  A=$(d "[i['id'] for i in d['items'] if i['kind']=='assistant' and i.get('len',0) > 5000][0]")
  [ "$(d "[r.get('footer',{}).get('model') for r in d['rows'] if r['id']=='$A'][0]")" = "anthropic/claude-haiku-4-5" ] && ok "the run's footer is on its last answer" || fail "footer $(d 'd["rows"]')"
  [ "$(d "[b['types'] for b in d['blocks'] if b['id']=='$A'][0].count('code')")" = 5 ] && ok "5 code blocks and a mermaid one from the host" || fail "blocks $(d 'd["blocks"]')"
  shot v2-5-turn-footer 0.4
  cmd "toggle:$G"
  expect '[ "$(d "[r[\"open\"] for r in d[\"rows\"] if r[\"kind\"]==\"group\"][0]")" = true ]' "a click opens the group" 5
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do cmd scroll:up; done
  sleep 0.4; shot v2-6-group-open 0.3
  cmd "toggle:$G"

  step "v2 §3 code cards: 30 lines, then Show all"
  sleep 0.4; cmd scroll:down; sleep 0.3; cmd scroll:down
  sleep 0.5; shot v2-3-code-card 0.4
  cmd "toggle:code:$A:3"
  expect '[ "$(d "\"code:$A:3\" in d[\"expanded\"]")" = true ]' "Show all 60 lines" 5
  shot v2-3-code-all 0.4 # the card grows below the lines already in view
  cmd click:latest

  step "v2 §5 message actions: hover, copy, edit and resend"
  U=$(d "[i['id'] for i in d['items'] if i['kind']=='user'][-1]")
  cmd "hover:$U" # its action row, for the screenshot
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do cmd scroll:up; done
  sleep 0.4; shot v2-5-hover-actions 0.4
  cmd click:latest
  cmd "click:copy:$A"
  expect '[ "$(d "d[\"lastCopy\"][\"len\"]")" -gt 5000 ]' "copy puts the answer's markdown on the clipboard" 5
  cmd "click:edit:$U"
  expect '[ "$(d "d[\"composer\"][\"text\"]")" = "write the long answer" ]' "edit and resend puts the message back in the composer" 5
  cmd clear # the composer's own clear (keys aren't under test here)

  step "v2 §3 rich content: mermaid, ANSI output, read excerpt, diff"
  CHAT=$(open_chat rich rich)
  ready
  send_text "show me rich content"
  expect '[ "$(phase)" = idle ] && [ "$(count_kind tool)" = 3 ]' "the rich run settles (bash, read, edit)" 30
  host >"$ART/v2-rich-host.json"
  SVG=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print([b["svg"] for i in d["items"] if i["kind"]=="assistant" for b in i.get("blocks",[]) if b["type"]=="mermaid"][0])' "$ART/v2-rich-host.json")
  [ -s "$SVG" ] && ok "the host rendered the mermaid SVG" || fail "svg $SVG"
  if needs_frames "the mod reads the SVG's size (viewBox) while drawing it"; then
    expect '[ "$(d "\"$SVG\" in d[\"svgSizes\"] and d[\"svgSizes\"][\"$SVG\"] is not None")" = true ]' "the mod read its size (viewBox) to fit the column" 5
  fi
  for _ in 1 2 3 4; do cmd scroll:up; done
  sleep 0.4; shot v2-3-mermaid 0.4
  A=$(d "[i['id'] for i in d['items'] if i['kind']=='assistant'][0]")
  K=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); a=[i for i in d["items"] if i["kind"]=="assistant"][0]; print([k for k,b in enumerate(a["blocks"]) if b["type"]=="mermaid"][0])' "$ART/v2-rich-host.json")
  cmd "svghover:$A:$K"
  expect '[ "$(d "d[\"svgHover\"]")" = "$A:$K" ]' "hovering the diagram shows its ⤤ enlarge hint" 5
  shot zoom-0-inline-hover 0.4
  cmd svghover:
  cmd "click:enlarge:$A:$K"
  expect 'overlay_open chat' "a click enlarges the diagram (a dialog)" 5
  shot v2-3-mermaid-enlarged 0.6

  step "v2 §3 the viewer zooms and pans (viewer.js): fit, 200 % and 400 % around a point, a pan, a drag; sharp SVG copies"
  # The viewer's dump (debug/viewer.json): vj '<python over d = its "viewer">'.
  vj() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1]))["viewer"]; v=eval(sys.argv[2]); print(v if isinstance(v,str) else json.dumps(v))' "$STATE/debug/viewer.json" "$1"; }
  expect '[ "$(vj "d[\"fit\"] and d[\"natural\"] is not None")" = true ]' "the viewer opens fitted, the diagram's natural size known ($(vj 'd["natural"]'))" 5
  if [ "$(vj 'd["renders"]')" -gt 0 ] 2>/dev/null; then FRAMES=1; else FRAMES=; note "the viewer has no frames (the window isn't drawn): the drawn-size checks skip"; fi
  [ -z "$FRAMES" ] || expect '[ "$(vj "d[\"frame\"][\"measured\"]")" = true ]' "its frame is measured ($(vj 'd["frame"]'))" 5
  [ "$(vj 'd["focused"]')" = true ] && ok "the viewer took the keyboard (keys + - 0 1)" || note "the viewer isn't focused: $(vj 'd["focused"]')"
  FITPCT=$(vj 'd["pct"]')
  shot zoom-1-fit 0.6
  cp "$STATE/debug/viewer.json" "$ART/zoom-1-fit.json"
  # 200 % around a frame point: the image point under it stays put (unless the clamp moves it).
  ZX=$(vj 'round(d["frame"]["w"]*0.3)'); ZY=$(vj 'round(d["frame"]["h"]*0.5)')
  cmd "viewer:zoom:200:$ZX:$ZY"
  expect '[ "$(vj "d[\"pct\"]")" = 200 ] && [ "$(vj "d[\"fit\"]")" = false ]' "zoom:200 around ($ZX, $ZY): 200 % (fit was $FITPCT %)" 5
  python3 - "$ART/zoom-1-fit.json" "$STATE/debug/viewer.json" "$ZX" "$ZY" <<'EOF' && ok "the point under ($ZX, $ZY) stays under it (or the clamp keeps the image covering the frame)" || fail "zoom anchor: $(vj 'd["pan"]')"
import json, sys
a = json.load(open(sys.argv[1]))["viewer"]; b = json.load(open(sys.argv[2]))["viewer"]; px, py = float(sys.argv[3]), float(sys.argv[4])
n, f = b["natural"], b["frame"]
def expect(p, o0, z0, z1, size, fs):
    x = p - (p - o0) / z0 * z1
    W = size * z1
    return (fs - W) / 2 if W <= fs else min(0, max(fs - W, x))
ex = expect(px, a["pan"]["x"], a["zoom"], b["zoom"], n["w"], f["w"]); ey = expect(py, a["pan"]["y"], a["zoom"], b["zoom"], n["h"], f["h"])
print("pan", b["pan"], "expected", round(ex), round(ey))
sys.exit(0 if abs(b["pan"]["x"] - ex) <= 1 and abs(b["pan"]["y"] - ey) <= 1 else 1)
EOF
  shot zoom-2-200 0.6
  cmd "viewer:zoom:400:$ZX:$ZY"
  expect '[ "$(vj "d[\"pct\"]")" = 400 ]' "zoom:400: 400 %" 5
  # Sharp: a copy of the SVG drawn at least 4× is written and drawn (GPUI rasterizes it at its own size × 2).
  expect '[ "$(vj "d[\"wanted\"] >= 4 and str(d[\"wanted\"]) in d[\"buckets\"]")" = true ]' "a 4× copy of the SVG is written ($(vj 'd["buckets"]'))" 5
  Z4="$HERDR_APP_HOME/$(vj 'd["buckets"]["4"]')"
  [ "$(python3 -c 'import re,sys,json; t=open(sys.argv[1]).read(); n=json.loads(sys.argv[2]); m=re.search(r"<svg\b[^>]*>", t).group(0); w=float(re.search(r"\swidth=\"([\d.]+)", m).group(1)); print(str(abs(w - n["w"]*4) < 0.01).lower())' "$Z4" "$(vj 'd["natural"]')")" = true ] \
    && ok "the 4× copy's root is 4× the natural width, viewBox kept ($(basename "$Z4"))" || fail "4x copy: $Z4"
  if [ -n "$FRAMES" ]; then
    expect '[ "$(vj "d[\"drawn\"][\"w\"] == round(d[\"natural\"][\"w\"]*4) and d[\"drawn\"][\"scale\"] == 4")" = true ]' "drawn at the zoomed size (4 × natural), from the 4× copy, not the fit size" 5
    note "drawn: $(vj 'd["drawn"]')"
  fi
  shot zoom-3-400 0.8
  cp "$STATE/debug/viewer.json" "$ART/zoom-3-400.json"
  # A pan: plain scroll moves the image; the clamp keeps the frame covered.
  X0=$(vj 'd["pan"]["x"]'); Y0=$(vj 'd["pan"]["y"]')
  cmd "viewer:wheel:-150:-60"
  expect '[ "$(vj "d[\"pan\"][\"x\"]")" -lt "$X0" ]' "a plain scroll pans (x from $X0)" 5
  note "pan after the scroll: $(vj 'd["pan"]'), zoom $(vj 'd["pct"]') %"
  shot zoom-4-panned 0.6
  cp "$STATE/debug/viewer.json" "$ART/zoom-4-panned.json"
  cmd "viewer:wheel:-100000:-100000"
  expect '[ "$(vj "d[\"pan\"][\"x\"] == round(d[\"frame\"][\"w\"] - d[\"natural\"][\"w\"]*d[\"zoom\"]) or d[\"natural\"][\"w\"]*d[\"zoom\"] <= d[\"frame\"][\"w\"]")" = true ]' "a huge pan stops at the edge: the image still covers the frame" 5
  X1=$(vj 'd["pan"]["x"]')
  cmd "viewer:drag:200:0"
  expect '[ "$(vj "d[\"pan\"][\"x\"]")" = $((X1 + 200)) ] && [ "$(vj "d[\"drags\"]")" = 1 ]' "a drag of 200 px pans 200 px (x from $X1)" 5
  cmd "viewer:wheel:0:40:cmd:$ZX:$ZY"
  expect '[ "$(vj "d[\"pct\"] > 400")" = true ]' "⌘ + scroll zooms in around the pointer" 5
  note "zoom after ⌘ + scroll: $(vj 'd["pct"]') %"
  P0=$(vj 'd["zoom"]')
  cmd "viewer:key:-"
  expect '[ "$(vj "d[\"lastKey\"] == \"-\" and abs(d[\"zoom\"] * 1.25 - $P0) < 0.01")" = true ]' "- zooms out by 1.25 (from $P0)" 5
  cmd "viewer:key:+"
  expect '[ "$(vj "d[\"lastKey\"] == \"+\" and abs(d[\"zoom\"] - $P0) < 0.01")" = true ]' "+ zooms back in" 5
  cmd "viewer:key:1"
  expect '[ "$(vj "d[\"pct\"]")" = 100 ]' "1: 100 %" 5
  cmd "viewer:key:0"
  expect '[ "$(vj "d[\"fit\"]")" = true ] && [ "$(vj "d[\"pct\"]")" = "$FITPCT" ]' "0: fit again ($FITPCT %)" 5
  cmd "viewer:zoom:100000"
  expect '[ "$(vj "d[\"pct\"]")" = 800 ]' "the zoom stops at 800 %" 5
  cmd "viewer:zoom:1"
  expect '[ "$(vj "d[\"pct\"]")" = 10 ]' "and at 10 %" 5
  # Esc reaches the app's overlay binding with the viewer focused (keys.py posts to the private app only).
  keys esc
  if until_ '! overlay_open chat' 3; then ok "Esc closes the viewer"; else note "Esc didn't land (the window isn't drawn?): closed by command"; do_ overlay.close; fi
  cmd click:latest
  for x in $(d "' '.join(i['id'] for i in d['items'] if i['kind']=='tool')"); do cmd "toggle:$x"; done
  sleep 0.4; shot v2-3-tool-cards 0.4
  python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); t=[i for i in d["items"] if i["kind"]=="tool"]; b=t[0]; sys.exit(0 if any(s.get("fg")=="ansi1" for l in b.get("outputLines",[]) for s in l) else 1)' "$ART/v2-rich-host.json" \
    && ok "bash output keeps its ANSI red (outputLines)" || fail "no ANSI red"

  step "v2 §6 clickable file paths: herdr-nvim when installed, else \$EDITOR beside the chat"
  R=$(d "[i['id'] for i in d['items'] if i['kind']=='tool' and i['name']=='read'][0]")
  cmd "click:open:$R"
  expect '[ "$(d "d[\"lastOpen\"][\"how\"]")" = editor ] && [ -n "$(d "d[\"editorTerm\"][\"address\"]")" ]' "no herdr-nvim: the editor runs in a terminal of the chat's tab" 10
  ED=$(d 'd["editorTerm"]["address"]')
  expect 'term_panes | grep -q " $ED$"' "in a pane of the chat's tab" 10
  EDPANE=$(term_panes | awk -v t="$ED" '$3 == t {print $2}')
  expect '[ "$(d "d[\"zoomedPane\"]")" = "$EDPANE" ]' "zoomed: the editor fills the tab" 10
  hidden_in "$(d 'd["place"]["tab"]')" "$(d 'd["host"]["address"]')" && ok "the host's pane stays hidden" || fail "the host's pane: $(node_of "$(d 'd["host"]["address"]')")"
  sleep 0.6; shot v2-6-file-editor 0.5
  hc kill "$ED" >>"$LOG" 2>&1
  expect '[ "$(d "d[\"editorTerm\"]")" = null ] && [ "$(d "d[\"zoomed\"]")" = false ] && hidden_in "$(d "d[\"place\"][\"tab\"]")" "$(d "d[\"host\"][\"address\"]")"' "the editor closed (its zoom with it): the chat alone, the host hidden" 10
  mkdir -p "$HERDR_APP_HOME/mods/herdr-nvim/bin"
  printf '#!/bin/sh\necho "$@" >>"%s"\n' "$BASE/herdr-nvim.log" >"$HERDR_APP_HOME/mods/herdr-nvim/bin/herdr-nvim"
  chmod +x "$HERDR_APP_HOME/mods/herdr-nvim/bin/herdr-nvim"
  E=$(d "[i['id'] for i in d['items'] if i['kind']=='tool' and i['name']=='edit'][0]")
  cmd "click:open:$E"
  expect '[ "$(d "d[\"lastOpen\"][\"how\"]")" = herdr-nvim ]' "with herdr-nvim installed it opens there" 10
  grep -q -- "open --tab .* $PROJ/src/parse.ts:" "$BASE/herdr-nvim.log" && ok "herdr-nvim open --tab <tab> --space <space> <file>:<line> ($(cat "$BASE/herdr-nvim.log"))" || fail "herdr-nvim args: $(cat "$BASE/herdr-nvim.log" 2>/dev/null)"
  rm -rf "$HERDR_APP_HOME/mods/herdr-nvim"
fi
