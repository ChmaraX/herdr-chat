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

`tests/box/box --help` lists every command. `tests/box/each.sh <item> [flows…]` runs each flow
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
