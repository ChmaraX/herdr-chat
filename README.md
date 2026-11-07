# herdr-chat

[![CI](https://github.com/ChmaraX/herdr-chat/actions/workflows/ci.yml/badge.svg)](https://github.com/ChmaraX/herdr-chat/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/ChmaraX/herdr-chat)](https://github.com/ChmaraX/herdr-chat/releases/latest)
[![License](https://img.shields.io/github/license/ChmaraX/herdr-chat)](LICENSE)

<p align="center">
  <a href="#features">features</a> · <a href="#install">install</a> · <a href="#quick-start">quick start</a> · <a href="#keys">keys</a> · <a href="#configuration">configuration</a> · <a href="#limitations">limitations</a> · <a href="CHANGELOG.md">changelog</a>
</p>

A native chat for **Pi, Claude Code and Codex** in the
[Herdr](https://herdr.dev) desktop app, in place of their terminal UIs. Each
agent is the CLI you already use, with your login, settings, extensions,
skills and sessions. The chat only draws it.

<!-- video: a short GIF or video of a chat goes here -->

![A chat: a test run, a file read and an edit with its diff](docs/media/chat.png)

## Features

- **One chat for three agents** - the same timeline, keys and pickers for Pi,
  Claude Code and Codex. Each control shows only where the agent supports it.
- **Readable answers** - streaming markdown, highlighted code, Mermaid
  diagrams you can zoom, and tool cards with diffs and exit codes.
- **Approvals** - allow once, always, or deny with a reason, by key.
- **Steer or queue** - while the agent works, Enter steers it and ⌥Enter
  queues a follow-up. Queued messages can be edited, moved or removed.
- **Pickers** - model, thinking effort and permission mode, from the chips
  under the composer or by key.
- **Slash commands and skills** - your commands, prompt templates and
  skills, plus the built-ins (`/model`, `/compact`, `/resume`, `/fork`,
  `/tui`…). A skill becomes a pill in your message.
- **The agent's own screens** - `/login`, `/settings` and the commands that
  only exist in the agent's terminal UI open in a dialog over the chat.
  `/tui` continues the session there.
- **`/fork`** - a new session up to any earlier message, with that message
  back in the composer.
- **Continue as chat** - right-click a running Pi, Claude Code or Codex
  terminal → **Continue as chat**: the chat takes over its session.
- **Sub-agent chats** - your agents start their helpers as chats. Click a
  helper's row in the agents list to read along or type to it.
- **A normal Herdr agent** - each chat has a status in the agents list and
  tab bar, `hc send` reaches it and `hc read` prints its transcript.

## Requirements

- The **Herdr desktop app** (0.1.12 or later), and herdr-core (`hc`) on
  `PATH`.
- **Node 20** or later.
- At least one agent on `PATH`, signed in: `pi` (1.5 or later), `claude` or
  `codex`.
- macOS.

## Install

With the Herdr app open:

```sh
curl -fsSL https://raw.githubusercontent.com/ChmaraX/herdr-chat/main/install.sh | sh -s -- --app
```

It downloads the release, checks it, adds its mods, binds ⌘I to the
launcher where it's free, and points the agents list and the right-click
menu at the chat. No clone, no npm install. Or ask the agent in your Herdr
window to "add the mod at github.com/ChmaraX/herdr-chat".

- **Update:** run the same command again. Open chats keep the old version
  until you reopen them.
- **Uninstall:** the same command with `--uninstall`. It puts back exactly
  what install changed.
- **Options:** `--no-subagents` (no sub-agent templates or notes),
  `--no-layout` (leave your layout alone). The full list of what install
  changes is in [herdr-app/RECIPE.md](herdr-app/RECIPE.md).

## Quick start

1. **Open a chat.** ⌘I, then **P**i, **C**laude Code or Code**X**. It opens
   in a new tab, in the focused terminal's folder.
2. **Talk to it.** Enter sends. `@` finds files; paste or drop an image to
   attach it. While it works, Enter steers and ⌥Enter queues; Esc stops.
3. **Pick a model or effort.** Click the chips under the composer, or
   `/model` and `/thinking`.
4. **Approve.** An approval card takes 1, 2 or 3: allow once, always, deny.
5. **Go further.** `/fork` from an earlier message, `/resume` another
   session, `/tui` for the agent's own terminal UI on the same session.

## Keys

| Key | Where | What |
|---|---|---|
| ⌘I | anywhere | The launcher (⌘J A when ⌘I is taken) |
| Enter / ⌥Enter | composer | Send; while the agent works, steer / queue a follow-up |
| Esc, ⌃C | chat | Stop the run (Esc also closes a menu or dialog) |
| ⇧⌘M / ⇧⌘T / ⇧⌘A | chat | Model, effort, permission-mode picker |
| ⇧Tab | composer | Next permission mode (next thinking level for Pi) |
| ⌥⌘T | chat | `/tui` |
| ⇧⌘R | chat | Resume another session |
| ⇧⌘N | chat | A new chat with the same agent, same folder |

Change them, or bind a key per agent, in
`~/.config/herdr-app/data/herdr-chat/keys.json`:
[mod/chat/KEYS.md](mod/chat/KEYS.md).

## Configuration

The model, effort, permissions, MCP servers and the rest stay in each
agent's own settings: the chat runs the same CLI you use in a terminal.
What the chat itself takes goes in
`~/.config/herdr-app/data/herdr-chat/settings.json` (install never writes
it; every key is optional):

```json
{
  "env": { "KEY": "value" },
  "pi":     { "command": "/path/to/pi", "args": ["--model", "anthropic/claude-sonnet-4-5"] },
  "claude": { "env": { "CLAUDE_CONFIG_DIR": "/path/to/config" } },
  "codex":  { "tui": ["my-wrapper", "codex"] }
}
```

`env` is for every agent. Per agent: `command` (instead of the one install
found), `args` (added to the agent's), `env`, and `tui` (the program `/tui`
runs). A new chat picks up a change.

## Limitations

- **macOS only.** Spaces on other machines still open the agent's TUI.
- **Run the install again after a Herdr update.** The agents list and the
  right-click menu are copies of Herdr's, made at install time.
- **Continue as chat on Codex guesses the session** when Codex runs on its
  shared daemon (the default): the newest session in that folder. With
  `codex --no-daemon` it's exact.
- **Codex reports no cost**, so its meter shows tokens only.
- **Not in the command palette.** Use the keys.

## Development

```sh
git clone https://github.com/ChmaraX/herdr-chat
cd herdr-chat && npm ci            # Node 24: a checkout runs the TypeScript itself
./install.sh --app                 # installs this checkout into the running app
```

`npm test` runs the host's tests (fake agents; `LIVE=1` for the real ones),
`npm run e2e` drives a private Herdr app. How it's built:
[docs/dev/](docs/dev/), [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
