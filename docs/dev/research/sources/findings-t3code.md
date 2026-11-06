# T3 Code → Pi GUI chat: how it works (read-only scout findings)

Repo: a clone of `t3code` (the commit is in `COMMITS.txt`). All citations are `path:line` into that tree.
Pi lives behind a dedicated provider package `packages/provider-pi` that an event-sourced
server orchestrator drives over Pi's JSON-RPC mode.

## TL;DR (10 lines)
1. T3 launches `pi --mode rpc` as a child process per provider session; it never scrapes a PTY/TUI and never runs Pi in-process (`packages/provider-pi/src/server/mcpInjection.ts:239`, `rpc.ts:186`).
2. The **server** owns the subprocess (not the UI). Clients are thin WebSocket viewers of an event-sourced projection, so the agent survives UI reload and multiple clients attach to the same thread (`AGENTS.md` "How it works"; `adapter.ts` emits events into a queue the orchestrator persists).
3. Pi is framed as LF-delimited JSONL; a hand-rolled framer drops oversized records and strips trailing CR (`rpc.ts:99`, `rpc.ts:186`).
4. Pi's native events (`message_update`, `tool_execution_*`, `agent_settled`, `compaction_*`, `auto_retry_*`, `extension_ui_request`) are normalized into a cross-provider `OrchestrationV2TurnItem` union + nodes/messages/subagents (`adapter.ts:1702`; `packages/contracts/src/orchestrationV2.ts:1594`).
5. A generated **bridge extension** is injected via `--extension`; it implements T3's permission modes through Pi's `tool_call` hook, exposes T3's orchestration MCP server, injects system-prompt guidance, and re-expands skill chips (`mcpExtensionSource.ts:15`).
6. Approvals/dialogs: Pi's blocking `confirm/select/input/editor` become `approval_request`/`user_input_request` runtime requests answered back via `extension_ui_response` (`adapter.ts:1137`, `adapter.ts:2790`).
7. Steer vs follow-up vs abort: in-turn steer is `prompt {streamingBehavior:"steer"}`; abort is `abort` or process terminate for `/compact`; queued messages cleared via `clear_queue` (`adapter.ts:2702`, `adapter.ts:2759`).
8. History/resume uses Pi native session **files** (`switch_session` by path), snapshot via `get_messages`, fork via CLI `--fork` + `fork`/`get_entries` tree walking (`adapter.ts:2294`, `adapter.ts:2895`, `adapter.ts:3076`).
9. Model/thinking switch in-session via `set_model`/`set_thinking_level`, with baseline capture so "Pi default" can be restored (`adapter.ts:2383`).
10. Big pitfall they solved: Pi has no clean "turn done" signal for command-only prompts, so they run a **settle probe** (`get_state` polling re-injected as a synthetic event) — copy the pattern, it is fragile (`adapter.ts:1627`, `adapter.ts:2110`).

---

## 1. Process & transport

**Launch.** Every provider session spawns a fresh `pi --mode rpc` child. Args are assembled in
`buildPiRpcLaunch` which hard-codes `--mode rpc`, optionally `--session <path>` or `--no-session`,
then the user's vetted launch args, then restriction flags (`mcpInjection.ts:236-258`). The binary
is `settings.binaryPath || "pi"` (`adapter.ts:openSession` ~ `adapter.ts:1096` region;
`settings.ts:15`). No SDK/in-process use; no `--mode json`; no PTY scraping.

User launch args are strictly filtered: `--mode`, `--session`, `--continue`, `--resume`, `--fork`,
`--print`, `--export` etc. are reserved to T3 and rejected (`mcpInjection.ts:14-33`,
`mcpInjection.ts:100`). Message text is never passed positionally.

**Transport.** Spawned via Effect `ChildProcessSpawner`, detached on non-Windows so a process group
can be signalled; teardown escalates SIGTERM→SIGKILL only against a PID confirmed alive, because a
dead PID/pgid may be recycled (`rpc.ts:165-213`). Windows uses `taskkill /T /F` to reap the tree
(`rpc.ts:232`). Stdout is **LF-delimited JSONL**: a custom framer strips trailing `\r` and *drops*
any record exceeding `MAX_PI_RECORD_CHARS` (image budget + 8 MiB) rather than buffering unbounded
(`rpc.ts:91`, `rpc.ts:99-133`). Requests get T3-generated ids `t3-<n>`; `{type:"response",id}`
records are matched to pending deferreds, everything else is offered to an events queue
(`rpc.ts:246-287`). Default request timeout 30 s; lifecycle ops 60 s (`rpc.ts:85`, `adapter.ts:84`).

**Ownership & survival.** The **server** process owns Pi, not any client. Per `AGENTS.md` "How it
works": clients send typed WS requests → commands → the pure Orchestrator decides events → event
sink commits → projections are what the UI reads; the effect worker then runs side effects
(starting a provider turn). The adapter only pushes `ProviderAdapterV2Event`s into a queue
(`adapter.ts:emit` ~ `adapter.ts:1040`). Because the transcript is an event-sourced projection,
the agent keeps running across UI reload/disconnect and **multiple clients** observe the same
projection. Shared reconnect/multi-env logic lives in `packages/client-runtime`
(`docs/internals/overview.md:11-13`).

Notably the adapter can even *adopt* agent work that Pi starts with no active T3 turn (a "wake":
`continuationRequests.offer`), rather than discarding it (`adapter.ts:1722-1760`). If no
continuation handler exists, unsolicited `agent_start` is treated as an error and the session is
terminated to prevent invisible tool execution (`adapter.ts:1760`, `adapter.ts:80`).

## 2. Event model (normalization)

The pump loop takes from `connection.events`, holds a 1-permit semaphore so terminal events cannot
overtake dialog resolution, and dispatches to `handleSessionEvent` (`adapter.ts:2178-2210`,
`adapter.ts:1702`). Mapping:

- `message_start` (assistant) → bumps `messageOrdinal` (`adapter.ts:1771`).
- `message_update` → `assistantMessageEvent` deltas: `text_delta`/`thinking_delta` accumulate into a
  `PiStreamItemState` keyed `<turn>:m<ord>:c<contentIndex>`, flushed every 50 ms; `*_end` completes
  the item (`adapter.ts:1778-1816`, flush `adapter.ts:1570`, `STREAM_FLUSH_MS` `adapter.ts:78`).
  Live token usage is read off every update (`adapter.ts:reportLiveUsage` ~ `adapter.ts:1244`).
- `tool_execution_start/update/end` → `emitToolItem` (`adapter.ts:1823-1834`, impl `adapter.ts:1289`).
- `compaction_start/end` → `compaction` turn item with running/completed/failed/cancelled + before/
  after token counts (`adapter.ts:1835-1900`).
- `auto_retry_start/end` → a provider-retry turn item (attempt/maxAttempts/delay) via
  `makeProviderRetryTurnItem` (`adapter.ts:1902-1975`).
- `extension_ui_request` → dialog/approval (§4) or `notify` → `system_notice` (`adapter.ts:1977`,
  `adapter.ts:1143`).
- `extension_error` → an `error` turn item, buffered if out-of-turn (`adapter.ts:1981`, `adapter.ts:1462`).
- `agent_settled` → arms the settle probe; `queue_update`/queued messages handled via `clear_queue`
  on stop (`adapter.ts:1984`, `clearNativeQueue` `adapter.ts:1117`).

**Normalized types** (all in `packages/contracts/src/orchestrationV2.ts`). The UI-facing unit is
`OrchestrationV2TurnItem`, a tagged union (`orchestrationV2.ts:1594-1793`): `user_message`,
`assistant_message` (`text`,`streaming`), `reasoning`, `proposed_plan`, `todo_list`,
`file_change` (`fileName`,`diffStr`,`oldStr`,`newStr`,`changes`), `command_execution`
(`input`,`output`,`exitCode`), `file_search`, `web_search`, `approval_request`,
`user_input_request`, `checkpoint`, `compaction`, `error`, `handoff`, `fork`, `subagent`,
`system_notice`, and the catch-all `dynamic_tool` (`toolName`,`input`,`output`). Alongside turn
items the adapter emits `node.updated` (execution-graph node), `message.updated`,
`subagent.updated`, `provider_turn.updated`, `provider_thread.updated`, `runtime_request.updated`,
and a `turn.terminal` marker (`adapter.ts:emitItemNode` ~ `adapter.ts:1198`, terminal
`adapter.ts:1640`). Provider capabilities are declared statically as
`PiProviderCapabilitiesV2` (streaming reasoning yes, plan text no, todo list no, subagents yes,
file-change approval yes, file-read approval no — `adapter.ts:88-181`).

## 3. Rendering (web client)

Turn items → UI rows in `apps/web/src/session-logic.ts` (`session-logic.ts:349`, `:434-520`):
- `command_execution` → labelled "Ran command", keeps `rawCommand`, opens to a command view
  (`session-logic.ts:434`).
- `file_change` → "Changed N files"/`Changed <file>`; diff rendered in `DiffPanel.tsx:454-489`
  (`toolCallDiff`), selectable in `diffPanelStore.ts:228`.
- `dynamic_tool` → classified (`read`/`search`/generic) for a nicer label; MCP tools get
  `mcpToolPresentation` and can open an MCP app frame (`session-logic.ts:498-520`, `:699-714`;
  `McpAppFrame.tsx:138`).
- `reasoning` → "Thinking" collapsible (`session-logic.ts:356`).
- streaming assistant text/markdown → `MessagesTimeline` (`apps/web/src/components/chat/MessagesTimeline*`).
- `todo_list` → "Tasks done/total · current" (`session-logic.ts:525`).
- `subagent` → subagent row with elapsed/progress (`AgentElapsed.tsx`; subagent items from
  `emitSubagentTasks` `adapter.ts:1375`).
- images: Pi `read` image output is de-duplicated (image mirrored in both model content and
  structured output; only the mirror is dropped) `adapter.ts:piToolOutput` `adapter.ts:227-258`.
Unknown item/tool types are tolerated: the turn-item union is decoded "forward-compatibly" and
unknown members are filtered out of projections (`orchestrationV2.ts:1795`, `:1812-1835`).

Tool call normalization lives server-side in `emitToolItem` (`adapter.ts:1289-1375`): `bash`/
`powershell`→`command_execution` (+exit code from structured/details); `edit`/`write`→`file_change`
(diff from `details.patch`, `newStr` from `content`); everything else→`dynamic_tool` with
`mcpToolPresentation`; `subagent` tool additionally fans out `subagent.updated` events.

## 4. Interactivity

**Permissions.** T3 does not use Pi's `--approve`; instead the injected bridge extension implements
the mode in Pi's `tool_call` hook (`mcpExtensionSource.ts` the `pi.on("tool_call", …)` block):
`full-access`→no prompt; read-only tools (`read,grep,find,ls`) always allowed; `auto-accept-edits`
allows `edit`/`write`; otherwise `ctx.ui.confirm("Allow <tool>?", …)` which surfaces as a T3
approval (`mcpExtensionSource.ts` tool_call hook; file-change set `mcpExtensionSource.ts:12`). Mode
is passed via `T3_PI_RUNTIME_MODE` env and a mode change **restarts** the session
(`capabilities supportsRuntimeModeSwitchInSession:false` `adapter.ts:92`; docs
`providers-pi.md` Permission Modes).

**Dialogs.** `extension_ui_request` methods `select/confirm/input/editor` become a pending prompt →
`approval_request` (confirm) or `user_input_request` (others) turn item + runtime request with
`responseCapability:{type:"live"}` (`adapter.ts:1297-1345`, `adapter.ts:1137`). Answered by
`respondToRuntimeRequest` → `extension_ui_response` (`adapter.ts:2790-2820`). "Accept for session"
is remembered in `sessionApprovals` keyed by title/message so the same confirm auto-answers
(`adapter.ts:2826`, check `adapter.ts:1156`). Dialog timeouts are honored via a scheduled
`t3.ui_request_expired` synthetic event (`adapter.ts:1444-1460`).

**Steer / follow-up / abort.** In-turn steer sends `prompt {streamingBehavior:"steer"}`
fire-and-forget under the permit (`steerTurn` `adapter.ts:2702-2745`). `/compact` is special-cased
to the `compact` RPC. Abort: ordinary `abort`, but when a manual `/compact` or native compaction is
in flight it falls back to process terminate, after capturing rollback tree refs
(`interruptTurn` `adapter.ts:2759-2815`). Queued steers/follow-ups are cleared on stop with
`clear_queue`, and the cleared text is surfaced as a `system_notice` (`clearNativeQueue`
`adapter.ts:1117-1141`). Prompts are **held** while Pi compacts (it rejects every prompt during
compaction) and replayed after `compaction_end` (`adapter.ts:1050-1075`, rejection constant
`adapter.ts:155`).

**Model/thinking.** `applySelection` diff-applies `set_model`/`set_thinking_level`, capturing a
baseline so the special slug `"default"` ("Pi default") can restore Pi's own config
(`adapter.ts:2383-2455`, inherit slug `adapter.ts:75`). Thinking levels validated against
`off..max` (`adapter.ts:71`).

**Slash commands / skills / prompt templates.** Discovered per-cwd with a throwaway `pi --mode rpc`
process calling `get_commands` (`status.ts:201-219`). RPC omits TUI builtins, so T3 manually
advertises `/compact` and maps it to the compact RPC (`commands.ts:4-29`). Skills appear in the
composer `$` menu; because Pi only expands one leading `/skill:`, the bridge extension re-expands
every selected skill chip from its frontmatter on the `input` hook (`mcpExtensionSource.ts` `pi.on("input", …)`).

**Attachments / mentions.** Image attachments are read and sent as base64 `images[]` on the prompt
(`resolvePromptPayload` `adapter.ts:2457-2482`); non-image attachment/file-mention paths are inlined
into the message via `providerMessageTextWithAttachmentPaths`.

## 5. History / resume / fork

- **Resume** an existing Pi thread: `switch_session {sessionPath}` using the native **file path**
  (not the display UUID) captured from `get_state().sessionFile` (`adapter.ts:2294`, `:2325`).
  New thread = `new_session` (`adapter.ts:2296`). Baselines (model/thinking/contextWindow) are
  re-captured on every (re)registration (`adapter.ts:2308-2340`).
- **Snapshot** for handoff/portable context: `get_messages` returns only the active branch and is
  mapped to role-tagged messages; `get_entries` is deliberately avoided here because it leaks
  abandoned branches (`readThreadSnapshot` `adapter.ts:2884-2945`).
- **Rollback**: compute a fork boundary, `fork {entryId}`, re-read `get_state`/`get_entries`, swap
  the native binding behind a drain barrier so native events can't race the rebind
  (`rollbackThread` `adapter.ts:2949-3075`).
- **Fork/branch**: spawns a *separate* short-lived `pi … --fork <sourceFile>` process (CLI form sets
  the destination cwd; RPC `switch_session`/clone alone would keep the source cwd), optionally
  `fork {entryId}` to a turn boundary, then registers the new session file as a new provider thread
  with `forkedFrom` set (`forkThread` `adapter.ts:3076-3190`).
- Turn boundaries are reconstructed by walking the Pi entry tree by leaf→parent ancestry, since
  `get_entries` lists abandoned branches in append order (`captureTurnTreeRefs` `adapter.ts:1511`).
- GUI transcript persistence is the server's event-sourced projection (not Pi's files); Pi files are
  used only for resume/rollback/fork and usage accounting (`usage.ts` reads Pi session JSONL for
  token totals, `usage.ts:17-40`).

## 6. Gaps vs Pi's TUI (and coping)

- **No Pi TUI chrome**: titles, status lines, widgets, decorations have no T3 equivalent
  (`providers-pi.md` "Pi terminal decoration … does not have a T3 Code equivalent").
- **Custom TUI components / custom tool renderers**: Pi extensions that draw bespoke TUI are not
  rendered; their tool calls fall through to the generic `dynamic_tool` row
  (`emitToolItem` default branch `adapter.ts:1357`). Only the four blocking dialog primitives
  (`select/confirm/input/editor`) + `notify` are bridged (`adapter.ts:1704`, `:1143`).
- **TUI builtins** like `/settings`, `/tree`, `/trust` aren't in `get_commands`; T3 reimplements the
  needed ones itself (model/thinking pickers, settings UI) and only re-advertises `/compact`
  (`commands.ts:26`). Untrusted-folder handling is surfaced as a one-time notice because RPC has no
  trust prompt (`mcpExtensionSource.ts` `before_agent_start` block + `providers-pi.md` Troubleshooting).
- **Injected bridge extension** (`PI_T3_MCP_EXTENSION_SOURCE`, materialized to a cache file and
  passed via `--extension`): it (a) enforces permission modes through the public `tool_call` hook
  without shadowing Pi's runtime; (b) registers T3's orchestration MCP server (`delegate_task`,
  `task_status`, thread tools) as `mcp__t3-code__*` tools owning that namespace; (c) injects
  `T3_CODE_ORCHESTRATION_INSTRUCTIONS` into the system prompt via `before_agent_start`;
  (d) re-expands `$skill` chips; (e) caps OpenRouter `max_tokens` to work around a Pi context-budget
  bug (`mcpExtensionSource.ts:15`, env names `:5-9`). It is always injected even without MCP
  creds, otherwise Supervised mode would become unrestricted (`adapter.ts:openSession` comment
  "Always inject the permission hook …" ~ `adapter.ts:1079`).
- Pi-native subagents (`subagent` extension) show progress/results but run session-less, so they
  **cannot be opened/resumed** as T3 threads (`providers-pi.md` last paragraph; capabilities
  `exposesSubagentThreadIds:false` `adapter.ts:140`).

## 7. Terminal coexistence

T3 Code is a GUI-only surface for this agent: Pi is always launched `--mode rpc`, so there is **no
shared TUI/GUI toggle for one session** — a thread's Pi process speaks RPC, not an interactive
terminal. The only terminal touchpoints are (a) one-off `pi --mode rpc` probes for version/models/
commands (`status.ts`), and (b) docs telling the user to run `pi` + `/login` in a real terminal
*once* to authenticate, because auth/models are owned by the user's Pi install, not T3
(`providers-pi.md` Set Up Pi). You cannot attach a live TUI to an in-flight T3 Pi session.

## 8. Clever bits & pitfalls (copy / avoid)

- **Settle probe** (clever but fragile): Pi emits no reliable "turn complete" for command-only
  prompts, aborted/failed compaction, or adopted background work. T3 fires `get_state`, re-injects
  the result as a synthetic `t3.settle_probe` event through the same pump, and only finalizes when
  `isStreaming/isCompacting/pendingMessageCount` are all clear, with ≤3 retries then terminate
  (`scheduleSettleProbe` `adapter.ts:1627`, handler `adapter.ts:2110-2170`). Copy the idea; budget
  for its complexity.
- **Single-writer event pump** with a 1-permit semaphore so a fast `agent_settled` can't overtake a
  dialog response resolution (`adapter.ts:76` comment, `:2180`). Worth copying for any streaming
  bridge.
- **Backpressure/framing**: unbounded stdout is dangerous — they cap per-record size and *drop*
  overflowing records with a warning rather than OOM; they also budget image base64 explicitly
  (`rpc.ts:91-133`, `rpc.ts:87`). Copy this; a naive readline that also splits U+2028/U+2029 would
  corrupt frames (`rpc.ts:1` header comment).
- **Prompt-while-compacting**: Pi rejects prompts during compaction; hold+replay instead of failing
  the turn (`adapter.ts:1050`). Avoid sending blindly.
- **Process teardown correctness**: never SIGKILL a recycled PID; check liveness before each signal;
  use process groups / `taskkill /T` (`rpc.ts:159-234`). Copy verbatim-in-spirit.
- **Native-file identity**: resume/fork key on Pi's session *file path*, and fork uses the CLI to
  fix cwd — a subtle correctness trap if you only use RPC clone (`adapter.ts:3098` comment).
- **Don't trust ad-hoc "done"**: treating `agent_start` with no active turn as an error-and-terminate
  prevents invisible tool runs (`adapter.ts:1760`). Good safety default to copy.
- **Perf of long transcripts**: rendering is projection-driven with virtualized trees
  (`ChangedFilesTree.tsx` windowing `:322-349`) and 50 ms stream-flush batching server-side
  (`adapter.ts:78`); big tool outputs are omitted on the wire and fetched on demand
  (`command_execution.outputOmitted`/`dynamic_tool.outputOmitted` `orchestrationV2.ts:1672`, `:1821`).

### What Herdr should copy
- Launch `pi --mode rpc`, own it in the daemon/core (not the panel), expose an event-sourced
  projection so panels reconnect and multiple viewers share state.
- A single normalized turn-item union + per-tool special casing (bash→command, edit/write→diff,
  else→generic) with forward-compatible decoding of unknown item/tool types.
- The injected bridge extension pattern: it is the clean seam for permissions (via `tool_call`),
  MCP tool exposure, and system-prompt guidance — all through Pi's *public* hooks.
- JSONL framing with record-size caps + drop, process-group teardown with liveness checks, and a
  single-writer pump semaphore.
- Output omission + fetch-on-demand for long transcripts; batched stream flush (~50 ms).

### What Herdr should avoid
- Relying on `agent_settled` alone for turn completion — you will need a settle-probe equivalent for
  command-only/compaction/adopted-work cases.
- Sending prompts during compaction; hold and replay.
- Using `get_entries` where you want only the active branch (use `get_messages`); and using RPC
  clone for forks when cwd must change (use `--fork`).
- Readline-based framing (corrupts U+2028/U+2029) and unbounded stdout buffering.
