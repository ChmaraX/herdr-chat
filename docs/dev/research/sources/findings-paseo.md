# Paseo → Pi GUI chat: how it's done

Repo: a clone of `paseo` (the commit is in `COMMITS.txt`) (getpaseo/paseo). Pi is one of several
first-class providers; its adapter lives in
`packages/server/src/server/agent/providers/pi/`. All citations are `path:line`.

## TL;DR (10 lines)

1. Pi runs as a child process spawned by the **daemon** (`packages/server`), not the UI, launched `pi --mode rpc` over newline-delimited JSON-RPC on stdio (`runtime.ts:120-148`, `cli-runtime.ts:53-86`).
2. The daemon (`AgentManager`) owns the agent, broadcasts a normalized timeline to all clients, and persists agent records; the Pi process is tied to the daemon's lifetime, resumed from Pi's JSONL session file after restart (`architecture.md`, `agent.ts:2742-2769`).
3. Pi's RPC events (`message_update`, `tool_execution_*`, `agent_end`/`agent_settled`, `compaction_*`, `auto_retry_start`, `extension_ui_request`) map to a cross-provider `AgentStreamEvent`/`AgentTimelineItem` model (`rpc-types.ts:150-210`, `agent-sdk-types.ts:400-471`).
4. Streaming text is sent as per-chunk `assistant_message` deltas keyed by `messageId`; the **client** reducer accumulates them on a frame boundary (`agent.ts:2444-2470`, `session-stream-reducers.ts:792-824`).
5. Tool calls normalize into typed `ToolCallDetail` (shell/read/edit/write/search/sub_agent/plan/unknown) via a schema-based mapper (`tool-call-mapper.ts:318-375`, `agent-sdk-types.ts:244-370`).
6. Paseo injects a **generated Pi extension** (`paseo-integration.mjs`) for system-prompt compose, submitted-user-entry capture, tree/rewind, and MCP registration (`agent.ts:470-640`).
7. Extension UI dialogs (`select`/`input`/`editor`/`confirm`) become Paseo "question" permissions answered with `extension_ui_response` (`agent.ts:910-1010`).
8. Steer (native `steer` RPC), abort (`clear_queue`+`abort`), slash commands, model/thinking switching, image attachments, and MCP are all wired (`agent.ts:380-470, 1330-1360`).
9. Subagents come from per-extension adapters reading Pi child JSONL files, incrementally followed and mapped into a subagents track (`extensions/host.ts`, `child-session.ts`).
10. Lost vs TUI: no custom TUI components, no custom tool renderers, no `/settings`/`/tree` UI; `/compact` and `/autocompact` are reimplemented out-of-band, everything else is best-effort generic.

---

## 1. Process & transport

- **Launch:** `pi --mode rpc`. `buildPiLaunch`/`appendPiLaunchArgs` build argv and default `--mode rpc` (`runtime.ts:76-148`). Binary resolves from `PI_COMMAND`/`PI_ACP_PI_COMMAND`/`pi` (`agent.ts:99`, `cli-runtime.ts:28-31`). The server does **not** embed Pi's SDK — `docs/providers.md:70`.
- **Transport:** newline-delimited JSON over stdio via a shared `JsonlRpcProcess` (`cli-runtime.ts:60-72`). Requests get an `id`; events arrive as `onMessage` and are cast to `PiRuntimeEvent` (`cli-runtime.ts:98-104`). Control-plane RPCs default to a 60s deadline (`agent.ts:113`), overridable via `providerOptions.rpcTimeoutMs`.
- **Who owns it:** the **daemon**, not the UI. The daemon's `AgentManager` creates the provider session, appends timeline rows, and broadcasts `agent_stream` to every subscribed client (`architecture.md` "Data flow"/"Key modules"). Clients (Expo app, CLI, desktop) attach over one WebSocket (`architecture.md` "System overview").
- **Survives UI restart/reconnect:** yes. Agent state persists to `$PASEO_HOME/agents/{cwd}/{id}.json`; timeline rows are runtime memory and **Pi's JSONL file is the durable transcript authority** — a resumed agent rebuilds from it (`architecture.md` "Agent lifecycle"). Resume goes back through `pi --mode rpc --session <file>` using the session file as `nativeHandle` (`agent.ts:2742-2769`, `docs/providers.md:84`).
- **Does the Pi process survive daemon restart?** No — it's a daemon child; on restart the daemon resumes from the JSONL file. `describePersistence()` returns the session file + metadata (`agent.ts:1183-1199`).
- **Multiple clients:** all clients subscribe to the daemon's one timeline; live stream for immediacy, `fetch_agent_timeline_request` authoritative, paged catch-up with sequence dedup and per-run epochs (`architecture.md` "Agent lifecycle", `docs/timeline-sync.md`). A logical session can hold several physical sockets.

## 2. Event model

Pi RPC events (`PiAgentSessionEvent`, `rpc-types.ts:150-210`) are consumed in
`handleRuntimeEvent`/`handleSessionEvent` (`agent.ts:1860-2335`) and emitted as the
normalized `AgentStreamEvent` (`agent-sdk-types.ts:415-471`):

| Pi event | Normalized output |
| --- | --- |
| `agent_start` | `thread_started` (`agent.ts:2095-2104`) |
| `turn_start` | `turn_started` (once) (`agent.ts:2105-2120`) |
| `message_update {text_delta}` | `timeline {assistant_message, messageId, text:delta}` (`agent.ts:2444-2459`) |
| `message_update {thinking_delta}` | `timeline {reasoning, text:delta}` (`agent.ts:2461-2470`) |
| `tool_execution_start/update/end` | `timeline {tool_call, status running→completed/failed}` (`agent.ts:2130-2180, 2362-2400`) |
| `compaction_start/end` | `timeline {compaction, status loading→completed, trigger}` (`agent.ts:2301-2320`) |
| `auto_retry_start` | `timeline {error, "Provider retry (attempt n)…"}` (`agent.ts:2321-2332`) |
| `agent_end`(willRetry)/`agent_settled` | buffered → `turn_completed`/`turn_failed`/`turn_canceled` (`agent.ts:2338-2360, 2690-2740`) |
| `thinking_level_changed` | `thinking_option_changed` (`agent.ts:2085-2094`) |
| `extension_ui_request` | `permission_requested` (question) or notification timeline (`agent.ts:1860-1875, 940-1010`) |
| context usage (polled, not an event) | `usage_updated` via `PiUsagePoller` (`agent.ts:330-355`, `usage-poller.ts`) |

Turn-boundary subtlety: on modern Pi, `agent_end` carries `willRetry`/`messages` but
is **not** terminal — the turn only completes on `agent_settled`
(`agent.ts:2338-2360`). COMPAT shim handles old Pi where `agent_end` is terminal.

Normalized types (`agent-sdk-types.ts`):

```ts
type AgentTimelineItem =
  | { type: "user_message"; text; messageId?; clientMessageId? }
  | { type: "assistant_message"; text; messageId? }
  | { type: "reasoning"; text }
  | ToolCallTimelineItem                 // status running|completed|failed|canceled
  | { type: "todo"; items }
  | { type: "error" | "notification" }
  | CompactionTimelineItem | PluginTimelineItem;      // :383-413
```

Turn/run state is daemon-owned: lifecycle `initializing → idle ⇄ running → error → closed`
with append-only sequence epochs per run (`architecture.md` "Agent lifecycle").
Each `timeline`/turn event may carry a `turnId` (`agent-sdk-types.ts:441-472`).

## 3. Rendering

Rendering is driven by `ToolCallDetail` discriminants (`agent-sdk-types.ts:244-370`),
produced by `mapToolDetail` (`tool-call-mapper.ts:318-375`):

- **bash** → `{type:"shell", command, output, exitCode}`; args/results parsed with zod, exitCode from `exitCode`/`code` (`tool-call-mapper.ts:319-330, 388-409`). Historical `bashExecution` records map the same way in history (`history-mapper.ts:270-293`).
- **read** → `{type:"read", filePath, content, offset, limit}` (`tool-call-mapper.ts:331-338`).
- **edit** → `{type:"edit", filePath, oldString, newString, unifiedDiff}`; `unifiedDiff` taken from `result.details.diff`; a legacy `old_string/new_string` shape is normalized (`tool-call-mapper.ts:339-353, 435-468`).
- **write** → `{type:"write", filePath, content}` (`tool-call-mapper.ts:354`).
- **find/grep/ls** → `{type:"search", query, toolName, content}` (`tool-call-mapper.ts:355-360, 470-482`).
- **Unknown/custom/MCP tools** → `{type:"unknown", input, output}` (`tool-call-mapper.ts:361-366`). Extension adapters can override name/detail first (`host.ts:112-123`).
- **Thinking blocks** → `reasoning` items from `thinking_delta`/`thinking` content (`agent.ts:2461-2470`, `history-mapper.ts:168-176`).
- **Streaming text/markdown** → delta `assistant_message` rows accumulated client-side (`session-stream-reducers.ts:792-824`); markdown is rendered by a shared engine (`docs/markdown-renderer.md`).
- **Images:** base64 image blocks are pulled out of tool results so base64 never hits the text stringifier, then rendered as follow-up assistant markdown images (`tool-call-mapper.ts:233-279`, `agent.ts:2375-2420`). Text-only models get a `[Image available at: <path>]` hint instead (`agent.ts:201-215, 243-258`); only models with `"image"` in `model.input` receive raw images.
- **Subagents** → `{type:"sub_agent", …}` plus a dedicated subagents track via `provider_subagent` events (`agent-sdk-types.ts:321-343`, `store.ts:28-52`).
- **Todo/plan** → `{type:"todo"}` / `{type:"plan"}` items, produced by extension adapters (e.g. `rpiv-todo`, `pi-example-todo`) rather than core (`agent-sdk-types.ts:371-382`, `extensions/registry.ts`).

## 4. Interactivity

- **Permissions / extension UI dialogs:** Pi has no native tool-approval gate; approvals arrive only as extension `extension_ui_request` dialogs. `mapExtensionUiRequestToPermission` turns `select`/`input`/`editor`/`confirm` into a Paseo `question` permission (`agent.ts:940-1010`), answered via `respondToPermission` → `extension_ui_response {value|confirmed|cancelled}` (`agent.ts:1150-1175`, `cli-runtime.ts:233-244`). Optional inputs preserve skip semantics; `ask_user` chains (select→optional comment) are coalesced (`docs/providers.md`, `agent.ts:1020-1060`).
- **Steer vs follow-up vs abort:** native `steer` RPC queues a message mid-turn (`agent.ts:388-437`); slash-command inputs report `unavailable` (Pi rejects extension commands on steer) and fall back to interrupt-and-replace. Steer echo is correlated by message **text** (Pi's steer RPC has no message id) (`agent.ts:1740-1770`). Abort issues `clear_queue` then `abort` (`agent.ts:1330-1360`, `cli-runtime.ts:150-168`); old binaries without `clear_queue` degrade gracefully (COMPAT shim).
- **Model/thinking switching:** `setModel` (`set_model`) and `setThinkingOption` (`set_thinking_level`) with 7 thinking levels off→max gated by `model.reasoning`/`thinkingLevelMap` (`agent.ts:1300-1325, 697-745`).
- **Slash commands / skills / prompt templates:** `get_commands` → mapped to `AgentSlashCommand` with kind `command`/`skill`; `/compact` and `/autocompact` are built-in handled commands run **out of band** (`tryHandleOutOfBand`, `agent.ts:1680-1725, 2000-2080`).
- **Image attachments & file mentions:** prompt input blocks (text/image/attachment) are converted; attachments rendered as text (`agent.ts:217-262`).

## 5. History / resume

- **Load existing sessions:** `getHistory` reads the Pi JSONL file directly (not an RPC), selecting the active branch ancestry across compaction (`cli-runtime.ts:170-195`, `transcript.ts:84-133`). `streamPiHistory`/`PiHistoryMapper` replays it into the same timeline events as the live path (`history-mapper.ts:300-345`).
- **`get_messages`/`switch_session`:** Paseo does **not** use `get_messages` (it reads the file; `rpc-types.ts:139` lists it but it's unused). There is no Pi "list sessions" RPC, so import discovery scans JSONL files on disk (`session-descriptor.ts:73-110`, `docs/providers.md:84`).
- **Fork / branch / rewind:** supported via a bridge. `revertConversation` calls the injected extension's `paseo_tree` command → `ctx.navigateTree(targetId)` and appends a `paseo_rewind` marker entry so the rewind survives Pi reopening at the last leaf (`agent.ts:1603-1640`, `agent.ts:560-600`, `rewind.ts`). `supportsRewindConversation:true`, files not (`agent.ts:166-175`).
- **Transcript persistence:** Pi's JSONL is the authority; Paseo's timeline rows are rebuilt from it on resume (`architecture.md` "Agent lifecycle").

## 6. Gaps vs TUI & the bridge extension

- **Injected bridge:** Paseo generates `paseo-integration.mjs` and passes it with `--extension` (`agent.ts:442-640`). It: appends Paseo/daemon system prompt via `before_agent_start` (because `--append-system-prompt` would suppress Pi's `APPEND_SYSTEM.md`, `docs/providers.md`); registers injected MCP servers; captures submitted user entries (Pi assigns entry ids only after `message_end`, matched by reference equality); emits the session entry tree for rewind; and runs the `paseo_tree`/`paseo_capture_entries` commands. Communication is one-way via `ctx.ui.notify` with base64 JSON markers decoded in `handleExtensionUiRequest` (`agent.ts:1876-1945`).
- **Per-extension adapters:** community Pi extensions (subagents, ask_user, todo, goal-x, MCP adapter) each get a registry entry under `extensions/` that maps their RPC facts to Paseo tool/timeline/subagent/question models; `agent.ts`/mappers never name an extension (`extensions/registry.ts`, `extensions/contract.ts`, `docs/providers.md`).
- **Lost:** custom TUI components, custom tool renderers (fall back to generic `unknown`), and built-in TUI commands like `/settings`/`/tree` have no GUI. Fire-and-forget extension UI (notifications) are shown generically or ignored (`agent.ts:1876-1900`). Native `system`/`branchSummary`/`compactionSummary` records are dropped in replay (`transcript.ts:95-105`).

## 7. Terminal coexistence

- Paseo is a GUI/daemon system, not a Pi TUI host. There is no in-GUI toggle to run the *same* session as a TUI. The bridge path is **import**: a Pi session started in a terminal writes JSONL under `~/.pi/agent/sessions`, which Paseo discovers (`listImportableSessions`) and resumes through `pi --mode rpc --session` (`session-descriptor.ts:73-150`, `agent.ts:2890-2905`). So a terminal-started session can be continued in the GUI, but not simultaneously driven from both.
- Paseo *does* own real terminals, but in a separate detached **terminal worker** process, unrelated to the agent RPC (`docs/terminal-worker.md`, `architecture.md`). When resuming for history only, the process closes after replay (`closeAfterHistory`, `agent.ts:310-316`).

## 8. Clever bits & pitfalls

Worth copying:
- **Thin per-chunk deltas + client-side accumulation keyed by `messageId`, flushed on a frame boundary** avoids re-sending cumulative text and paces reveal (`agent.ts:2444-2459`, `session-stream-reducers.ts:792-824, 1855-1861`; `docs/agent-stream-performance.md`). COMPAT handles old Pi that resends cumulative messages (`rpc-types.ts:168-174`).
- **Image extraction before stringify** so base64 never lands in tool output / history (`tool-call-mapper.ts:233-279`).
- **Ordered async emit queue** (`emitAsync`/`pendingOutput`) keeps timeline order while images are materialized, without blocking state events (`agent.ts:1745-1775`).
- **Incremental child-transcript follower** with byte/line caps (2 MiB/200 items, 16 MiB replay budget) and partial-line buffering until newline (`child-session.ts:55-105`, `host.ts:44-66`).
- **Durable turn boundary** gated on `agent_settled`, and abort that clears Pi's queue first so a queued steer can't resume a just-stopped turn (`agent.ts:2338-2360, 1330-1360`; `docs/providers.md` steering contract).
- **Reconnect/replay correctness:** live stream + authoritative `fetch_agent_timeline` + paged catch-up + sequence dedup + per-run epochs; 8 MiB outbound high-water mark with per-socket termination, 4 MiB terminal backpressure (`architecture.md` "WebSocket protocol", "Agent lifecycle"; `docs/timeline-sync.md`).

Pitfalls to avoid:
- **Text-correlated steer echo** is fragile — identical steer text can mis-associate (`agent.ts:1740-1770`). Prefer a provider message id when the agent exposes one.
- **No native permission gate in Pi** — all approvals ride extension dialogs; a Pi build without the relevant extension gives you no approval UX (`agent.ts:940-1010`).
- **Entry-id capture races:** Pi only assigns ids after `message_end`, so Paseo captures by object reference equality and flushes on `message_start`/`turn_end` — brittle if another extension mutates the message (`agent.ts:510-560`).
- **Rewind must re-anchor:** Pi reopens at the last leaf, so a `paseo_rewind` marker entry is appended or the rewind is lost (`agent.ts:583-600`).
- **Compaction blocks prompts:** manual `/compact` is a no-timeout RPC and prompts are deferred until it settles; model this as out-of-band work, not a turn (`cli-runtime.ts:150-166, 263-271`, `agent.ts:1988-2060`).

---

## What Herdr should copy / avoid

Copy:
- Normalize everything to one cross-provider timeline (`AgentStreamEvent` + typed `ToolCallDetail`); keep the daemon/owner as source of truth and let the UI be a thin, reconnectable subscriber. Herdr mods are socket clients — mirror Paseo's "live for immediacy, authoritative fetch for truth, paged catch-up, sequence dedup" model.
- Launch Pi as `pi --mode rpc` over a long-lived JSONL-RPC socket owned by a resident process; resume from Pi's JSONL file by path. A GPUI mod can open that TCP/WS to a resident daemon rather than spawning Pi per-panel.
- Send per-chunk text/reasoning deltas keyed by a message id and accumulate in the renderer on a paint boundary; extract images before serializing; follow child transcripts incrementally with hard caps.
- Inject a small Pi extension for: system-prompt compose (not `--append-system-prompt`), entry/tree capture for rewind, and MCP registration; keep per-extension adapters out of the core mapper.
- Bridge `extension_ui_request` dialogs into your approval/question UI; gate abort behind `clear_queue`+`abort`; complete turns on `agent_settled`.

Avoid:
- Don't PTY-scrape the TUI — use RPC. Paseo never scrapes.
- Don't correlate steer echoes by text if you can mint/track a message id.
- Don't assume Pi gives tool approvals natively; plan for extension-driven dialogs (and graceful absence).
- Don't treat `agent_end` as terminal on modern Pi, and don't resend cumulative assistant text.
- Don't expect `/settings`, `/tree`, custom TUI components, or custom tool renderers to survive into a GUI — fall back to a generic renderer and reimplement the few that matter (`/compact`, rewind).
