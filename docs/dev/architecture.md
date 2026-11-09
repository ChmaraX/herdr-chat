# Architecture

herdr-chat has two halves: a **host** process per chat, which drives the
agent, and **mods** in the Herdr app, which draw the chat and send what you
do back to the host.

```
Herdr tab
 ├─ mod pane "chat"   mods/chat   (GPUI, JS: timeline, composer, dialogs, pickers)
 │      │  TCP 127.0.0.1, a token, JSONL (protocol.md)
 └─ hidden pane: a herdr-core terminal (outlives the window)
        └─ herdr-chat-host  (a release: built JS, Node 20+; a checkout: the TypeScript, Node 24+)
               │  one adapter per agent (providers.md)
               ├─ pi --mode rpc
               ├─ claude -p  (stream-json + control protocol)
               └─ codex app-server  (JSON-RPC)
```

## The host (`host/`, `bin/herdr-chat-host`)

- Runs in a herdr-core terminal, so it keeps running when the window closes,
  and Herdr lists it as an agent: status, notifications, `hc send`, `hc read`.
- A provider-neutral core (`chat.ts`, `timeline.ts`, `commands.ts`) sits on
  one adapter per agent (`host/providers/pi|claude|codex/`). An adapter turns
  its agent's protocol into normalized events; the core turns those into the
  same timeline for every agent. The seam is
  [`host/providers/types.ts`](../../host/providers/types.ts); the design is
  in [providers.md](providers.md).
- Supervises the agent in its own process group, and keeps the timeline,
  the queue and the dialogs. A mod that reconnects gets a snapshot, then
  patches (`server.ts`).
- Renders for the wire (`render.ts`): code highlighted with highlight.js,
  Mermaid turned into a self-contained SVG, diffs and tool output as lines.
- Reports Herdr status with OSC 7501, turns `hc send` input on its stdin
  into messages, and prints a plain transcript for `hc read` (`terminal.ts`).
- Writes the chat registry and a lock on the session file (`registry.ts`).
  The Pi extension `extension/herdr-chat-lock.ts` reads that lock, so a Pi
  TUI never writes a session a chat has open.

## The mods (`herdr-app/mods/`)

| Mod | What it does |
|---|---|
| `chat` | The chat itself. Only draws and sends ops; slow work goes through the host. Its keys: [`herdr-app/mods/chat/KEYS.md`](../../herdr-app/mods/chat/KEYS.md) |
| `new-chat` | The launcher (⌘I) and the `new-chat.*` commands. An empty block of it floats in the layout, so those commands reach it |
| `chat-agents` | An install-time copy of Herdr's agents list: a click on a chat sub-agent opens its chat |
| `chat-menu` | An install-time copy of Herdr's right-click menu: Open as chat, Continue as chat |

A mod can't import another, and Herdr restores its shipped mods on every
start, so `chat-agents` and `chat-menu` are copies made by
[`install/mods.ts`](../../install/mods.ts). The install checks each one first
and leaves out a copy whose original changed shape.

## The hidden host pane

The host's terminal is a pane of the chat's own tab, marked `hidden: true` in
Herdr's layout document. Herdr counts it as the tab's agent but never draws
it, so a split of the chat tab looks like any other. No Herdr command hides a
pane, so the chat writes the flag itself (`doc.set`), once per host, timed
around Herdr's own half-second reads of the document. If a Herdr version
drops the flag, the chat falls back to a 0 px pane and says so once. The
whole story: [research/split-glitch.md](research/split-glitch.md).

Closing the chat's pane closes the tab: the host watches the layout document
on herdr-core's event stream and, once its chat's pane is gone, closes its
own pane and exits ([`host/panewatch.ts`](../../host/panewatch.ts)).
Quitting the app doesn't change the document, so the host keeps running.

## Sub-agent chats

An agent that runs `hc run … pi-chat "<task>"` starts a host in place of a
TUI (`bin/herdr-chat-subagent`, `host/subagent.ts`). The core records the
caller as its parent, so the parent's `hc wait`, `hc send`, `hc read` and
`hc kill` work as with a TUI. The chat opens in a dialog from the agents list
(`chat-agents`). Design and the experiments behind it:
[research/subagent-chat.md](research/subagent-chat.md).

For you, in the chat: the helper's row in the agents list opens the chat in
a dialog (80 % × 80 %, dimmed behind). ⌘-click on a sub-agent's address in a
terminal still opens Herdr's own peek of its transcript; right-click there →
**Open as chat**. `/tui` and the other hand-offs aren't offered in a
sub-agent's chat: the session is its parent's to drive. A sub-agent chat's
tab isn't an agent to Herdr (not in `cmd-]`, the dots or Herdr's toasts);
the row under the parent is.

## Continue as chat

`chat-menu` offers **Continue as chat** on an agent's TUI (Herdr reports the
agent: Pi, Claude Code or Codex) that is idle or done. `new-chat`
asks the host which session it has open, `herdr-chat-host tui-session
--provider <agent> --pid <its pid>`; each agent's module answers its own way
(`host/providers/<agent>/tui.ts`):

- **Pi:** the lock extension labels the TUI's terminal with its session file
  (`herdr-chat.session`); the model and thinking level are the session's last
  `model_change` and `thinking_level_change` entries.
- **Claude Code:** its registry of live processes,
  `~/.claude/sessions/<pid>.json` (`sessionId`, `cwd`).
- **Codex:** the rollout file the TUI has open (`codex --no-daemon`), else
  the newest rollout in its folder written since it started (a TUI on the
  shared daemon leaves the file to the daemon); the model and effort are the
  last `turn_context`'s.

Then:

- **A TUI in its own pane:** the chat opens beside it. The agent (only the
  agent, not the shell it runs in) gets SIGTERM, saves the session and quits.
  The chat's host waits for that pid to exit before it opens the session
  (`--after-pid`), so the two never write it at once; while the agent still
  holds it (Codex's daemon keeps a thread up to a minute), the host tries
  again every 5 s for 90 s. Then the TUI's pane closes. The model and
  thinking level are passed as `--model` and `--thinking`.
- **A sub-agent** (`hc run … -- pi`): a terminal runs one program, so the
  TUI ends and a chat host starts in its place, with the same parent, name
  and folder, on that session (the model and thinking as the agent's own
  arguments). The parent sees one exit note for the old terminal; after
  that `hc send`, `hc wait` and `hc read` by name reach the chat.

## The install (`install.sh`, `install/app.sh`, `install/`)

Each change is recorded under `data/herdr-chat/` in the app home, so
`--uninstall` undoes exactly that:

- `mods.ts`: the copies of the shipped agents list and menu;
- `layout.ts`: the layout on screen if it's yours, else your one copy of
  Herdr's, else a fresh clone (`layout.clone`). Its `agents` block shows
  `chat-agents` (what it showed is kept in the block's `props.replaces`),
  its root `terminal_menu` is `chat-menu`, and its `floating` list gets an
  empty `new-chat` block. A slot another plugin holds is left to it unless
  `--take-agents-slot` / `--take-menu`;
- `keys.ts`: the global keys in Herdr's `keys.json`, the file rewritten only
  if unchanged since it was read;
- `instructions.ts`: the marked sub-agents block
  (`<!-- herdr-chat:subagents begin -->` … `end -->`) in each installed
  agent's instruction file; uninstall leaves each file byte for byte as it
  was;
- `compat.ts`: the tested and minimum Herdr versions (`package.json`
  `"herdr"`).

The `hc` templates go to `~/.config/herdr-core/templates/`, never over a
file the install didn't write. An older install left `mods/pi`, the chat
under its old name; the install removes it once no tab or layout shows it.
