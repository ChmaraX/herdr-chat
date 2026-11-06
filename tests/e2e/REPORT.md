# pi-chat mod (`mod/chat`): E2E report

## Test audit 1 (mod side, batch B; the audit notes are in git history)

- **Verified:** without visual passes 375 checks, 1 skipped (1 by command: `pick_mode`'s keys, which counted as a PASS before), `/tmp/ta-B/final-nonvisual/`; with `E2E_VISUAL=1` 376 checks, no skips, `/tmp/ta-B/final-visual/`. Before: 378 checks, no skips.
- **By command:** a fallback that does by the mod's command what a key should have done (`press_sc`, `press`, `type_text`, `launch_pick`, the v3 Esc, `pick_mode`, the launcher's `2`) calls `by_command`, and the next check is a SKIP "(by command: the key didn't land)", not a PASS. The summary line counts them: `N checks, M skipped (K by command)`. `send_text` is setup: its fallbacks don't mark anything.
- **Every key step has a command tier** (`keys_or`, `ask_key`, `open_launcher`, `press`): the keyboard claim is its own check (a SKIP "by command" when the key dropped), and what reached the agent (`apply_flag_settings`, `control_response`, `turn/interrupt`…) is checked after it either way. `E2E_NO_FRAMES=1` with the screen locked: 355 checks, 32 skipped (22 by command, 10 no frames), `/tmp/ta-B/nf7/`; with every key dropped on purpose (`keys` a no-op), the claude, codex, overlays and keys flows pass with every key step a SKIP. Conditions that held on a missing value (`-n "$(d …)"`, `!= None` on the dump's `null`) now test `is not None`.
- **No mod errors:** the run ends with `no_mod_errors`: nothing in the app's `status.errors`, and `renderError` null in every chat's dump. A render that throws keeps the last frame, so the data checks alone would still pass.
- **Drawn, not derived:** the footer records the chips it drew (`footerChips`), and the Claude/Codex chip checks read those under `needs_frames` (the dump's copy of the footer's logic, `chips`, is gone). Stream's "stuck to the bottom" checks the drawn rows and the view's top moving down while the answer grows, under `needs_frames`.
- **Removed:** checks that couldn't fail (the launcher's unconditional "Esc closes it", readbacks of `hover` and `statusesOpen`, `sticky` read while nothing could clear it, soft `&& ok || note` checks now plain notes or real checks), a host-owned `clear_queue` grep, and dead controls (`actions:*`, `dialog:yes|no|answers|q:|<n>`, `menu:`, `more:`, `scroll:bottom`, `new-chat.move:*`) and lib helpers.

## Feedback round 1 (mod side)

What changed, per row of `docs/dev/feedback-1.md`, and the flows that check it
(`flows-fix1.sh`: `overlays keys reports handoff2 conflict tabs split migrate fallback narrow`).

- **Verified:** the whole suite, 358 checks, no skips:
  - without visual passes: `tests/artifacts/e2e-fix1-nonvisual-20261103-221531/`;
  - with `E2E_VISUAL=1`: `tests/artifacts/e2e-fix1-visual-20261103-222433/` (no stale shots, screenshots `fix1-<n>-*.png`).
- **Pickers and menus (rows 1, 3, 7):**
  - They're an overlay above the composer: a `Popup` anchored to it, painted over the timeline. The composer block keeps its height with a menu open (`bottomH` in the dump).
  - The wheel moves a window of rows (`top`) and leaves the selection where it is. ↑↓ bring the selection back into view. The timeline under the menu doesn't scroll.
  - Esc closes a picker: Esc is now also bound inside its filter field (`PiChatMenu > Input`). A press outside closes it (`on_mouse_down_out`), and a press on the chip that opened it doesn't reopen it.
- **Shortcuts (row 2):** `keys.default.json`, overrides in `data/pi-chat/keys.json` (`null` unbinds), documented in `mod/chat/KEYS.md`.
  - They're bound in the chat's contexts only (`PiChat`, `<ctx> > Input`).
  - Shift+Tab is bound in the composer contexts only, so it does nothing while a menu is open.
  - Tooltips, picker titles and the `/` menu show the keys. An action the agent can't do says so in the hint line.
  - `stop` is ⌃C, not ⌘.: macOS turns ⌘. into Esc before the app sees it.
- **Report cards (row 4):** a user item with a `from` is a left-aligned card headed "from t7 review". Its body is markdown, folded to 10 lines when long, with Show all. The queue chip reads "Report from …" (`queue.steeringFrom`, else the envelope).
- **Spacing (row 5):** 20 px between the timeline and the composer (was 10).
- **The spinner (row 6):** it was already Herdr's own spinner (`workspace-chrome/spinner.svg`, `spin(900)`), and a re-render doesn't restart it.
  - Measured from rapid `herdr-app shot`s (the arc's angle per frame): our activity-line spinner moved in lockstep with Herdr's tab-bar and agents-list spinners, while streaming too. All of them repaint at about 8 fps (a 53° jump every ~120 ms, median 116 ms). That's the lag the user saw, and it's Herdr's native spin.
  - With a native opacity loop on the same SVG (0.97 → 1, invisible, ~30 fps), the window repaints at ~25 fps: 23° steps, every ~40 ms (median 39 ms). The cost is ~2.5 % app CPU while a spinner is drawn (1.9 % → 4.4 %, 10 s samples).
  - A faster `spin(700)` steps further per repaint, since the repaint rate doesn't depend on `ms`, so it only looks choppier. The 3/4 arc changes nothing about the rate.
  - The unused braille frames were removed.
- **A narrow chat:** the composer footer steps down with the room left of the send button. The row clips instead of running under the button. Checked at 244, 324, 424 and 604 px (`fix1-16-footer-<window>.png`, flow `narrow`).
  - `xs` (< 200 px): icons only, with the labels in their tooltips.
  - `sm` (< 300 px): the model's short name and the level, a mode icon, no chevrons.
  - `md` (< 520 px): shorter labels, no cost.
  - In `xs` and `sm`, every status goes in "+N".
- **A repeated notify:** an extension's notify that repeats an earlier one word for word (the startup warning after a resume) shows once (rows.js).
- **The ⋯ menu (row 8):** removed. `/transcript` is a slash command; the mod adds it when an older host doesn't list it.
- **Hand-off (rows 9, 10):**
  - After `hc run`, the mod sends `handoff_started {terminal}`. A reloaded mod sends it again for a `pi-chat.tui=<chat>` terminal, and sends `resume` when `state.handoff.terminal` is gone.
  - The mod no longer resumes on its own: the host does (the old path stays for a host without `state.handoff`).
  - The banner has **Return to chat**. While the TUI still runs, it asks "Close it / Cancel" first, then kills the TUI and sends `resume`.
  - The `tuis` override replaces the program after the `env K=V…` prefix.
  - The conflict banner has **Go to that chat** (that chat's pane from the layout document, else `agent.focus`) and **Take over**. Against an agent outside any chat, it has **Check again** (`resume`).
  - A chat whose host got `bye shutdown` (another chat took the session over) says so and doesn't restart.
- **Tab identity (row 12):**
  - `props()` names no pane, and `panes()` lists mod panes without their props.
  - The core's layout document (`hc connect` → `doc.get herdr-app`) has every mod pane with its props. The chat reads its own pane from there (`place.js`) and never guesses from `focused()`. With no document, it falls back to the host's tab label, else the only chat pane.
  - Self-heal: a host labeled for another tab gets `shutdown` and is restarted in the chat's own tab, on the registry's session.
  - The `tabs` flow opens Pi, Claude and Pi with `tab.select` back to the first tab between them. Then it checks each host's `herdr.tab`, one terminal pane per tab, and a relabeled host healing.
- **Hosts out of sight (row 11): a hidden host pane** (`docs/dev/research/split-glitch.md`; it replaced option A, parking).
  - The host's pane stays in the chat's tab, marked `hidden: true` in the core's layout document (`mod/chat/hostpane.js`: `doc.get`, edit, `doc.set` with the version read, again on `conflict`). A new host starts without `herdr.*` labels; the chat adds its hidden node when the tab is quiet, then labels it. Nothing is zoomed and nothing is parked.
  - Herdr lists the host as the tab's agent through splits (the agents list, the tab and space dots, `cmd-]`, its own toasts), and never draws it. Focus that lands on the hidden pane (`agent.focus`, an agents-list click) goes back to the chat, from render.
  - Older chats migrate when the mod loads: a host that shows gets the flag (and the chat's zoom goes), a parked one gets a node and its labels.
  - Closing the chat's pane leaves only the hidden pane: a detached check ends the host once the document has no pane of the chat, and the tab closes with it. After a quit the document still has the chat, and the host lives on.
  - `/transcript` peeks (`terminal.peek`): a hidden pane can't be zoomed into view.
  - Fallback: if the flag can't be written, or keeps being dropped (three writes in 20 s), the host's pane is resized to 0 px (`layout.resize`), never parked.
  - Herdr reads the document every 500 ms, and a change of its own made before it has read ours is lost ("Layout changed elsewhere": a tab just opened with a mod in it is gone; terminal panes come back by their labels). So the chat writes once per host, when the document matches the app's tabs and panes and nothing has moved for a second, and times the write to land just before the app's next read (a label echo marks the app's loop; the `hc connect` is started ahead and sends at that time). Flow `race`: a mod tab opened 0.15 s after the write survives. Measured: untimed, 4 of 6 such tabs were lost at 0.15 s; timed, none of 16. Within the first ~0.1 s some still are: only a Herdr change closes that (a command that hides a tab's pane, or merging on conflict).
  - Verified: the whole suite non-visual twice in a row (`tests/artifacts/e2e-hidden-host-{1,2}/`): 443 checks with 2 skipped, then 424 with 12 skipped (no frames: the screen locked during part of run 1 and most of run 2; 1 "done → idle" each: the private window is never active). In run 1 the frame checks ran: one reflow (993 → 491 px), the host's header never rendered, full width back.
  - Flows: `split` (right, down and root splits: one reflow, measured as the chat's widths; the host's header never renders in a probe layout; Herdr's toast and dots while split; `agent.focus`; an app restart; closing the chat's pane), `migrate` (an older mod's zoomed and parked chats, then this mod), `fallback` (a client that keeps dropping the flag).
- **Harness findings:**
  - A chat hidden behind a zoomed pane, or in a tab that isn't shown, takes no `chat.*` commands ("need the mod loaded"). Mod commands go to the shown copy.
  - The wheel and a press outside run by command (`chat.wheel:<dy>`, `chat.outside`), like clicks: synthetic mouse events posted to the app aren't taken.
  - `hc send` waits about 3 s for quiet, so the queued-report check uses a 10 s tool (`tests/e2e/fix1/slow-steer.json`; `open_chat` takes a scenario path).

## Providers on the real host (Claude Code, Codex)

The `claude` and `codex` flows (`flows-v3.sh`) run the real host with
`tests/fake-claude/fake-claude.mjs` and `tests/fake-codex/fake-codex.mjs` on
`tests/e2e/{claude,codex}/e2e.json` (the mock host is gone). They check the
dump and what reached the agent (the fakes' logs of what the host sent):
permission cards (Allow once with `1`; Always, then no second card; Deny with
a reason by Esc → declined), questions (number keys, Other, Enter), Claude's
plan approval (markdown in the card; approve-with-edits moves the mode chip),
subagent steps nested in the agent card, todo lists as plan cards, a steer
mid-run, Esc interrupting a stall, the effort / model / permission-mode chips
reaching the agent, the TUI hand-off argv (`--resume <id>`, `resume --no-daemon <thread>`),
`/login` running the built-in's `argv` (`claude auth login`, `codex login`) zoomed, then resuming,
and the timeline back after the host restarts.

- **Verified:** 270 checks, without visual passes (`tests/artifacts/e2e-providers-nonvisual-20261103-195311/`) and with `E2E_VISUAL=1` (`tests/artifacts/e2e-providers-visual-20261103-195939/`, no stale shots).
- **Live:** `LIVE=1 PROVIDER=claude` (haiku) and `LIVE=1 PROVIDER=codex` (luna, low, Ask first, set from the chips): the launcher, then `touch live-ok.txt && ls` through the permission card (Allow once from the keys), then the answer. 10 and 15 checks; `tests/artifacts/e2e-live-{claude,codex}-20261103-200624/`. (`ls` alone is read-only, so both agents run it without asking.)
- **A locked screen** renders nothing, so checks of render-time state (unsticking on scroll, paging history, an SVG's size) fail then; the dump now builds its rows from the store so the rest doesn't depend on a render.

## v3: providers (mod side; first built on a mock host, since replaced by the real one)

The mods are `mod/chat` (pane title "chat", commands `chat.*`) and `mod/new-chat`
(the launcher, `mod.open:new-chat`); the state dir `data/pi-chat` and the
`pi-chat.*` terminal labels are unchanged. After the rename the full suite
passed without visual passes: 212 checks (`tests/artifacts/e2e-rename-nonvisual-20261103-182349/`;
the new one: the pane header reads "chat").

Claude Code and Codex chats run on `tests/e2e/mock-host.mjs` (it speaks the
protocol v1–v3 with each provider's capabilities, plays `tests/e2e/mock/v3.json`
and logs every request) until the host adapters land. `mods/chat/config.json`
`hosts: {claude, codex}` points those providers at it; Pi chats keep the real host.

- **Verified:** 211 checks pass without visual passes (`tests/artifacts/e2e-v3-nonvisual-20261103-180247/`) and with `E2E_VISUAL=1` (`tests/artifacts/e2e-v3-visual-20261103-180745/`): the 171 v1/v2 checks (the launcher now asks first: `launch_pick`) plus 40 for v3.

- **Flow `v3`** (`flows-v3.sh`): the launcher's chooser (`2` → Claude Code, registry `provider: claude`, remembered as the default); the Claude empty state and footer (thinking levels from `capabilities.thinkingLevels`, permission-mode chip → `set_permission_mode plan`, cost; no status/widget areas with `extensionUi: false`); permission cards for a command (`1` = Allow once), a deny with a reason (Esc), an edit (Allow edits this session) and an MCP tool (`2` = Deny), the tool card `declined`; a questions card (`1`, then `1` `3` toggles, Enter submits `{db: "Postgres", ci: ["Unit tests", "Lint"]}`); a plan updated in place (one card); a subagent's steps nested in its card (no rows of their own); Codex without cost, mode Auto. Screenshots `v3-<n>-*.png`.

## v2: the visual pass

The mod was redesigned to `docs/dev/visual-v2.md` against host v2 (blocks,
`syn:` spans, mermaid SVGs, `outputLines`, `diffLines`, assistant
`model`/`durationMs`/`usage`, `set_theme`).

- **Full run:** `E2E_VISUAL=1 tests/e2e/run.sh` passes every v1 flow plus the new `v2` flow (`flows-v2.sh`, scenarios `mod-v2.json` and the host's `rich.json`). Verified: 171 checks pass both without visual passes (`tests/artifacts/e2e-v2-nonvisual-20261103-170621/`) and with `E2E_VISUAL=1` (`tests/artifacts/e2e-v2-visual-20261103-171052/`, screenshots), screenshots `v2-<spec section>-<what>.png`.
- **What `v2` checks** (debug dump + host): the empty state, the agent and its folder (startup warnings shown under it, info notifies hidden); `set_theme` accepted; the ⋯ menu and the thinking chip's picker; status chips in key order, an empty one hidden, one hidden from the popover and shown again; the widget tray opening and folding to one line; while streaming, the activity line and stick-to-bottom; after, thinking and tools folded into one closed group, the turn footer on the run's last answer, 5 code cards and a mermaid block; a group opening; a 60-line block's Show all; hover, copy (the message's markdown) and edit-and-resend; the host's SVG, its size read for the column, a click enlarging it (dialog); bash ANSI red in `outputLines`; a file link opening `$EDITOR` in a pane of the chat's tab, zoomed over the rest (the chat zooms back when it closes), then `herdr-nvim open --tab --space <file>:<line>` once a (stub) herdr-nvim is installed.
- **Performance** (FPS HUD: `touch data/pi-chat/debug/fps`; `mod-v2.json`'s ~7 KB answer with six code blocks and a diagram): streaming under the 60-line block, frame 3.1 ms, p95 3.6 ms, 0 % drops, app CPU 15 % (the spike's measured scroller: 3.0 ms, 18.7 %). JS `render()` 0.6–1.1 ms avg. What got it there:
  - finished blocks (closed code fences, markdown the stream moved past) are retained nested views (`codeview.js`, `cx.new` from the record handler), rebuilt only when their props change;
  - an open fence draws plain lines (one text run each); highlighting arrives when it closes;
  - adjacent spans that draw the same merge into one text run.
  With the mermaid SVG on screen the average was 5.8 ms (p95 10 ms) while streaming.
- **Not drivable from the harness:** pointer hover and clicks (synthetic mouse events to the pid aren't taken), so hover runs through `chat.hover:<id>` and clicks through `chat.click:<control>`, as in v1. The height animation of a group is native (`.transition("height")`) and only visible in motion.
- **An undrawn window drops keys** (the private window behind the person's app, or an activation that didn't take): `send_text` presses a dropped Enter again after a priming Shift, `type_text` retypes slowly when the composer doesn't hold the text, the dialog steps prime the bindings and check the answer came from the keyboard (not the dialog's timeout), and clears that aren't under test use `chat.clear`; if retyping drops too, `chat.type:<text>` puts the text in, and a twice-dropped Enter falls back to `chat.click:send`. Each retry is a `note:` in `run.log`. (Since test audit 1, a check that holds only because a command did what the key should have is a SKIP "by command", counted in the summary line; see the top.)
- **Dev loop:** `tests/e2e/dev.sh` keeps a private app running; `tests/e2e/dev-ctl.sh open <scenario> | sync | shot <name> | cmd <c> | dbg <expr>`.

The chat mod (`mod/chat/`; it was `mod/pi/` until v3, so the pane title now reads "chat" for every agent) and its launcher (`mod/new-chat/`, key action `mod.open:new-chat`) were run
end to end in a private Herdr app: its own `HERDR_APP_HOME`, its own herdr-core
session, the real `bin/pi-chat-host`, and fake-pi scenarios. The last flow
ran on real Pi.

- **Full run:** `E2E_VISUAL=1 tests/e2e/run.sh` passed **123 checks**, with no failures. Artifacts: `tests/artifacts/e2e-20261103-144111/` (screenshots, host snapshots, `run.log`, the final debug dumps and registry in `final/pi-chat/`).
- **Real Pi:** `LIVE=1 E2E_VISUAL=1 tests/e2e/run.sh` passed 9 checks. It ran `anthropic/claude-haiku-4-5` with a temp `--session-dir` (a bash call, then the answer). Artifacts: `tests/artifacts/e2e-live-20261103-1438/`.
- `herdr-app check` passes for `chat` and `new-chat`.
- Spike results: [`spike/REPORT.md`](spike/REPORT.md).

## How to run

```sh
tests/e2e/run.sh [artifacts dir] [flows…]   # default: every flow, tests/artifacts/e2e-<ts>/
E2E_VISUAL=1 tests/e2e/run.sh              # with screenshots (see "Visual passes")
LIVE=1 tests/e2e/run.sh                    # one flow on real Pi (haiku)
```

Flows: `basic dialogs abort commands external handoff agent stream misc
extras` (fake-pi) and `live` (LIVE=1).

## What a run does

The flows drive the chat the way a person does:

- the launcher key (`cmd-alt-p` in the private `keys.json`);
- typing and Enter, Esc, ↑/↓, Tab and backspace, via `keys.py`, which posts keys to the private app's pid only;
- `hc send` and `hc kill` from outside;
- quitting and relaunching the app.

Clicks go through the mod's own commands, which run the click handlers' code:
`chat.click:<control>`, `chat.toggle:<id>`, `chat.scroll:*`,
`chat.drop:<paths>`.

Checks read three things:

- the host's view (`pi-chat-host inspect`);
- the mod's debug dump (`data/pi-chat/debug/<chat>.json`), which the mod writes from state changes, not from render;
- the core and the app (`hc`, the app's layout document).

| Flow | What it proves |
|---|---|
| basic | The launcher opens a chat in the focused terminal's folder. The host is a pane of the tab, hidden in the layout document; nothing is zoomed. Extension statuses show (ANSI → spans). A typed prompt plus Enter is sent with no newline left behind. Nine tool cards of every kind arrive, one failed. The mod's items equal the host's, in order. Cards expand. The launcher's tab "pi" takes the chat's name. |
| dialogs | A select answered with ↓↑ Enter, a confirm (Enter = Yes), then an input typed into the dialog's own field and submitted. Pi gets each answer. An extension command's dialog outside a run, cancelled with Esc. |
| abort | Enter while working queues a steer. Esc aborts: the steer text comes back into the composer and the tool ends as failed (the `clear_queue`-then-`abort` order and the stop reason are `tests/host/steer-abort.test.ts`'s). Up/Up/Down/Down walk the prompt history. |
| commands | `/` lists all 20 commands, `/mo` ranks `model` first, Enter opens the model picker, and ↓ Enter switches the model. `/thinking high`. `/re` lists resume and reload. Esc closes the menu and keeps the text. `@READ` lists `README.md`, and Enter inserts `@README.md `. |
| external | `hc send` from another terminal arrives as a user item from outside, and Pi answers. |
| handoff | `/tui` hands off: phase `handoff`, the TUI runs with `--session <the chat's file>` in a pane of the chat's tab, zoomed so it fills the tab (the host's pane stays hidden). Quitting it resumes Pi on the same session, the chat alone again, unzoomed. `/login` runs `pi --no-session`, then restarts Pi. |
| agent | Focusing the host's hidden pane (what an agents-list click does) lands back on the chat. **Transcript** peeks at the host's terminal over the tab, and the layout doesn't move. Killing the host shows "host stopped" instead of restarting it silently. **Restart** brings back the same session and its items. |
| stream | A long markdown answer streams with the view following it (while drawing: the answer's row drawn, the view's top moving down as it grows). Scrolling up unsticks and **↓ Latest** re-sticks. The app quits mid-stream and relaunches: the same host (same pid) runs on, and the reopened mod's items equal the host's. |
| misc | A dropped PNG becomes a chip and goes with the prompt (thumbnail in the user bubble). `/copy`. `/resume` opens the sessions picker. A Pi crash mid-run shows "Pi exited (code 1)" and **Restart Pi** resumes. |
| extras | A tool result's image is saved under the app home and shown as a thumbnail that enlarges on click. An extension's `set_editor_text` fills the composer and gets acknowledged. An `<hc from="t9 reviewer">` envelope shows as a "from t9 reviewer" badge without the envelope. 230 answers, then the app relaunches: the snapshot holds 200 with `hasOlder`, and scrolling up pages in all 239 items with none repeated. Its scenario is `tests/fake-pi/scenarios/mod-extras.json`. |
| live | Real Pi through the launcher. A bash card with the real output, then the answer, with context % in the header. |

Screenshots worth a look:

- `basic-1-cards-expanded.png`: the edit diff with tints, the failed bash card;
- `dialogs-1-select.png`, `commands-1-slash.png`, `commands-2-model-picker.png`;
- `abort-1-queued.png`: the steer strip;
- `handoff-1-tui.png`: the TUI zoomed over the tab;
- `agent-2-stopped.png`, `misc-3-crashed.png`: the banners;
- `stream-2-scrolled-up.png`: the Latest pill;
- `extras-1-tool-image.png`, `extras-2-from-badge.png`;
- `e2e-live-…/live-2-answered.png`: real Pi.

## Built (mod/chat)

`main.js` (view, commands, hand-offs), `connection.js` (registry, start the
host with `hc run`, TCP + hello, reconnect), `store.js` (snapshot/patch/
history), `timeline.js` (the measured scroller), `cards.js` (items, tool
cards, diffs, thumbnails), `composer.js` (Textarea, key contexts, history,
menu input), `menus.js` (slash and @ menus, pickers), `dialogs.js`,
`header.js`, `debug.js`, `util.js`, `icons/`.

- **Host placement:** the host is a hidden pane of the chat's tab (see row 11 above), with labels `herdr.space`, `herdr.tab` (once its pane is in the document), `pi-chat.chat`, `pi-chat.role=host`, and no `--name` (so toasts show the title the host sets). Focus that lands on the host's pane is sent back to the chat. The mod moves layout or focus only while its tab is the shown one.
- **Keys** (spike d): bindings in contexts around the Textarea (`PiChatMenu > Input`, …):
  - Enter sends, Shift+Enter is a newline;
  - Esc closes a menu, cancels a dialog, or aborts;
  - ↑/↓ walk the menus, history, and a select/confirm dialog while the composer is empty;
  - Tab completes a command.
- **Config** (`mods/chat/config.json`): `host`, `node`, optional `pi`, `piArgs`, `env`, `tui` (the command for TUI hand-offs, default `pi`). E2E passes per-chat `props.hostEnv` (the fake-pi scenario).

## Known gaps

- The pane title is the mod's folder name (`panes()[i].title`; `mod.json`'s `title` isn't used for it), hence the folder `mod/chat` ("chat" for every agent).
- **Not exercised:**
  - `paste_other` with a real clipboard image (the run doesn't touch the clipboard);
  - drag-and-drop by the OS (the same code runs through `chat.drop:`);
  - remote machines (v1 is local).
- **Harness quirks** (all handled in `lib.sh` / `run.sh`):
  - The private window draws only while it's frontmost and the screen is unlocked. Data checks don't depend on drawing, and visual passes bring it forward (logged, ≤170 s, the person's app given back).
  - When the window isn't drawn, the composer's key bindings match only after a key event with a pane focused, so the harness primes them with a lone Shift before each new chat.
  - The runtime's socket `read()` fails with EAGAIN after ~30 s without data. The mod keeps reading. A host keepalive would avoid it too.
  - Screens marked "stale" in `run.log` were usually fine. The person had moved to another app during a pass, which can cover the window.
- `mod.json` `focusable: true`: `pane.go` sends `focus`, and the mod focuses the composer (or the open picker or dialog field).
