# The split glitch: keeping the chat in Herdr's agents list without a visible host pane

**Question.** Splitting a chat tab (`cmd-j v`, `cmd-d`, `cmd-e` → herdr-nvim,
`cmd-shift-g` → gitview, `/tui`'s editor…) ends the zoom that hides the host
terminal. The mod then parks the host (`terminal.park`), which reflows the tab
a second time and drops the chat out of the agents list while the split lasts.
Is there a workaround, with no change to Herdr, that keeps the chat listed as an
agent (plus `cmd-]`/`cmd-[`, the tab and space dots, Herdr's own toasts) and
makes splits look normal?

**Short answer. Yes: hide the host's pane instead of parking it.** A pane node
in a tab's tree takes the same `hidden: true` flag as any layout node. Herdr
doesn't draw a hidden pane and gives it no room, but it is still a pane of the
tab, so its terminal is still an agent: listed, navigable, rolled up into the
tab and space dots, and alerted on. The flag is set by editing the core's
`herdr-app` layout document (`doc.get`/`doc.set` over `hc connect`), which the
app re-reads live (≈0.5 s) and preserves through its own writes, splits,
closes and restarts. **Verified** in a private Herdr 0.1.12 (§5): a split then
inserts the new pane beside the chat with the host still hidden, closing it
restores the chat to full width, no frame ever draws the host, `agents()` keeps
the host with its pane, the tab dot and Herdr's "needs you" toast come from the
hidden host. No zoom is needed any more, so the "Z" marker goes too.

The cost: it writes the layout document, which Herdr's docs treat as internal
("Use commands to change structure"). It relies on behavior that is in the
source and in the shared document format, not on a documented command. The
documented fallback, `layout.resize {id: <host pane>, px: 0}` (it does reach tab
panes, contrary to what we concluded before), leaves an 8 px seam and a
zero-width pane header. Everything else on the table either keeps the chat out
of the list, reflows, or is impossible by construction (§4).

## Sources

- **App source**, `herdrdev/herdr-app` at tag `v0.1.12` (commit `4aa3460`), the
  version installed here (`herdr-app 0.1.12`). Cited as `file:line`. `HEAD`
  (`816d205`, 2026-11-04) was diffed against the tag: none of the cited code
  changed (`model.rs`, `layout.rs`, `mirror.rs` are identical; `window.rs`
  changes are elsewhere).
- **Core**, `herdrdev/herdr-core` `schema/README.md` ("Documents", "Events"),
  installed `hc 0.1.17`.
- **Installed docs**: `~/.config/herdr-app/AGENTS.md` and `herdr.d.ts`
  (0.1.12), the shipped mods `agents`, `tabs`, `pane`, `peek`, the user's
  `layouts/main.json` and `keys.json`.
- **Prior art**: [herdr-nvim](https://github.com/ChmaraX/herdr-nvim) (`src/app/sidebar.rs`,
  `src/app/doc.rs`), [herdr-gitview](https://github.com/ChmaraX/herdr-gitview) (`src/apphost.rs`), and
  herdr-app issues #117, #192, #386, #460, #503 (read only).
- **Experiment** (§5): a private Herdr app and core built on
  `tests/e2e/lib.sh`, a probe mod and a fake agent. The scripts were
  scratch files (not committed); the recipe and raw results are
  in §5 so it can be rebuilt.

Claims are marked **verified** (source read and/or experiment) or
**inferred** (from source only, not run).

---

## 1. Root cause

### 1.1 Why a split ends the zoom

Every split goes through `Model::split_with`, which clears the tab's zoom
unconditionally:

```rust
// src/model.rs:281-291
pub fn split_with(&mut self, target: &str, axis: Axis, block: Node) -> bool {
    …
    if !c.root.split(target, axis, block, container) { return false; }
    c.zoomed = None;
    c.focus(&new_pane);
    true
}
```

All the user's triggers land there: `pane.split` with a terminal or a mod
(`src/window.rs:2389-2415`, `2865-2876`), `terminal.open {place: right|down}`
(`2936-2940`), `terminal.keep {place: right|down}` (`2456-2482` →
`apply_terminal_change` → `model.split`, `2532-2549`), herdr-nvim's `cmd-e`
(`mod.open:herdr-nvim` → `herdr-nvim toggle` → `pane.split` on the tab's root
node, herdr-nvim `src/app/sidebar.rs:72-125`), gitview's diff
panes (herdr-gitview `src/apphost.rs:351-403`, `pane.split`), and a
pane drag (`move_pane`, `src/model.rs:296-323`). Only label adoption keeps the
zoom (`src/window.rs:2109-2141`, `adopt` saves and restores `tab.zoomed`),
which is why the mod's "zoom first, then adopt" trick works.

A zoom shows exactly one node: `Tab::shown()` is the zoomed pane or the whole
root (`src/model.rs:139-141`), and the renderer draws `c.shown()` only
(`src/window.rs:1187`). So "keep the zoom through a split" is impossible by
construction: a zoomed tab can never show two panes, and an unzoomed tab shows
every non-hidden pane. **Verified** by reading; no key rebinding changes it,
because every split path above ends in `split_with`.

### 1.2 Why parking is a second reflow and drops the chat from the list

`terminal.park` is asynchronous: it writes `herdr.space=""`, `herdr.tab=""`
and `keep=false` to the core, and only when the core answers does the app
remove the pane (`src/window.rs:2484-2496`, `2497`, `2551-2553`). Hence
`pending: true` and the second layout jump after the first (the unzoom).
Nothing can make it happen in the same frame as the split.

### 1.3 What makes a terminal an agent (the exact rule)

`agents()` is built in `publish` from **the panes of every tab**, keeping those
whose terminal has a status:

```rust
// src/window.rs:1637-1667
for p in ctx.root.panes() {
    …
    let Some(addr) = p.terminal() else { continue };
    …
    let Some(status) = m.status(addr) else { continue };
    agents.push(json!({ "address": addr, "pane": p.id, … }));
}
```

`Node::panes()` walks the whole tree, hidden nodes included
(`src/layout.rs:545-548` uses `walk()`, which never looks at `hidden`;
only `visible_blocks()` does, `550-562`). The same tree feeds everything else
the user cares about:

| Feature | Source of truth | Cite |
|---|---|---|
| agents list entry (`agents()`) | `ctx.root.panes()` with a status | `window.rs:1639`, `1658-1659` |
| tab and space dot (`status`) | `rollup(addresses(&c.root))` | `model.rs:588`, `608`, `531-533` |
| Herdr's toast + sound | `alert_for` requires `pane_of(addr)` | `model.rs:475-480` |
| `agent.next`/`agent.prev` order | `all_addresses()` with a status | `window.rs:1316-1319`, `3046-3060` |
| `agent.focus`, a click in the list | `pane_of(addr)` → `focus_pane` | `window.rs:1350-1356`; agents mod `pane.focus` |
| tab icon in the tab bar | first pane in the tab whose program is an agent | `mods/tabs/main.js:56` |

Every one of them is keyed on **having a pane in the tab tree**, not on being
drawn. A parked terminal has no pane → out of all of them (the mod's
`notifyParked` re-creates only the toast, `mod/chat/main.js:460-476`).
Sub-agents (`parent`) are the one exception the shipped `agents` mod makes,
nested under a parent agent (`mods/agents/main.js:169-179`), and #460 confirms
they are left out of the dots.

### 1.4 Corrections to what we concluded before

- **"No pane-resize command."** Wrong: `layout.resize {id, px|weight}` resolves
  the id in the shown layout first, then in every tab's tree
  (`src/window.rs:3284-3289`, `3129-3137`; the command's pre-check even
  derives the tab's machine, `2787-2789`). herdr-gitview already uses it on
  tab panes (`apphost.rs:347-349`, `weigh`). **Verified** in §5 (px 0 and
  weight 0 both applied). Issue #117 predates this and is stale.
- **"No way to hide one pane."** No *command* reaches a pane's `hidden`
  (`layout.toggle|show|hide` only search the chrome,
  `src/window.rs:3120-3128`). But the tab tree is made of the same `Node`
  type as the layout, and `Node.hidden` is honored wherever a tab is drawn:
  `render_node` filters `children.iter().filter(|c| !c.hidden)`
  (`src/window.rs:3880`, `4110`) and `visible_blocks()` skips hidden nodes
  (`src/layout.rs:550-553`). Setting it needs the document (§3).
- **"The layout document: is it read live?"** Yes. The app subscribes to core
  events; a `doc` event marks the slot dirty (`src/hc.rs:107-109`,
  `src/window.rs:655`, `688`), `flush_documents` re-reads with `doc.get`
  (`1752-1781`), and a newer version replaces the model's spaces while
  focus, zoom and settle are kept per screen (`1829-1877`,
  `src/mirror.rs:115-139`, `View::apply` `196-214`). The document serializes
  each tab's `root: Node` whole (`src/mirror.rs:24-31`), so `hidden`, `size`,
  `min`, `max` on pane nodes round-trip. **Verified**: applied within one
  polling step (≤1.5 s in §5; the app's loop is 500 ms).
- **`terminal.show {terminal, pane}`** swaps a terminal view into a *terminal*
  pane only (`swapped.retain(|p, _| model.address_of(p).is_some())`,
  `src/window.rs:1375`); a terminal that has its own pane is focused there
  instead (`3007-3023`); `pane.focus` ends the swap (`2923`). The swapped-in
  terminal is not that pane's agent (`agents()` still names the pane's own
  terminal). **Verified** (§5: `terminal.show` of the host onto the chat's mod
  pane just focused the host's own pane).
- **Overlays** (`openOverlay {kind: "window", layout: {terminal blocks}}`)
  are positioned in window coordinates (`at`), not anchored to a pane; mods
  get no pane geometry (#315). Overlay terminals are drawn (`1204-1207`) but
  are not tab panes, so they are not agents.
- **Pane headers** are one mod per *layout*, with one `height` for every pane
  (`src/layout.rs:223-234`, `PaneFrame` `249-270`); a header "grown over" the
  host pane would grow over every pane in the window.

---

## 2. The recommendation: a hidden host pane

Keep the host's pane in the chat's tab, **marked `hidden: true`**, for the
whole life of the chat. Never zoom, never park.

### 2.1 What the user sees

| Situation | Today | With a hidden host pane |
|---|---|---|
| Open a chat | chat zoomed over the host; tab shows "Z" | chat alone in the tab; no "Z" (**verified**: `zoomed=false`, width equal to a lone pane) |
| `cmd-j v`, `cmd-d`, `cmd-shift-d` | unzoom (host visible), park 400 ms later (reflow again) | one reflow: chat \| new pane, exactly as splitting any pane (**verified**: tree `[chat ½, new ½, host hidden]`, chat 491 px of 993; no host frame drawn) |
| `cmd-e` (herdr-nvim), gitview diff panes | same two jumps | one reflow; nvim is split off the tab root as it does for any tab (**verified** with a root split) |
| close the split | host adopted back, chat zoomed again (a third jump) | chat back to full width in one step (**verified**: 993 px, tree `[chat, host hidden]`) |
| agents list | gone while split | always listed, "Working / Needs you / Done", Pi icon, the tab's name (**verified**, screenshot) |
| click the agent, `cmd-]`/`cmd-[`, `agent.focus` | lands on the host pane behind the zoom; the mod refocuses the chat on its next tick | identical: `focused().pane` becomes the hidden host pane (**verified**), the mod's existing redirect (`mod/chat/main.js:312-320`) brings the chat back. Same keyboard gap as today (≤400 ms; see §2.4) |
| tab and space dots, status bar count | from the host while zoomed; nothing while parked | always from the host (**verified**: blocked → red dot, "1 needs you"; finished unseen → done) |
| Herdr's own toast and sound | only while not parked (the mod fakes one while parked) | Herdr's own ("host needs you · probe / chat", **verified**, screenshot); `notifyParked` can go |
| `/tui`, `/login`, editor hand-offs | the new terminal is adopted and zoomed over the tab | unchanged: adopted into `[chat, host hidden, tui]`, the mod zooms the TUI pane as now; when it exits, `remove_pane` clears the zoom and the chat is full again (`model.rs:328-333`) |
| Transcript | zooms the host pane, or peeks when parked | must always **peek** (`terminal.peek`): zooming a hidden node shows nothing (`shown()` = a node with no visible blocks). Peek works on any live terminal (`window.rs:3495-3509`, **verified** by reading) |
| `hc read`, `hc send`, sessions | unchanged | unchanged (the host process is untouched) |
| app restart | host re-adopted, zoomed | the document keeps the hidden pane (**verified** after `restart_app`: still hidden, listed, chat full width) |
| "done" turning "idle" when you look | never (a zoomed-over pane is not "visible" to `share_seen`) | same by default; fixable with the shared `herdr.seen=<turn>` label (**verified**, §2.5) |

Small warts, all **verified** or **inferred** from source:
- The chat pane gets a drag grip on top-edge hover, because `pane_movable`
  counts hidden panes (`src/window/pane_drag.rs:38-47`). Dropping it on itself
  cancels. Today the zoomed chat has no grip.
- Pane frames: unchanged (the user's `main` layout has `lone: true`, and a
  2-pane tab is framed anyway, `window.rs:3828`).
- `herdr-app ls` and `panes()` list the hidden pane like any other; mods
  that count panes (`TabInfo.panes`) see 2.

### 2.2 How the mod sets it

Two orders work; both were run (§5, runs 2 and 3).

**(b) Add the node yourself, then label — recommended.** No zoom, no frame
ever shows the host (its pane header rendered **0** times).

1. Start the host **without** `herdr.*` labels: `hc run --bg --keep
   --no-parent --label pi-chat.chat=… --label pi-chat.role=host -- …`
   (`--keep` so the core keeps it, as adoption would).
2. `doc.get herdr-app` → find this chat's tab (`place.js` already does this
   by `props.chat`) → append to its root row
   `{"id": "p<32 hex>", "type": "block", "hidden": true, "content":
   {"terminal": "<addr>"}}` → `doc.set` with the version read. On `conflict`,
   read again and retry (the edit is idempotent).
3. When the document shows the node, `hc label <addr> herdr.space=<s>
   herdr.tab=<t>` so `where`/`hc ls` and every client agree. The app will not
   adopt it a second time: `reconcile` only places labeled terminals **without**
   a pane (`src/window.rs:2049-2072`, `pane_of(a).is_none()`). **Verified**:
   one pane after labeling, `keep: true`, no app errors.

**(a) Adopt as today, then flip the flag.** Zoom the chat, let Herdr adopt the
host, `doc.set` `hidden: true` on its node, unzoom ≈1 s later. Simpler diff,
but the host pane is drawn for a frame or two between adoption and the zoom
(its header rendered twice in the run even with a tight poll), exactly as
today.

Either way, drop `keepHostOutOfSight`'s park/adopt branches
(`mod/chat/main.js:425-458`), `notifyParked`, `reapLater`'s "parked" case,
and the zoom-on-adopt (`304-311`). Keep `healHost` (a host in the wrong tab)
and the focus redirect.

### 2.3 Edge cases the implementation must cover

- **Closing the chat pane** (`cmd-shift-w`, `cmd-j x`, the header's ×). With
  two panes, `pane.close` removes only the chat (`window.rs:2883` closes the
  tab only when `panes().len() == 1`), leaving a tab whose only pane is hidden:
  nothing drawn, the hidden pane focused (**verified**). The mod's `close()`
  must end the host whenever the layout document no longer has the chat's
  pane (today's `reapLater` does this only for parked hosts and bails when the
  host has a tab label: `mod/chat/place.js:36-52`). When the host's terminal
  ends, `terminal_ended` → `remove_pane` → the tab closes with its last pane
  (`window.rs:2213-2241`, `model.rs:328-345`). On app quit the document still
  holds the chat's pane, so the host survives, as now.
- **Host restart** (Restart, `healHost`): the old pane goes with the old
  terminal; add a new hidden node for the new address (same steps as 2.2).
- **A chat whose document has the host visible** (a chat open before the
  change, or a client that dropped the flag): set `hidden` on the existing
  node; it's the same `doc.set`.
- **Write conflicts.** The app writes the document right after every command
  and whenever its projection differs (`flush_documents`). Our CAS write can
  lose (→ `conflict`, retry) or, if it lands during the app's own write, make
  the app lose that write and toast "Layout changed elsewhere"
  (`window.rs:1829-1850`, `1882`). The window is the app's `doc.set` round
  trip, milliseconds. Write once per host, when the tab is quiet (no pane
  change seen in the last few hundred ms), and the risk is negligible; it was
  never hit in the runs.
- **Remote spaces**: not applicable (the chat is this computer only); the
  document has `on: <machine>` if ever needed.

### 2.4 The keyboard gap on `agent.focus`

Herdr focuses the hidden pane (`focus_agent` → `focus_pane`), so keystrokes
reach the host's pty until the mod runs `pane.focus` on itself (today in
`tick`, ≤400 ms). Behind a zoom it is the same (#503 describes this class).
Improvement available: the mod re-renders when `focused()` changes, so it can
notice `focused().pane === host.pane` in `render` and schedule the redirect
with `cx.spawn` instead of waiting for the timer. Not required for parity.

### 2.5 Bonus: "done" clears when you look at the chat

Herdr marks an agent seen only when its terminal is drawn
(`visible_addresses`, `window.rs:1338-1348`, `share_seen` `1497-1537`), so a
hidden (or zoomed-over) host stays "done" until its next turn. Every client
shares seen-ness through the label `herdr.seen=<turn>`
(`herdr-app/docs/labels.md`): the mod knows when the person is looking
(window active, its tab shown, as `notifyParked` already computes) and can
`hc label <host> herdr.seen=<turn>` with `turn` from `terminals()`.
**Verified**: `agents()` went `done` → `idle` on the label.

### 2.6 Cost and risks

- **Undocumented surface.** Writing the layout document is API-only ("Use
  commands to change structure", AGENTS.md; #117 calls it internal). The
  format is the serde of `Node`, shared by every Herdr client and persisted
  by the core, so it changes rarely; `hidden` is a documented node property
  (AGENTS.md, "Properties any node can have"), just not documented for panes.
  A future app could strip or reject it: then the fallback is §4-E
  (`layout.resize px 0`, documented, verified) and the chat degrades to an
  8 px seam, never to a parked, unlisted host.
- **One more moving part**: `doc.get`/`doc.set` through `hc connect`, which
  `place.js` already does for reads.
- **Nothing to upstream is required.** If one line were accepted upstream,
  `layout.hide {id: <pane>}` reaching tab panes (use `find_node_mut` in the
  `layout.toggle|show|hide` arm, `window.rs:3122`) would make this a
  documented command; worth an issue, not a dependency.

---

## 3. Mechanics of the document write

```sh
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"hello","params":{"generation":1}}' \
  '{"jsonrpc":"2.0","id":2,"method":"doc.get","params":{"name":"herdr-app"}}' | hc connect
# → {"result": {"value": {"spaces": [{"id", "name", "folder", "tabs": [{"id", "name", "root": <Node>}]}]}, "version": N}}
# edit root: set "hidden": true on the host's block (or append a hidden block), then
# {"method":"doc.set","params":{"name":"herdr-app","version":N,"value":<doc>}}
# → {"result": {"version": N+1}}  or  error kind "conflict" (read again)
```

The core raises a `doc` event (`herdr-core/schema/README.md` "Documents",
"Events"); the app's listener re-reads and replaces its model (§1.4). Pane
nodes carry `size` as the app wrote them (`{"weight": 0.5}` after a split);
leave sizes alone. In the render, weights are summed over **shown** children
only (`window.rs:3883-3887`), so the hidden node's weight takes no room
(**verified**: chat ½ + new ½ with a hidden ½ present).

---

## 4. Every candidate, ranked

| # | Candidate | Listed while split | Dot / toast / `cmd-]` | Reflows on split | Verdict |
|---|---|---|---|---|---|
| **D** | **hidden host pane** (§2) | yes | yes / yes / yes | 1 (the split itself) | **recommended** |
| E | `layout.resize {id: host, px: 0}` | yes | yes / yes / yes | 1 | fallback: 8 px seam + zero-width header |
| C | never park (host pane stays visible) | yes | yes | 1 | a plain terminal pane shows in every split |
| A | park "in the same frame", blank host screen | no | no / mod-made / no | 2 (park is async) | can't be same-frame |
| B | clone the `agents` mod to list parked chats | list only | no / mod-made / no | 2 | loses the dots, toasts, navigation; a fork to maintain |
| F | invert roles: chat drawn over a visible host pane | yes | yes | 1 | no anchored overlay, header height is per layout, `terminal.show` can't take a mod pane |
| G | keep the zoom through a split (rebind keys) | n/a | n/a | n/a | impossible: `split_with` clears zoom; a zoom shows one pane |
| H | host as a sub-agent (`parent`) of something | nested only | no (#460) | — | nothing to be a child of |
| I | the host's tab is the agent; the chat is another tab | yes (wrong tab) | yes (wrong tab) | — | the list opens a terminal, not the chat |
| J | `tab.settle`, window overlays, `programs.json` | — | — | — | unrelated to the question |

Details:

- **E. `layout.resize` to 0 px (or weight 0).** Documented command, reaches
  tab panes (§1.4). **Verified**: the chat became 985 px instead of 993 (the
  layout's 8 px pane `gap` stays, `render_node` draws a separator per shown
  child, `window.rs:3892-3894`), the host's pane header mod still renders at
  zero width (`frame_pane`), and the chat's frame stops 8 px short of the
  tab's right edge (screenshot `04-px0.png`, compared with `02-hidden-host.png`). Sizes are rewritten by the app's own
  splits (`Node::split` halves the target's weight, `layout.rs:574-606`;
  `remove` gives a closed pane's share back to its neighbor), so a 0 weight
  can grow back after a split-and-close next to it (**inferred**: weights
  only move between the split target and the new pane, so a host next to the
  chat keeps 0 unless the chat is removed). Use only if D stops working.
- **C. Never park.** What the user sees today in the first ~400 ms, kept
  forever: a plain terminal with the host's transcript beside nvim. Rejected
  by the user already.
- **A. Park in the same frame.** `terminal.park` acknowledges `pending: true`
  and removes the pane only after the core applies labels and `keep`
  (`window.rs:2484-2497`, `2551-2553`). No render-time hook exists for mods
  (they see `panes()` after the fact). Even perfectly timed, the chat is out
  of the list while split (§1.3).
- **B. Clone the agents mod.** Possible (`mod.clone`, a `terminals()` filter
  on `pi-chat.role=host` and `setAgentOrder`), and `agent.next` would follow
  the mod's order only for addresses that are agents in the model
  (`mods::agent_order` filters by `m.status(a).is_some()` over
  `all_addresses()`, `window.rs:1316-1319`) — a parked host isn't, so
  `cmd-]` skips it. Tab/space dots (`space_json`) and `alert_for` are in Rust.
  The fork also has to track Herdr's `agents` mod releases.
- **F. Invert the roles.** Overlays: `openOverlay` windows sit at window
  coordinates (`herdr.d.ts` `OverlaySpec.at`), over every tab, and mods
  have no pane bounds (#315). Headers: one height for all panes
  (`layout.rs:223-234`). `terminal.show`: terminal panes only
  (`window.rs:1375`). An `{agent: "focused"}` block is a chrome block that
  shows one agent full size (`layout.rs:30`), not a per-tab pane.
- **G. Keep the zoom.** §1.1. Rebinding `cmd-j v` to a mod command cannot help:
  the mod would still have to call `pane.split`, which clears the zoom, and a
  zoomed tab cannot show two panes. herdr-nvim and gitview split through the
  CLI anyway.
- **H/I.** A sub-agent needs a parent that is itself a listed agent; the chat
  has none. A separate host tab makes the agents list open the wrong tab.

---

## 5. The experiment

A private Herdr app and core (own `HERDR_APP_HOME`, `HC_SESSION`, XDG dirs;
`tests/e2e/lib.sh` with `E2E_NO_INSTALL=1 E2E_NO_VISUAL=1`, the window never
raised; `herdr-app shot` for frames). Versions: herdr-app 0.1.12, hc 0.1.17,
macOS 26.5.1. A minimized window lays nothing out (no `on_size_change`, no
renders), so the window stayed un-minimized behind the person's windows.

Instruments:
- **probe mod** (`mods/probe/`): every 300 ms writes `agents()`, `panes()`,
  `focused()`, `spaces()` and its own `on_size_change` size to
  `<appHome>/probe/<role>.json`. As `{role: "pane"}` it stands in for the chat
  (a `tab.new {mod: "probe"}` tab); as the layout's pane header
  (`{role: "header"}`, in a copy of `main` with the header mod swapped) one
  copy per **drawn** pane records its render count and last render time —
  a pane whose header never renders was never drawn.
- **fake agent**: `sh fake-agent.sh <statefile>` prints OSC 7501
  `state=<working|blocked|idle>:app=pi` whenever the file changes.
- Document edits over `hc connect` (`doc.get`, edit in Python, `doc.set` with
  the version).

Recipe (run 2, abridged):

```sh
herdr-app do space.new --name probe --folder /tmp/x            # → SPACE, SHELL_TAB
herdr-app do tab.new --name chat --space $SPACE --mod probe --props '{"role":"pane"}'   # → TAB, CHAT
hc run --bg --json --keep --no-parent --label herdr.space=$SPACE --label herdr.tab=$TAB -- sh fake-agent.sh $STATE
# wait for the doc to show the host's pane HOSTPANE in TAB, then:
doc.set: HOSTPANE.hidden = true
herdr-app do pane.split --direction right --pane $CHAT ; herdr-app do pane.close --pane $NEW
herdr-app do pane.split --direction down  --pane $CHAT ; … ; pane.split --pane <tab root> (herdr-nvim's way)
herdr-app do agent.focus --terminal $HOST ; herdr-app do agent.next
herdr-app do tab.select --id $SHELL_TAB ; echo blocked > $STATE ; herdr-app status   # toast?
restart the app ; herdr-app do layout.resize --id $HOSTPANE --px 0 ; terminal.show ; pane.close $CHAT
```

Raw results (run 2, trimmed; widths are logical px of the probe pane in a
1280×820 window):

```
chat width alone: 993
host adopted → tree: TAB(row)[CHAT(mod:probe,{weight:0.5}) HOSTPANE(t2,{weight:0.5})]
  chat width beside the visible host: 491 ; headers drawn: HOSTPANE CHAT
  agents(): [[t2, HOSTPANE, TAB, working]] ; tab status: working, panes 2, zoomed false
doc.set hidden → version 4 ; applied ≤1.5 s
  tree: …[CHAT(…{weight:0.5}) HOSTPANE(hidden,t2,{weight:0.5})]
  chat width: 993 (= alone) ; headers drawn: CHAT only
  panes(): still lists HOSTPANE ; agents(): [[t2, HOSTPANE, TAB, working]] ; tab status: working
  status: focused_pane CHAT, zoomed None, errors []
pane.split right → tree: …[CHAT({weight:0.25}) NEW(t3,{weight:0.25}) HOSTPANE(hidden,…{weight:0.5})]
  chat width: 491 ; zoomed false ; agents(): [[t2, HOSTPANE, working]] ; headers drawn: NEW CHAT
pane.close NEW → tree: …[CHAT({weight:0.5}) HOSTPANE(hidden,…)] ; chat width: 993
pane.split down → …[s…(column,{weight:0.5})[CHAT NEW(t4)] HOSTPANE(hidden,…)] ; close → as before
pane.split on the tab root → s…(row)[TAB(row)[CHAT HOSTPANE(hidden)] NEW(t5)] ; headers drawn: NEW CHAT
agent.focus host → focused(): {pane: HOSTPANE, terminal: t2, agent: t2} ; agents focused: [[t2, true]]
pane.focus CHAT → focused(): {pane: CHAT, terminal: null} ; agent.next → pane HOSTPANE again
another tab shown, host blocked → tab status: blocked ; space status: blocked ; overlays: ['toast']
host idle, unseen → tab status: done ; overlays: ['toast','toast'] ; chat shown → still done (§2.5)
restart app → hidden survives ; chat width 993 ; agents(): [[t2, HOSTPANE, done]] ; headers drawn: CHAT
unhide → chat width 491 ; layout.resize px 0 → ok ; tree: HOSTPANE({px:0.0}) ; chat width 985 ;
  headers drawn: HOSTPANE CHAT (the host's header renders at 0 width) ; weight 0 → 985
terminal.show host onto CHAT → ok, but focused(): {pane: HOSTPANE} (its own pane was focused)
hide again, pane.close CHAT → tree: s…(row)[HOSTPANE(hidden,t2,{weight:2.0})] ; tab "chat" stays,
  nothing drawn, focused_pane HOSTPANE (→ §2.3)
```

Run 3 (zoom-first order, exact zoom readings) and run 2b (node added by
`doc.set` before labeling):

```
zoom on a one-pane tab: zoomed=false            (pane.zoom needs >1 panes, window.rs:2891-2899)
adopt, zoom at once: zoomed=true, width 993, host header renders=2   (a frame or two of the host)
doc.set hidden, still zoomed: width 993 ; unzoom: zoomed=false, width 993, host header renders=2 (no new frame)
herdr-app ls: chat → [{terminal t2, pane HOSTPANE, status working, app pi, name host}]
another tab shown, host blocked → overlays: ['toast'] ; screenshot: "host needs you · probe / chat",
  red tab dot, agents "Needs you", status bar "1 needs you"
(b) unlabeled host2, doc.set appends {id, type: block, hidden: true, content: {terminal: t3}}:
  tree: …[CHAT HOSTPANE(hidden,t2) pnewt3(hidden,t3)] ; chat width 993 ; agents(): t2 and t3, each with its pane
  host2 header renders: 0 (never drawn) ; hc label herdr.space/tab → still one pane for t3 ; keep true ; errors []
pane.split:right with no pane argument (as the key does) → [CHAT ¼ NEW ¼ HOSTPANE(hidden) pnewt3(hidden)] ; close → 993
tab.rename (the app rewrites the document) → both hidden flags kept
hc label host herdr.seen=<turn> while the chat shows → agents(): t2 done → idle
```

Screenshots taken in run 2/4 (`herdr-app shot`, the window un-raised):
`02-hidden-host.png` (chat alone, tab with the Pi icon, agents "Working ·
probe · chat", no "Z"), `03-split.png` (chat | shell, both framed, nothing
else), `04-px0.png` (the 8 px seam at the right edge), `05-toast.png` (Herdr's
toast for the hidden host).

Everything the experiment started (app, core, holders, fake agents, temp
homes) was ended by `lib.sh`'s cleanup; the person's app and core were only
read (`layouts/main.json`, `window.json` for the display id).
