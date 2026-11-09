# Changelog

## 0.1.0 (2026-11-09)


### Features

* `/tui` opens the agent's own TUI on the same session; quit it and the chat continues. ([eab837c](https://github.com/ChmaraX/herdr-chat/commit/eab837c43580be88f170f5ac70e5a2b76ca8d722))
* A chat is a normal Herdr agent: its status shows in the agents list and tab bar, other agents can `hc send` to it, and `hc read` shows a transcript. ([eab837c](https://github.com/ChmaraX/herdr-chat/commit/eab837c43580be88f170f5ac70e5a2b76ca8d722))
* A click on a diagram or image opens it in a viewer with zoom and pan: ⌘ or Ctrl + scroll zooms around the pointer, `+` `-` `0` (fit) `1` (100 %) and the header's buttons too, from 10 % to 800 %; scroll or drag pans. Diagrams stay sharp when zoomed. ([eab837c](https://github.com/ChmaraX/herdr-chat/commit/eab837c43580be88f170f5ac70e5a2b76ca8d722))
* A native chat in a Herdr tab for Pi, Claude Code and Codex. Each runs as the CLI you already use, with your login, settings, extensions, skills and sessions. ([eab837c](https://github.com/ChmaraX/herdr-chat/commit/eab837c43580be88f170f5ac70e5a2b76ca8d722))
* an edit waiting for approval shows its diff in the approval card ([bfeaac4](https://github.com/ChmaraX/herdr-chat/commit/bfeaac47415cdd1cce1df82462860b2efaa21831))
* Continue as chat for Claude Code and Codex TUIs, and every agent's terminal-only commands in the / menu ([31657f8](https://github.com/ChmaraX/herdr-chat/commit/31657f88128b89332820a4e59a1f10d0c3c41836))
* Continue as chat: an idle Pi TUI, a sub-agent or a top-level one, becomes a chat on the same session. ([eab837c](https://github.com/ChmaraX/herdr-chat/commit/eab837c43580be88f170f5ac70e5a2b76ca8d722))
* Keys: ⌘I opens the "New chat…" launcher (⌘J A when ⌘I is taken). You can bind keys for a Pi, Claude Code or Codex chat, and for Continue as chat. The chat's own keys can be rebound. ([eab837c](https://github.com/ChmaraX/herdr-chat/commit/eab837c43580be88f170f5ac70e5a2b76ca8d722))
* Pickers for the model, thinking effort and permission mode, a `/` command menu, `@` file mentions, and pasted or dropped images. ([eab837c](https://github.com/ChmaraX/herdr-chat/commit/eab837c43580be88f170f5ac70e5a2b76ca8d722))
* skill pills, terminal commands in a dialog, and /fork for Pi, Claude Code and Codex ([152de44](https://github.com/ChmaraX/herdr-chat/commit/152de4459cfdef7bedefd9faf85b90b315c7e52f))
* Streaming answers with highlighted code and Mermaid diagrams, tool cards with diffs, and approval cards: allow once, always, or deny with a reason. ([eab837c](https://github.com/ChmaraX/herdr-chat/commit/eab837c43580be88f170f5ac70e5a2b76ca8d722))
* Sub-agent chats: `hc run … pi-chat`, `claude-chat` or `codex-chat` starts a helper that opens as a chat from its row in the agents list or from the right-click menu. ([eab837c](https://github.com/ChmaraX/herdr-chat/commit/eab837c43580be88f170f5ac70e5a2b76ca8d722))
* The install checks Herdr's version: it warns on a Herdr newer than the tested 0.1.13 and refuses one older than 0.1.12. ([eab837c](https://github.com/ChmaraX/herdr-chat/commit/eab837c43580be88f170f5ac70e5a2b76ca8d722))
* The install leaves another plugin's agents list or right-click menu alone and says what that costs. `--take-agents-slot` and `--take-menu` take them anyway, and uninstall gives them back. ([eab837c](https://github.com/ChmaraX/herdr-chat/commit/eab837c43580be88f170f5ac70e5a2b76ca8d722))
* The one-line install, `curl -fsSL https://raw.githubusercontent.com/ChmaraX/herdr-chat/main/install.sh | sh -s -- --app`, downloads the release, checks it against the release's SHA256SUMS and installs it: no clone, no npm install, Node 20 or later. It adds the mods, keys, layout edits, hc templates and a small Pi extension that keeps a TUI from writing a session a chat has open. Run it again to update. `--uninstall` puts back exactly what it changed. In a clone, `./install.sh` does the same from the clone. ([eab837c](https://github.com/ChmaraX/herdr-chat/commit/eab837c43580be88f170f5ac70e5a2b76ca8d722))
* Two queues above the composer: Enter steers the current run, Alt+Enter queues a follow-up for after it. Click a queued message to edit it, move it to the other queue, or remove it. ([eab837c](https://github.com/ChmaraX/herdr-chat/commit/eab837c43580be88f170f5ac70e5a2b76ca8d722))


### Bug Fixes

* a startup dialog the agent resolved by its timeout closes when the agent starts ([d731b0b](https://github.com/ChmaraX/herdr-chat/commit/d731b0b57df195d6dd6f598d8625e57cfb62f0a6))
