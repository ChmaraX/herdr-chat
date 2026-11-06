# Sub-agents in the chat UI: a peek that shows herdr-chat instead of a TUI

**Question.** An agent starts helpers with `hc run`; the core records it as
their `parent`, and Herdr lists them under it in the agents list, without a
pane. Clicking one opens Herdr's **peek** (a floating view of the terminal),
so today the user sees the helper's TUI there. Can a sub-agent's peek show
herdr-chat's chat UI instead, ideally exactly where the peek appears today (a
click in the agents list, `agent.focus`, Ctrl/Cmd-click on an address), with
no change to Herdr, and with the parent's `hc send`/`hc wait`/`hc read`, the
nesting, exit and `--rm` untouched?

**Short answer. Yes for the click in the agents list; not for the Rust peek
itself.** Two halves:

1. **Run the sub-agent as a chat host.** A parent can start
   `pi-chat-host serve …` (directly or through an `hc` template) exactly as it
   starts `pi`. The host reports OSC 7501 (`idle` at once, `working`, `done`,
   `blocked`, `error`), takes `hc send` as a bracketed paste, prints a plain
   transcript for `hc read`, and exits cleanly on `hc kill` or the parent's
   end. **Verified** host-only (§4): a task pasted the way herdr-core pastes a
   template's first message, right after the first status and before Pi is up,
   is taken; the status runs `idle → working → done`; a second `hc send` with
   an `<hc from>` envelope lands as a "from t59 lead" message; SIGHUP exits 0
   and clears the registry. What's missing is a launcher (chat id, state dir,
   labels, the agent's binaries) and a template file; the protocol needs no
   change.
2. **Show the chat where the peek shows.** The peek is built in Rust
   (`peek_terminal`, `src/window.rs:3587-3600`): a `dialog` overlay 0.8×0.8
   of the window holding the shipped `peek` bar mod and a terminal block of
   the address. The mod name is hard-coded and shipped mods are restored on
   every start, so **the peek cannot be made to show a mod** (§1.3). But every
   route into it except two is JavaScript: the agents list calls
   `terminal.peek` from its sub-row's `on_click` (`mods/agents/main.js:203`,
   method `peek()` at `170`), and a layout picks its own agents mod. A copy of the
   agents mod whose `peek(addr)` opens
   `openOverlay({mod: "chat", kind: "dialog", width: 0.8, height: 0.8,
   props: {chat, peek: addr}})` for a chat-host sub-agent gives the user the
   chat in the same place, same size, same open/close gestures as the peek
   (**inferred** from source; the overlay API is the one the chat already
   uses for its image viewer). The two routes that stay Rust, Ctrl/Cmd-click
   on an address and a key bound to `terminal.peek`, open the TUI peek of the
   host's transcript; a right-click there can offer **Open as chat** through
   the layout's `terminal_menu` (documented hook). `agent.focus` on a paneless
   sub-agent shows nothing today in the shipped layout, so there is no parity
   to keep.

The chat mod needs a **peek mode** (no layout-document writes, no host
reaping, its own header bar) before any of this is safe: today a chat view
that closes **kills the host it finds** (`close()` → `reapLater`,
`mod/chat/main.js:1599-1609`), and `sweepOrphans` (`main.js:578-600`) kills
any `pi-chat.role=host` terminal whose chat has no pane. A sub-agent host has
no pane by design. §5 lists the changes.

For sub-agents started as plain `hc run -- pi` by other tools, nothing can
swap the TUI for the chat in place (a core terminal runs one program, and an
exited program ends the terminal). What can be done: a hand-over that kills
the TUI and starts a host under the same `--parent` with the same `--name`
(the parent hears an exit, then the name answers again), or a read-only
**observer** host that tails Pi's session JSONL and sends through `hc send`
(§2, candidates F and G).

## Sources

- **App source**, `herdrdev/herdr-app` `master` at `816d205` (2026-11-04),
  which differs from tag `v0.1.13` (the installed `herdr-app 0.1.13`) only in
  `Cargo.toml`/`Cargo.lock`. Cited as `file:line`. Vendored runtime
  `vendor/gpui-kit/crates/shell` for the mod loader.
- **Core**, `herdrdev/herdr-core` at `ec8adcd`: `docs/templates.md`,
  `schema/hc.openrpc.json` (`terminal.run`, `terminal.attach`, `terminal.send`,
  `terminal.wait`), `hc --skill`, `hc run --help`, `hc wait --help`
  (installed `hc 0.1.17`).
- **Installed docs**: `~/.config/herdr-app/AGENTS.md` and `herdr.d.ts`
  (0.1.13), the shipped mods `agents`, `peek`, `menu`, the user's layout
  `layouts/main-mods.json` (a clone of `main` 0.1.11 that herdr-nvim and
  gitview patched), `shared.json`, `installed.json`.
- **This repo** at `7df6d00` (lines cited as of that commit; the tree is
  moving): `mod/chat/main.js`, `connection.js`, `place.js`,
  `hostpane.js`, `host/main.ts`, `host/terminal.ts`, `host/chat.ts`,
  `host/registry.ts`, `tests/host/terminal.test.ts`,
  `extension/herdr-chat-lock.ts`.
- **Prior art**: [herdr-nvim](https://github.com/ChmaraX/herdr-nvim) (`herdr-app/RECIPE.md`: the 0×0
  floating controller mod, the install-time copy `pane-base.js` of a shipped
  mod, layout slot patching), [herdr-gitview](https://github.com/ChmaraX/herdr-gitview)
  (`src/appsetup.rs`: finding or cloning the person's layout, editing one
  slot, undoing exactly that). Upstream issues #288, #289, #330, #460, #534
  (read only).
- **Experiment** (§4): host-only, no Herdr app. A scratch
  `subagent-launch.test.ts` (not committed; the recipe
  and results are in §4).

Claims are **verified** (source read, or a host-only run) or **inferred**
(from source only; the experiment that settles it is in §3.2). No Herdr app
was started for this research.

---

## 1. How sub-agents, the peek and `agent.focus` work

### 1.1 What a sub-agent is to Herdr

- The core records the starter of an `hc run` as `parent` (default: the
  terminal `hc` runs in; `--parent <t>` sets it, `--no-parent` clears it;
  `hc run --help`). A child ends with its parent unless `--outlive-parent`;
  `--rm` removes it after exit "once a waiting parent has the exit code".
- It has no pane, so it is **not** in `agents()`: that list is built from the
  panes of every tab, keeping terminals with a status (`src/window.rs:
  1704-1733`, `let Some(status) = m.status(addr) else { continue }` at
  1725). `agent.next`/`agent.prev` walk `all_addresses()` of the tab trees
  (`src/model.rs:433-435`, `window.rs:1324-1327`), with sub-agents folded
  into their top parent (`root_agent`, `1367-1376`): **`cmd-]` never lands on
  a sub-agent** (verified). Tab and space dots ignore it (#460, `model.rs:
  562-564`). Herdr never toasts for it: `alert_for(addr, sub_agent, …)`
  returns `None` when `sub_agent` or no pane (`model.rs:475-480`).
- The shipped agents mod draws it from `terminals()` as a tree row under the
  parent: `tree()` takes every live terminal whose `parent` is the row's
  address (`mods/agents/main.js:175-185`); its status word is the raw report,
  `error` shown as blocked and `done` as idle ("it reports to its parent",
  `kidStatus`, `main.js:51-54`); its urgency rolls into the parent's row
  (`main.js:237`). Clicking the row runs `this.peek(k.address)` →
  `run("terminal.peek", {terminal})` (`main.js:170-172`, `203`). The row's
  text is `name || template || program.name || address`; the icon is the
  program table's for the OSC `app` (`programs::resolve` prefers the report,
  #330).
- A kept sub-agent (`terminal.keep`, the peek bar's **↗ keep**) gets a pane
  and keeps its `parent`, so it then appears both as a tree row and as a
  top-level row (#534, open; verified in the two filters above).

### 1.2 What the peek is

`terminal.peek {terminal}` (`src/window.rs:3077-3082`) and the Ctrl/Cmd-click
on a live address in terminal text (`src/terminal.rs:1914`
`LinkTarget::Terminal` → `TerminalEvent::Peek` → `window.rs:1408`) both call
`peek_terminal`:

```rust
// src/window.rs:3587-3600
fn peek_terminal(&mut self, address: &str, …) {
    self.close_overlay("terminal-peek", window, cx);
    self.open_overlay("terminal-peek".into(), json!({
        "kind": "dialog", "width": 0.8, "height": 0.8,
        "layout": { "type": "column", "children": [
            { "type": "block", "size": { "px": 34 }, "content": { "mod": "peek", "props": { "terminal": address } } },
            { "type": "block", "content": { "terminal": address } } ] }
    }), window, cx);
}
```

So the peek is: one overlay with the fixed id `terminal-peek` (a second peek
replaces the first), kind `dialog` (dims the window, a click beside it closes
it, `window.rs:4283-4296`), 80 % × 80 % of the window, a 34 px bar (the
`peek` mod: name, status word, "from <parent>", **↗ keep** / **↗ go to**, ✕;
`mods/peek/main.js`) and a **terminal view** of the address. Because the body
is a layout, Esc goes to the terminal, not to `overlay.close` (`4270`: the
`Overlay` key context is only set for mod overlays). The overlay closes
itself when the terminal ends (`terminal_ended`, `2289-2292`). Drawing the
terminal resizes its pty to the view (`src/terminal.rs:187-190`, `349`) and
marks it seen (`share_seen`, `window.rs:1512-1537`). Right-click in it opens
the layout's `terminal_menu` mod with `target {pane: <block id>, terminal}`
(`1411-1413`, `3463-3476`).

### 1.3 Why the peek can't be made to show a mod

- The mod name `"peek"` and the terminal block are literals in Rust.
- A mod is found by folder name in `~/.config/herdr-app/mods/` only
  (`mods::scan_dir`, `src/mods.rs:364-387`; `AppWindow::load` reads
  `self.folders.get(name)`). There is no alias or override table.
- Shipped mods are restored on **every start**: `write_workspace` →
  `sync_defaults` fingerprints each shipped folder and, when
  `~/.config/herdr-app/mods/peek` differs (an edited or an added file,
  `as_shipped`, `mods.rs:291-315`), renames it to `peek-edited` and writes the
  shipped files back (`sync_defaults`, `mods.rs:99-137`, AGENTS.md "Herdr's own layouts and
  mods are read-only"). An edited `peek` lives one start.
- A mod may import only files inside its own folder: the module resolver
  refuses a path that canonicalizes outside the application root
  (`vendor/gpui-kit/crates/shell/src/engine/quickjs/mod.rs:5440-5490`,
  "module … resolves outside the application directory"). So a clone can't
  be a thin wrapper that imports the shipped mod; it must carry a copy
  (herdr-nvim copies the shipped `pane` mod into `pane-base.js` at install
  time for this reason, `RECIPE.md`). #289 describes the clone chain.
- Mods cannot see overlays: `focused()` reports a `terminal` only for a
  chrome (layout) terminal block (`terminal_block(&self.chrome, …)`,
  `window.rs:1700`, `1738-1742`, `4555-4558`), never for an overlay's block;
  `herdr-app status` lists overlays as `"layout"` for any layout overlay
  (`3719-3722`). A mod has no way to learn that a peek opened. **Verified**
  by reading.

What a mod *can* see of a peek: the `size` event (`src/hc.rs:160`:
`cols`/`rows` updated in `terminals()`) when the peek's view resizes the pty,
and a `herdr.seen` label write when the peek shows an unseen turn. Neither is
a dependable trigger (§2, candidate E).

### 1.4 `agent.focus` for a paneless terminal

`agent.focus {terminal}` → `focus_agent` (`window.rs:1358-1364`): focuses the
pane showing it, if any, and sets `self.agent`, "the shown agent". In a
layout with an `{agent: "focused"}` block that block draws it; the shipped
`main` (and the user's `main-mods`) has none, so for a sub-agent **nothing
visible happens**: `focused().agent` becomes its address (the agents mod then
highlights its row, `main.js:190`, `232`) until the next pane change clears it
(`1489`). A toast's click runs `agent.focus`, but sub-agents never get a toast
(§1.1). **Verified** by reading. A mod that re-renders on `focused()` could
turn `focused().agent === <chat sub-agent>` into opening the chat (candidate
D).

### 1.5 What a chat is, and what it assumes

A chat is a `chat` mod pane plus a host process in a core terminal, hidden as
a pane of the chat's tab (split-glitch.md). The mod assumes it has a pane and
a tab in several places (`mod/chat/main.js`):

| Code | Assumes | For a chat in an overlay |
|---|---|---|
| `lookupPlace` / `findPlace` (`149-199`) | its pane is in the layout document | never found (`placeMisses` climbs); harmless |
| `Connection.ensureHost` (`connection.js:182-230`) | `place()` to start a host | "waiting for the chat's tab"; a host is never started, which is right for a sub-agent, wrong text |
| `keepHostHidden` (`409-490`), `healHost` (`374-397`), `redirectFocus` (`547`), `markSeen` (`563`) | `me` / `placeFrom === "doc"` | return early |
| `close()` → `reapLater` (`1599-1609`, `place.js:39-49`) | closing the chat's pane ends its host | **kills the sub-agent host** when the overlay closes, if the host carries `pi-chat.chat=<id>` |
| `sweepOrphans` (`578-600`, called from `tick`, `353`), in every chat view every 30 s | a `pi-chat.role=host` terminal whose chat has no pane in the document is an orphan | **kills a labeled sub-agent host** after two checks |
| `startHandoff` (`/tui`, `/login`, `1446`) | `findPlace()` | flashes "No tab to open the terminal in" |
| `newChat` | a place for the tab | opens in the focused space; fine |

The host side assumes nothing about panes: it serves whoever connects with the
registry's token (`host/server.ts`), reports status and takes typed input on
its own terminal (`host/terminal.ts`), and the registry entry
(`<stateDir>/chats/<chat>.json`) is how the mod finds its port.
`hostTerminal(chat)` (`connection.js:32-34`) finds the terminal by the label
`pi-chat.chat=<id>` alone.

---

## 2. Every candidate, ranked

Two independent choices: **how the sub-agent runs** (A: as a chat host) and
**how the chat is shown** (B, C, D, E for a chat host; F, G for a plain TUI
sub-agent). The recommendation (§3) is A + B, with C as the right-click
fallback for the Rust peek.

| # | Candidate | Click in the list | Cmd-click an address | `agent.focus` | Parent's control | Verdict |
|---|---|---|---|---|---|---|
| **A** | **the sub-agent is a `pi-chat-host`** (direct `hc run`, or an `hc` template) | TUI peek of the transcript | same | nothing | identical: OSC status, `hc send`, `hc read`, `hc wait`, `--rm`, parent exit (**verified** host-only) | **required base** |
| **B** | **copy of the agents mod**: `peek()` opens the chat as a 0.8×0.8 dialog for chat hosts | **the chat** | TUI peek | nothing | unchanged | **recommended** |
| C | `terminal_menu` clone: right-click in any peek → **Open as chat** | — | TUI peek, then one right-click | — | unchanged | recommended addition |
| C′ | **Open as tab**: `tab.new {mod: chat}` adopting the host as its hidden pane | from B's bar or C | — | reaches it (`cmd-]`, dots) | unchanged if closing **parks** instead of kills | optional ("↗ keep" for chats); #534 duplicate rows |
| D | always-on controller mod (0×0 floating block) watching `focused().agent` | — | — | **the chat** | unchanged | optional; only keys and `herdr-app do` reach it |
| E | controller or host detects the peek (pty `size` event) and swaps it for the chat | — | the chat, **first time only** | — | unchanged | rejected: no second trigger (no resize API) |
| F | hand-over of a plain `pi` sub-agent: kill the TUI, start a host `--parent <same> --name <same>` on its session | B applies after | — | — | the parent hears an **exit**, then the name answers again | for other tools' sub-agents; lossy |
| G | **observer** host: tails the TUI's session JSONL, sends through `hc send` | B applies | — | — | **untouched** | for other tools' sub-agents; medium build |
| H | edit the shipped `peek` mod | the chat | the chat | — | — | impossible: restored every start (§1.3) |
| I | `terminal.show` the host onto a pane, zoom tricks, `programs.json` | — | — | — | — | unrelated: `show` takes terminal panes only (split-glitch §1.4); `programs.json` only picks icons |

### A. The sub-agent as a chat host

**UX.** The parent runs, as it would for `pi`:

```sh
hc run --bg --name review --cwd /path/to/repo pi-chat-subagent          # then: hc wait review; hc send review "…"
hc run --bg --name review --cwd /path/to/repo pi-chat "Review src/x.rs"  # a template: the task is the first message
```

What it then sees is what it sees with a TUI Pi: `hc wait review` ends when
the status stops being `working`; `hc send review "…"` pastes a message (while
working, it's queued/steered as the chat does for `hc send` today; while
`blocked`, `send` refuses without `--force`, as for any agent); `hc read
review` prints the host's transcript (`> prompt`, the answer's text, `· tool
✓`, `! error`); `hc interrupt` presses the stop key (a lone ESC or Ctrl-C:
`InputParser`, `host/terminal.ts:34-130`, aborts the run); `hc wait
--children` sees its turns (`idle → working → done`); the core's notes
(blocked, error, exited) reach the parent; `hc kill`, `--rm` and the
parent's exit end it (SIGHUP/SIGTERM → `exit(0)`: the agent stopped, the
session lock released, the registry marked `pid: null`, `host/main.ts:
132-146`). In the agents list the helper nests under the parent with the
Pi/Claude/Codex icon (the host reports `app=<provider>`), the name the parent
gave, and working / needs you / idle. The user clicking it today gets the TUI
peek of that transcript (A alone changes nothing on screen).

**Evidence.**
- **Verified** (host-only, §4): the host reports `idle` as soon as it
  listens (`main.ts:156-160`), before its agent is up; a bracketed paste +
  Enter written right after that first status is taken (`chat.send` waits for
  readiness, `host/chat.ts:1040`), the status runs `idle → working → done`
  (`terminalState`, `chat.ts:817`, `861`), the transcript shows the prompt and
  answer, a second paste with `<hc from="t59 lead">…</hc>` becomes a message
  "from t59 lead" (`parseHcEnvelope`, `terminal.ts:21-27`), SIGHUP exits 0
  and clears the registry.
- **Verified** (source): herdr-core's template flow is "wait for the first
  OSC 7501 status, then paste `<body>\n\n<task>` and press Enter" (`herdr-core
  docs/templates.md`, "Readiness and input"); `terminal.wait` counts a child
  with a launch task as working "until its turn advances past delivery, or it
  reports done, blocked, error, or exits" (`schema/hc.openrpc.json`,
  `terminal.wait.children`), which the host's `working → done` satisfies.
  Status words the host emits: `working`, `blocked` (with the dialog title
  as `msg`), `done`, `error`, `idle` (`chat.ts:817`, `861`, `908-909`); the
  same words `hc` documents.
- The existing test `tests/host/terminal.test.ts` covers `hc send`'s paste in
  chunks, the envelope, arrow keys not aborting, ESC / ESC ESC / Ctrl-C
  aborting.

**What's missing** (host/launcher work, no protocol change):
- A launcher, `bin/pi-chat-subagent` (or `pi-chat-host run`), because a
  parent can't be expected to pass the mod's private arguments. It must:
  make a fresh chat id (`c-<hex>`; **never** derive it from a reusable value:
  `serve` resumes the registry's previous session for a known id,
  `main.ts:85`); pass `--state-dir "${HERDR_APP_HOME:-~/.config/herdr-app}/data/pi-chat"`
  (the host's default is `~/.local/state/pi-chat`, `main.ts:50-52`, which the
  mod never reads: `connection.js:11`); read `mods/chat/config.json` for the
  host, `node` and the agent binaries, since a core terminal's environment
  lacks the login PATH for explicit commands (`hc --skill`: "explicit commands
  are unchanged"); label its own terminal `hc label $HC_TERMINAL_ID
  pi-chat.chat=<id> pi-chat.role=subagent pi-chat.provider=<p>` so the mod
  finds it (`hostTerminal`) and `sweepOrphans` ignores it (it filters
  `role === "host"`, `main.js:590`). The template's `command` runs through
  `sh` in the terminal's cwd, so `--cwd` is `$PWD`.
- Templates: `~/.config/herdr-core/templates/pi-chat.md` (and per role, e.g.
  `reviewer.md` with `command: pi-chat-subagent --provider pi -- --model …`),
  so an agent following `hc --skill` ("First check `hc templates`") picks the
  chat. None exist today (`hc templates` → `[]`).
- Pi's `--model`/`--thinking`: pass through after `--` as `serve` already
  does (`main.ts:75`, `a.after`).

**Cost and risks.** Small. The host's `idle` before readiness means `hc wait`
right after `hc run` returns at once; a `send` then is held until the agent
answers `whenReady` (30 s) — the same as a plain launch of a slow TUI, and
the template path is unaffected. A sub-agent chat's registry entries, logs
and images accumulate under `data/pi-chat` like any chat's.

### B. A copy of the agents mod that opens the chat (recommended)

**UX.** Click the sub-agent's row in the agents list: the chat opens as a
centered 80 % × 80 % dialog over the window, dimmed behind, exactly where the
peek opens, with the timeline, composer and footer of a normal chat. A header
bar on top (drawn by the chat in peek mode, replicating `mods/peek`): the
name, the status word, "from t59 lead", **↗ Open as tab** (C′) and ✕. Typing
goes to the composer; a message typed there is a turn the parent will see end
(as with `hc attach` today). Esc **closes the dialog** rather than stopping
the run (inferred, below; **E1 found the opposite**, §3.3: Esc stops a run,
and the chat closes the dialog on an Esc with nothing to stop); the ■ button stops. A click beside the dialog
closes it, as for the peek. Opening another sub-agent's chat replaces it if
the overlay carries the same `key` (windows only) or the copy closes the
previous one first by id. When the parent ends the sub-agent, the chat shows
"the sub-agent ended" (today's banner reads "The chat's host stopped" and
offers a Restart that can't work without a tab, §1.5). Cmd-click on an
address, a key bound to `terminal.peek`, and `agent.focus` are unchanged (TUI
peek; nothing).

**Mechanics.**
- `mods/chat-agents/`: `agents-base.js` = the shipped `mods/agents/main.js`
  copied at install time (as herdr-nvim does with `pane-base.js`), and
  `main.js`:
  ```js
  import Agents from "./agents-base.js";
  export default class ChatAgents extends Agents {
    peek(addr) {
      const t = terminals().find((x) => x.address === addr);
      const chat = t?.labels?.["pi-chat.chat"];
      if (!chat) return super.peek(addr);
      run("overlay.close", { id: "terminal-peek" });
      openOverlay({ mod: "chat", kind: "dialog", width: 0.8, height: 0.8, props: { chat, peek: addr } });
    }
  }
  ```
  `subRow`'s `on_click` already goes through `this.peek(k.address)`
  (`agents/main.js:203`), so the override is the whole change. The base's
  asset paths (`mods/workspace-chrome/*.svg`) resolve against the app folder
  and keep working; its sort popup opens `{mod: "agents"}` (the shipped one)
  which is fine.
- The user's layout is already personal (`layouts/main-mods.json`,
  `cloned_from: main 0.1.11`, patched by herdr-nvim and gitview): set its
  `agents` block (`id: "agents"`) to `content.mod: "chat-agents"`, the way
  gitview's `appsetup.rs` edits one slot and undoes exactly that
  (`herdr-gitview/src/appsetup.rs:278-325`). On a shipped layout the install
  would clone it first (`layout.clone`), as both plugins do.
- The chat mod in peek mode (`props.peek`): skip `lookupPlace`,
  `keepHostHidden`, `healHost`, `redirectFocus`, `markSeen`, `renameTab`;
  never `reapLater` on close; banner texts for a sub-agent; the header bar;
  `/tui` could open the TUI in the parent's tab or stay unavailable.

**Evidence.**
- **Verified** (source): the click path (§1.1); `openOverlay` with `mod`,
  `kind: "dialog"`, fractional `width`/`height` and `props` (`herdr.d.ts`
  `OverlaySpec`; `open_overlay`, `window.rs:3478-3560`: the mod copy is loaded
  with `props.overlay = id`, size `0.8` is "a share of the window", `4259`);
  the chat already opens itself this way for the image viewer
  (`mod/chat/main.js:1227`, `props.viewer`) and closes with
  `closeOverlay(props().overlay)`; `overlay.close {id}` closes any overlay by
  id (`3265-3271`), so the copy can first close a Rust peek that may be open.
  A dialog's mod copy counts as shown, so `herdr-app do chat.<command>` and
  the E2E dump reach it (`visible()`, `1262-1275`).
- **Inferred**: Esc. For mod overlays of kind dialog the body gets the
  `Overlay` key context (`4270`) where `escape` is bound to `overlay.close`
  (`src/keys.rs:270`). GPUI dispatches matching key bindings before key-down
  listeners, so the chat's own Esc handling (stop / cancel) would not run; the
  `new-chat` launcher's own `escape` handler and the viewer's "Close · Esc"
  are consistent with that. A `kind: "window"` overlay has no `Overlay`
  context (Esc reaches the mod), is draggable, doesn't dim and isn't closed
  by a click beside it, and with `key: "chat-peek"` a second open replaces the
  first in place: the alternative if Esc-to-stop matters more than peek
  parity. Experiment E1.
- **Inferred**: the composer takes the keyboard. The overlay's frame focuses
  first ("a mod that focuses itself while loading wins", `3532-3537`); the
  chat calls `composer.focus()` at init and 400 ms later, as the launcher
  dialog does. E1.
- **Verified** (source): nothing in the overlay path touches the layout
  document (the chat writes it only from `keepHostHidden`, gated on
  `placeFrom === "doc"`), so the "Layout changed elsewhere" risk of
  split-glitch §2.3 does not arise.

**Cost and risks.**
- A copied mod. The install-time copy follows the shipped agents mod at each
  install (not at each app update): between installs the list is frozen at
  the copied version. The installer should check that the copy still defines
  `peek(` and that `subRow` calls it, and refuse to install the override
  otherwise. Upstream could move the click inline (then the override is
  silently bypassed, never broken).
- The layout edit: the same undocumented-but-practised surface herdr-nvim and
  gitview already use on this layout.
- Two Herdr issues touch this: #289 (clone chains) and #534 (a kept
  sub-agent listed twice).

### C. `terminal_menu`: "Open as chat" in any peek

**UX.** Cmd-click the sub-agent's address in the parent's TUI (or press a
`terminal.peek` key): Herdr's peek opens with the host's transcript (plain
text, readable: `> prompt`, answers, `· tool ✓`). Right-click in it → the
menu has **Open as chat** (and **Open as a chat tab**): the peek closes and
the chat dialog of B opens. One extra click; the transcript is a fair
preview meanwhile. The host can print a hint line at the top of its
transcript ("Herdr: right-click → Open as chat").

**Mechanics.** The layout root takes `terminal_menu: "<mod>"` (`herdr.d.ts`
`layout()`, `src/layout.rs:377`, `window.rs:3467-3476`); `main-mods.json` is
personal, so it can. `mods/chat-menu/` = a copy of the shipped `menu` (same
install-time copy) whose `items("pane")` adds, when
`terminals().find(target.terminal).labels["pi-chat.chat"]` is set, an item
that runs `overlay.close {id: "terminal-peek"}` then `openOverlay({mod:
"chat", …})`. The menu gets `target {pane, terminal}` for the peek's block
too (`1411-1413`; AGENTS.md: "right-click targeting follow keyboard focus,
including peek and floating terminals").

**Evidence.** **Verified** (source) that the menu opens for a peek's
terminal with the terminal in `target`; **inferred** that an item's handler
may close the peek and open another overlay in the same tick (E4).

**Cost and risks.** One more copied mod (the shipped `menu` changes with
Herdr: themes list, worktree items). The user already runs no custom menu.

### C′. Open as tab

**UX.** From B's header bar (or C's menu): a new tab in the parent's space
with the chat filling it, like a chat the user opened: listed top-level in
the agents list, reachable with `cmd-]`, counted in the tab and space dots,
toasted by Herdr. It stays a tree row under the parent too (#534). Closing
the tab sends it back under the parent, still running.

**Mechanics.** `tab.new {space: <parent's space>, mod: "chat", props: {chat,
provider, cwd, subagent: addr}}`. The chat finds its pane in the document,
`keepHostHidden` finds the host by label, appends a hidden node and labels it
`herdr.space/tab` (split-glitch §2.2 (b)), and the host becomes a hidden pane
of the chat's tab. Required mod change: `close()` for a host with a `parent`
must `terminal.park` it (pane and `herdr.*` labels removed, the terminal
keeps running; `docs/commands.md` "a sub-agent shows under its parent again")
instead of `reapLater`'s kill; `healHost` must not restart a host that has a
`parent`.

**Evidence.** **Verified** (source): `terminal.keep`/`park` semantics
(`commands.md:132-147`, `window.rs:3027-3035`, `keep_terminal` `2529`, `park_terminal` `2557`); the hidden-pane mechanics are
split-glitch's, verified there. **Inferred**: the duplicate rows (#534
reports it for `terminal.keep`; our path produces the same state).

**Cost.** The mod's close/heal paths learn about parents. Risk: a mistake
there kills the parent's helper; the hand-off tests in `tests/e2e` would need
a sub-agent scenario.

### D. An always-on controller watching `focused().agent`

A 0×0 floating block in the layout (`floating: [{id: "chat-controller",
content: {mod: "chat", props: {role: "controller"}}, edge: "bottom", align:
"end"}]`, herdr-nvim's answer to #288, `RECIPE.md:249-252`) is rendered on
every live change and can act on `focused().agent` becoming a chat-host
sub-agent (set by `agent.focus`, §1.4): open the chat dialog, then
`pane.focus` the current pane to reset `self.agent` so the next
`agent.focus` fires again (`2999`: `pane.focus` sets `self.agent` to the
pane's). Only keys, `herdr-app do agent.focus` and other mods call
`agent.focus` for a sub-agent, so this adds a route rather than fixing one.
**Inferred**; worth it only if a key for "open the shown agent as chat" is
wanted. It also gives `herdr-app do chat.peek:<addr>` a copy to land on when
no chat tab is open.

### E. Detect the Rust peek and swap it (rejected)

The peek's terminal view resizes the pty (`src/terminal.rs:187-190`); the
core emits a `size` event (`hc.rs:160`) that mods see in `terminals()`
(`cols`/`rows`) and the host sees as SIGWINCH. A controller (or the host via
`herdr-app do overlay.close --id terminal-peek` + a mod command) could swap
the peek for the chat. But the pty keeps the peek's size after the peek
closes (no viewer sets it back; `terminal.attach` is the only resize path,
`hc.openrpc.json`), so the **second** peek of the same host produces no event
unless the window was resized in between. There is no `terminal.resize` API
for the host or a mod to reset it. Also fires for `terminal.keep` and `hc
attach`. **Inferred** from source (E5 would confirm the single-shot
behaviour). Not worth building.

### F. Hand-over for a plain `hc run -- pi` sub-agent

A core terminal runs one program; when it exits the terminal is finished
(`--keep` only replaces a *lost* program with a shell, never reruns; `hc
--skill`). So a TUI Pi can't be swapped for a host in place. What works:
find its session file, `hc kill <old>`, then `hc run --bg --parent <parent>
--name <old name> --cwd <cwd> -- pi-chat-subagent --session <file>`:
`--parent` is an explicit `terminal.run` parameter and names resolve to live
terminals, so `hc send <name>` and `hc wait <name>` keep working once the new
one is up; the core writes the parent one **exit note** for the old child and
`hc wait <old address>` ends. Do it only while the TUI is `idle`/`done` (a
killed turn is lost). The session file: Pi's per-cwd session dir
(`host/providers/pi/sessions.ts:13-16`) newest file, or, dependable, the
installed `herdr-chat-lock` extension labelling its terminal on
`session_start`/switch (`hc label $HC_TERMINAL_ID pi-chat.session=<file>`;
it already reports hand-off sessions this way, `extension/herdr-chat-lock.ts:
47-61`). The lock stays correct: the host takes it after the TUI exits.
**Verified** (source) for the mechanics; the parent's confusion at the exit
note is the cost. Could be offered from B's menu for `pi` sub-agents
("Continue as chat").

### G. An observer host for a plain `pi` sub-agent

Leave the TUI running; start a host in `--observe <session.jsonl> --terminal
<t>` mode (no agent process) that tails the JSONL and maps entries with the
existing `historyEvents` (session `message` entries are the `get_messages`
records it already handles: `host/providers/pi/adapter.ts:92-131`; entry
shapes verified in a live session file: `session`, `session_info`,
`model_change`, `thinking_level_change`, `custom`, `message`), takes status
from `hc get <t>`, and sends the composer's text with `hc send <t>` (into the
TUI). The parent's control is **untouched**; the view is coarse (Pi writes a
message when it is complete, so no streaming or live tool progress). B
applies unchanged (the row's label points at the observer's chat id). Medium
cost: a new adapter and a host mode, plus the session label from F.
**Inferred** design; nothing verified beyond the file format.

---

## 3. Recommendation

**Build A + B, then C.** A makes a sub-agent a chat host with the parent's
semantics intact (verified host-only). B puts the chat exactly where the peek
appears for the one route users click; C covers the Rust peek with one
right-click. C′ is the "keep" equivalent for chats and can follow. Leave D
unless a key is wanted; skip E; F and G are the answers for other tools'
sub-agents, G being the honest one (no process swap) and F the cheap one.

### 3.1 Changes this needs (not made here)

Host / launcher:
- `bin/pi-chat-subagent` (or `pi-chat-host run`): fresh chat id, the app's
  state dir, `config.json`'s binaries, self-labels (`pi-chat.chat`,
  `pi-chat.role=subagent`, `pi-chat.provider`), `--cwd "$PWD"`, pass-through
  of agent arguments; a transcript hint line.
- Templates under `~/.config/herdr-core/templates/` written by `install.sh`
  (opt-in flag), one per provider (`pi-chat`, `claude-chat`, `codex-chat`;
  Codex with `--no-daemon` as `hc --skill` requires).

Mod:
- Peek mode (`props.peek`): no place lookup or document writes, no
  `reapLater`, header bar (name, status, "from <parent>", Open as tab, ✕),
  banners for a sub-agent ("ended", no Restart), `/tui` disabled or opened in
  the parent's tab.
- `sweepOrphans`: leave `role !== "host"` alone (already), and never touch a
  terminal with a `parent`.
- `close()` / `healHost`: park, never kill or restart, a host with a `parent`
  (C′).
- Chat parents: addresses in assistant text as links (the chat renders
  markdown, so Cmd-click on an address exists only in TUI parents) → the chat
  peek for chat-host children, `terminal.peek` for others.

Install:
- `mods/chat-agents/` (copy + override) and `mods/chat-menu/` (copy + item),
  the layout slot edit (`agents` block → `chat-agents`, root
  `terminal_menu`), gitview-style find-or-clone of the person's layout and an
  exact uninstall; a guard that the copied base still routes clicks through
  `peek(`.

### 3.2 Experiments still needed (app runs; a private app as in split-glitch §5)

- **E1 (B).** Start a fake-agent host as a sub-agent of a fake parent (`hc run
  --parent`), install `chat-agents`, click the row: a 0.8×0.8 dialog with the
  chat; `herdr-app status` overlays; `chat.dump` shows `placeFrom: null`,
  `hideWrites: 0`; keys reach the composer; **Esc**: does it close the dialog
  before the chat sees it (expected yes); click beside it closes; re-open
  three times; the host survives 90 s with another chat tab open
  (`sweepOrphans`) and after the overlay closes (`reapLater`). Same with
  `kind: "window"` + `key`.
- **E2 (A).** A real TUI parent (`pi`) runs `hc run --bg --name r pi-chat
  "task"` with the template: `first_message.sent: true`; the row nests under
  the parent with the Pi icon; `hc wait r`, `hc send r`, `hc read r`, `hc
  interrupt r`; `--rm`; killing the parent ends the child; the parent gets the
  blocked note when the chat shows a dialog. Then the same from a chat parent
  (the hidden host is the parent): nesting under the chat's row.
- **E3 (C).** Cmd-click the child's address in the parent's TUI: the Rust peek
  shows the transcript; right-click → Open as chat replaces it. `terminal_menu`
  on `main-mods.json` is honoured (no "terminal menu mod not found" warning in
  the log).
- **E4 (C′).** Open as tab: the hidden host node appears; the row is listed
  twice (#534); closing the tab parks it (back under the parent, still
  answering `hc send`).
- **E5 (E).** `terminals()` `cols/rows` of the child before, during and after a
  peek, and on a second peek (expected: no change the second time).
- **E6 (F).** Hand-over of a plain `pi` child while idle: the parent's `hc wait
  --children any` returns with the exit; `hc send <name>` reaches the new host.

### 3.3 Results of E1–E4 (built, then run once in a private app)

Run as the explicit-only E2E flow `subagent-exp` (`tests/e2e/run.sh <dir>
subagent-exp`, `tests/e2e/flows-subagent.sh`; findings in the artifacts'
`findings.txt`), Herdr app 0.1.13, hc 0.1.17, on the built feature (the
chat-agents/chat-menu mods, the chat's peek mode, `bin/pi-chat-subagent`).
The private window was never raised (`E2E_NO_VISUAL=1`); it happened to be
drawn, so keys landed. Clicks went through the mods' own commands, which run the
click handlers' code (`chat-agents.peek:<t>` = a row's `this.peek`). E5 and E6
were not run.

- **E1 (B): verified, except Esc, which is the opposite of the inference.**
  - The row's click opens one overlay, `["chat"]` in `herdr-app status`. The dialog's dump shows `placeFrom: null`, `place: null`, `hideWrites: 0`.
  - A key typed right after the open lands in the composer. The composer's own `focused` flag read `false` in the dump, though: its `focus` event didn't fire for the focus taken while loading.
  - Three more clicks still leave one chat overlay (chat-agents closes the one it opened).
  - **Esc while the sub-agent works: the dialog stays open and the run stops** (status `idle`). The chat's own `escape` binding, in its deeper `PiChat` context, wins over the app's `Overlay` binding. The inference above (Esc closes before the chat sees it) is **wrong**.
  - So the chat closes the dialog itself on an Esc with nothing to stop, cancel or close (peek mode). **Esc while idle: the dialog closes.** The hint line says "Esc closes" while idle and "Esc stops" while working.
  - A click beside the dialog: not tried (needs the pointer; source: `window.rs:4283-4296`).
  - The host survives the dialog's close and 90 s of another chat view's `sweepOrphans`: verified in the `subagent` flow (below).
  - `kind: "window"` with a `key`: not tried (the dialog was chosen).
- **E2 (A): verified with a shell as the parent, not a real `pi` TUI.**
  - `hc run --parent <shell> --name r pi-chat "<task>"`: `first_message {"sent": true, "started": true, "turn": 0}`. The child's parent is the shell. `hc read` shows the transcript and the hint line.
  - `hc wait r` returns (the turn was already `done`). `hc interrupt r` during a long tool: `idle`.
  - `hc kill` of the parent: the child `finished`.
  - A startup dialog in the child: status `blocked` with the dialog's title as `msg`.
  - A chat as the parent (`--parent` = its hidden host): the child's `parent` is that host, and the host is listed in `agents()`, so the child nests under the chat's row.
  - Not tried: `--rm`; the parent's own blocked note, and the Pi icon in the row (`hc get` showed no `agent` field; the OSC reports `app=pi`).
- **E3 (C): verified, except the right-click itself.**
  - `terminal.peek` of the child shows as `["layout", …]` in the overlays. Its terminal is the transcript `hc read` prints.
  - The menu chat-menu, opened for that terminal as a right-click opens it (`chat-agents.menu:<t>`), with **Open as chat** picked: overlays `["toast", "chat"]`. The peek and the menu closed, and the chat dialog opened.
  - `terminal_menu: "chat-menu"` on the clone is honoured: no "terminal menu mod not found" warning in the app log.
  - A real right-click: not tried (needs the pointer).
- **E4 (C′): verified, built differently from §2's C′.**
  - Closing a tab ends its panes' terminals, a kept sub-agent's too (`tab.close` → `remove_tab` + `kill`, `window.rs:2886-2896`, `2636-2660`). Verified: `terminal.keep` of the child, then `tab.close` of that tab → the child `finished`.
  - So Open as tab does **not** adopt the host as the tab's hidden pane. The tab holds the chat pane alone (`props.subagent`). The host keeps no `herdr.*` labels and stays a paneless tree row under its parent. It isn't listed twice (no #534), and isn't in `agents()`.
  - Closing the tab leaves the host live, under the parent, still answering `hc send`. The cost: the tab gets no Herdr status, dots, toasts or `cmd-]`. The row under the parent keeps those.

The regression flow `subagent` (part of the default run) checks the same path
end to end: the template launch, the row's click, a send typed in the dialog
and answered (and seen in the parent's `hc read`), Esc closing it, the host
alive after the close and after 90 s of another chat's sweeps, reopen, Open as
tab, the tab closed (live, paneless, answering `hc send`), the Rust peek's menu
→ Open as chat, and `hc kill`.

---

## 4. The host-only experiment

What herdr-core does for a template launch, replayed against the real host
with `fake-pi` (`tests/fake-pi`, scenario `abort.json`: prompts containing
"quick" get a short answer), outside any app. A scratch
`subagent-launch.test.ts` (not committed), run with `node --test` from
the repo (Node 26.5, Pi fake reporting 1.5.0).

Recipe:
1. Spawn `host/main.ts serve --chat sub-t99 --cwd <tmp>/cwd --state-dir
   <tmp>/state --pi fake-pi.mjs -- --session-dir <tmp>/sessions` with
   `HC_TERMINAL_ID=t99`, stdio piped; collect stdout.
2. Wait for the first OSC 7501 on stdout (core's `ready` default). Check the
   registry has a port by then.
3. Write what core types for a template: `ESC[200~<body>\n\n<task>ESC[201~\r`
   at once, before fake-pi is ready.
4. Wait for `working`, then for a non-working state (what `hc wait <t>` does).
5. Connect a chat client (what the mod does from the registry) and check the
   user item (`source: "external"`) and the answer.
6. Write a second paste with an `<hc from="t59 lead">` envelope; wait for the
   second answer.
7. `SIGHUP` (what `hc kill` / the parent's end delivers); check exit 0 and the
   registry.
8. A second run: plain launch, paste right at the first status (what `hc wait
   helper; hc send helper "…"` does), a lone ESC while idle.

Results:

```
first status: idle, 0 ms after the registry's port appeared
paste → working: 48 ms
status sequence (deduplicated): idle, working, done
after the second send:          idle, working, done, working, done
transcript (what hc read shows):
  pi-chat-host · chat sub-t99 · /…/cwd
  > You are a focused review agent. Read the code before giving findings.
    
    quick: Review src/x.rs only. Report with hc send t59 when done.
  Quick answer.
  > [t59 lead] quick: Recheck the error path.
  Quick answer.
client: user item text = "<body>\n\n<task>", source external; second user item from "t59 lead"
SIGHUP → exit 0; registry: pid null, port null, sessionFile kept, terminal "t99", piVersion "1.5.0"
plain launch: statuses idle, working, done; a lone ESC while idle leaves the host running; SIGTERM → exit 0
both tests pass (344 ms, 541 ms)
```

Not covered here (needs the core or the app): the core's `turn` counter
advancing on these status changes (the `terminal.wait` rule is read from the
schema), `hc send`'s refusal while `blocked`, and the peek itself.
