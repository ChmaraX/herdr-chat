# T3 Code vs the 12 Pi-GUI problems (read-only scout)

Repo: a clone of `t3code` (the commit is in `COMMITS.txt`). Every `path:line` points into that tree.
This builds on [`findings-t3code.md`](findings-t3code.md) and doesn't repeat it. Line numbers
are from the current checkout. Some differ from the earlier file, which was off by about 100 lines in `adapter.ts`.
`adapter.ts`, `rpc.ts`, `status.ts`, `commands.ts`, `mcpInjection.ts` and `mcpExtensionSource.ts`
all live under `packages/provider-pi/src/server/`.

## Summary table

| # | Solved? | One-line mechanism | Key path:line |
|---|---|---|---|
| 1 | partial | It re-implements a few builtins in its own UI or maps them to RPC (model, thinking, compact, name, new, fork/rollback, restart). `/login`, `/settings`, `/tree` and `/trust` are not offered; the docs send the user to a terminal `pi`. | `commands.ts:4-30`, `status.ts:507`, `useComposerMenuItems.ts:219-262` |
| 2 | no (partial mitigation) | `custom()` is not handled. Mitigations: never block on the `prompt` ack, honour dialog `timeout`, and Stop kills the Pi process group. Throwaway helper processes run `--no-extensions`. | `adapter.ts:2683-2686`, `adapter.ts:2759-2792`, `textGeneration.ts:44-52` |
| 3 | partial | `notify` becomes a plain-text work-log row (no ANSI stripping, level dropped, dropped outside a turn). setStatus/setWidget/setTitle are ignored. One renderer exists for one extension tool (`subagent`). Command output gets a real SGR parser. | `adapter.ts:1314-1333`, `adapter.ts:1112-1114`, `packages/shared/src/terminalOutput.ts:1-10` |
| 4 | yes (versions) / yes (composer) | It checks `pi --version` against a minimum and gates features by version or by feature detection. Recorded Pi RPC transcripts are replayed in CI. The composer has history recall, `@` path search via `git ls-files`, `/` and `$` menus fed by `get_commands` per cwd, persisted drafts and keybindings. No external editor. | `status.ts:62-68`, `mcpExtensionSource.ts:317,364`, `apps/server/scripts/record-pi-rpc-replay-fixture.ts:33-35` |
| 5 | yes | Paste, drag-drop and picker upload to the server's attachment store over HTTP. The adapter reads the file and sends base64 `images[]`. Caps: 100 files, 10 MiB per image, 80 MiB of images per message, longest edge 2000 px. Tool-result images are capped at 8, and their base64 is stripped from the wire and served by URL. | `adapter.ts:2437-2461`, `packages/contracts/src/chatAttachment.ts:13-17`, `packages/shared/src/toolOutput.ts:242-256` |
| 6 | yes | Server-side status derivation drives sidebar pills, sounds, toasts, OS notifications and the dock badge. Other agents and CLIs reach any thread through an OAuth-gated `/mcp` (`t3_thread_send/read/wait`) or the `t3 thread` CLI. Subagents use `delegate_task`. | `Sidebar.logic.ts:882-910`, `ThreadNotificationCoordinator.tsx:61-200`, `apps/server/src/cli/thread.ts:205-235` |
| 7 | yes | 50 ms server stream flush. Virtualized LegendList with stick-to-bottom. Only the last markdown block re-renders. History pages of about 1 MiB or 500 rows. Tool bodies are omitted on the wire and loaded on expand. Find bar and copy buttons. | `adapter.ts:82,966`, `MessagesTimeline.tsx:1307-1343`, `markdownStreamBlocks.ts:7-11` |
| 8 | yes | Server-owned agents. The client connection runtime handles route lists, jittered backoff and dead-socket probes. LAN, Tailscale, SSH-launched servers and the T3 Connect relay. Snapshot/catch-up resume. | `docs/internals/remote.md:33-46,162-169`, `docs/internals/connection-runtime.md:11-36` |
| 9 | yes | Process-group teardown with liveness checks. On Pi crash the turn fails as "Pi process exited unexpectedly". On server restart or shutdown, recovery terminalizes in-flight runs and can queue a "continue where you left off" run. The session is reopened by file path on the next turn. Idle Pi processes are released after 30 min. | `rpc.ts:172-237`, `adapter.ts:2208-2248`, `ProviderRuntimeRecoveryService.ts:199-271` |
| 10 | no | There is no lock on Pi session files and no GUI↔terminal handoff. It has a single writer only by construction (one Pi process per T3 session), and forks always write a new file, which is checked. T3 locks its own state dir with an exclusive SQLite lock. | `adapter.ts:3099-3144`, `apps/server/src/serverOwnership.ts:203` |
| 11 | yes | An `agent_start` with no active T3 turn becomes a buffered "wake". The wake is offered to a continuation queue that creates an agent-attributed run, and its buffered events replay into it. If no handler accepts it, Pi is killed. | `adapter.ts:1702-1766`, `ProviderContinuationService.ts:183-206`, `adapter.ts:2620-2669` |
| 12 | yes | Loopback by default (private-only for the LAN service). Scoped sessions via pairing codes, bearer/DPoP/cookie auth and short-lived WS tickets. Every RPC is scope-checked. Desktop uses an HMAC bootstrap token. Each Pi process gets its own MCP bearer token, revoked on release. | `docs/internals/environment-auth.md:73-89`, `packages/shared/src/desktopBootstrapToken.ts:4-31`, `docs/orchestration-v2/orchestrator-mcp-server.md:42-56` |

---

## 1. Built-in TUI commands not available over RPC

The code says it outright: `// Pi RPC get_commands omits TUI builtins. Advertise /compact so T3 can map it to RPC compact.` (`commands.ts:4`). `withPiBuiltinSlashCommands` adds only `/compact`, at the front of the list (`commands.ts:26-30`). Each builtin is handled like this:

| TUI builtin | T3 equivalent | How |
|---|---|---|
| `/compact` | `/compact [instr]` in composer, "Compact context" in meter | Maps to RPC `compact` (`adapter.ts:598-600`, `adapter.ts:2559-2563`, `adapter.ts:2632-2637`). Stop during compaction terminates the process (`adapter.ts:2771-2792`). |
| `/model` | Model picker, T3 `/model` command (`useComposerMenuItems.ts:219-226`) | Maps to RPC `set_model` / `set_thinking_level` diffed per turn (`adapter.ts:2383-2432`). The model list comes from a discovery `get_available_models` (`status.ts:176`). |
| `/new` | New thread | Maps to RPC `new_session` (`adapter.ts:2292-2296`). |
| `/resume` | Sidebar/thread list (T3 threads only) | Maps to RPC `switch_session {sessionPath}` using the stored file path (`adapter.ts:2292-2295`). Pre-existing Pi sessions created in a terminal are **not importable** (no reader of `~/.pi/agent/sessions` except usage accounting, `usage.ts:17-50`). |
| `/fork` | "Fork from turn" | Shells out: a separate `pi --mode rpc --no-extensions --no-tools --fork <src>`, then `fork {entryId}` (`adapter.ts:3099-3144`). |
| `/tree` | Only "edit an earlier prompt" (rollback) | Rollback = `fork {entryId}` on the live process (`adapter.ts:2999`). There is no tree browser. |
| `/name` | Thread title (auto-generated or renamed) | Pushed with RPC `set_session_name` when the title changes (`adapter.ts:2546-2556`). |
| `/session` | Context meter / usage | `get_session_stats` (`adapter.ts:707-711`) plus live usage from `message_update` (`adapter.ts:713-725`). |
| `/reload` | Command palette "Restart agent session" (`apps/web/src/components/CommandPalette.tsx:1421`) | Restarts the provider process; the next turn re-resumes the file (`docs/user/composer.md:242-244`). |
| `/copy` | Message copy button (`apps/web/src/components/chat/MessageCopyButton.tsx:32-46`) | Re-implemented. |
| `/hotkeys` | Settings → Keybindings (`docs/user/keybindings.md:1-4`) | Re-implemented (its own keymap, not Pi's). |
| `/export` | Cross-environment transcript export (`docs/internals/performance-regressions.md:39-41`) | Re-implemented; no Pi HTML export. |
| `/quit` | n/a | The process lifecycle is owned by T3. |
| `/settings` | Only binary path, launch args, custom models, env (`packages/provider-pi/src/settings.ts:11-40`) | Not addressed for Pi's own `settings.json`. The docs suggest launch args or `PI_CODING_AGENT_DIR` (`docs/user/providers-pi.md:20-24`). |
| `/login`, auth.json | **Not offered.** | The docs say: run `pi` in a terminal, then `/login` (`docs/user/providers-pi.md:11`, `:26-30` for headless/SSH). Auth state is only *diagnosed*: `authenticated = discoveredModels.length > 0` (`status.ts:191`). For an unavailable default model it shells out to `pi auth check --provider X --json --no-refresh` (Pi ≥0.84.1) and, on `credentials_not_configured`, tells the user to `/login` (`status.ts:67-68`, `status.ts:251-292`, message `status.ts:507`). |
| `/trust` | Not offered | The injected extension sends a one-time `ctx.ui.notify` telling the user to run `pi` → `/trust` (`mcpExtensionSource.ts:244-257`). |

Launch args that would collide with T3's lifecycle are rejected: `--mode`, `--session`, `--resume`, `--fork`, `--print`, `--export`… (`mcpInjection.ts:14-32`).

**Transferable to Herdr**
- Build a builtin→RPC table in the host. Re-implement model/thinking/compact/name/new/stats natively in the mod. Do `/fork` the same way: spawn a short `pi --mode rpc --no-extensions --no-tools --fork <file>` from the host, not from the mod's 30 s `exec`.
- For `/login`, `/trust` and `/settings`: Herdr has terminals. Open a real `pi` TUI in a herdr-core terminal for those (better than T3's "go find a terminal"). Detect missing auth the way T3 does, with discovery model count plus `pi auth check --json --no-refresh`.
- `/resume` of terminal-created sessions is a gap in T3 that Herdr can close: list `~/.pi/agent/sessions/<cwd>` and `switch_session`, keeping the problem-10 caveats in mind.

## 2. `ctx.ui.custom()` returns undefined in RPC mode / extension commands hang

**Not addressed.** There is no reference to `custom` anywhere in the Pi adapter or the bridge extension (`rg 'ui\.custom'` finds nothing). Partial mitigations:
- **Never block on the prompt ack.** The adapter fires `prompt` and treats the ack as a later event: `// Pi acks prompt only after slash-command expansion completes, and extension commands may block on user dialogs indefinitely. Rejections therefore return later as id-less response records handled by the event pump.` (`adapter.ts:2683-2686`). So a hung command does not deadlock the event pump.
- **Command-only prompts are settled by polling.** A `/cmd` turn is tagged `promptMayBeCommandOnly` (`adapter.ts:2596-2597`). After the ack, a `get_state` settle probe finalizes the turn (`adapter.ts:2066-2075`, handler `adapter.ts:2128-2170`). If the command never returns, `isStreaming` may stay false. The turn then stays open until Stop. *Inference:* the probe only runs after the ack, so a command stuck in `await custom()`, which never acks, keeps the turn "working".
- **Stop kills the process.** User Stop arrives with `requestRuntimeRestart: true` (`apps/server/src/orchestration-v2/ProviderTurnControlService.ts:223-228`). Pi then runs `clear_queue` and `abort`, captures tree refs, and `connection.terminate`s the process group (`adapter.ts:2771-2792`). The server caps any interrupt at 15 s (`ProviderSessionManager.ts:61`, `:1878-1893`).
- **Dialog timeouts are honoured.** `timeout` on `select/confirm/input/editor` schedules a synthetic `t3.ui_request_expired` (`adapter.ts:1347-1352`, `:1468-1486`, handled `:2108-2115`).
- **No extension allowlist** for live sessions: Pi loads the user's extensions normally (`docs/user/providers-pi.md:50`). Only T3's own helpers are filtered. Text generation runs `ephemeral + --no-extensions + --no-tools` (`textGeneration.ts:44-52`) and so does the fork helper (`adapter.ts:3101-3108`), with restrictions appended *after* user args so they can't be re-enabled (`mcpInjection.ts:271-273`).
- Extension load/runtime errors (`extension_error`) become error rows naming the extension (`adapter.ts:1463-1500`, `piExtensionDisplayName` `adapter.ts:3376`).

**Transferable to Herdr**
- Copy the "ack is an event, not a blocking await" rule, the settle probe, and "Stop = abort then kill the process group".
- Go further than T3. The host knows which `/command` it sent and can detect a prompt with no ack, no `agent_start` and no `extension_ui_request` after N seconds. It can then show "this extension command may need the TUI", with an "Open in terminal TUI" action (the same session in a herdr-core terminal after stopping RPC; see #10).
- An injected bridge extension (the T3 pattern) can wrap known-bad commands. A per-extension denylist plus `--no-extensions` for helper processes is cheap.

## 3. Extension decoration and custom renderers

- `notify` → `system_notice` work-log row with `label: item.message` (`adapter.ts:1314-1324`; `apps/web/src/session-logic.ts:479-484`). It is dropped when there's no active turn (`adapter.ts:1318`). The `notifyType` level is not passed (`emitSystemNotice(turn, id, message)`). **No ANSI stripping** on this path; no escape handling exists in the Pi adapter.
- `setStatus`, `setWidget`, `setTitle`, `set_editor_text` and any other method: `logDebug("Ignoring pi extension UI update.")` (`adapter.ts:1326-1333`). The docs say: "Pi terminal decoration such as titles, status lines, and widgets does not have a T3 Code equivalent" (`docs/user/providers-pi.md:51-53`).
- Custom tool renderers (`renderCall`/`renderResult`) are not rendered. Tool classification is by name only: `bash|powershell` → command (`adapter.ts:1058-1074`), `edit|write` → diff (`adapter.ts:1076-1096`), everything else → `dynamic_tool` with `mcpToolPresentation` (`adapter.ts:1097-1111`). **One per-extension adapter exists:** Pi's example `subagent` extension. Its `details.results` is parsed into subagent cards (`adapter.ts:1112-1200`). The docs describe it as "observes its documented `details.results` shape … Unknown result shapes remain ordinary dynamic tool output" (`docs/orchestration-v2/orchestrator-mcp-server.md:175-181`).
- ANSI *is* parsed for command output. `packages/shared/src/terminalOutput.ts` is a small terminal emulator that keeps only SGR escapes plus cursor-addressable live lines (`terminalOutput.ts:1-10`, ESC handling `:491`), turned into spans for `CommandOutputPanel.tsx`. Code blocks have an `ansi` highlighting path (`apps/web/src/lib/incrementalHighlighting.ts:77-78`).
- Large or nested `details` are bounded: "Structured output omitted because it exceeds the stored result limit." (`adapter.ts:277-287`).

**Transferable to Herdr**
- Herdr can do better here. The host should keep the *last value* of `setStatus(key)`, `setWidget(key)` and `setTitle` per session and send them to the mod as state, not events: a status bar, a widget strip, and the tab title. Run every string through an SGR→spans parser like `terminalOutput.ts`, plus a stripper for other CSI/OSC. The mod has no DOM, so emit styled spans.
- Keep `notify` (with its level) even outside a turn; T3 drops those.
- Register per-tool renderers in the mod keyed by `toolName`, with a fallback that pretty-prints JSON args and `content[]` text. Ship adapters for popular extensions as T3 did for `subagent`.

## 4. Version maintenance; composer features

**Versions / compat**
- Version probe `pi --version` with a 10 s timeout, semver-compared to `MINIMUM_PI_VERSION = "0.80.5"`, chosen because `get_entries` arrived in 0.80.3 and `agent_settled` in 0.80.4 (`status.ts:62-66`, `:354-443`). Unsupported → provider error with an update message (`status.ts:429-442`).
- Per-feature gates by version: `pi auth check` ≥0.84.1 (`status.ts:67-68`, `:261-266`). Live usage on `message_update` is "0.84.2+" (`adapter.ts:714`). Pi 0.84+ may exit 1 without output, which is diagnosed specially (`rpc.ts:153-159`).
- Capability probing by feature detection inside the bridge extension: `typeof pi.getAllTools === "function"` and the builtin `tool_search` (`mcpExtensionSource.ts:317-318`), `"registerMcpServer" in pi` (`mcpExtensionSource.ts:364`). The docs describe the different behaviour on "Pi 0.99+" vs older (`orchestrator-mcp-server.md:165-170`).
- Tolerant parsing everywhere: optional `get_commands` (`status.ts:177-179`), `recordString` helpers, multiple field spellings for skills (`commands.ts:59-73`), and an unknown-member-tolerant turn-item union (earlier findings).
- **Recorded fixtures / contract tests.** `apps/server/scripts/record-pi-rpc-replay-fixture.ts` records real Pi RPC traffic hermetically (`--no-extensions --no-skills --no-prompt-templates --no-context-files --approve`, `:33-35`) into `pi_transcript.ndjson` with `piVersion` metadata. Eight scenarios exist: simple, multi_turn, message_steering, pi_compaction, provider_thread_resume, thread_rollback, thread_rollback_after_stop, turn_interrupt_mid_tool (`apps/server/src/orchestration-v2/testkit/fixtures/*/pi_transcript.ndjson`, registered in `fixtures/index.ts:845,1482,1553`). Plus a 4.7k-line `adapter.test.ts`.
- Update advisories: `enrichProviderSnapshotWithVersionAdvisory` (`status.ts:535-557`). The docs say to use `pi update` (`docs/user/providers-pi.md:32-34`).

**Composer**
- Input history: ArrowUp/Down in an empty composer walks prompts loaded in the thread (`docs/user/composer.md:139-150`; `apps/web/src/components/chat/composerPromptHistory.ts`).
- Trigger detection `/`, `#`, `$`, `@` (`apps/web/src/composer-logic.ts:250-292`).
- `@` path completion: RPC `projects.searchEntries` (`packages/contracts/src/rpc.ts:413`, handler `apps/server/src/ws.ts:2822`), backed by `git ls-files` (`apps/server/src/workspace/WorkspaceEntries.ts:460-477`), merged in `useComposerMenuItems.ts:207-215`. `@` also mentions *threads* (`docs/user/composer.md:296-298`).
- Slash menu: T3 builtins (`/model`, `/plan`, `/default`, `/side`, `/btw`), Pi commands and skills (`useComposerMenuItems.ts:219-296`), fuzzy-ranked (`composerSlashCommandSearch.ts:30-75`). Pi commands come from a throwaway `pi --mode rpc --no-session` running `get_commands` **per workspace cwd** (`status.ts:201-226`, wired as `snapshotForCwd` in `driver.ts:189-210`). A failed read keeps the previous catalog (`status.ts:213`). Skills are re-expanded by the bridge `input` hook (`mcpExtensionSource.ts:260-279`).
- Drafts: a zustand `persist` store per thread (`apps/web/src/composerDraftStore.ts:2476-2477`), plus a prompt stash (`docs/user/composer.md:169-178`). Large pastes (≥32 KiB) become file attachments (`docs/user/composer.md:9-13`).
- Keybindings: user-customizable keymap (`docs/user/keybindings.md:1-20`).
- External `$EDITOR`: **not addressed** (no hits).

**Transferable to Herdr**
- Probe `pi --version` once per binary in the host. Gate features on version *and* on feature probes (`get_commands` success). Put Pi's minimum version in one constant.
- Record a JSONL replay of real `pi --mode rpc` sessions per Pi release and replay them against the host's normalizer in CI. The recording format (`transcript_start` with `piVersion`, then `expect_outbound`/inbound frames) is easy to copy.
- Composer feeds: `get_commands` per cwd (cached, refreshed on reload), `git ls-files` (or `fd`) run by the host for `@` (not mod `exec`, given the 30 s/no-stdin limits), and history from `get_messages` user turns. Herdr can add an "edit in $EDITOR" action by opening a herdr-core terminal on a temp file, which T3 lacks.

## 5. Images

- Input paths: paste and drag-drop into the web/desktop composer, file picker, mobile library, and drag onto a sidebar row (`docs/user/composer.md:43-53`; `docs/user/thread-sidebar.md:69-72`; paste gate `apps/web/src/components/chat/composerAttachmentFiles.ts:165`, `ChatComposer.tsx:3186,3417`).
- Upload: the client uploads each attachment to the environment as soon as it is added (3 concurrent, 5 min timeout; `apps/web/src/lib/attachmentUploadQueue.ts:33-34`). The send carries attachment references. HEIC is converted and oversized photos are resized to a 2000 px longest edge (`packages/client-runtime/src/imageAttachmentSize.ts:6-26`).
- To Pi: `resolvePromptPayload` reads each image from the server attachment store and sends `{type:"image", data:<base64>, mimeType}` in `prompt.images` (`adapter.ts:2437-2461`, `:2641-2646`). Non-image attachments become file **paths** inlined into the message text (`providerMessageTextWithAttachmentPaths`, `adapter.ts:2442-2447`).
- Caps: 120 000 chars, 100 attachments, 10 MiB per image, 80 MiB of images per message, 50 MiB per other file (`packages/contracts/src/chatAttachment.ts:13-17`, data-URL cap `:31`).
- Images in tool results: at most `MAX_TOOL_OUTPUT_IMAGES = 8`, each ≤ the base64 of 10 MiB (`packages/shared/src/toolOutput.ts:242-256`). Pi's `read` duplicates the image in structured output and only that mirror is dropped (`adapter.ts:255-275`). The RPC framer budgets for them: `MAX_PI_RECORD_CHARS = 2*8*maxBase64 + 8 MiB` (`rpc.ts:92-94`). The wire projection strips base64 (`apps/server/src/orchestration-v2/WireProjection.ts:229-232`) and clients fetch by index from asset access (`apps/server/src/assets/AssetAccess.ts:249`).

**Transferable to Herdr**
- The mod has a text-only clipboard, so image paste must go through the host. Use a host RPC like "read clipboard image", which shells `pngpaste`/`wl-paste`/`xclip` on the host, or a file picker or path drop. Then the host base64s the file into `prompt.images`. Never send base64 through the mod.
- Copy the caps and the 2000 px downscale. For tool-result images, have the host store each image and give the mod a reference or local path rather than inline base64.

## 6. Agent status, inter-agent messaging, subagents

**Status**
- Server projection fields (`runtime.status`, `hasPendingApprovals`, `hasPendingUserInput`, `pendingSubagentRequest`, `blockedOnThreadWait`, `latestRun`) → `resolveSidebarThreadStatus`. That returns `approval > input > request(guest) > waiting(blocked on thread wait) > working > waiting(idle) > failed/limited > ready` (`apps/web/src/components/Sidebar.logic.ts:882-910`). Pills: Working, Pending Approval, Awaiting Input, Waiting, Completed, Failed, Plan Ready… (`Sidebar.logic.ts:665-677`). Unseen completion/failure is compared with a server-side `lastVisitedAt` (`Sidebar.logic.ts:712-738`).
- For Pi, "blocked" comes from bridged dialogs. `confirm` → `approval_request` and others → `user_input_request`, with node status `waiting` (`adapter.ts:1371-1426`). The provider session goes `running`/`ready` on `agent_start`/`agent_settled` (`adapter.ts:1715-1716`).
- Attention surfaces: `ThreadNotificationCoordinator` diffs thread shells per environment. On transitions it plays a sound (completion vs input), shows an in-app toast when focused on another thread, or shows an OS `Notification` when unfocused, and keeps the badge at the pending count (`apps/web/src/components/ThreadNotificationCoordinator.tsx:61-200`, attention keys `:253-263`). The desktop badge uses `Electron.app.setBadgeCount` (`apps/desktop/src/ipc/methods/notificationBadge.ts:37`). The web badge is a favicon (`apps/web/src/threadNotifications.ts:41-76`). Notification modes are in `threadNotifications.ts:8-20`.

**Messaging into a GUI-hosted agent**
- `/mcp` is an orchestration toolkit: `t3_thread_list/read/send/wait/interrupt/launch`, `delegate_task`, `task_status`… (`docs/orchestration-v2/orchestrator-mcp-server.md:198-466`). Outside agents (Claude Code, Codex, ChatGPT) connect over OAuth with PKCE and a pairing-code approval. They get read-only access or a runtime-mode ceiling (`docs/user/outside-agents.md:33-54`; `docs/internals/environment-auth.md:44-62`).
- Host CLI: `t3 thread start|send|show|list` and `--wait` (`docs/user/outside-agents.md:95-114`). It reads the server origin from the persisted runtime-state file, mints a short-lived full-access MCP session through the auth DB (filesystem trust), and revokes it on exit (`apps/server/src/cli/thread.ts:205-235`). `send` never interrupts: a busy thread gets the message as its next turn.
- All transports go through `ThreadManagementService`, so the CLI, MCP and the UI share send-mode, locking and postconditions (`orchestrator-mcp-server.md:22-28`).
- Peer links let one environment's agents act in another's threads (`docs/internals/remote.md:69-140`).

**Subagents**
- `delegate_task` creates durable child T3 threads on any provider. When the child finishes, a continuation dispatches "Delegated task X reached a terminal state. Use task_status…" into the parent, queued after its active run (`apps/server/src/orchestration-v2/ProviderContinuationService.ts:13-17,105-135`). For Pi this is exposed by the bridge extension as `mcp__t3-code__*` tools over a per-session HTTP MCP bridge (`orchestrator-mcp-server.md:151-170`). Pi-native `subagent` children are shown but session-less and not openable (`docs/user/providers-pi.md:71-74`).

**Transferable to Herdr**
- The host should compute one status enum per agent from RPC state: `extension_ui_request` pending → blocked; streaming or pending prompts → working; `agent_settled` → idle/done; process exit → error. Publish it to herdr-core so Herdr's existing sidebar, notifications and badges stay the single surface. Use T3's priority order.
- Inter-agent messaging: give the host a small local API with the same verbs (`send` queued-after-active, `read` from `get_messages`, `wait`, `interrupt`). Expose it both as a CLI (`hc`-style) and to Pi via an injected extension tool, so other agents can talk to a GUI-hosted Pi.

## 7. Long-transcript rendering

- Delta batching: text/thinking deltas accumulate per content block and are flushed at most every `STREAM_FLUSH_MS = 50` (`adapter.ts:82`, schedule `adapter.ts:960-975`). Command-output hub frames are 100 ms, or 500 ms when a subscriber overflows (`apps/server/src/orchestration-v2/CommandOutputHub.ts:32-34,243-276`). The Pi adapter does not use the hub: bash `partialResult` goes out as `turn_item.updated` (no hub reference in `packages/provider-pi`).
- Wire budgets: cold open and history pages are about 1 MiB / ≤10 user turns / ≤500 rows. Resume catch-up is ≤128 events / 1 MiB, then a snapshot. Command, dynamic-tool and file-change bodies are omitted on the wire and fetched when a work group expands (`docs/internals/performance-regressions.md:15-50`).
- Virtualization: `LegendList` with `estimatedItemSize={90}`, `initialScrollAtEnd`, `maintainScrollAtEnd` (smooth while working, off when the user has scrolled up, during find, or while a disclosure settles), and `maintainVisibleContentPosition` (`apps/web/src/components/chat/MessagesTimeline.tsx:1307-1343`). Follow and release logic is a state machine fed by wheel, touch, key and scrollbar navigation events (`apps/web/src/components/chat/timelineViewport.ts:35-61`, `useTimelineFollow.ts`).
- Streaming markdown: the text is split at blank lines that close all blocks, so only the last block re-renders. It falls back when the syntax spans blocks (`apps/web/src/components/chat/markdownStreamBlocks.ts:7-47`, used `apps/web/src/components/ChatMarkdown.tsx:1733-1740`).
- Collapsible tool cards: work-group rows (`TimelineWorkGroupRows.tsx`), plus the "Thinking" collapsible (earlier findings).
- Find-in-chat: `ThreadFindBar`, `threadFindStore` and `useThreadFindNavigation`, which scrolls the virtual list to the matching row and pins it during paging (`apps/web/src/components/chat/useThreadFindNavigation.ts:1-30`). Cross-thread message search is in the command palette (`docs/user/thread-sidebar.md:216-223`).
- Copy: per-message copy button (`MessageCopyButton.tsx:32-46`). Markdown serialization for clipboard text, with chips turned into links (`docs/user/composer.md:327-329`). Selection inside assistant text gets a "cite" toolbar (`AssistantSelectionToolbar`, `MessagesTimeline.tsx:1300-1305`). Selection across messages is ordinary DOM selection (no special handling found).

**Transferable to Herdr**
- Coalesce deltas in the host at about 50 ms per content block. Never forward raw `message_update`, which carries the full partial message every time.
- Send the mod only a window (the last N turns). Keep tool bodies in the host and fetch them on expand. The mod has no DOM, so virtualization and cross-message selection depend on GPUI's list. Plan a per-message "copy" and "copy as markdown" instead of free selection, and a host-side search for find.
- Copy the stable-prefix markdown split so only the tail block re-parses each frame.

## 8. Remote

- Model: the environment (server) owns providers. Every route is just HTTP and WS to it (`docs/internals/remote.md:1-7`). Mobile, web and desktop share `packages/client-runtime` connection code (`docs/internals/connection-runtime.md:1-7`).
- Routes: an ordered route list per saved environment. Each direct route is checked against the public descriptor *before* sending credentials. The supervisor preflights earlier routes and swaps the session when one works (`remote.md:33-46`). Learned LAN and tailnet routes are reported by the server (`remote.md:48-56`).
- Reconnection: jittered exponential backoff capped at 5 min, and auth failures wait for a wakeup (`connection-runtime.md:11-17`). Dead-socket detection uses probes with route-dependent deadlines: 3 s loopback/LAN, 15 s elsewhere (`connection-runtime.md:19-36`). Data freshness is tracked separately from transport health (`connection-runtime.md:65-70`).
- SSH: desktop main launches and forwards. It stops a remote server only if it launched it, and restores the forward before reopening transport (`remote.md:162-169`).
- Relay: T3 Connect tunnel with DPoP-bound tokens renewed in their last minute (`connection-runtime.md:48-55`; `docs/internals/t3-connect.md`). Peer-link waits are split into ≤50 s calls because the edge drops idle requests after about 100 s (`remote.md:107-109`).
- Latency: the bounded snapshot plus catch-up replay (#7) and server-side batching. Mobile can queue messages offline (`docs/user/composer.md:84-90`).

**Transferable to Herdr**
- Put the host process on the remote machine, inside a herdr-core terminal there, and have the mod connect over an SSH-forwarded TCP port. Pi and its session files stay on the machine that owns the workspace.
- Copy three things: route preflight before sending a token, jittered backoff, and "socket open ≠ ready" (wait for a hello/snapshot). Resume with "since seq N", falling back to a snapshot.

## 9. Process supervision

- Spawn: `detached` on POSIX (its own process group) and a finalizer registered right after spawn, "so interrupted setup cannot leak a detached process" (`rpc.ts:198-237`). Teardown is SIGTERM, a 1 s grace, then SIGKILL to the *group*, checking liveness before each signal because the pid/pgid may be recycled (`rpc.ts:171-184`, `:213-224`). Windows uses `taskkill /T /F` (`rpc.ts:226-233`). stderr is logged by length only (`rpc.ts:359-368`). Stdout close is diagnosed against the exit code (`rpc.ts:333-357`).
- Pi crash mid-run: the pump's `catchCause` finalizes the active turn as `transport_error` "Pi process exited unexpectedly." and sets the session to `error` (`adapter.ts:2208-2248`). The next message reopens a provider session and `switch_session`s the stored file (`adapter.ts:2276-2299`). Pending dialogs are not resumable (`pendingRequestsSurviveRestart: false`, `adapter.ts:98`).
- Server restart/shutdown: `ProviderRuntimeRecoveryService.reconcile("startup"|"shutdown")` terminalizes non-terminal runs ("Cancelled because the server restarted…"), stops sessions, and cancels process-bound outbox effects. Pending free-text questions stay answerable by a normal message (`ProviderRuntimeRecoveryService.ts:199-271`, `:612-720`). Optional auto-continue, per project (`continueThreadsAfterServerUpdate`), queues a run with `CONTINUE_PROMPT` ("Continue where you left off… confirm it did not take effect before repeating…"). It is capped at a chain of 3 within 5 min and blocked when archived, snoozed or awaiting input (`apps/server/src/orchestration-v2/RestartContinuation.ts:33-80`; `ProviderRuntimeRecoveryService.ts:652-668`, `prepareForShutdown` `:767-805`).
- SIGINT/SIGTERM: events after the signal are dropped "so recovery owns that state" (`ProviderSessionManager.ts:388-400`).
- Idle: provider sessions are released after 30 min idle, or after a max 4 h pin with no activity (`ProviderSessionManager.ts:57-58`, `:1114-1240`).
- Orphans after a hard server crash (SIGKILL): **not explicitly handled**. The children are detached, so nothing kills the group. *Unverified:* Pi RPC may exit when its stdin pipe closes; no code asserts that.
- App quit: desktop `before-quit` waits for backend shutdown, with a stall timeout (`apps/desktop/src/app/DesktopLifecycle.ts:108-210`). The background service keeps agents running without the UI (`docs/user/background-service.md:1-30`).

**Transferable to Herdr**
- The herdr-core terminal is the supervisor. Run the host under it so a dying UI never kills Pi. The host spawns Pi in its own process group and kills it by checked pgid.
- Persist `{sessionFile, runState, pendingUi}` in the host. On restart, mark in-flight runs "interrupted", offer a one-click "continue where you left off" using T3's careful prompt wording, and `switch_session` back to the file.
- Add what T3 lacks: a pidfile/lockfile per session so a restarted host can find and kill an orphaned Pi before respawning. This ties into #10.

## 10. Session-file concurrency / GUI↔terminal handoff

- **No Pi session-file locking, no detection of external writers, no handoff.** `rg -i 'lock|concurren'` in `packages/provider-pi` finds only semaphores. T3 never attaches a TUI to a T3 session (earlier findings §7).
- Single writer by construction inside T3: one Pi process per provider session (`supportsMultipleProviderThreadsPerSession: false`, `adapter.ts:93`). `registerThread` refuses to switch while a turn or wake is active (`adapter.ts:2258-2275`). Forks write a *new* file and verify it: `if (file === undefined || file === sourceFile) … "Pi fork did not create a distinct session file"` (`adapter.ts:3139-3143`). The fork helper only reads the source, but it does read it while the main process may be appending.
- Nothing stops the user running `pi --session <same file>` in a terminal while T3's Pi has it open. T3's in-memory leaf would then diverge. After an idle release (#9), the next turn re-`switch_session`s and picks up whatever is on disk.
- Related pattern T3 *does* use, for its own state: an exclusive SQLite lock on the state dir (`PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;`, `apps/server/src/serverOwnership.ts:183-203`), so a second server exits with `SERVER_EXIT_CODE_STATE_DIR_OWNED`.

**Transferable to Herdr**
- Herdr must invent this. Suggested: a sidecar lock `<session>.jsonl.herdr-lock` (flock, plus pid and owner), taken by the host before `--session`/`switch_session`. Wrap terminal `pi` in a Herdr launcher or extension that checks the same lock. A Pi extension's `session_start` hook can refuse or warn when the lock is held.
- Handoff GUI→TUI: wait for idle (settle probe), send `abort` if needed, stop the RPC process, release the lock, then start `pi --session <file>` in a herdr-core terminal. TUI→GUI: on TUI exit, the host retakes the lock and `switch_session`s. Never run both at once.

## 11. Unsolicited / self-started turns

- Detection: an `agent_start` while `threadState.activeTurn === null` (`adapter.ts:1722-1729`).
- When a continuation handler exists, the event becomes a `PiWake`. All non-dialog events are buffered into `pendingWake.events`, while session status shows running/ready (`adapter.ts:1703-1717`). It is offered to `ProviderContinuationRequests` with `delivery: "adapter_buffered"` and `dispatchIfCurrent`/`clearIfCurrent` guards (`adapter.ts:1730-1757`; contract `packages/provider-core/src/server/ProviderContinuationRequests.ts:15-41`).
- The server worker dispatches a `message.dispatch` with `createdBy: "agent"`, `creationSource: "provider"`, default text "Background task completed.", a notification `{source: background_task, summary: "Background activity updated"}`, and `queue_after_active` (`apps/server/src/orchestration-v2/ProviderContinuationService.ts:11,183-206`). Archived threads clear the wake, which kills Pi (`:88-103`).
- `startTurn` recognizes a continuation (`createdBy agent && creationSource provider`, `adapter.ts:2542-2544`). It sends **no prompt**, adopts the wake (`adoptedWake`) and replays the buffered events into the new turn. The settle comes from a deferred `agent_settled` through the settle probe (`adapter.ts:2620-2669`, `:1993-2001`).
- Rendering: it is an ordinary run with an agent-attributed opener. `resolveUserMessagePresentation` gives `attribution: "agent"` (`packages/client-runtime/src/userMessage.ts:107-117`), and notification messages are excluded from the user queue UI (`packages/client-runtime/src/state/threadWorkflows.ts:114-127`).
- With no handler, during rollback, or when stopping: `"Pi started agent work outside an active T3 turn. The session was stopped to prevent invisible tool execution."`, and the process is terminated (`adapter.ts:85-86`, `:1731-1734`, `:1760-1765`).
- Dialogs raised before a turn exists stay session-scoped and are shown immediately (`adapter.ts:1703-1706`). Out-of-turn `extension_error`s are buffered and flushed into the next turn (`adapter.ts:1463-1468`, `:2670-2672`).
- T3 does not use Pi's own follow-up queue. Every prompt is sent `streamingBehavior: "steer"` and T3 queues follow-ups itself. Pi's leftover queue is cleared on Stop and surfaced as a notice (`adapter.ts:1280-1307`).

**Transferable to Herdr**
- The host is always attached, so it can simply *render* self-started runs instead of killing them. On `agent_start` with no pending client prompt, open a synthetic "agent-started run" block labelled by cause where known (extension, follow-up, wake). Mark the agent "working" and raise attention on completion.
- Keep T3's two guards: buffer events that arrive before the UI acknowledges them, and offer a kill switch for runaway self-starts.

## 12. Security of the local UI↔agent transport

- Binding: loopback by default. The background service binds wildcard IPv4 but `socket.destroy()`s any connection whose peer is not loopback, private or tailnet (`apps/server/src/server.ts:338-358`; `docs/internals/remote.md:58-66`). Managed policy can forbid binds before they happen (`server.ts:339-345`).
- Auth: every environment issues scoped sessions (pairing link/code → bearer, DPoP or cookie). Exchange can narrow scopes, never widen them (`docs/internals/environment-auth.md:7-27`). Long-lived tokens never appear in WS URLs: clients get short-lived WS tickets over authenticated HTTP, DPoP-bound when possible. Every RPC declares a scope that middleware checks before the handler runs (`environment-auth.md:73-89`).
- Origin: CORS lists the desktop renderer origins `t3code://app` and `t3code-dev://app` (`apps/server/src/httpCors.ts:1-13`). Hosted pairing secrets travel in the URL fragment so they never reach the hosted origin (`remote.md:146-151`).
- Desktop↔local backend: an HMAC-SHA256 bootstrap token over 12 h windows, checked with timing-safe compare (`packages/shared/src/desktopBootstrapToken.ts:4-31`), delivered on fd3 (`apps/desktop/src/backend/DesktopBackendPool.test.ts:113-117`). Restarts replace the previous local bearer token (`environment-auth.md:101-106`).
- Agent→server: before opening a Pi session the server mints an MCP credential scoped to environment, thread, provider instance and session. It expires on idle or max lifetime and is revoked on release; the raw token is never persisted (`docs/orchestration-v2/orchestrator-mcp-server.md:40-56`). It reaches Pi via env `T3_MCP_BEARER_TOKEN`, and inherited credentials are deleted first (`mcpInjection.ts:282-286`).
- Per-client: sessions are listed and revocable in Settings → Sharing & access. MCP clients get a separate `mcp-client` subject that only `/mcp` accepts (`environment-auth.md:52-62`).

**Transferable to Herdr**
- The host should listen on a Unix socket, or on 127.0.0.1 with a random port. Write the port and a 256-bit random token to a 0600 file under the Herdr state dir. The mod reads that file via `exec` and sends the token as the first frame; the host closes on mismatch and compares in constant time.
- Reject WebSocket upgrades that carry a browser `Origin`, which blocks drive-by localhost attacks.
- If agents get messaging tools (#6), give each its own token with a narrower scope (read vs send), as T3 does with per-session MCP credentials.
