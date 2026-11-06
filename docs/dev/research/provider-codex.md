# Codex as a structured chat provider

**Question.** How does our host drive **Codex** as a long-lived, structured
agent, so the GUI that shows Pi also shows Codex?

**Short answer.** Use `codex app-server`: JSON-RPC 2.0 over JSONL on stdio.
It is the interface Codex's own rich clients use (VS Code, desktop). Paseo,
Orca and T3 all use it too. It covers threads (sessions), turns (runs), items
(messages and tool calls) with deltas, approvals as server→client requests,
steer, interrupt, compact, fork, rename and model lists. Run one app-server
per chat, owned by the host, like `pi --mode rpc`.

Codex also has something Pi lacks: a **shared app-server daemon**. The TUI
attaches to it by default. Two clients on one daemon thread both see live
events and can both drive it. I proved this with a TUI and a GUI client on
one thread (sample 13). That makes a live TUI hand-off possible. It is a
phase-2 option, not the default (§5, §7).

## Sources

- Installed CLI `codex-cli 0.163.0` (`/opt/homebrew/bin/codex`). The shared daemon runs `0.166.0` (`codex app-server daemon version`). `--help` of `codex`, `app-server`, `resume`, `fork`, `exec resume`, `queue`, `agents`, `app-server daemon` and `proxy`.
- **[S]** schema made by `codex app-server generate-ts --out ts` (and `--experimental`, and `generate-json-schema`), 0.163.0. Paths like `ts/v2/ThreadItem.ts`. Rebuild it with the same command: the bundle depends on the version.
- **[D]** https://developers.openai.com/codex/app-server, the official app-server docs (sections are named where cited).
- **[DD]** https://github.com/openai/codex/blob/main/codex-rs/app-server-daemon/README.md
- Upstream adapters at the commits in `sources/COMMITS.txt`:
  - **P** = `paseo/packages/server/src/server/agent/providers/codex-app-server-agent.ts`;
  - **O** = `orca/src/main/codex/`;
  - **T** = `t3code/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`.
- **Real runs** (gpt-5.6-luna, effort low, temp dir `/tmp/codex-probe/work`) are in [`samples/codex/`](samples/codex/), numbered `00`–`17`. Each file opens with a `note` record. `dir`: `out` = host→codex, `in` = codex→host, `stderr`, `mark` = probe step. Home paths, account ids and email are scrubbed.

The probe had to run under `hc exec`. In my shell, Codex's code-mode host
couldn't start: every tool call failed with `timed out negotiating with the
code-mode host`, and no item was emitted at all (§6).

---

## 1. Interface, launch and auth

| Option | Verdict |
|---|---|
| `codex` TUI | Today's terminal; not structured |
| `codex exec --json` | One-shot. It can't take a second prompt, steer or answer an approval mid-run |
| **`codex app-server` (stdio)** | **Use this.** Long-lived bidirectional JSON-RPC; "the interface Codex uses to power rich clients" [D intro] |
| `codex app-server` on the daemon (`unix://` socket, WebSocket framing) | Same protocol, shared by the TUI and other clients. Phase 2 (§5) |
| Codex SDK | For CI and automation [D intro]; wraps exec |

**Launch** (host-owned child, cwd = chat cwd):

```
codex -c notify=[] app-server            # --listen stdio:// is the default
env: inherit the user's env; drop HERDR_PANE_ID / HERDR_SOCKET_PATH / HERDR_ENV (see below)
```

- `-c notify=[]`: the user's `notify` program (`~/.codex/config.toml`) runs at every turn end. The host does its own notifications. T3 and Orca also pass their own `-c` overrides (O `codex-structured-launch-args.ts`).
- Don't pass `-s/-a/--dangerously-*`. Set permissions per thread and turn over RPC. Orca drops these flags and rejects `--remote` and a positional prompt (O `codex-structured-launch-args.ts:15-41,76-104`).
- **Hooks run inside app-server.** `hook/started`/`hook/completed` arrive for the user's `~/.codex/hooks.json` (sample 01). The Herdr Codex hook (`~/.codex/herdr-agent-state.sh`) reports pane status when `HERDR_ENV=1` and `HERDR_PANE_ID` are set. Inherited, it would report status for the host's pane next to our OSC 7501, so strip those variables.
- **Handshake** (each connection): request `initialize {clientInfo, capabilities}`, then notification `initialized`. Requests before it get `Not initialized`; a second `initialize` gets `Already initialized` [D "Initialization"].
  - Send `capabilities: {experimentalApi: true}`. It is needed for `thread/queue/*`, `thread/settings/update`, `collaborationMode/list`, background terminals and more [D "Experimental API opt-in"].
  - Optionally send `optOutNotificationMethods: ["turn/diff/updated"]`, as T does (T:233-237), or keep it for diffs (§2).
- **`clientInfo.name`** becomes the thread's `originator` and the User-Agent prefix (sample 06: `herdr_chat_probe/0.163.0 …`).
  - OpenAI asks integrations to set it for compliance logs [D "Initialization"].
  - Paseo uses Codex's reserved non-originating name `codex_app_server_daemon`, so requests keep the CLI identity (P:175-182). Ours should be `herdr_chat`.
  - Threads started over app-server are recorded with `source: "vscode"`, so they appear in `codex resume` and in `thread/list`'s default interactive filter (rollout `session_meta`; [D "thread/list" `sourceKinds`]).
- **Auth.** The app-server reads the user's login from `$CODEX_HOME` (default `~/.codex`, `auth.json`), so it reuses the TUI login with no work.
  - `account/read` → `{account: {type: "chatgpt", email, planType}, requiresOpenaiAuth}` (sample 00).
  - Login, if missing: `account/login/start {type: "chatgpt" | "chatgptDeviceCode" | "apiKey"}`, then `account/login/completed` [D "Authentication modes"]. Simpler: hand off to `codex login` in a terminal, as we do for Pi.
- **Version gates** to keep in mind:
  - `thread/rollback` was removed in 0.156 (P:205; [D "Revert thread history"]).
  - `collabAgentToolCall` changed shape at 0.143 (P:186).
  - `turn/start` replies named nonexistent turns before 0.148 (O `codex-structured-turn-steer.ts:13`).
  - Read `userAgent` from `initialize` for the version. Generate fixtures from the binary you ship against.

## 2. Mapping to our normalized events

The native model is a **Thread** that holds **Turns**, which hold **Items**
(`ts/v2/Thread.ts`, `Turn.ts`, `ThreadItem.ts`). Every item has `item/started`
(full item) and `item/completed` (final item, "authoritative") [D "Items"].
Deltas reference `itemId`. One host run = one turn. One turn holds several
`agentMessage`, `reasoning` and tool items, in emission order.

| ours | Codex native (exact shape: [S] + samples) |
|---|---|
| `run_started` | `turn/started {threadId, turn: {id, status: "inProgress", items: []}}`. If the host didn't send the `turn/start`, mark it `autonomous` (queued follow-up, goal continuation, another client) |
| `run_settled` | `turn/completed {threadId, turn: {id, status: "completed"\|"interrupted"\|"failed", error: TurnError\|null, durationMs}}`. Also `thread/status/changed {status: {type: "idle"}}`, which follows. Status `active` carries `activeFlags` (`waitingOnApproval`, sample 07) |
| `queue_changed` | steer: pending from the `turn/steer` reply until the `userMessage` echo (match `clientUserMessageId` ↔ `item.clientId`). Follow-ups: `thread/queue/changed {threadId}` (experimental), then re-read `thread/queue/list` (sample 15) |
| `user_message` | `item/completed {item: {type: "userMessage", id, clientId, content: UserInput[]}}`. `UserInput` = `text{text,text_elements}` \| `image{url}` \| `localImage{path}` \| `skill` \| `mention` (`ts/v2/UserInput.ts`). Steered input shows up as a new `userMessage` **inside the same turn** (sample 08) |
| `assistant_delta` text | `item/agentMessage/delta {itemId, delta}` |
| `assistant_delta` thinking | `item/reasoning/summaryTextDelta {itemId, delta, summaryIndex}` and `item/reasoning/summaryPartAdded {summaryIndex}` (section boundary). Raw `item/reasoning/textDelta {contentIndex}` when the model supports it. Summaries come **only if** the turn sets `summary: "detailed"`/`"auto"` (sample 11; none without it, samples 01–10) |
| `assistant_block_end` | `item/completed` of that `agentMessage` (`text`) or `reasoning` (`summary: string[]`, `content: string[]`). Replace the buffered text with it |
| `assistant_end` | No per-message end record. `agentMessage.phase` is `commentary` \| `partial_answer` \| `final_answer` \| null (`ts/MessagePhase.ts`). `stopReason` comes from `turn.status` (`completed→stop`, `interrupted→aborted`, `failed→error` with `turn.error.message`). Model: `thread/settings/updated.threadSettings.model`. Usage: below |

Two rules: many `reasoning` items are empty (`summary: [], content: []`,
sample 08), so drop empty thinking items. And treat each `agentMessage` item
as its own assistant Item: Paseo joins them with `\n\n---\n\n` (P:183), which
we don't need.

### Tools (all built-in item types, `ts/v2/ThreadItem.ts`)

| item `type` | args / live / result | our ToolDetail |
|---|---|---|
| `commandExecution` | `{command, cwd, processId, source: agent\|userShell\|unifiedExecStartup\|unifiedExecInteraction, status: inProgress\|completed\|failed\|declined, commandActions[], aggregatedOutput, exitCode, durationMs}`. Live: `item/commandExecution/outputDelta {itemId, delta}` (sample 09); `item/commandExecution/terminalInteraction` for stdin. The command is wrapped: `/bin/zsh -lc 'ls -la'` (sample 03). Unwrap `-lc`/`-c` as Paseo does (`codex/tool-call-mapper.ts:223-264`) | `bash`, `exitCode`. Use `commandActions` (`read{path,name}`, `listFiles{path}`, `search{query,path}`, `unknown`, `ts/v2/CommandAction.ts`) to show `read`/`search` details for reads done through the shell |
| `fileChange` | `{changes: [{path, kind: {type: add}\|{type: delete}\|{type: update, move_path}, diff}], status}`. **`diff` for `add` is the whole new file**; for `update` it's bare hunks with no file headers (sample 04). `turn/diff/updated {diff}` carries the turn's full git-style unified diff, re-sent often (sample 04; P:5785 treats it as telemetry). `item/fileChange/patchUpdated` exists, but streaming patches is an unreleased feature (`apply_patch_streaming_events` "under development", `codex features list`) | `edit`; `write` for `add`. Build the unified diff from `changes[i]` plus a synthesized `--- a/ +++ b/` header |
| `mcpToolCall` | `{server, tool, arguments, status, result: {content[], structuredContent, _meta}\|null, error: {message}\|null, durationMs, mcpAppUi, readOnlyHint}`; progress `item/mcpToolCall/progress {message}` | `generic {server, tool}`; text and image blocks come from `result.content` |
| `dynamicToolCall` | client-defined tools (`dynamicTools` on `thread/start`, experimental); the server asks the client with `item/tool/call` | `generic` |
| `webSearch` | `{query, action: {type: search, query, queries}\|openPage{url}\|findInPage{url,pattern}, results: JsonValue[]\|null}`. `query` is `""` at start; the full value comes at completion (sample 11) | `search {tool: "web", query}` |
| `imageView` | `{path}` (the agent viewed a local image) | `read`, image = path |
| `imageGeneration` | `{status, revisedPrompt, result, savedPath?}` | generic + image |
| `collabAgentToolCall` | subagents: `{tool: spawnAgent\|sendInput\|resumeAgent\|wait\|closeAgent\|sendMessage\|followupTask\|interruptAgent\|listAgents, senderThreadId, receiverThreadIds[], prompt, model, reasoningEffort, agentsStates: {threadId: {status, message}}}`. `subAgentActivity {kind: started\|interacted\|interrupted\|completed, agentThreadId, agentPath}`. Children are threads with `parentThreadId` | new `subagent` detail, or generic. Children's own items arrive with their child `threadId`; filter by `threadId` |
| `plan` | `{text}`, plan-mode proposal; `item/plan/delta` (the final item is authoritative) | notice or markdown |
| todo list | `turn/plan/updated {turnId, explanation, plan: [{step, status: pending\|inProgress\|completed}]}`. The `update_plan` tool was **not offered** in my run (sample 11: "update_plan … isn't available"). T enables it with thread config `"tools.update_plan.enabled": true` (T:1356-1359) | `widget` / todo card |
| `contextCompaction` | `{id}` between `item/started` and `item/completed` | compaction |
| `enteredReviewMode` / `exitedReviewMode` | `{review}` from `review/start` | notice + markdown |
| `hookPrompt`, `sleep {durationMs}`, `functionCallOutput` | rare | generic or notice |

- **Code mode.** This setup has `code_mode_host` enabled (`codex features list`). The model's tool call is a JS `exec` custom tool: `tools.exec_command({cmd: …})` (rollout `custom_tool_call`). The app-server still emits the inner `commandExecution` items (`mini` run under `hc exec`). The `exec` wrapper itself has no item. When the code-mode host fails, the GUI sees nothing at all (§6).
- **Interrupt leaves tools open.** After `turn/interrupt` the running `commandExecution` **never gets `item/completed`**; only `turn/completed {status: "interrupted"}` arrives (sample 07). The adapter must close every open tool item at `turn/completed`. Paseo also notes that an interrupted live command can be reported `failed` while it still runs, and kills it with `thread/backgroundTerminals/terminate` (P:5176-5255).

### Asks (server→client JSON-RPC requests; answer = the response to that `id`)

| request | params | answer |
|---|---|---|
| `item/commandExecution/requestApproval` | `{kind, threadId, turnId, itemId, approvalId?, command, cwd, commandActions, reason, proposedExecpolicyAmendment, networkApprovalContext, availableDecisions}`, after the item's `item/started` (sample 03) | `{decision: "accept"\|"acceptForSession"\|{acceptWithExecpolicyAmendment:{execpolicy_amendment}}\|{applyNetworkPolicyAmendment}\|"decline"\|"cancel"}`. **Offer only `availableDecisions`**; here that was `["accept", {acceptWithExecpolicyAmendment: ["ls","-la"]}, "cancel"]`, with no `acceptForSession` (sample 03). Decline: the model saw it and retried (sample 06) |
| `item/fileChange/requestApproval` | `{threadId, turnId, itemId, reason, grantRoot}`; take the diff from the pending `fileChange` item | `{decision: accept\|acceptForSession\|decline\|cancel}` |
| `item/permissions/requestApproval` | `{permissions (network/fs), cwd, reason}` | `{permissions: <granted subset>, scope: "turn"\|"session"}` |
| `item/tool/requestUserInput` (legacy `tool/requestUserInput`, P:4021-4024) | `{questions: [{id, header, question, isOther, isSecret, options[{label,description}]}], isBlocking}`. Also used for app-tool approvals [D "MCP tool-call approvals"] | `{answers: {<qid>: {answers: [string]}}}` |
| `mcpServer/elicitation/request` | `{serverName, mode: form\|openai/form\|url, message, requestedSchema\|url}` | `{action: accept\|decline\|cancel, content, _meta}`. Paseo declines `url` and forms with required fields (P:7403-7409) |

Then `serverRequest/resolved {threadId, requestId}` arrives, also when Codex
clears the request itself (turn end or interrupt) [D "tool/requestUserInput"].
**Close the card on `resolved`, not on our own answer.** With several clients
on one thread, every client gets the same request, the first answer wins and
the others get `resolved` (sample 16).

### The rest

| ours | Codex |
|---|---|
| errors / retries | `error {error: {message, codexErrorInfo, additionalDetails}, willRetry, threadId, turnId}`. `willRetry: true` → a retry notice, and the turn stays active. A final failure → `turn/completed status: "failed"`. Values include `contextWindowExceeded`, `usageLimitExceeded`, `unauthorized`, `sandboxError` and `{httpConnectionFailed: {httpStatusCode}}` [D "Errors"]. Also `warning {message}`, `configWarning`, `deprecationNotice`, `model/rerouted {fromModel, toModel, reason}`, `modelProvider/authRecoveryStarted/Completed` → notices |
| usage | `thread/tokenUsage/updated {tokenUsage: {total, last, modelContextWindow}}`, each `{totalTokens, inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens}`. `total` is cumulative billing (437k after a dozen turns); `last` is the last request. Context in use = `last.totalTokens`, window = `modelContextWindow` (258400 for gpt-5.6-luna, sample 10). **No cost** anywhere: `cost: null`. Per-turn usage = the `total` delta from turn start (T `src/provider/CodexTurnTokenUsage.ts`). Plan quota: `account/rateLimits/updated {primary/secondary: {usedPercent, windowDurationMins, resetsAt}, planType}` (sample 01), a status chip |
| compaction | Manual `thread/compact/start` → `{}`, then its **own turn**: `turn/started`, item `contextCompaction` started/completed, `turn/completed` (sample 10). Auto-compaction shows up as a `contextCompaction` item inside a turn. `thread/compacted` is deprecated, but some builds send both; Paseo pairs them (P:3561-3566) |
| decoration | `hook/started/completed {run: {eventName, statusMessage, status}}`, `mcpServer/startupStatus/updated {name, status, error}` (14 per thread start here, one `alpha_mcp` auth failure on stderr), `thread/goal/*`, `turn/moderationMetadata` (noise, drop it) |
| session | `thread/started {thread}` (`id`, `path` (rollout file), `name`, `cwd`, `model`, `reasoningEffort`); `thread/name/updated {threadName}`; `thread/settings/updated {threadSettings: {model, effort, summary, approvalPolicy, approvalsReviewer, sandboxPolicy, collaborationMode, cwd}}` (sample 01), the source for the model, thinking and permission chips |
| lifecycle | process exit / stdout EOF → `exited`. Log stderr: it carries `tracing` ERRORs with ANSI codes (samples 01, 07) |

## 3. Commands

| command | Codex |
|---|---|
| prompt (idle) | `turn/start {threadId, input: [{type: "text", text, text_elements: []}, {type: "localImage", path}], effort?, summary?, model?, approvalPolicy?, sandboxPolicy?, clientUserMessageId?}` → `{turn}` (samples 01, 02). Overrides **persist to later turns** [S `TurnStartParams`]. Images need the model's `inputModalities` to include `image` (`model/list`) |
| steer | `turn/steer {threadId, expectedTurnId, input}` → `{turnId}`. No overrides allowed. The model takes it at its next sampling step: here, after the current message finished streaming (sample 08). Idle → `-32600 "no active turn to steer"`. **A `turn/start` while active also steers**: it returned the same turn id (sample 09). Orca: interrupt clears pending steers (O `codex-structured-turn-end-settlement.ts:100`) |
| follow-up queue | Host-side: hold the text, send `turn/start` after `turn/completed`. Or the experimental server queue `thread/queue/add {threadId, input, clientUserMessageId}` (+ `list/update/delete/reorder/start`), which starts the next turn by itself (sample 15; `codex queue --thread` is the CLI) |
| abort | `turn/interrupt {threadId, turnId}` → `{}`, then `turn/completed status interrupted` (sample 07). Then close open items and, optionally, `thread/backgroundTerminals/clean {threadId}` (P:5225-5255) |
| answer ask | the JSON-RPC response (§2 Asks) |
| permission modes | Three axes [S]: `approvalPolicy`: `untrusted`\|`on-request`\|`never`\|`{granular}`; `sandbox`: `read-only`\|`workspace-write`\|`danger-full-access` (turn-level `sandboxPolicy` object: `readOnly`/`workspaceWrite{writableRoots,networkAccess}`/`dangerFullAccess`/`externalSandbox`); `approvalsReviewer`: `user`\|`auto_review`. Upstream presets: read-only = on-request + read-only; auto = on-request + workspace-write; auto-review = auto + reviewer `auto_review`; full = never + danger-full-access (P:327-350; T:704-741 adds `untrusted + readOnly` as "approval-required"). Set on `thread/start`/`thread/resume` and per `turn/start`. The user's default here is `never` + `danger-full-access` (`~/.codex/config.toml`), so a chip must show it |
| plan mode | `collaborationMode/list` → `[{name: "Plan", mode: "plan", reasoning_effort: "medium"}, {name: "Default", mode: "default"}]` (sample 00); `turn/start {collaborationMode: {mode, settings}}` (P:4278-4283) |
| list / set model | `model/list {includeHidden?}` → `[{id, displayName, isDefault, hidden, defaultReasoningEffort, supportedReasoningEfforts: [{reasoningEffort, description}], inputModalities, serviceTiers}]` (sample 00: 10 models). Set it with `turn/start {model}` (sticky) or `thread/settings/update` (experimental) |
| thinking | `effort`: per model, e.g. `low,medium,high,xhigh,max,ultra` (luna: up to `max`). **No `off`**. `summary`: `auto`\|`concise`\|`detailed`\|`none` controls whether thinking is visible at all |
| compact | `thread/compact/start {threadId}` |
| new session | `thread/start {cwd, model?, approvalPolicy?, sandbox?, config?, developerInstructions?, ephemeral?}` → `{thread, model, reasoningEffort, approvalPolicy, sandbox, …}`. **The rollout is written at the first turn**: until then other processes can't resume it (`no rollout found`, seen in the `shared2` run; P:3482-3484) |
| list sessions | `thread/list {cwd, limit, sortKey: "updated_at", cursor, searchTerm?, archived?}` → `{data: Thread[], nextCursor}` (sample 10). `Thread.preview` = first user message; `name` = title |
| resume | `thread/resume {threadId, excludeTurns: true, approvalPolicy?, sandbox?}`, then history with `thread/turns/list {threadId, sortDirection, itemsView: "full", cursor}` (newest first by default) and `thread/items/list` (sample 06). Full-history `thread/resume` is deprecated for paginated threads [D "Start or resume a thread"]. Legacy threads (`historyMode: "legacy"`) load with `thread/read {includeTurns: true}` (Paseo `codex/thread-history.ts:74-117`). Check `thread/loaded/list` first and skip the resume if loaded; unarchive on the "archived" error (P:4129-4185) |
| fork | `thread/fork {threadId, lastTurnId?, excludeTurns: true, model?}` → new thread with `forkedFromId`, written right away. **Pass `model`/`effort`**: without them the fork took the config default (`gpt-5.6-sol medium`), not the source's luna (sample 10) |
| rewind | `thread/revert {threadId, beforeTurnId}`, history only; files are untouched [D] |
| rename | `thread/name/set {threadId, name}` → `thread/name/updated` (sample 10) |
| review / user shell | `review/start {threadId, target}`; `thread/shellCommand {threadId, command}` (runs **outside the sandbox**: only for an explicit user `!cmd`) |
| slash commands | **No list API.** The TUI's built-ins (`/model`, `/permissions`, `/compact`, `/new`, `/resume`, `/fork`, `/rename`, `/review`, `/init`, `/mcp`, `/skills`, `/status`, `/goal`, `/diff`, …; Orca lists their descriptions in `native-chat-codex-slash-command-descriptions.ts`) are client-side. Rebuild them over RPC: compact, model, review, goal (`thread/goal/*`), fork, rename, new, resume, mcp (`mcpServerStatus/list`), status (`account/read` + rate limits). Skills: `skills/list {cwds}` (86 entries here) → send `$name args` text **plus** `{type: "skill", name, path}` [D "Invoke a skill"]. Custom prompts: `~/.codex/prompts/<name>.md`, expanded by the client (P:4224-4230, 5328-5352). `/init` is just a prompt |

**Sessions on disk.**
- Rollouts: `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` (`thread.path`).
- Each line is `{timestamp, ordinal, type: session_meta|response_item|event_msg|turn_context|compacted|world_state|token_usage_record, payload}` (counted in the probe rollout).
- New threads use `historyMode: "paginated"` (sample 06) and are indexed in `~/.codex/thread_history_1.sqlite`, `state_5.sqlite` and `session_index.jsonl`.
- **Never parse these files.** Replay history through `thread/turns/list`: it returns the same `ThreadItem` shapes as live events, so `history()` reuses the live mapper.
- A turn left over from a killed process reads back as `status: "interrupted"` (sample 06, turn 5).

## 4. Capability column

| capability | Codex |
|---|---|
| `steer` | **yes**: `turn/steer` (lands at the next sampling step) |
| `thinkingLevels` | per model from `model/list` (`low…max/ultra`), no `off`; visibility through `summary` |
| `permissions` + `permissionModes` | **yes**: approval cards for command, patch, permissions, questions, MCP; modes = presets over `approvalPolicy` × `sandbox` × `approvalsReviewer`, plus collaboration mode Plan/Default |
| `extensionUi` | **no** (only hook, MCP-startup and rate-limit statuses) |
| `compact`, `rename`, `fork` | **yes, yes, yes** (plus `revert`, `review`, `goal`) |
| `images` in prompts | **yes** (`localImage {path}`, `image {url}`) when the model lists `image` |
| `slash` | **no agent list**: host built-ins + `skills/list` + `~/.codex/prompts` |
| `tui` | **yes**: `codex resume <threadId>` (§5) |
| extra: `followUpQueue` | yes (experimental `thread/queue/*`) |
| extra: `cost` | **no**: tokens and plan percentage only |

## 5. TUI hand-off

- **argv:** `codex resume <threadId>` in the chat's cwd. The help says it takes a UUID or a session name, plus `--last` and `--all`; `-C <dir>` sets the working root. `codex fork <threadId>` branches. Sample 13 ran `codex resume <id>`.
- **Codex enforces one writer per thread.**
  - While our stdio app-server has a thread loaded, `codex exec resume <id>` fails with `thread-store conflict: thread … already has an active writer (code -32600)` (sample 14).
  - Orca maps this error to "conversation open elsewhere" (O `codex-structured-thread-open.ts:103-117`). Two **processes** can't share a thread, and history can't be corrupted that way.
- **One daemon, many clients.**
  - The TUI attaches to the shared daemon (`~/.codex/app-server-control/app-server-control.sock`) when it is running. `--no-daemon` turns that off; an explicit `--remote unix://` fails loudly instead of falling back to an embedded server [DD].
  - Clients on the same daemon **share** a loaded thread: both get every event, both can start turns (sample 12), approvals go to all of them (sample 16).
  - With our client holding thread D on the daemon, `codex resume D` in a terminal joined it live. The GUI saw the TUI's prompt and turn, and the TUI rendered a turn the GUI started (sample 13; the screen was read with `hc read`).
- **Pitfall: unload delay.** A thread stays loaded on the daemon for `thread_unload_delay_secs` (default 60) after its last subscriber leaves [D "Unsubscribe"]. In that window a different app-server process can't take it: `active writer` at +1 s and +31 s, OK at +71 s (sample 17).

So there are two hand-off designs.

1. **Own stdio server (default, like Pi).**
   - Hand-off: interrupt if working, exit our app-server (the writer is released at exit), then run `codex resume --no-daemon <id>`.
   - When the TUI exits, restart our server and `thread/resume`.
   - `--no-daemon` matters: without it the TUI loads the thread into the daemon, and our resume fails for about 60 s after the TUI exits.
2. **Daemon client (phase 2, live hand-off).**
   - The host connects to the daemon socket instead of spawning a server: WebSocket upgrade over the Unix socket, one JSON message per text frame [D "Transports"]. A 70-line client in the probe did it (`wsrpc.mjs`). `codex app-server proxy` only pipes raw bytes, so WebSocket framing is still needed (it never answered plain JSONL).
   - The TUI (`codex resume --remote unix:// <id>`) and the chat then show **one live thread**, with no stop and restart. That is Herdr's "TUI beside GUI" for free.
   - Costs:
     - The daemon's version can differ from the CLI's (0.166 vs 0.163 here). Generate the schema from `~/.codex/packages/app-server-daemon/current/bin/codex`.
     - Hooks and shell commands run with **the daemon's environment**, inherited from whoever started it [DD "Shared clients use the environment inherited…"].
     - The daemon auto-updates and restarts ("active or queued work may be interrupted", [DD]).
     - Orca runs each Codex terminal on its own server by default, "to keep status and closing tabs working" (`orca/src/renderer/src/components/settings/codex-terminal-server-isolation-copy.ts:4-15`; launch `pty/shell-startup/codex-no-daemon-launch-command.ts`).
     - Our host can't own interrupt-on-close: another client may still be watching.

How the upstream apps guard it:
- Orca: launch isolation (`--no-daemon` injection), plus the active-writer refusal.
- Paseo: checks `thread/loaded/list` before it resumes (P:4150-4156).
- T3: runs one shared app-server for many threads, guards `initialize` with a semaphore and tolerates `Already initialized` (T:1755-1785).

## 6. What a GUI can't get, and how upstream copes

- **The TUI's own surfaces**:
  - the hooks-review dialog: the resumed TUI showed "Hooks need review / Trust all / Continue without trusting" (sample 13 screen);
  - `/permissions`, `/experimental`, `/keymap`, `/vim`, `/ide`, `/memories`, `/import`.
  - Orca shows descriptions only; we rebuild what has an RPC (`config/value/write`, `experimentalFeature/*`, `skills/config/write`) or hand off to the TUI.
- **Cost.** It doesn't exist; show tokens and plan percentage.
- **A slash-command list.** Built from skills, prompts and host built-ins (Paseo `listCommands`, P:5328).
- **Silent stalls.**
  - One turn produced nothing after its `userMessage` for 9 minutes: no `error`, no retry (sample 05).
  - When the code-mode host fails, a tool call times out with **no item at all**, only stderr `codex_core::tools::router: timed out negotiating with the code-mode host`; the model then says "Unable to run the command" (first probe run, not kept; same error in the `mini` run).
  - Coping: a no-progress watchdog (notice + "Interrupt" affordance), and stderr ERROR lines → `notice`.
- **Tool lifecycles.**
  - Interrupt leaves items open (sample 07); close them at `turn/completed`.
  - Paseo also kills a turn's PTY processes after interrupt (P:5225-5255).
- **Diffs.**
  - `fileChange.diff` isn't a unified diff (add = content, update = bare hunks).
  - `turn/diff/updated` is the full turn diff, re-sent 3–4× per edit (sample 04). Paseo ignores it (P:5785); T opts out of it (T:235).
- **Plans and todos.** They need `tools.update_plan.enabled = true` in thread config (T:1356-1359); without it the model says it has no plan tool (sample 11).
- **Thinking.** Invisible unless `summary` is set (sample 11). The summary text is bold headings like `**Searching latest Node.js stable version**`.
- **Duplicate channels.**
  - Older builds mirror lifecycle events under `codex/event/*` (P:6823-6830).
  - Compaction can come both as an item and as `thread/compacted` (P:3561).
  - Plans can come both as `turn/plan/updated` and as a `plan` item (P:6889).
  - Dedupe by item id.
- **Large frames.** A long thread's resume reply measured 19.75 MB. Paseo allows 128 MiB lines (`codex/app-server-transport.ts:9-11`) and fails only the request that is too large; Orca has `CodexAppServerFrameSizeError`. Use `excludeTurns` and pages, and cap our own relay, as protocol.md does.

## 7. Recommended adapter design

`host/providers/codex/` with three parts:

1. **`rpc.ts`: JSON-RPC peer.**
   - Spawns `codex -c notify=[] app-server`.
   - Splits on `\n` only, never `readline` (same rule as Pi).
   - Caps lines (≥128 MiB from Codex, P) and correlates ids.
   - Has a server-request table and logs stderr.
   - On exit: fails pending requests and emits `exited {code, stderrTail}`.
   - Behind the same interface there is a daemon transport for phase 2 (WebSocket over `net.connect({path})`).
2. **`adapter.ts`: state and commands.**
   - Handshake: `initialize {clientInfo: {name: "herdr_chat", …}, capabilities: {experimentalApi: true}}` then `initialized`, then `model/list`, `collaborationMode/list`, `skills/list`, `account/read`.
   - Start: `thread/start` (new) or `thread/resume {excludeTurns}` + `thread/turns/list itemsView full` (paged) → `history()`.
   - Permission presets (§3) map to a mode chip. Default to the user's configured policy, read from `thread/start` → `approvalPolicy`/`sandbox`, so we don't silently tighten or loosen it.
   - `prompt` → `turn/start`, with `summary: "auto"` so thinking shows; set it once and it sticks.
   - `mode: steer` or busy → `turn/steer {expectedTurnId}`. If that fails with `-32600`, the turn just ended, so fall back to `turn/start`.
   - `followUp` → host queue (or `thread/queue/add` behind a capability check).
   - `abort` → `turn/interrupt`, then clear steers and close open items.
   - Thread config `{"tools.update_plan.enabled": true}` so todos appear.
3. **`map.ts`: items → normalized events**, shared by live and history.
   - Key items by item id; buffer deltas (50 ms) and replace them at `item/completed`.
   - Turn = run; `thread/status/changed idle` = settled.
   - Asks keyed by JSON-RPC id, closed on `serverRequest/resolved`.
   - The tool classifier table: `commandExecution` → bash, with read and search from `commandActions`; `fileChange` → edit/write, with a synthesized header; `mcpToolCall` → generic `server·tool`; `webSearch` → search; `collabAgentToolCall` → subagent; `imageView`/`imageGeneration` → images.

**Hand-off:** design 1 from §5 (stop, then `codex resume --no-daemon <id>`,
then resume). Revisit design 2 once Herdr wants live TUI+GUI.

**OSC 7501:**
- `working` from `turn/started`;
- `blocked` from `activeFlags: ["waitingOnApproval"]` or an open ask;
- `done`/`idle` at settle;
- `app=codex`.

**Pitfalls to copy:**
- `availableDecisions` drive the approval buttons.
- Close open items at turn end.
- Pass `model` and effort on fork.
- Check the `-32600 active writer` error and show "open elsewhere: hand back / wait".
- Unwrap the `zsh -lc` command wrapper.
- Drop empty reasoning items.
- Treat `turn/diff/updated` as optional.
- Strip `HERDR_*` env vars.
- Version-gate on the `userAgent`.

**Pitfalls to avoid:**
- Full-history `thread/resume`.
- Parsing rollout files.
- Treating a `turn/start` reply as "a new turn began": it can be a steer (sample 09).
- Resuming a thread before its first turn exists.

### Fake agent for tests

A scripted `fake-codex app-server` in Node, as Paseo does
(`codex/test-utils/fake-app-server.ts`, 822 lines). It speaks JSONL on stdio
and replays **the recorded samples** with fresh ids and timestamps. Script
these cases:

1. handshake, `thread/start`, a text turn (01);
2. a reasoning summary plus text (11);
3. a shell command with output deltas and its exit code (09);
4. a file add and update with `turn/diff/updated` (04);
5. a command approval answered accept, and decline then retry, with `availableDecisions` and `serverRequest/resolved` (03, 06);
6. an interrupt mid-command whose item **never completes** (07);
7. a steer that lands as a `userMessage` in the same turn, and steer while idle → `-32600` (08);
8. `turn/start` while active → the same turn id (09);
9. compaction as its own turn (10);
10. resume plus paged `thread/turns/list`, including an `interrupted` leftover turn (06);
11. a fork without a model → the default model (10);
12. `error {willRetry: true}` then success, and `turn/completed failed` (from [D]: not recorded live);
13. `active writer` on resume (14);
14. a question via `item/tool/requestUserInput`, and an MCP elicitation (schema only);
15. a silent stall (05), for the watchdog;
16. process exit mid-turn (stderr tail).

Keep one live smoke test with the cheapest model (`gpt-5.6-luna`, effort
`low`) that records a fresh `samples/codex` run, so schema drift shows up in
the diff when Codex updates.
