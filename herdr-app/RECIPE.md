# herdr-chat

A native chat for Pi, Claude Code and Codex in a Herdr tab, in place of
their terminal UIs. It streams markdown, highlighted code and Mermaid
diagrams, and shows tool cards with diffs, approval cards, and pickers for
the model, effort and permission mode. Messages sent while the agent works
wait in a steer lane and a follow-up lane. Each agent is the CLI the person
already uses, with their login, settings, extensions, skills and sessions.
Each chat is also a normal Herdr agent: it has a status, `hc send` reaches it
and `hc read` prints it. Agents can start their helpers as chats that open
from the agents list.

![herdr-chat](preview.png)

## Adding it (for the app's agent)

Don't copy the folders. The chat needs its host (a Node program, shipped
built in the release), a config that points at it, edits to the person's
layout and keys, and the `hc` templates, and copying does none of that.
With the app open, run its installer:

```sh
curl -fsSL https://raw.githubusercontent.com/ChmaraX/herdr-chat/main/install.sh | sh -s -- --app
```

Tell the person first what it does:

- downloads the release (`herdr-chat-<version>.tar.gz`) from GitHub,
  checks it against the release's `SHA256SUMS`, and unpacks it to
  `~/.local/share/herdr-chat/<version>`, with a `current` link to it;
- needs macOS, Herdr 0.1.12 or later with `hc` on `PATH`, Node 20 or
  later, and at least one agent on `PATH`: `pi`, `claude` or `codex`. A
  Herdr newer than the tested 0.1.13 gets a warning; an older one than
  0.1.12 is refused;
- adds the mods `chat`, `new-chat`, `chat-agents` and `chat-menu`;
- edits the person's layout: the agents list becomes `chat-agents`, the
  right-click menu becomes `chat-menu`, and an empty `new-chat` block floats
  in it. A slot another plugin holds is left to that plugin, and the install
  says what that costs;
- binds ⌘I to the launcher (⌘J A when ⌘I is taken). It never replaces a key
  of the person's unless they asked for that key;
- writes the `hc` templates `pi-chat`, `claude-chat` and `codex-chat`, and a
  short marked note in each installed agent's instruction file
  (`~/.pi/agent/AGENTS.md`, `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`)
  asking it to start sub-agents as chats (`--no-subagents` skips both);
- installs a Pi extension, `~/.pi/agent/extensions/herdr-chat-lock.ts`. It
  keeps a Pi TUI from writing a session a chat has open.

The chats run the agents' CLIs, which reach their own providers. The host
itself has no network of its own: it listens on 127.0.0.1 only, with a token.
Running the installer again updates; chats already open keep the old
version until they're reopened. `--uninstall` puts back exactly what the
install changed, and removes the unpacked release.

## What you see

- **The launcher** (⌘I): a small dialog with **P**i, **C**laude Code and
  Code**X** (only the installed ones). Enter alone takes the last pick. The
  chat opens in a new tab, in the focused terminal's folder.
- **The chat**: the timeline (user bubbles, answers in markdown with highlighted code and
  Mermaid diagrams, thinking, tool cards with their output and diffs,
  approval cards, notices); the composer, with the model, effort and
  permission-mode chips under it and a hint line.
- **The queue**: above the composer, a blue "Steer: next turn" lane and a
  yellow "Follow-up: after this run" lane.
- **Menus**: `/` lists the agent's commands and the built-ins; `@` finds
  files in the project; the pickers for model, effort, mode and sessions.
- **The viewer**: a click on a diagram or an image opens it over the chat,
  with zoom (10 % to 800 %) and pan.
- **A sub-agent's chat**: a dialog over the window (80 % × 80 %) with a
  header bar: the name, the status, "from <parent>", ↗ Open as tab, and ✕.

## How it behaves

- **Sending**: Enter sends. While the agent works, Enter steers (the message
  reaches it at its next step) and ⌥Enter queues a follow-up for when the run
  ends. Esc or ⌃C stops the run, and what was queued comes back into the
  composer. A queued row's click edits it, ⇄ moves it to the other lane, ×
  removes it.
- **Approvals**: 1, 2 or 3 allow once, allow always, or deny. Esc denies.
- **`/tui`** (⌥⌘T) opens the agent's own TUI on the same session in a
  dialog over the chat (a layout overlay: a bar, then the terminal, which
  has no pane). Quitting it, or the bar's Back to chat, brings the chat
  back; Open as tab gives it a tab. `/login`, `/settings`, `/tree`… open
  the same way, with the command typed into the TUI once it's idle, so it
  lands on that screen; the bar's Done ends it.
- **Skills** are pills (inline tokens) in the composer: picked from `/`
  (which lists skills anywhere in the text), or typed out with a space.
  Sent, the pill becomes the message's leading `/command`; in the timeline
  it heads the bubble and opens to what the agent got.
- **Continue as chat**: on an idle Pi TUI (right-click, or its row's menu),
  Pi quits cleanly and a chat opens on the same session, with the session's
  model and thinking level.
- **Sub-agents**: `hc run --bg --name <n> pi-chat "<task>"` (or
  `claude-chat`, `codex-chat`) starts a helper. Its row under the parent
  opens its chat; closing the dialog or tab leaves it running, and only its
  parent ends it. `hc wait`, `hc send`, `hc read` and `hc kill` work as with
  a TUI.
- **The chat outlives the window**: its host runs in herdr-core. Reopening
  the app reattaches the chat to it. Closing the chat's tab ends it.
- **Keys** work only while the chat has the keyboard. They are rebound in
  `data/herdr-chat/keys.json` in the app home (`mod/chat/KEYS.md` in the
  repo). Its `"global"` part sets the keys that open a chat, applied by the
  next install.

## Built from

- **The host**, `herdr-chat-host` (`host/`, TypeScript; built to one JS file
  for a release): it runs `pi --mode rpc`, `claude -p` (stream-json) or
  `codex app-server`, turns their output into one timeline, the same for
  every agent, and serves it to the mod on TCP 127.0.0.1 with a token
  (JSONL; `docs/dev/protocol.md`). It runs in a hidden pane of the chat's
  tab, so Herdr lists it as the tab's agent.
- **Mods** (`mod/`):
  - `chat`: draws the timeline and sends ops; no slow work in the mod;
  - `new-chat`: the launcher and the `new-chat.*` commands;
  - `chat-agents` and `chat-menu`: install-time copies of Herdr's agents
    list and right-click menu, with the chat's entries (a mod can't import
    another, and Herdr restores its own mods on every start).
- **Config**: `mods/chat/config.json` (install writes it) names the host
  (`…/herdr-chat/current/bin/herdr-chat-host`), node, `hc`, each agent found
  on `PATH` and the version. The person's own settings are in
  `data/herdr-chat/settings.json` (README "Settings"; install never writes it).
- **The install** (`install.sh` → `install/app.sh`, `install/*.ts`): each
  change recorded under `data/herdr-chat/` in the app home, so the uninstall
  undoes exactly that.
- More: `docs/dev/architecture.md`.

## Watch out

- The host pane is hidden by a flag the chat writes into Herdr's layout
  document. A tab or split made in the same tenth of a second as a chat
  opening can be undone. If a Herdr version drops the flag, the chat falls
  back to a 0 px pane and says so once.
- `chat-agents` and `chat-menu` are copies of Herdr's own mods made at
  install time: after a Herdr update, run the install again. A copy whose
  original changed shape is left out, with the reason.
- Some screens exist only in the TUIs (Pi extension panels, Claude Code's
  and Codex's `/mcp` and `/permissions`): `/tui`.
- Continue as chat is Pi only; spaces on other machines open the TUI.
- macOS only.

## Done when

- `herdr-app check` passes for each installed mod, and `herdr-app status`
  shows no errors.
- ⌘I opens the launcher, and P, C and X open a chat with that agent in a
  new tab.
- A prompt streams an answer; a tool call shows its card and an approval
  card answers with 1, 2 or 3; Enter while it works steers, ⌥Enter queues a
  follow-up, Esc stops it.
- The agents list shows the chat's status; `hc send` reaches it and `hc read`
  prints its transcript.
- `hc run --bg --name x pi-chat "…"` shows a row under its parent that
  opens the chat in a dialog.
- `/tui` opens the TUI on the same session, and quitting it brings the chat
  back.
- `--uninstall` leaves the layout, `keys.json` and the agents' instruction
  files as they were.
