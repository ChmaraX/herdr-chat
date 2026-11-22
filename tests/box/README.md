# The test box

The real Herdr app (its Linux release), herdr-core and the chat's host on Node, on a virtual
display in a Docker container. It drives and checks the mods the way `tests/e2e/run.sh` does on
macOS, with real keyboard and mouse input, and takes screenshots and videos, without touching
your screen, focus, keyboard or pointer. It has no network and no credentials, and the worktree
is mounted read-only, so **code from someone else's PR runs here, never on your machine**.

```sh
tests/box/box build                       # once (about 40 s): pinned herdr-app, herdr-core, Node
tests/box/box up pr-33 ../worktrees/33    # a box for a worktree (copied in; read-only)
tests/box/box doctor pr-33                # fit to test on? JSON, exit 1 on problems
tests/box/box run pr-33 basic misc        # tests/e2e/run.sh flows, in the box
tests/box/box run pr-33 --run before --script tests/repro/run.sh   # any script: a replay
tests/box/box test pr-33                  # npm test, in the box
tests/box/box down pr-33
```

`tests/box/box --help` lists every command.

## The live app: explore, then film

`box run` starts a fresh app for each run. To look into a bug by hand, keep one running:

```sh
tests/box/box app up pr-33                 # a private app with the mods, a fake project, fake agents
tests/box/box chat pr-33 tools             # a chat tab on a fake-pi scenario
tests/box/box click pr-33 480 700          # real X input, in the window's pixels
tests/box/box type pr-33 "look around"; tests/box/box key pr-33 Return
tests/box/box dbg pr-33 'd["phase"]'       # the chat's debug dump
tests/box/box shot pr-33 /tmp/now.png      # the app's current frame
tests/box/box record pr-33 tests/box/scenes/model-picker.sh --run before
tests/box/box app down pr-33
```

The verbs are Herdr's own `scripts/sandbox` verbs (herdr-app, Apache-2.0): `move`, `click`
(button 1 left, 3 right), `drag`, `scroll`, `type`, `key <keysym> [mods]` (`key l Control_L`),
`hold`/`release`, and `sequence '<json>'` for a scene over one connection (hover and held keys
survive). Also `do`, `status`, `ls`, `check <mod>`, `hc`, `opened` (links the app tried to open),
`clip get|set`, `log`, `wait <terminal> <text>` (until it shows, else a dump), and
`app restart` (the window only; terminals live on).

A scene (`tests/box/scenes/*.sh`, the form of Herdr's `scripts/notes-clips`) has `setup` (not
filmed), `play` (filmed) and `crop` (`width:height:x:y`). `box record` films `play` at 12 fps
from the app's own frames, draws the cursor on each frame, and writes `clip.mp4`, `clip.webp`,
`frames/` and `pointer.jsonl` into a stamped run dir.

Other app versions: `tests/box/box build --app 0.1.15` makes `herdr-chat-box:app0.1.15-core…`
(the default image stays), and `tests/box/box up <item> <worktree> --image <that tag>` uses it. `tests/box/each.sh <item> [flows…]` runs each flow
on its own (a run stops at a flow's first FAIL) and writes a summary.

## Proof

Each run writes to `~/.cache/herdr-chat-box/<item>/<run>/` (`BOX_PROOF_DIR` moves it):
`run.log`, the screenshots and frame folders the flows take, the app's log, and the final state.
The run dir is stamped:

- `.worktree-rev`: the worktree's commit, `(dirty)` with uncommitted changes (then `dirty.diff`).
- `versions.txt`: the image's herdr-app, herdr-core, Node, OS and Mesa.

`--run before` and `--run after` refuse a dirty worktree (`--allow-dirty` keeps the diff) and an
existing run dir (`--replace`), so a before/after pair is two clean commits.

## What's real and what isn't

- **Real:** the Herdr app's own Linux build, herdr-core, the chat's host, the mods from the
  worktree, the X input path (keys and mouse through XTest, the app's keymap and focus), the
  app's own rendering (software Vulkan, on the CPU), `herdr-app shot`.
- **Fake:** the agents (fake-pi, fake-claude, fake-codex), as on macOS.
- **Linux, not macOS:** Ctrl where macOS has ⌘ (keys.default.linux.json), Linux font
  rendering, no macOS menus or clipboard. Check macOS-only behaviour with `tests/e2e/run.sh` on a
  Mac (trusted code only).

## Dependencies

The box has no network, so `node_modules` comes from the worktree. For code you didn't write,
install them on the host without running their scripts: `npm ci --ignore-scripts`. The box
gets the worktree's git history and tags as a bundle (flows that run an old release's host
use them).

## On macOS, without the box

`tests/e2e/run.sh` runs the same flows on a Mac. The private app starts in the background
(`open -g -n`) and is hidden at once; it is never brought to the front. `herdr-app shot`
(0.1.16+) draws the current frame of the hidden window, so screenshots are fresh while you work
in other apps, play a full-screen game, or have the screen locked.
