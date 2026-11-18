# Debugging the chat's layout and scroll

For bugs you can see but the code says are fine: content that jumps, a gap that
opens, text that "dances" while scrolling. The e2e suite checks state; these
are the tools for what is drawn. They were worked out chasing a scroll bug
([#28](https://github.com/ChmaraX/herdr-chat/issues/28)): the timeline mixed
zoomed and unzoomed pixels, and nothing in the state showed it.

## 0. Check the environment first: the UI zoom

`settings.json` has a `zoom`. The sizes `on_size_change` reports are multiplied
by it, while the numbers you give `top()`, `bottom()`, `.w()`, `.h()` are not
(Herdr-side report: [herdr-app#1123](https://github.com/herdrdev/herdr-app/issues/1123)).
At zoom 1.0 they agree, so a layout bug can be invisible to anyone testing at
the default. Reproduce at `"zoom": 1.2` before anything else, and measure the
factor instead of assuming it: a 100 px element with
`on_size_change((s) => scale = s.height / 100)`.

## 1. See what the code believes: the debug dump

```sh
mkdir -p "$HERDR_APP_HOME/data/herdr-chat/debug"
touch "$HERDR_APP_HOME/data/herdr-chat/debug/enabled"   # read when a chat view starts:
touch "$HERDR_APP_HOME/mods/chat/main.js"               # saving a file reloads the mod
```

`debug/<chat>.json` is rewritten (at most every 150 ms) with the chat's state:
`sticky`, `top`, `viewH`, `shown` (the rows drawn), `rows`, and `heightsSeen`,
a `Trace` (`debug.js`): per key, `[ms, ...values]` each time the values change,
the first 8 times. To record a series (per-frame positions, wheel events),
add keys to `heightsSeen` from the code you are debugging, one per event
(`heightsSeen.add("f0001", JSON.stringify(...))`), and delete old keys so the
file stays small. `debug/fps` adds the FPS overlay. Delete both files when done:
the dump costs a write every 150 ms.

## 2. Make it do the thing, repeatably

Mod commands are reachable from a shell: `herdr-app do 'chat.<command>'`
(`click:latest`, `scroll:up`, ... the list is in `main.js`'s header). `scroll:up`
moves 600 px; for small steps add a temporary command next to it in
`main.js` (`scroll:by:<n>` calling `this.timeline.scrollBy(n)`) and remove it
after. `herdr-app shot file.png` saves the window.

Compare shots of a chat that is **not streaming**: new text between two shots
looks like a jump.

## 3. Draw the model on the screen

When a number and the picture disagree, draw the number. In the timeline, a 2 px
red bar at the position the code computed for each row, and a blue one at the
row's real top (a child of the measured wrapper, `absolute().top(0)`), then
`herdr-app shot`. If the two columns of bars do not line up, the model is wrong,
and the ratio between their spacings says by how much (here: exactly 1/zoom).

## 4. Record the screen and measure frames

A shot is one frame; a jump lives between two. Record 8-10 s with
`cmd+shift+5` (a 60 fps recording is 60 samples per second) and wait for the
file on the Desktop: the temporary path the recorder shows first is not readable
by other programs. Then, with ffmpeg and nothing else:

```sh
# raw gray frames of the chat region; -fps_mode passthrough keeps the REAL frames
ffmpeg -i rec.mov -fps_mode passthrough \
  -vf "crop=iw*0.62:ih*0.5:iw*0.2:ih*0.12,scale=700:330,format=gray" -f rawvideo -
```

Without `-fps_mode passthrough` ffmpeg duplicates frames to a constant rate
and every frame index drifts from the one you extract later with `select=eq(n,N)`.
For each pair of consecutive frames, take the mean of each pixel row (a 1-D
profile) and find the vertical shift that best matches the two (sum of absolute
differences over, say, ±120 px). A scroll is a steady 1-4 px per frame; a jump is
one frame with 40-100 px, usually the opposite way. Extract the frames around
each jump as PNGs and look at them side by side: what moved, and what did not.

## 5. A simulation helps, if it models the environment

A small harness that runs `Timeline.view()` with mocked `gpui-kit` elements (rows
with real heights, estimated heights for the unmeasured, `on_size_change`
callbacks after each render, then a re-render) finds logic bugs in seconds and
counts the frames where a visible row moved by something other than the scroll.
It said "0 jumps" while the app jumped, because it used a single unit: model the
UI zoom, a stale height cache, rows that change height late, a pool that is never
measured. Whatever the harness does not model is where the bug is.

## Before calling it fixed

Measure on the real window: N equal scroll steps should move the content by N
equal amounts (the shot registration of section 2), at zoom 1.0 and at another
zoom. A fix that only the simulation likes is not a fix.
