# Debugging the chat's layout and scroll

For bugs you can see but the code says are fine: content that jumps, a gap that
opens, text that "dances" while scrolling. Most e2e flows check state; these
are the tools for what is drawn. They were worked out chasing a scroll bug
([#28](https://github.com/ChmaraX/herdr-chat/issues/28)): the timeline mixed
zoomed and unzoomed pixels, and nothing in the state showed it.

This guide matches herdr-chat with the #28 fix (PR #33) in: `util.js uiScale()`,
`chat.scroll:by:<dy>`, the dump's `scale` and `rowsAt`, and the e2e flow `zoom`.

## 0. Two units: layout px and window pt

`settings.json` has a `zoom`. Elements take **layout px**: the numbers you give
`top()`, `bottom()`, `.w()`, `.h()`, `.left()`. What the window reports back is
in **window pt**, layout px × the zoom: `on_size_change` sizes, and a pointer or
wheel event's position, bounds and delta (Herdr-side report:
[herdr-app#1123](https://github.com/herdrdev/herdr-app/issues/1123)). At zoom 1
they agree, so a unit mix-up is invisible at the default, and the e2e harness
pins `"zoom": 1` (`tests/e2e/lib.sh`).

The mod has one scale for this: `uiScale()` in `herdr-app/mods/chat/util.js`
(window pt per layout px, read from `settings().zoom`). Every value the window
reports is divided by it where it is read: the timeline's row and viewport
heights and its wheel delta (`timeline.js`, whose header says the same), the
chat's width (`main.js`, `width` over `widthPt`), a group's measured height
(`groupMeasured`), the viewer, code view and menus. New code that measures
something and feeds it back into layout must do the same. A row's height in
layout px does not change with the zoom, so stored heights stay right across a
zoom change; the viewport's height in layout px does.

When a layout bug looks like a scale, reproduce at `"zoom": 1.2` (and 0.9)
before anything else; the e2e flow `zoom` (section 4) does this for the
timeline.

## 1. See what the code believes: the debug dump

```sh
H="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
mkdir -p "$H/data/herdr-chat/debug"
touch "$H/data/herdr-chat/debug/enabled"   # read when a chat view starts
```

`debug/enabled` is read once, when a chat view starts (`debug.js`), so open a
new chat after creating it (saving a mod file reloads the mod too).
`debug/<chat>.json` is then rewritten, at most every 150 ms, with the chat's
state. For layout:

- `sticky`, `top`, `viewH` (layout px), `shown` (the row ids built: on screen
  plus 400 px of overscan), `rows`;
- `scale`: the UI scale the mod uses (`uiScale()`), to check it against the zoom;
- `rowsAt`: the same rows as `{id, y}`, each one's y in the viewport in layout px
  (negative: above the top). Multiply by `scale` to compare with a shot;
- `heightsSeen`: a `Trace` (`debug.js`): per row id, `[ms, height]` each time
  its measured height (layout px) changes, the first 8 times.

To record a series (per-frame positions, wheel events), add keys to
`heightsSeen` from the code you are debugging, one per event
(`this.heightsSeen?.add("f0001", JSON.stringify(...))`), and delete old keys
from its `seen` map so the file stays small. `debug/fps` adds the FPS overlay.
Delete both files when done: the dump costs a write every 150 ms.

## 2. Make it do the thing, repeatably

Mod commands are reachable from a shell: `herdr-app do 'chat.<command>'`
(`click:latest`, `scroll:up`, ... the list is in `main.js`'s header).
`scroll:up` and `scroll:down` move 600 layout px; `scroll:by:<dy>` moves `dy`
layout px (positive: up, toward history), as one wheel event of `dy × zoom` pt
does. `herdr-app shot file.png` saves the window.

Compare shots of a chat that is **not streaming**: new text between two shots
looks like a jump.

## 3. Draw the model on the screen

When a number and the picture disagree, draw the number. In the timeline, a 2 px
red bar at the position the code computed for each row, and a blue one at the
row's real top (a child of the measured wrapper, `absolute().top(0)`), then
`herdr-app shot`. If the two columns of bars do not line up, the model is wrong,
and the ratio between their spacings says by how much (in #28: exactly 1/zoom).
The dump's `rowsAt` gives the model's side without drawing; the bars still show
it next to the real rows.

## 4. Measure how far the content moved between frames

A shot is one frame; a jump lives between two. The e2e suite has the tools:

- `tests/e2e/shift.py steps FRAMES WANT OUT.json`: for numbered shots
  (`000.png`, `001.png`, …) of the e2e window, the vertical shift of the
  transcript between each frame and the one before, found by matching pixel
  rows. A step more than 2 pt off `WANT` is uneven. `shift.py grow` measures a
  group opening (no overshoot). Its crop box assumes the e2e window size
  (`E2E_WIN_W`, `E2E_WIN_H` from `lib.sh`).
- `tests/e2e/wheel.py`: posts one real wheel event over the private app's
  window, to check the wheel path, not just `scroll:by`. It moves your pointer
  for a moment, so the flow only runs it with `E2E_WHEEL=1`.
- The flow `zoom` (`tests/e2e/flows-zoom.sh`) uses both: at zoom 1.2 and 1 it
  scrolls a long chat in equal `scroll:by` steps and checks each moved
  `40 × zoom` pt (from the bottom, across a history page-in, after a streamed
  answer), changes the zoom while scrolled up, and opens a tool group.

```sh
tests/e2e/run.sh /tmp/zoom-art zoom              # E2E_WHEEL=1 adds the wheel series
```

Each case leaves its frames, the mod's state per frame (`steps.jsonl`) and
`shift.py`'s verdict in `zoom-z<zoom>-<case>/`, and the per-step table in
`zoom-z<zoom>-<case>.json`. A new layout bug usually needs a new case here
rather than a new tool.

For a real trackpad, record the screen instead: 8-10 s with `cmd+shift+5` (a
60 fps recording is 60 samples per second), and wait for the file on the
Desktop: the temporary path the recorder shows first is not readable by other
programs. Extract the frames with ffmpeg:

```sh
ffmpeg -i rec.mov -fps_mode passthrough frames/%03d.png
```

Without `-fps_mode passthrough` ffmpeg duplicates frames to a constant rate
and every frame index drifts from the one you extract later with
`select=eq(n,N)`. Measure them as `shift.py` does (crop to the transcript; its
box is for the e2e window, not a full-screen recording). A scroll is a steady
few pt per frame; a jump is one frame with 40-100 pt, usually the opposite way.
Look at the frames around each jump side by side: what moved, and what did not.

## 5. A simulation helps, if it models the environment

A small harness that runs `Timeline.view()` with mocked `gpui-kit` elements (rows
with real heights, estimated heights for the unmeasured, `on_size_change`
callbacks after each render, then a re-render) finds logic bugs in seconds and
counts the frames where a visible row moved by something other than the scroll.
It said "0 jumps" while the app jumped, because it used a single unit: model the
UI zoom (report sizes in window pt), a stale height cache, rows that change
height late, a pool that is never measured. Whatever the harness does not model
is where the bug is.

## Before calling it fixed

Measure on the real window: N equal scroll steps should move the content by N
equal amounts (`shift.py steps`, or the flow `zoom`), at zoom 1 and at another
zoom. A fix that only the simulation likes is not a fix.
