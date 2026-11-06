# Multiple agents, one chat UI

Goal: the same chat UI (mod `chat`, then named `pi`) for **Pi, Claude Code and Codex**, then
others. The user's rule: nothing provider-specific is hard-coded in the UI.

## The seam

```
mod (provider-neutral: renders Items + ChatState, sends ops; adapts to `capabilities`)
   │  protocol.md: unchanged wire, plus `state.provider` and `state.capabilities`
host core (provider-neutral)
   server.ts · registry.ts · terminal.ts (OSC 7501, hc send, transcript) · coalescing · timeline store
   blocks/highlight/mermaid/ansi · images · files · clipboard · sessions lock · built-in slash commands
   │  ProviderAdapter interface (host/providers/types.ts)
   ├── host/providers/pi/       pi --mode rpc           (today's pi-rpc.ts + the Pi half of chat.ts/timeline.ts)
   ├── host/providers/claude/   Claude Code, structured mode (see research)
   └── host/providers/codex/    Codex app-server JSON-RPC (see research)
```

An **adapter** owns:
- spawning and talking to its agent process;
- turning that agent's events into a small set of **normalized events**;
- carrying out normalized commands.

The core owns everything a user sees, so every provider renders the same way.

### Normalized events (adapter → core), first draft

These are refined after the Claude and Codex research.

- **run:** `run_started {autonomous?, cause?}`, `run_settled {aborted, error?}`, `queue_changed {steering[], followUp[]}`
- **message:**
  - `user_message {text, images, source, from?}`;
  - `assistant_delta {msg, index, kind: "text"|"thinking", delta}`;
  - `assistant_block_end {msg, index, kind, text}`;
  - `assistant_end {msg, stopReason, error?, model?, usage?, durationMs?}`.
- **tool:**
  - `tool_started {callId, name, args}`, `tool_progress {callId, partialOutput}`;
  - `tool_ended {callId, ok, output, images?, exitCode?, diff?}`;
  - `name` is mapped to a ToolDetail by a **shared** classifier, with per-provider name tables: Pi `bash`/`read`/`edit`/…, Claude `Bash`/`Read`/`Edit`/`MultiEdit`/`Write`/`Grep`/`Glob`/`WebFetch`/`Task`/`TodoWrite`, Codex `commandExecution`/`fileChange`/`mcpToolCall`/`webSearch`.
- **ask** (one shape for extension dialogs, permission prompts and questions): `ask {id, kind: "select"|"confirm"|"input"|"editor"|"permission", title, message?, options?, tool?: {name, args}, timeoutAt?}`, answered by the `dialog_answer` op. Permission asks render as an approval card: "Allow once / Always / Deny".
- **decoration:** `status {key, text}`, `widget {key, placement, lines}`, `title {text}`, `notice {level, text}` (from the agent: extensions, hooks, system messages)
- **session:** `session {id, file?, name?}`, `model {provider, id, name, reasoning, contextWindow}`, `thinking {level}`, `usage {contextTokens, contextWindow, cost}`, `compaction {phase, …}`, `retry {…}`
- **lifecycle:** `exited {code, stderrTail}`

### Commands (core → adapter)

- `prompt {text, images, mode: auto|steer|followUp}`, `abort`, `answer {askId, value}`. The core holds follow-ups itself while a run is on (protocol v3.2), so an adapter sees `followUp` only in its own edge cases
- optional `canRemoveQueued(id)` / `removeQueued(id)`: take back a queued message the agent hasn't taken yet (Pi: clear and re-add; Claude Code: `cancel_async_message`; Codex: none)
- `listModels`, `setModel`, `setThinking`, `compact`, `newSession`, `listSessions`, `switchSession`, `setName`
- `history()`: the normalized events to rebuild a resumed session
- `tuiCommand(session)`: the argv of the agent's own TUI on this session, for hand-offs. Examples: `pi --session <f>`, `claude --resume <id>`, `codex resume <id>`.

### Capabilities (in `ChatState.capabilities`, the mod adapts)

| capability | Pi | Claude Code | Codex |
|---|---|---|---|
| `steer` (message mid-run) | yes | ? | ? |
| `thinkingLevels` | off…max | ? | reasoning effort ? |
| `permissions` (approval prompts) + `permissionModes` | no (extensions) | yes | yes |
| `extensionUi` (status/widgets) | yes | hooks/statusline? | no |
| `compact`, `rename`, `fork` | yes | ? | ? |
| `images` in prompts | yes | yes | ? |
| `slash` (agent commands list) | `get_commands` | ? | ? |
| `tui` (hand-off) | yes | yes | yes |

The `?` cells are filled from [`research/provider-claude.md`](research/provider-claude.md) and
[`research/provider-codex.md`](research/provider-codex.md).

## Process (one host process per chat, unchanged)

- **Launcher:** `cmd-j shift-p` still opens Pi. A provider chooser comes later: the + menu or separate keys.
- The provider is a chat prop: `{chat, cwd, provider}`. The host gets it as `serve --provider pi|claude|codex`.
- The registry records it, so reopening uses the same provider.
- The Herdr agent status (OSC 7501) reports `app=pi|claude|codex`, so Herdr shows the right icon.

## Order of work

1. Pi v2 finished (in progress).
2. Research Claude Code and Codex structured interfaces from primary sources and the upstream adapters (scouts, now).
3. Pin the adapter interface (this doc). Refactor the host so Pi is the first adapter, with no behavior change: the existing 37 host tests and 168 E2E checks must still pass.
4. Claude and Codex adapters in parallel, each with:
   - a fake agent, plus fixtures recorded from the real CLI;
   - host tests;
   - one live run.
5. The mod: capability-driven bits (approval cards, permission-mode chip, provider icon or label, per-provider model and thinking pickers, provider chooser in the launcher). E2E per provider.
