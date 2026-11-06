# Developer docs

For working on herdr-chat. The setup and the tests are in
[CONTRIBUTING.md](../../CONTRIBUTING.md).

- [architecture.md](architecture.md): the host, the mods, the hidden host
  pane, sub-agent chats, the install.
- [protocol.md](protocol.md): the wire contract between the host and its
  clients (the mod, `pi-chat-host inspect`, the tests). Both sides change
  together.
- [providers.md](providers.md): one chat UI for several agents; the adapter
  seam and what each agent supports.
- [visual-v2.md](visual-v2.md): the chat's look and feel. The mod's code
  cites its sections (`visual-v2.md §3`).
- [feedback-1.md](feedback-1.md): the first round of user feedback and the
  decisions it led to. The E2E flows in `tests/e2e/flows-fix1.sh` cite its
  rows.

Older notes call the chat mod `pi` or `pi-chat`, its names before `chat`.

## Research

The investigations behind designs that aren't obvious from the code:

- [research/pi-gui-chat.md](research/pi-gui-chat.md): can Herdr show an
  agent as a native chat, and why a host process in a herdr-core terminal.
  [research/pi-gui-chat-problems.md](research/pi-gui-chat-problems.md): the
  risks of that design, and how Orca, T3 Code and Paseo handle each. Their
  sources, with `path:line` citations: [research/sources/](research/sources/).
- [research/split-glitch.md](research/split-glitch.md): keeping the chat in
  Herdr's agents list without a visible host pane (the hidden pane).
- [research/subagent-chat.md](research/subagent-chat.md): sub-agents as
  chats, opened from the agents list.
- [research/provider-claude.md](research/provider-claude.md) and
  [research/provider-codex.md](research/provider-codex.md): driving Claude
  Code and Codex as long-lived structured agents. Their recorded runs are in
  [research/samples/](research/samples/); `tests/fixtures/codex/build.mjs`
  builds replay fixtures from them.
