# Multiple agents, one chat UI

Goal: the same chat UI (mod `chat`) for **Pi, Claude Code, Codex and
Antigravity**, then others. The rule: nothing provider-specific is hard-coded outside an adapter
(`host/providers/<agent>/`); the core and the mod read capabilities and the
adapter's answers. The ids and names are listed once on each side:
`host/providers/index.ts` (the host) and `herdr-app/mods/chat/util.js` (the mod; a mod
can't import the host's code).

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
   ├── host/providers/codex/    Codex app-server JSON-RPC (see research)
   └── host/providers/agy/      Antigravity `agy acp` (ACP, JSON-RPC 2.0; host/providers/jsonrpc.ts, shared with Codex)
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
  - `name` is mapped to a ToolDetail by a **shared** classifier (host/tools.ts). Each adapter brings its `tools` (a ToolMap, `host/providers/<agent>/tools.ts`): its names for the shared kinds (Pi `bash`/`read`/`edit`/…, Claude `Bash`/`Read`/`Edit`/`MultiEdit`/`Write`/`Grep`/`Glob`/`WebFetch`/`Task`, Codex `commandExecution`/`fileChange`/`mcpToolCall`/`webSearch`), and hooks for what only it sends (Codex's shell wrapper and parsed command actions, Claude's patch in its edit results). The shared code never names an agent.
- **ask** (one shape for extension dialogs, permission prompts and questions): `ask {id, kind: "select"|"confirm"|"input"|"editor"|"permission", title, message?, options?, tool?: {name, args}, timeoutAt?}`, answered by the `dialog_answer` op. Permission asks render as an approval card: "Allow once / Always / Deny".
- **decoration:** `status {key, text}`, `widget {key, placement, lines}`, `title {text}`, `notice {level, text}` (from the agent: extensions, hooks, system messages)
- **session:** `session {id, file?, name?}`, `model {provider, id, name, reasoning, contextWindow}`, `thinking {level}`, `usage {contextTokens, contextWindow, cost}`, `compaction {phase, …}`, `retry {…}`
- **lifecycle:** `exited {code, stderrTail}`

### Commands (core → adapter)

- `prompt {text, images, mode: auto|steer|followUp}`, `abort`, `answer {askId, value}`. The core holds follow-ups itself while a run is on (protocol v3.2), so an adapter sees `followUp` only in its own edge cases
- optional `canRemoveQueued(id)` / `removeQueued(id)`: take back a queued message the agent hasn't taken yet (Pi: clear and re-add; Claude Code: `cancel_async_message`; Codex: none)
- `listModels`, `setModel`, `setThinking`, `compact`, `newSession`, `switchSession`, `setName`
- `sessions: SessionSource`: where /resume's sessions come from. `{kind: "files", files(current, scope), describe(path)}` (Pi, Claude Code: the core reads and caches them, `host/sessions.ts`) or `{kind: "agent", list(scope)}` (Codex: `thread/list`, a page at a time). The core lists, searches (name, first message, folder) and marks each `here` the same way for every agent
- `history()`: the normalized events to rebuild a resumed session
- `tuiCommand(session)`: the argv of the agent's own TUI on this session, for hand-offs. Examples: `pi --session <f>`, `claude --resume <id>`, `codex resume <id>`.
- optional `forkPoints()` and `fork(point)`: the person's messages, and a new session holding what came before one of them (resolves with the message's text). Pi: `get_fork_messages` / `fork`. Claude Code: its transcript's prompts, then a restart with `--resume <id> --fork-session --resume-session-at <the answer before>` (the fork's transcript is written at its first prompt; until then the history is the original's up to that answer). Codex: the turns' first `userMessage`, then `thread/fork {lastTurnId: the turn before}` on the same model and effort.
- optional `tuiInput(name)`: what the chat types into the agent's terminal for a built-in that opens one, so it lands on that screen (Pi `/login`, Claude Code `/config`).

### Capabilities (in `ChatState.capabilities`, the mod adapts)

| capability | Pi | Claude Code | Codex |
|---|---|---|---|
| `steer`, `followUp` | yes | yes | yes |
| `thinkingLevels` | off…xhigh | the model's efforts | the model's efforts |
| `permissions` + `permissionModes` | no (Pi has no approvals) | yes: Ask, Accept edits, Plan, Auto | yes: Ask first, Read only, Auto, Auto-review, Full access, Plan |
| `extensionUi` (statuses, widgets) | yes | no | no |
| `compact` / `compactInstructions` | yes / yes | yes / yes | yes / no |
| `rename`, `fork` | yes | yes | yes |
| `images` | per model | yes | per model |
| `cost` | yes | yes | no (tokens only) |
| `tui` | yes | yes | yes |

What else differs, from each agent's own mechanism, not from the chat:

| | Pi | Claude Code | Codex |
|---|---|---|---|
| Terminal utilities (`utilityCommand`) | login, settings, scoped-models | login, settings (`/config`) | login |
| TUI commands (`tuiCommands`) | its built-ins RPC doesn't run (tree, export, share, session…) | its terminal-only commands (doctor, theme…) | its TUI's (init, status, review, diff, mcp…) |
| Another process on the session | the lock extension | its `~/.claude/sessions` registry (`sessionHolder`) | its "active writer" error |
| The chat follows a session switch made in `/tui` | yes (the lock extension's hand-off file) | no | no |
| Continue as chat: the TUI's session (`tui.ts`) | the lock extension's label | its `~/.claude/sessions/<pid>.json` | the rollout it has open, else the newest in its folder |
| The plan (`state.plan`; a subagent's is a `plan` card) | none | TodoWrite: the chat's plan from the call, a subagent's as its card. TaskCreate/TaskUpdate/TaskList: the chat's plan, subagents' changes included, from the results (`plans.ts`), in task id order; a resume carries the transcript's list on, a fork starts a new one | `turn/plan/updated`, each turn's update replaces the plan; a subagent thread's is its card. Resume reads the rollout's `update_plan` calls (`rollout.ts`; code mode's `exec` JS too), and a fork's source's up to the fork |

## Process (one host process per chat)

- **One host per chat.** A host claims its chat before it writes the
  registry or starts the agent, and refuses to serve one another live host
  has (protocol.md "One host per chat"). So two starts at once (a restart's
  two paths, two windows, a stale terminal list) give one host and one agent
  on the session, whichever agent it is: the claim is the host's, not the
  adapter's.
- **The registry names the host.** The mod takes the chat's host terminal
  from the registry's `terminal` (connection.js `registeredHost`), never from
  the first terminal labelled with the chat: hiding, labels, the seen mark,
  restarts and the update question all act on that one. Its orphan sweep ends
  a chat's other host terminals (a second host from before the claim).
- **Launcher:** ⌘I opens `new-chat`, which offers each agent install found.
- The provider is a chat prop: `{chat, cwd, provider}`. The host gets it as `serve --provider pi|claude|codex|agy`.
- The registry records it, so reopening uses the same provider.
- The Herdr agent status (OSC 7501) reports `app=pi|claude|codex|antigravity` (the registry's `herdrApp`, else the id), so Herdr shows the right icon.

## Adding an agent

1. `host/providers/<id>/`: the adapter (`ProviderAdapter`), its `tools.ts` (ToolMap), a fake agent under `tests/fake-<id>/`, host tests.
2. Register it in `host/providers/index.ts` (with `herdrApp` when Herdr names it differently), and its name and icon in `herdr-app/mods/chat/util.js` (`PROVIDER_NAMES`, `icons/providers/<id>.svg`).
3. The launcher's entry (`herdr-app/mods/new-chat/main.js` `CHOICES`, and `KNOWN_AGENTS` for Herdr's name of it; `HERDR_AGENTS` there and in chat-menu only when Continue as chat works for it), its key name (`install/keys.ts`), its template in the sub-agents note and, if it reads one, its instruction file (`install/instructions.ts`), `PROVIDERS` in `install/app.sh`, and `updateArgv` in `herdr-app/mods/new-chat/update.js`.
4. An agent that can't take a message mid-run says `capabilities.steer: false`: the host then holds every such message as a follow-up (protocol.md v3.2).
