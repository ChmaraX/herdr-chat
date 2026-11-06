# Orca → Pi native GUI chat: how it works (research for Herdr)

Repo: `stablyai/orca` (Electron IDE, "run Codex/Claude/OpenCode/Pi side-by-side"). All paths below are in this repo
unless noted. Pi docs referenced from the installed package under `.../pi-coding-agent/docs/`.

## TL;DR (10 lines)
1. Orca runs two integrations in parallel: a **TUI/PTY** path (scrape terminal + parse agent hook/transcript files) and a **"native chat" / structured** path that is a real GUI chat. For Pi the GUI uses **`pi --mode rpc`** over the child's **stdio** as newline-delimited JSON-RPC (`src/main/pi/rpc-launch.ts:107`, `src/main/jsonl-rpc/agent-connection.ts:51`).
2. The Pi child is owned by the Electron **main process** (an in-process `PiRpcSessionAdapter`), not the renderer; renderers/mobile attach as RPC clients to a runtime server and get journal snapshots (`src/main/pi/rpc-session-adapter.ts`, `src/main/runtime/runtime-rpc.ts`).
3. Pi RPC events (`message_*`, `tool_execution_*`, `agent_start/end`, `agent_settled`, `compaction_*`, `auto_retry_*`, `extension_ui_request`) are normalized into a **provider-agnostic `ProviderTimelineEvent`** stream, then into a durable **journal** (`AgentJournal*Item`) shared by every provider (`src/main/pi/rpc-turns.ts`, `src/main/native-chat/agent-session-timeline/provider-timeline-event.ts`).
4. Streaming text and "thinking" are split into `assistant`/`reasoning` channels by content index; tool calls become `tool-call` items with running→completed/failed state + bounded input/output previews (`src/main/pi/rpc-messages.ts`).
5. Turn/run state is reconstructed host-side: Orca mints turn IDs, tracks steer vs follow-up, and **polls `get_state` to confirm idle** because Pi's settle is lifecycle-only (`src/main/pi/rpc-turns.ts:48`, `rpc-idle-check.ts`).
6. Extension UI dialogs (`confirm`/`select`/`input`/`editor`) map to journal **approval**/**question** request cards; terminal decoration (`notify/setStatus/setWidget/setTitle`) is intentionally dropped (`src/main/pi/rpc-extension-dialogs.ts`, `rpc-dialog-callbacks.ts:12`).
7. Steer vs follow-up is automatic: a send while working gets `streamingBehavior:'steer'`, else `'followUp'`; Stop = `abort` RPC + cancel dialogs (`src/main/pi/rpc-turns.ts:76`, `rpc-session-adapter.ts cancelTurn`).
8. History/resume uses Pi's own session file + `get_entries` branch reconciliation, persisted into Orca's journal with a resume cursor; GUI transcript is the journal, snapshot+cursor replayed to clients (`src/main/pi/rpc-session-startup.ts`, `rpc-history-capture.ts`).
9. Images: local-path only, sniffed + size-capped, sent as base64 in the `prompt` frame; URLs rejected (`src/main/pi/rpc-prompt.ts`).
10. Clever bits worth copying: oversized-record head recovery, bounded maps for backpressure, host-side idle probe, journal-as-source-of-truth for multi-client reconnect. Pitfall: lots of Pi-TUI richness (custom extension TUIs, `/settings`, `/tree`, custom tool renderers) is lost; they inject a **visuals skill** to compensate.

---

## 1. Process & transport

**Mode.** Pi GUI chat launches `pi --mode rpc`. `buildPiRpcLaunch` hard-codes `--mode rpc` and *rejects* a caller trying to pass `--mode/--print/--session/-r/--fork/...` itself, and requires full access:
```ts
if (!options.fullAccess) throw new Error('Pi structured chat supports full access only')   // rpc-launch.ts:58
args: [...prefix, '--mode','rpc', ...args,
       ...(sessionFile?['--session',sessionFile]:[]),
       ...(forkFile?['--fork',forkFile]:[])]                                                 // rpc-launch.ts:107
```
(`src/main/pi/rpc-launch.ts:58,86,107`). `--session`/`--fork` are added by Orca for resume/branch. The TUI path instead treats `--mode rpc|json|acp|daemon` as *non-interactive* and only hosts the TUI in text mode (`src/shared/prime-agent-headless-command.ts:3`).

**Transport.** Child stdio, newline-delimited JSON-RPC via `JsonlRpcPeer(child.stdout, child.stdin, …)` (`src/main/jsonl-rpc/agent-connection.ts:51`). Not a socket. Commands seen: `get_state`, `get_commands`, `get_entries`, `get_messages`, `get_session_stats`, `prompt`, `abort`, `set_model`, `set_thinking_level`, `set_session_name`, `extension_ui_response` (`src/main/pi/rpc-options.ts:41,176,182,217`, `rpc-session-adapter.ts`).

**Owner.** The main process owns the child through `PiRpcSessionAdapter` (`implements StructuredAgentSessionAdapter`), keyed by `sessionId`, with careful spawn/exit proof (`ProviderAcquisitionStarts`, root-exit verdicts) (`src/main/pi/rpc-session-adapter.ts:33-130`). Renderer and mobile are **RPC clients** of a runtime server (`src/main/runtime/runtime-rpc.ts`, websocket + long-poll transports under `runtime-rpc/`), receiving journal snapshots — not the raw Pi pipe.

**Survival / multi-client.** The transcript is the durable **journal**; clients resume via `AgentJournalSnapshot { cursor, items, submissions }` and a cursor; any resume failure forces a clean reload (`AGENT_JOURNAL_RESET_REASONS`) (`src/shared/agent-session/journal/agent-session-journal-types.ts:~470-490`). Multiple clients (desktop + phone) attach to the same session; a durable compare-and-set `AgentJournalResolution` stops two clients answering one prompt twice (`…journal-types.ts:~150`). If the Pi child dies, the lane is finalized `session.ended {state:'interrupted'}` and held sends are reconciled (`src/main/pi/rpc-session.ts:exit()`). The child does **not** itself survive main-process exit (it is a supervised child), but the journal does, enabling resume via Pi's session file (§5).

## 2. Event model → normalized types

Pi frames are parsed with zod (`src/main/pi/rpc-protocol.ts`) and fed to `PiRpcTurns.receive` (`src/main/pi/rpc-turns.ts:116`). Each maps to one or more `ProviderTimelineEvent` applied to a `JsonlRpcTimelineLane`:

| Pi RPC frame | Normalized handling |
|---|---|
| `message_start/update/end` | `PiRpcMessages.message` → `text.delta`/`text.close` on `assistant` vs `reasoning` channel (`rpc-messages.ts:76-140`) |
| `tool_execution_start/update/end` | `PiRpcMessages.tool` → `item.open/update/close` with `AgentJournalToolCallItem {state: running|completed|failed}` (`rpc-messages.ts:150-230`) |
| `agent_start` | `turn.open` (Orca mints `run:<gen>:<n>` when Pi supplies none) (`rpc-turns.ts:131,` `open()`) |
| `agent_end`/`turn_end` | lifecycle-only; may precede retry/compaction, so **not** treated as settle (`rpc-turns.ts:186`) |
| `agent_settled` | `commandCompleted()` → idle probe → `turn.end {outcome}` (`rpc-turns.ts:190`) |
| `compaction_start/end`,`auto_compaction_*` | `context.compacting()/compacted()`; `willRetry` clears failure (`rpc-turns.ts:196-214`) |
| `auto_retry_start/end` | `piRpcRetryActivity` activity rows; failure text on non-success (`rpc-turns.ts:216-229`) |
| `extension_ui_request` | routed to `PiRpcDialogCallbacks` not turns (`rpc-session.ts` onRecord) → `request.open` |
| oversized record | head recovered from JSON prefix regex + "content missing" notice (`rpc-protocol.ts:63-95`) |

Normalized **wire model** (`provider-timeline-event.ts`): `turn.open/turn.end`, `item.open/update/close`, `text.delta/close` (`channel: assistant|reasoning`), `request.open/withdrawn`, `context.usage`, `activity`, `provider.frame` (fallback), `session.ended`. The assembler, not the adapter, owns turn rows and prompt→turn binding (`input.accepted` + `join {turn}`); comments at top of that file state the invariants ("Only turn.open creates turns… Settled rows never regress").

Durable **render model** (`agent-session-journal-types.ts`): `AgentJournalItemBody` = `message | tool-call | diff | approval | question | status | turn | agent-start | agent-handoff`. Tool calls carry `state`, `endedAs` (`interrupted|unverifiable`), `output: AgentJournalBoundedPayload {head,byteLength,digest,truncated}`. Turns carry `AgentJournalTurnLifecycle {state, outcome, requestedAt, durationMs, contextUsage}`. Submissions are write-ahead rows (`AgentJournalSubmission {dispatchState: pending|accepted|rejected|unknown}`), giving durable "did my send land?".

Key subtlety: **Pi doesn't name assistant messages**, so Orca assigns local ordinals and keys text items `message:<gen>:<ordinal>:<index>:<channel>` (`rpc-messages.ts:key()`, comment at `:62`). Thinking vs text is purely `content[i].type === 'thinking'` → `reasoning` channel (`rpc-messages.ts:31-36,125`).

## 3. Rendering

Renderer components in `src/renderer/src/components/native-chat/`:
- **Tool calls**: `nativeChatToolLineLabel` picks a verb by category+state (Running/Ran, Reading/Read, Editing/Edited, Added/Deleted/Renamed, Searching, Listing, Fetching, "Searching the web", "Subagent") (`src/shared/native-chat/tools/native-chat-tool-line-label.ts:12-48`). Category from `nativeChatToolCategory(name, mcpIdentity)`; **unknown tools render as a generic command row** (`native-chat-tool-icon.ts`, line-label `command = category==='unknown'`).
- **MCP/custom tools**: detected via explicit identity or `^mcp__<server>__<tool>$`, server/tool humanized (`native-chat-tool-identity.ts:mcpToolIdentity`). `webSearchResults`, `exitCode`, `durationMs` surfaced as metadata.
- **bash**: command rows show full command + language label (`fullCommand/commandDetail/commandLanguage`).
- **read/edit/write diffs**: `AgentJournalDiffItem {path, patch}` and editor cards: `NativeChatDiffCard.tsx`, `NativeChatDiffView.tsx`, edit modeling in `native-chat-edit-model.ts`, `native-chat-unified-patch.ts`, `native-chat-begin-patch.ts`, LCS in `native-chat-edit-lcs.ts`.
- **Thinking blocks**: `NativeChatReasoningRow.tsx` collapsible with headline "Thought for <d>"/"Reasoning" (`native-chat-reasoning-row.ts`).
- **Streaming markdown**: `NativeChatPacedMarkdown.tsx` / `NativeChatMarkdown.tsx` (code wrap, mermaid, inline images).
- **Images**: `NativeChatMarkdownImage.tsx`, `NativeChatImageAttachmentPreview.tsx`, session-image read client.
- **Subagents**: `native-chat-subagent-sections.ts`, `NativeChatMessageList.subagent-sections.test.tsx`; producer linkage `AgentJournalProducerLinkage {agentId,parentAgentId,attempt}` lets subagent rows thread under a parent.
- **Todo/plan**: plan approval modeled as `AgentJournalPlanApprovalSubject {kind:'plan', text, filePath}`; thread-goal rows `native-chat-thread-goal-rows.ts`.
- **Virtualization**: long transcripts use growth windowing (`NativeChatMessageList.growth-windowing.spec.tsx`, `native-chat-autoscroll.ts`, reader-navigation spec).

## 4. Interactivity

- **Approvals / extension dialogs**: `extension_ui_request` → `piRpcDialogPresentation` maps Pi's 4 methods to cards (`src/main/pi/rpc-extension-dialogs.ts`):
  - `confirm` → `kind:'approval'` with Yes/No; reply `{confirmed:boolean}`.
  - `select` → `kind:'question'` with option list; reply `{value:<label>}`.
  - `input`/`editor` → `kind:'question'` free-text (`editor`=multiline+prefill); reply `{value:<text>}`.
  Cancel → `{cancelled:true}`. Capacity-guarded (≤64 pending, ≤8 MiB) (`rpc-dialog-callbacks.ts:46`). Decoration methods (`notify/setStatus/setWidget/setTitle/setEditorText`) are dropped (`rpc-dialog-callbacks.ts:12`). Answers are durable + CAS so only one client wins.
- **Steer vs follow-up vs abort**: send chooses behavior by live state — `streamingBehavior: this.working ? 'steer' : 'followUp'` (`src/main/pi/rpc-turns.ts:76`). Abort = `session.turns.stop(); dialogs.cancelAll(); connection.request('abort')` (`rpc-session-adapter.ts cancelTurn`). Queued messages are modeled (`NativeChatQueuedMessage*`, submissions with `queuedMessageId`).
- **Model / thinking switching**: `set_model` / `set_thinking_level` RPCs via `applyPiRpcSessionOption`; catalog from `get_commands`/model-options probe; effort levels `PI_THINKING_LEVELS` (`src/main/pi/rpc-options.ts:176-197`, `rpc-model-options.ts`). Picker UI `NativeChatModelCombobox.tsx`, `NativeChatPermissionModePicker.tsx`.
- **Slash commands / skills / templates**: `get_commands` → `AgentSessionSlashCommand[]` surfaced in composer autocomplete (`rpc-session-startup.ts readCommands`, `NativeChatAutocompleteMenus.tsx`). Skills chosen per-message recorded as `AgentJournalMessageItem.skills: AgentJournalSkillRef[]`; conversation commands recorded as `message.command {name,instructions}`.
- **Image attachments / file mentions**: `preparePiRpcPrompt` reads local images, sniffs magic bytes, caps 5 MiB/image, 20 images, 20 MiB total, rejects URLs, enforces RPC line limit (`src/main/pi/rpc-prompt.ts`). File-reference pills: `NativeChatFileReferencePill.tsx`, `native-chat-markdown-file-destinations.ts`.

## 5. History / resume / fork

- **Startup reconcile**: on open, `get_state` (rejects `provider:'unknown'` as not-signed-in), then `catchUpPiSession` reads Pi's session file + `get_entries` to rebuild the active branch; a resume decodes a stored `resumeCursor` claim (`src/main/pi/rpc-session-startup.ts:44-86`).
- **Branch math**: `piBranchSince`/`piBranchInTree` walk leaf→claim over `get_entries` (`entries[]`, `leafId`), refusing unknown claims (`src/main/pi/rpc-history-import.ts`). `get_entries` "returns append order, including abandoned branches" (comment `:23`).
- **Catch-up persistence**: after each turn, `PiHistoryCapture.turnEnded` drains the lane, snapshots Pi's leaf, and persists `handle.resumeCursor = encodePiHistoryClaim({entry, epoch, sequence})` so the next open claims exactly through that cursor (`src/main/pi/rpc-history-capture.ts:60-120`).
- **Resume/fork launch**: `--session <file>` (resume) or `--fork <file>` (branch) added by `buildPiRpcLaunch`; a resumed/forked session keeps its own model (`resolvesConfig=false`), a fresh one adopts config default (`rpc-launch.ts:107`, `rpc-session.ts resolvesConfig`).
- **GUI transcript persistence**: the journal (`src/main/native-chat/agent-session-journal/`) is the source of truth; transcript files are also imported/decoded per provider (`transcript-line-decoders-*.ts`) — Pi history is read through `get_entries`/`get_messages`, not by scraping. `switch_session` equivalently is a new acquire against a different session file.

## 6. Gaps vs Pi TUI, and coping

- **Lost**: Pi extension **custom TUI widgets** and decoration (`setWidget/setStatus/setTitle/notify`) are discarded in chat (`rpc-dialog-callbacks.ts:12`); only the 4 modal dialog shapes survive. Built-in TUI screens like `/settings`, `/tree`, and any custom tool-specific TUI renderer have no GUI equivalent — unknown tools degrade to a generic command row (`native-chat-tool-icon.ts`), unknown approval subjects are "carried but never drawn/approved" (`AgentJournalUnknownApprovalSubject`, journal-types `:~250`).
- **Coping / injected extension**: Orca ships a **"native-chat visuals" skill/plugin** it delivers to the Pi child via env (`ORCA_CHAT_SCRATCH_DIR`) so the agent can emit rich inline visuals the GUI renders (`src/main/native-chat/native-chat-visuals-delivery.ts`, `src/shared/orcad-artifacts.ts:169` → `native-chat-visuals/skills/orca-chat-visuals/SKILL.md`). Inline visuals rendered by `NativeChatInlineVisual.tsx` + `native-chat-visual-markdown-extension.tsx`. The scratch dir is per-chat and stripped from inherited env so chats can't cross-write.
- **Fallbacks**: unmodeled frames become a bounded `provider.frame` status row rather than being dropped (`provider-timeline-event.ts`, `AgentJournalStatusItem.providerFrame`). Oversized events keep their head (§2).

## 7. Terminal coexistence

- Orca keeps **both**: the same agent can run as a TUI in a PTY pane (hook-listener + transcript scraping: `src/shared/agent-hook-listener/providers/pi-family-events.ts`, `pi-family-tool-fields.ts`, PTY fixtures `src/main/runtime/__fixtures__/pi-0-74-*.txt`) or as a structured GUI chat (`src/main/pi/rpc-*`). The TUI path parses Pi lifecycle events (`session_start`, `tool_call`, `ui_prompt_start/end`, `compaction_start`, `agent_end`, `model_select`, `subagents_update`) into a shared `ParsedAgentStatusPayload` just for status/title/attention, not a full transcript.
- Pi's session **file is the shared handle**: a comment notes "Pi stores its own sessions; an explicit session file is shared with terminal resumes" (`rpc-launch.ts:54`). So a conversation started in one surface can be resumed in the other via `--session <file>`, but there is no live hand-off of a single running child between TUI and GUI — each surface owns its own Pi process; they meet through the session file + journal.

## 8. Clever / pitfalls worth copying or avoiding

Copy:
- **Journal-as-truth + snapshot/cursor replay** for multi-client reconnect and durable "did it land?" submissions, with reset reasons forcing clean reload (`agent-session-journal-types.ts`).
- **Host-side idle confirmation**: don't trust `agent_end`; poll `get_state` and only settle when `!isStreaming && !isCompacting && pending==0` (`rpc-protocol.ts:piRpcIdle`, `rpc-idle-check.ts`) — Pi emits `agent_end` before retry/compaction.
- **Oversized-record head recovery**: regex the JSON prefix to keep tool/message identity + emit a visible "part missing" notice instead of desyncing (`rpc-protocol.ts:63-95`, `rpc-messages.ts:piRpcSkippedEventNotice`).
- **Backpressure**: bounded maps for open tool snapshots (`MAX_PROVIDER_TIMELINE_OPEN_ENTRIES`), per-message/tool caps (128 streams, 1 MiB tool bytes), reader pause holds that pace journal pressure but keep startup replies readable (`rpc-messages.ts`, `rpc-session.ts ReaderPauseHolds`).
- **Provider-agnostic timeline**: one `ProviderTimelineEvent`/journal model across Pi/Claude/Codex/OpenCode; adapters only translate. Herdr should define this seam first.
- **Auto steer/follow-up** from live turn state, and CAS answers so two clients can't double-resolve a prompt.
- **Inject a visuals skill** to recover GUI-only richness an agent's TUI extensions would otherwise provide.

Avoid / watch:
- Dropping decoration/custom-TUI means feature parity gaps; plan an escape hatch (generic rows, `provider.frame`) from day one.
- Turn identity is fragile because Pi doesn't name messages/turns — Orca mints IDs and documents "known limits" (a start silently folded into a running turn reads as `start`). Expect edge cases around steer-into-running-turn and compaction-between-reply-and-settle.
- Full-access only for Pi RPC (`fullAccess` required) — no sandbox/permission tiers in GUI chat yet.
- Image path-only (no URLs/remote) and strict RPC line-byte limit can reject large prompts (`historyTooLarge`).

---
### What Herdr should copy / avoid
- **Copy**: `pi --mode rpc` over stdio JSON-RPC; a provider-agnostic timeline+journal as the single source of truth; snapshot+cursor client attach; host-side `get_state` idle probe; oversized-head recovery; bounded-map backpressure; auto steer-vs-followUp; CAS prompt resolution; injected visuals skill for GUI-only rendering.
- **Avoid**: trusting `agent_end` as settle; assuming Pi names turns/messages; dropping unknown tools/frames silently (keep fallback rows); forgetting multi-client double-answer guards; blocking startup on journal backpressure.
