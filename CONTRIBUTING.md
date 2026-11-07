# Contributing

## Setup

You need what [the README](README.md#install) lists (macOS, the Herdr app,
herdr-core, `pi`), plus git and **Node 24 or later**: a checkout runs the
host's TypeScript directly, where a release ships it built and runs on Node
20. With the Herdr app open:

```sh
git clone https://github.com/ChmaraX/herdr-chat
cd herdr-chat
npm ci
./install.sh               # installs this checkout into the running app; again after a change
./install.sh --uninstall   # takes it out
```

The README's options work here too (`./install.sh --no-subagents`). It
installs into `$HERDR_APP_HOME` when that's set, else `~/.config/herdr-app`.

The host is TypeScript that Node runs directly (type stripping: no enums, no
parameter properties, `.ts` in imports). A checkout has no build step; only a
release is built (below).

## Tests

```sh
npm test                    # the host end to end: the real host, a real TCP client, fake Pi/Claude/Codex
npx tsc --noEmit -p .       # typecheck the host (npm run typecheck)
tests/e2e/run.sh            # the mods in a private Herdr app
```

- **`npm test`** runs `tests/host/*.test.ts`: the real `herdr-chat-host`
  process against the fake agents (`tests/fake-pi/`, `tests/fake-claude/`,
  `tests/fake-codex/`) and recorded real sessions (`tests/fixtures/`).
  `LIVE=1 npm test` adds one run on real Pi.
- **`tests/e2e/run.sh [artifacts dir] [flows…]`** starts a private Herdr app
  with its own app home and its own herdr-core session, installs the mods
  there, and drives them as a person does: the launcher key, typing, Enter,
  Esc. Keys go to the private app's process only; it never touches your
  window. Checks read the host's state and the mod's debug dump, not the
  screen. Screenshots, dumps and logs go to `tests/artifacts/` (not
  committed).
  - **`E2E_NO_VISUAL=1`** never brings the private window to the front. Use
    it while you work in other apps: GPUI draws only a frontmost window, so
    the screenshot passes would otherwise take the front for a moment and
    hand it back. The checks pass either way; only the screenshots go
    stale.
  - `E2E_VISUAL=1` runs the whole suite in visual passes, for a full set of
    screenshots.
  - `LIVE=1 PROVIDER=pi|claude|codex tests/e2e/run.sh` runs one flow on the
    real CLI, on its cheapest model, with your login.

Write tests as end-to-end scenarios a person would run, and check what they
would see (the timeline, the state, the transcript), not internals.
`tests/host/FAILURE-MODES.md` lists how the host can fail and which test
catches each.

## Commits and pull requests

Commit messages and PR titles use
[Conventional Commits](https://www.conventionalcommits.org/): `feat:`,
`fix:`, `docs:`, `test:`, `chore:`, with an optional area, for example
`fix(host): …` or `feat(chat): …`. CI checks PR titles, and the changelog and the
version come from them.

A change to the wire protocol changes the host and the mod together, and
[docs/dev/protocol.md](docs/dev/protocol.md) with them.

## Releases

[release-please](https://github.com/googleapis/release-please) keeps a release
PR open on `main`, with the next version (from the commits' types) and its
`CHANGELOG.md` entry. Merging it tags `v<version>`, and `release.yml` builds
the release and attaches it:

- `herdr-chat-<version>.tar.gz`, from `npm run build` (`scripts/build.mjs`):
  the host and `install/*.ts` built with esbuild into plain JS for Node 20+
  (`highlight.js` and `beautiful-mermaid` bundled in), with `bin/`, `mod/`,
  `extension/`, `install/app.sh` and `install.sh`. It's the same archive for
  every platform.
- `SHA256SUMS`, which `install.sh` checks the archive against.

`install.sh` is the one-liner's script. Run as `./install.sh` in a checkout,
it installs the checkout (`install/app.sh`). Run any other way, it downloads
a release (`--version X.Y.Z`; `--from <archive or folder>` for a local one),
unpacks it to `~/.local/share/herdr-chat/<version>`, points `current` at it,
and runs that version's `install/app.sh`.

```sh
npm run build               # dist/herdr-chat-<version>.tar.gz and dist/SHA256SUMS
npm run test:built          # the host suite against the built host (HERDR_CHAT_TEST_NODE=<node 20> for the minimum)
npm run test:install        # the release install on a scratch home: install, update, tampered archive, uninstall
```

`npm run test:install` (`tests/release/install-e2e.sh`) needs `herdr-app` and
`hc` on `PATH` but no running app. CI (`ci.yml`, macOS) runs the typecheck,
`npm test`, the build and `test:built` on Node 20. It doesn't run the e2e
suites, which need the app.

## Design docs

[docs/dev/](docs/dev/README.md) has the architecture, the protocol, the
provider adapters, the visual spec, and the research behind the designs
that aren't obvious from the code (the hidden host pane, sub-agent chats,
driving Claude Code and Codex).
