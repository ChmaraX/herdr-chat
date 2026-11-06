# Orca vs the 12 Pi-GUI problems (deep dive)

Repo: `stablyai/orca` @ `ed54ecfa`. All paths are repo-relative. This builds on `findings-orca.md` and corrects it in two places, marked **Correction**. Orca's Pi GUI = `pi --mode rpc` over stdio, owned by an Electron-main/orcad "structured agent session host". Clients (renderer, phone, paired desktop, CLI) talk to that host over Orca's own runtime RPC.

## Summary table

| # | Solved? | Mechanism (one line) | Key path:line |
|---|---|---|---|
| 1 | partial | Host-owned `/model` `/effort` `/clear` `/compact` `/resume`, plus rename. Everything else is Pi's own `get_commands` list sent through as prompt text. `/login` is a text instruction to run `pi` and then `/login` in a terminal | `src/shared/agent-session/view/structured-agent-session-composer.ts:19-33`, `src/shared/agent-session/lifecycle/agent-session-sign-in.ts:9` |
| 2 | partial | Nothing for `custom()` itself. Unknown dialog methods are auto-cancelled. Prompt replies have no deadline, but Stop works while a send is held, and leftover dialogs are cancelled when the run settles | `src/main/pi/rpc-dialog-callbacks.ts:26-33`, `src/main/pi/rpc-session-adapter.ts:153-158` |
| 3 | no (by design) | `notify/setStatus/setWidget/setTitle/setEditorText` are dropped silently. Extension tools get a generic category row, text blocks only. No ANSI handling on this path | `src/main/pi/rpc-dialog-callbacks.ts:11,23`, `src/main/pi/rpc-messages.ts:158-164` |
| 4 | yes (versions) / yes (composer) | Minimum Pi 0.84.0, re-probed on every launch. Recorded Pi 1.0.4 / 1.3.0 RPC captures are replayed in tests. Strict zod schemas plus tolerant reply fields. Composer: recall from the transcript, `@` workspace file index, `/` menu fed by `get_commands`, IndexedDB drafts | `src/main/pi/rpc-launch-resolution.ts:49,200-206`, `src/main/pi/rpc-capture-replay.test.ts:129-243` |
| 5 | yes (prompt) / no (tool results) | Paste, drop and picker all go to local files. Pi gets base64 `images[]` (MIME sniffed; 5 MiB each, 20 images, 20 MiB total, line-size cap). Images in tool results are dropped | `src/main/pi/rpc-prompt.ts:15-18,83-124`, `src/main/pi/rpc-messages.ts:15,163` |
| 6 | yes | Status is computed from the journal (`working`/`attention`/`idle` plus outcome) and drives sidebar, banner+sound and phone push. The CLI and other agents reach the host through runtime RPC: `orchestration.send` delivers a whole message as a queued turn, and `workerRead` reads the transcript | `src/shared/agent-session/view/structured-agent-session-projection.ts:201-231`, `src/main/runtime/orchestration/structured-mailbox-pointer-delivery.ts:1-2` |
| 7 | yes | Coalescing at 60 ms on the host and 48 ms on the client, a 350 ms word-paced reveal, TanStack virtualizer, a 48 px stick-to-bottom threshold, collapsible work runs, DOM find via the CSS Highlight API, per-row copy | `src/main/native-chat/agent-session-wire/agent-session-delta-coalescer.ts:4`, `src/renderer/src/components/native-chat/use-native-chat-transcript-window.ts:4,18` |
| 8 | partial | Pi chat runs only on the runtime's own local host (not WSL, not SSH). Remote = run Orca (`orca serve` / desktop) on that machine and pair: WS + E2EE, per-device tokens, a relay for phones, 10 s/25 s liveness, cursor resubscribe | `src/main/provider-process/supervised-provider-child-location.ts:5-15`, `src/shared/remote-runtime/remote-runtime-socket-liveness.ts:4-6` |
| 9 | yes | Detached supervisor per child polls `ppid` every 100 ms and reaps the process group (stdin-end 1 s → TERM 3 s → KILL). On exit the lane is finalized as `interrupted`. Teardown writes resume markers (`quit`/`update`). Restart sends a continuation and never replays the prompt | `src/main/provider-process/provider-process-supervisor.ts:4-13,155-164`, `src/main/pi/rpc-session.ts:260-305` |
| 10 | partial | No file lock. Orca-originated terminal resumes of a chat-owned session are refused (a targetless `-c`/`-r` too). Terminal→chat closes the terminal and waits for proven exit. Chat→terminal is always a fork. Reopen imports outside writes behind a divider | `src/main/ai-vault/structured-session-ownership.ts:224-241`, `src/main/pi/rpc-history-catch-up.ts:42` |
| 11 | partial | `agent_start` while idle opens a host-minted turn. Pi's later user echoes consume queued sends. Non-assistant messages (custom/user) are not rendered live | `src/main/pi/rpc-turns.ts:123-141`, `src/main/pi/rpc-messages.ts:84-86` |
| 12 | yes | Unix socket 0600 or named pipe, 24-byte random token in a 0600 metadata file. WS bound to loopback until a network device pairs. Per-device tokens, E2EE (tweetnacl box), 10 s pre-auth timeout, phone method allowlist, caller scopes. No WS Origin check | `src/main/runtime/rpc/unix-socket-transport.ts:66`, `src/main/runtime/runtime-rpc/runtime-rpc-state.ts:55` |

---

## 1. Built-in TUI commands over RPC

How the `/` menu is built: host-owned commands come first, then whatever the live session reports. `structuredSessionSlashCommands` puts `model`, `effort`, `clear` and `compact` ahead of the reported catalog (`src/shared/agent-session/view/structured-agent-session-composer.ts:19-33,120-136`). Pi has **no curated list**: `COMMANDS_BY_AGENT` covers claude/openclaude/codex/omp only (`src/shared/native-chat/input/native-chat-slash-commands.ts:123-128`). So Pi's menu is the host commands plus `get_commands`. `readPiRpcCommands` maps `source==='skill'` to skills and everything else to commands (`src/main/pi/rpc-options.ts:216-226`). The command list is read after the session opens and is published as a late report; if the read fails, the chat simply has no `/` menu (`src/main/pi/rpc-session-startup.ts:98-120,151-161`).

| TUI cmd | Orca GUI | How |
|---|---|---|
| `/model`, thinking | yes | Host command opens a picker, or takes an argument. `applyPiRpcSessionOption` sends `set_model` / `set_thinking_level` (`src/main/pi/rpc-options.ts:176,182`). The model list comes from a throwaway probe child, `pi --mode rpc --no-session` in `$HOME`, that calls `get_available_models` (`src/main/pi/rpc-model-catalog-probe.ts:84-89`) |
| `/compact [instr]` | yes | RPC `compact` with `customInstructions`, `timeoutMs:null`. "Nothing to compact" becomes a warning row (`src/main/pi/rpc-compaction.ts:13-38`). Refused while work is running (`.../structured-agent-session-composer.ts:247-275`) |
| `/new`, `/clear` | yes (re-implemented) | Host-side `/clear` writes a provider-context boundary record. The next launch starts a fresh Pi child with no `--session` (`src/main/native-chat/agent-session-wire/structured-conversation-command.ts:156`, `src/main/runtime/agent-session/records/agent-session-conversation-command-record.ts:19-27`). The `clear` command is always offered (`.../structured-agent-session-options-read.ts:259`) |
| `/resume` | yes (re-implemented) | An Orca-owned row replaces the agent's `/resume` and opens the Session History modal; it never reaches Pi (`src/renderer/src/components/native-chat/use-native-chat-resume-command.ts:17-34,54-75`). Resuming relaunches with `--session <file>` (`src/main/pi/rpc-launch.ts:114`) |
| `/fork` | partial | No in-chat fork: Pi `rewind:false` (`src/main/pi/rpc-agent-definition.ts:9`). History's "Resume in New Terminal" forks, so the chat stays unchanged (`src/renderer/src/components/right-sidebar/ai-vault-session-cli-fork-copy.tsx`). A cwd change relaunches with `--fork` (`src/main/pi/rpc-launch-resolution.ts:193-197`) |
| `/name` | yes | `renameProviderSession` → `set_session_name` (5 s timeout), but only while the child is live. At rest it is "not implemented" (`src/main/pi/rpc-session-adapter.ts:222-232`) |
| `/session` stats | partial | Context-usage meter from `get_session_stats` at each `turn_end` (`src/main/pi/rpc-turns.ts:308-318`) |
| `/copy` | yes (re-impl.) | Per-row copy in the UI (`src/renderer/src/components/native-chat/native-chat-message-copy-text.ts:5-8`) |
| `/quit` | yes (re-impl.) | Closing the tab closes the child (`rpc-session-adapter.ts:240-262`) |
| `/login` | **no** | No Pi OAuth UI. `get_state` returning `model.provider==='unknown'` → `notSignedIn` refusal (`src/main/pi/rpc-session-startup.ts:49-51,177-185`). The copy says: run `pi`, then use `/login` "on the computer running this chat" (`src/shared/agent-session/lifecycle/agent-session-sign-in.ts:9`, `src/shared/agent-session/failures/agent-session-failure-copy.ts:56-57`). A prompt reply `No API key found for…` is also mapped to notSignedIn and retried up to 8× at 250 ms before it fails (`src/main/pi/rpc-prompt-delivery.ts:32-37,115-139`). Guided host sign-in exists for Claude and Codex only (`src/shared/host-account-sign-in-types.ts:6`) |
| `/settings` | **no** | Orca has its own Settings → Agents → Command for the Pi binary path (`agent-session-failure-copy.ts:59-60`). There is no editor for Pi's `settings.json`. `PI_CODING_AGENT_DIR` points at the user's account home, so the TUI's settings apply (`src/main/pi/rpc-launch-resolution.ts:140`) |
| `/tree`, `/hotkeys`, `/export`, `/reload`, `/share`, `/scoped-models` | **no** | Not in the host list and not reported by `get_commands`. Typing them sends text, which `classifyNativeChatSend` treats as an `unknown-token` (`native-chat-slash-commands.ts:213-235`) |
| extension cmds, prompt templates, `skill:` | yes | Sent as `prompt` text. If the reply carries `disposition:'handled'` or `agentInvoked:false`, the send settles as command-only with no turn (`src/main/pi/rpc-prompt-delivery.ts:156-159`, `src/main/pi/rpc-turns.ts:73-76`) |

## 2. `ctx.ui.custom()` → undefined / hanging extension commands

- **No detection** of `custom()`, no extension allowlist, no `--no-extensions`. The launch adds no extension flags (`src/main/pi/rpc-launch.ts:70-119`). The user's whole `PI_CODING_AGENT_DIR` loads (`rpc-launch-resolution.ts:140`).
- Unknown `extension_ui_request` methods are cancelled at once: anything that is neither decoration nor one of the four dialogs gets `{cancelled:true}` (`src/main/pi/rpc-dialog-callbacks.ts:26-33`). This would answer a future request-style `custom` frame, but Pi 1.5's `custom()` sends no frame at all (Pi `docs/rpc-extension-ui.md:16`).
- **No deadline on prompts:** the comment says "Prompt replies can be idless and arrive after dialogs; they have no elapsed-time deadline" (`src/main/pi/rpc-turns.ts:35`). A hung command handler leaves the send `holdsDispatch` (`src/main/pi/rpc-prompt-delivery.ts:54-56`).
- Mitigation 1: Stop still works while a send is held. `cancelTurn` proceeds when `holdsDispatch` is true, then runs `dialogs.cancelAll()` and RPC `abort` with a 2 s timeout (`src/main/pi/rpc-session-adapter.ts:147-159`).
- Mitigation 2: open dialogs are cancelled whenever a run settles (`idle: () => this.dialogs.cancelAll()`, `src/main/pi/rpc-session.ts:119`).
- Pi's dialog `timeout` field is not in the schema, so Orca ignores it (`src/main/pi/rpc-protocol.ts:118-140`).
- Hard caps: more than 64 pending dialogs or more than 8 MiB **fails the session** (`rpc-dialog-callbacks.ts:38-44`).

## 3. Decoration and custom renderers

- `const DECORATION = new Set(['notify','setStatus','setWidget','setTitle','setEditorText'])` and `if (DECORATION.has(frame.method)) return` (`src/main/pi/rpc-dialog-callbacks.ts:11,23`). Nothing is shown and there is no ANSI parsing on this path. The doc comment states it: "Terminal decoration is deliberately absent from the chat projection" (`src/main/pi/rpc-extension-dialogs.ts:18`).
- Tool rendering, live:
  - Only `content[].text` survives, joined with `\n`. Non-standard results are `JSON.stringify`'d. Pi's `details` is ignored, and so are image blocks (`src/main/pi/rpc-messages.ts:15,155-164`).
  - The category comes from the tool name. MCP-style names → `mcpToolCall`; names outside the vocabulary → `'other'` with a generic glyph (`src/shared/native-chat/tools/native-chat-tool-icon.ts:115-136`).
  - **Correction:** unknown tools are `other`, not a "command row". `unknown` means an unclassified shell command (`native-chat-tool-icon.ts:14-24`).
  - There are no per-extension renderers.
- ANSI stripping does exist elsewhere, for local-command stdout in transcripts (`src/shared/native-chat/tools/native-chat-command-output.ts:55`). The TUI path also strips scrollback (`native-chat-scrape-fallback`).
- **Correction to findings §6:** structured Pi gets **no** visuals scratch dir. `PI_RPC_SESSION_ENV_TO_DELETE` removes `NATIVE_CHAT_SCRATCH_DIR_ENV` ("Structured Pi has no scratch folder", `src/main/pi/rpc-launch.ts:28-34`).

## 4. Version maintenance and composer

**Versions**
- `PI_RPC_MINIMUM_VERSIONS = ['0.84.0']`, because turns need `agent_settled` (`src/main/pi/rpc-launch-resolution.ts:48-49`). The check runs on every launch "because the PATH binary may have changed" (`:198-206`) and in the catalog probe (`rpc-model-catalog-probe.ts:73-76`).
- The probe runs `--version`. An `unknown` version is allowed (`src/main/agent-launch/preflight/agent-cli-version-probe.ts:43,68`).

**Capability tolerance**
- Reply fields `disposition` / `agentInvoked` are optional (`rpc-prompt-delivery.ts:156`).
- `get_commands` `source` absent → `kindUnspecified` (`rpc-options.ts:221`).
- Oversized frames keep their head via a regex on the prefix (`rpc-protocol.ts:63-95`).
- Event types Orca does not model fall through `switch` without effect (`rpc-turns.ts:112-205`).
- Malformed message/tool events, by contrast, **throw** and fail the session (`rpc-messages.ts:79-81,149-151`).

**Recorded fixtures**
- `src/main/pi/__fixtures__/*.jsonl` hold `{dir, raw}` envelopes: command-only, compaction, dialogs, provider-fetch/socket-error, signed-out, steer-followup, stop-mid-tool, subagent-wake.
- These are "scrubbed Pi 1.0.4 RPC captures", replayed through the real `PiRpcTurns` plus the timeline assembler (`src/main/pi/rpc-capture-replay.test.ts:17-27,129-243`). The Pi 1.3.0 subagent wake is at `:212`.
- There is also a scripted fake child (`src/main/pi/pi-scripted-child.test-fixture.ts`) and PTY fixtures `src/main/runtime/__fixtures__/pi-0-74-*.txt`.

**Composer**
- **History recall:** derived from the visible transcript at keypress, so reloads and other clients need no separate store (`src/renderer/src/components/native-chat/native-chat-sent-prompt-history.ts:1`). ArrowUp/Down work only when the draft is empty or recalled and the caret is on the visual edge (`use-native-chat-composer-keydown.ts:146-170`).
- **`@file`:** the workspace quick-open index (`useRuntimeFileListForWorktree`), ranked with quick-open history, 20 results. This also works for remote/runtime worktrees (`use-native-chat-mention-files.ts:9,34-54`). Pi is not asked.
- **`/` autocomplete:** a leading `/` or a mid-prompt `/skill:` (`src/shared/native-chat/input/native-chat-picker-triggers.ts:6-7`). Merged with skills discovered on disk; ranked, 50 per group (`native-chat-picker-items.ts:67-140`).
- **Drafts:** IndexedDB `orca-native-chat-composer-drafts`, with an unload journal and cross-window adoption (`native-chat-composer-draft-indexeddb.ts:8`, `native-chat-composer-draft-persistence.ts:1`). Pasted images are restored from the paste folder (`src/main/window/clipboard-image-temp-file.ts:45-49`).
- **Keys:**
  - Enter sends; Shift+Enter inserts a newline.
  - Mod+Enter sends the "alternate" behaviour (steer vs queue).
  - Mod+Shift+Enter steers the head queued card.
  - Esc interrupts (`use-native-chat-composer-keydown.ts:121-144`).
- **External editor:** none found (no `$EDITOR` hook in `native-chat/`). There is dictation (`use-native-chat-dictation.ts`).

## 5. Images

- **Input paths:**
  - Clipboard paste → main saves the buffer into the structured-chat attachment store (local structured chats) or the paste folder (`src/main/window/clipboard-ipc-handlers.ts:97-104`). The file name is shell-inert and the signature is checked (`clipboard-image-temp-file.ts:28-31`).
  - File picker: `window.api.shell.pickAttachments()` (`use-native-chat-file-attachment-actions.ts:9`).
  - Drag-drop: pane, element, workspace and floating drop hooks (`use-native-chat-file-drops.ts`, `native-chat-pane-file-drop.ts`).
  - Remote owners save through the owning runtime (`native-chat-clipboard-image-save.ts:13-40`).
- **To Pi:** `preparePiRpcPrompt` builds `{type:'prompt', message, images:[{type:'image', data: base64, mimeType}]}` (`src/main/pi/rpc-prompt.ts:27-32`).
  - URLs are rejected and a local path is required.
  - The extension must be png/jpg/gif/webp, and the magic bytes must match it (`:55-124`).
  - Caps: 5 MiB per image, 20 images, 20 MiB total, plus the RPC line limit (`:15-18`).
  - Failures become typed attachment refusals (`rpc-message-dispatch.ts:33-50`).
- **Images in tool results:** dropped live. Only `text` blocks survive (`rpc-messages.ts:15,163`). For a skill that emits pictures, Orca relies on markdown images in the assistant text instead.

## 6. Status, identity, inter-agent messaging

**Status**
- `projectStructuredAgentSessionStatus`: any pending approval or question → `attention`; owed work → `working`; otherwise `idle` (`src/shared/agent-session/view/structured-agent-session-projection.ts:201,218-231`).
- The summary adds `latestPrompt`, the current `toolName`/`toolInput`, `lastAssistantMessage`, and `turnOutcome` (idle only) (`:233-300`).
- The host publishes `AgentSessionStatusSummary` with `hostExecutionPhase: starting|ready` and restart-resume progress (`src/shared/agent-session/agent-session-wire.ts:192-222`) via `agentSession.subscribeStatus` and `subscribeTurnCompletions`.
- Busy is confirmed by the host-side `get_state` idle probe, not by `agent_end` (`rpc-turns.ts:53-62,165-170`).

**Surfacing**
- Sidebar rows consume the projection.
- Desktop banner + sound: `deliverAgentAttentionNotification` → `notifications.dispatch`, then `playDesktopNotificationSound` (`src/renderer/src/attention/agent-attention-notification-delivery.ts:14-36`).
- Phone push straight from the execution host, deduped by edge id and withdrawn when read (`src/main/runtime/agent-session/structured-agent-session-mobile-attention.ts:1-2`).
- Read tracking uses journal cursors (`src/shared/agent-session/agent-session-attention.ts:79-90`).
- **No OS badge / dock bounce** (no `setBadgeCount` or `dock.*` hits).

**Identity**
- The Pi child gets `ORCA_AGENT_SESSION_ID` plus a spawn token. Its mailbox address is `orca_session_id:<id>`, or the worker handle (`src/shared/agent-session/lifecycle/agent-session-caller-env.ts:1-29`). Inherited caller env is stripped first (`rpc-launch.ts:22-43`).

**Messaging into a GUI agent**
- The bundled `orca` CLI finds the runtime through the metadata file (unix socket + `authToken`, `src/cli/runtime/metadata.ts:15`).
- `orca orchestration send …` (`src/cli/handlers/orchestration/message-send-handler.ts`) delivers to chat sessions "each orchestration message whole, as its own ordinary message: the chat's queue holds it behind running work or a question" (`src/main/runtime/orchestration/structured-mailbox-pointer-delivery.ts:1-2`).
- That goes through `sendAgentTurn` with a reusable `operationId`, which makes retries idempotent. The sender shows as `from` (`src/main/runtime/orchestration/send-agent-turn.ts:26-35`).
- PTY agents keep a pointer lane instead.

**Reading a GUI agent**
- `orchestration.workerRead` / terminal read is served from the bounded lineage journal, with PTY-style line/limit projection (`src/main/runtime/structured-worker-terminal-read.ts:1-4`, `orchestration/structured-worker-journal-page.ts:5-20`).
- Generic clients can call `agentSession.history` / `item` / `subscribe`.

**Subagents**
- Orca dispatches its own subagents as structured "workers": a preamble is sent as a turn, and settled workers restart when mail arrives (`src/main/runtime/rpc/methods/orchestration-structured-worker-session.ts:5-6`).
- Pi-internal subagent wakes are tracked as idle-started runs (§11).

## 7. Long-transcript rendering

- **Batching:**
  - The host coalesces token deltas into snapshots every 60 ms and flushes text before lifecycle rows (`src/main/native-chat/agent-session-wire/agent-session-delta-coalescer.ts:1-4`).
  - Clients coalesce batches every 48 ms, but bypass that for anything except assistant-message updates (`src/shared/agent-session/structured-agent-session-coalescer.ts:8-18`).
  - Batches are "cursor-qualified current reduced states, not deltas, so duplicate batches converge" (`src/shared/agent-session/agent-session-wire.ts:132`).
- **Paced reveal:** word-by-word on rAF, 350 ms reveal delay, 300 ms fade, honouring reduced motion (`src/shared/native-chat/transcript/native-chat-text-reveal.ts:10`, `use-native-chat-paced-text.ts:13-18`).
- **Virtualization:**
  - `@tanstack/react-virtual`, overscan 6 rows, measurement-key compaction at 512 (`use-native-chat-transcript-window.ts:4,18-24`).
  - Height estimates come from typography (`native-chat-row-height-estimate.ts`).
  - Older pages autoload from a sentinel (`use-native-chat-older-history-autoload.ts:1`).
- **Autoscroll:** a 48 px near-bottom threshold hides the jump button (`native-chat-autoscroll.ts:8`). The design rule: "Virtualizer owns row anchoring; scroll hook owns follow intent … never reattach a parked reader from geometry alone" (`use-native-chat-transcript-window.ts:1`).
- **Collapse:**
  - Consecutive tool calls and thoughts merge into work runs (`native-chat-transcript-work-runs.ts:1`).
  - Disclosure state lives outside the windowed rows, so scrolling never resets it (`native-chat-disclosure-store.ts:1`).
  - Reasoning rows are collapsible.
- **Find:** DOM search via the CSS Custom Highlight API, re-run on mutation with a 120 ms delay for growing text, skipping hover chrome (`use-native-chat-find-matches.ts:10-60`). Because it is DOM-based, it presumably only covers mounted rows; I did not verify.
- **Selection:** native DOM selection plus quote-selection (`native-chat-quote-selection.ts`). Copy is per row.

## 8. Remote

- **Where a Pi chat can run:** "Local non-WSL only" (`src/main/provider-process/supervised-provider-child-location.ts:5-15`). A record pinned to another host is refused, because "local launch would create a second provider-session writer" (`src/main/runtime/structured-agent-launch-composition.ts:120-125`).
- **SSH targets:** get only TUI Pi via the relay PTY (`docs/site/content/docs/ssh.mdx:54-58`).
- **Remote chat:** run Orca (desktop app or `orca serve`, i.e. orcad) on the remote machine. The Pi child is then "local" there. Other clients pair with it (`docs/site/content/docs/remote-servers.mdx:10,115-120,138-171`).
- **Transport:** WebSocket with a 128-connection cap and a 10 s pre-auth timeout. Heartbeats run every 15 s (`src/main/runtime/rpc/ws-transport.ts:1-27`). E2EE frames sit above it (`e2ee-channel.ts:1`). Long-poll is a fallback (`runtime-rpc-long-poll.ts`). Phones can use a cloud relay director `https://relay.onorca.dev` (`src/main/orca-profiles/profile-cloud-auth-config.ts:27`, `rpc/relay-transport.ts`).
- **Reconnection:** the client pings every 10 s and treats 25 s of silence as dead. This catches half-open tunnels (`src/shared/remote-runtime/remote-runtime-socket-liveness.ts:1-6`). The client resubscribes with a cursor. A gap returns `reset` plus a byte-bounded tail page (`agent-session-wire.ts:122-130`, reasons in `agent-session-journal-types.ts:475-481`).
- **Latency:** sends are write-ahead submissions, so the UI shows pending before the host confirms. Mutations are idempotent through `clientOperationId` (`replayed: true`, `agent-session-wire.ts:293-302`).

## 9. Supervision, crash, quit

- **Spawn:** POSIX children run under a detached inline Node supervisor.
  - It refuses to start if its owner is already gone and polls `ppid` every 100 ms.
  - When the owner disappears it ends stdin, then TERM after 3 s, then KILL, then reaps the group (`src/main/provider-process/provider-process-supervisor.ts:4-28,155-164`).
  - A group-orphan guard finishes stops the supervisor could not complete (`provider-group-orphan-guard.ts:6`).
  - Windows needs process start-time proof (`supervised-provider-child-location.ts:13`).
- **Re-acquire:** blocked until the previous start is proven exited: "Previous Pi start has not exited" (`src/main/pi/rpc-session-adapter.ts:55-59`).
- **Crash mid-run** (`src/main/pi/rpc-session.ts:260-305`):
  - Dialogs are cancelled and turns end.
  - The lane is finalized `session.ended {state:'interrupted'}`, with a 2 s drain.
  - Held sends settle as `unknown` ("Pi ended before confirming delivery") or as a sign-in refusal (`rpc-prompt-delivery.ts:163-187`).
  - Lifecycle `ended` records `cause: unexpected-exit|requested-close` and death evidence.
  - The next send re-acquires with `--session <file>`, and a startup catch-up reconciles via `get_entries`.
- **Quit / update:** teardown captures live work just before stopping the children (`structured-agent-session-working-at-teardown.ts:2-3`). Resume markers record the trigger `quit|update` (`src/shared/agent-session/lifecycle/agent-session-resume-marker.ts:14-17`). After restart a status-bar offer can "send a continuation, never replaying the original prompt" (`structured-agent-session-restart-resume-runner.ts:1`; methods `agentSession.restartResumable/restartResume/continueInterrupted`).
- Local chats do not keep running after the app quits. Durability comes from the journal plus Pi's session file. Only `orca serve` hosts keep running.

## 10. Session-file concurrency and handoff

- **No lock.** The code says: "Pi has no writer lock; terminal writes are safe only while chat Pi is stopped. Reopen reloads disk" (`src/main/pi/rpc-history-catch-up.ts:42`).
- **Guard 1 – terminal resumes:** `assertLegacyAiVaultResumeCommandAllowed` parses every shell command Orca itself sends or launches.
  - Hook points: agent launch plugin hook, `terminal.send` RPC, plugin-rewritten prompts, session-tabs (`src/main/ipc/pty/spawn-agent-launch-plugin-hook.ts:55`, `src/main/runtime/rpc/methods/terminal/terminal-send-method.ts:57`, `src/main/runtime/terminal/input/terminal-plugin-hooked-input.ts:73`, `src/main/runtime/rpc/methods/session-tabs.ts:67`).
  - It refuses `pi --session <owned file>` and also **targetless** `pi -c/-r` ("A targetless resume could open any owned session", `src/main/ai-vault/structured-session-ownership.ts:224-241,272-282`).
  - `sameIdTerminalResumeEnabled` returns `false` for every agent, so the same-id resume is always refused (`src/main/native-chat/agent-session-wire/structured-provider-session-ownership.ts:64-75`).
  - Raw keystrokes typed in a shell are **not** covered.
- **Guard 2 – one writer per chat record:** fail-closed lease adjudication: "a wrong answer here creates two writers on one provider session" (`src/shared/agent-session/lifecycle/agent-session-lease-adjudication.ts:2-10`). It uses PID + start time + spawn token.
- **Terminal → chat** ("Continue in Chat UI"):
  - The session file comes from the TUI status extension.
  - "The chat's create waits for the terminal's proven exit", with a 30 s timeout (`src/renderer/src/components/tab-bar/cli-chat-resume-run.ts:124-129,241`).
  - The adopted file is checked: header `id` must equal the filename and `cwd` must match (`rpc-launch-resolution.ts:180-190`).
- **Chat → terminal:** "Resume in New Terminal" always forks: "Start a new terminal agent session with a copy… This chat stays unchanged" (`ai-vault-session-cli-fork-copy.tsx`). Forks are exempt from the guard (`structured-session-ownership.ts:217-218`).
- **Outside writes:** found on reopen through `get_entries`. They are imported behind a "continued-outside(-rewound)" divider (`src/main/pi/rpc-history-import.ts:107-117`, `structured-agent-session-history-catch-up.ts:25-27`). A file-tail entry id is used as a hint only (`rpc-session-file-tail.ts:8`).

## 11. Unsolicited / self-started turns

- `agent_start` with no active turn: "A run Pi starts while idle (an extension wake) opens with its own prompt". It opens `run:<gen>:<n>`. `awaitingRunTrigger = consumeNext() || idle` (`src/main/pi/rpc-turns.ts:123-129`).
- Queued follow-ups: "A run's first message is the prompt that started it; later user echoes consume queued inputs". Each user `message_end` accepts the next waiting submission (`rpc-turns.ts:138-141`).
- Steer vs follow-up is chosen automatically per send (`rpc-turns.ts:66`).
- Settlement still waits for `agent_settled` plus the `get_state` idle probe (`rpc-turns.ts:168-170`).
- Test: the 1.3.0 subagent wake yields 2 turns, 1 accepted send and `WAKE_CONSUMED` text (`rpc-capture-replay.test.ts:212-219`).
- **Rendering gap:** live `message_*` frames with role ≠ assistant return `[]` (`rpc-messages.ts:84-86`). The wake's `custom` message (`subagent-notify`, `display:true`) is therefore not drawn. Only the reply is.
  - The OMP decoder would show `display:true` custom messages (`transcript-line-decoders-omp.ts:44,100`). But catch-up imports only entries written outside the chat (`rpc-history-catch-up.ts:86-90`), and turn-end capture persists only a cursor (`rpc-history-capture.ts:36`).
- Other host-originated turns: orchestration mail rendered with a sender (§6), usage-limit auto-continue (`use-native-chat-usage-limit-auto-continue.ts`), restart continuations (§9).

## 12. Local transport security

- **UI ↔ Pi:** stdio pipes, with no network surface.
- **Renderer ↔ host:** Electron IPC.
- **CLI and other local clients:** a Unix socket chmod 0600 or a named pipe (unix: `chmodSync(this.endpoint, 0o600)`). Limits: 1 MB frames, 32 connections, 30 s idle (`src/main/runtime/rpc/unix-socket-transport.ts:1,63-67`). Every request carries `authToken = randomBytes(24).toString('hex')` (`src/main/runtime/runtime-rpc/runtime-rpc-state.ts:55`). The token is checked in `parseAndAuth` (`runtime-rpc-request-admission.ts:145-151`) and published in a metadata file written by `writeSecureFile` (0600 file in a 0700 dir, Windows ACL hardening) (`src/main/runtime/runtime-metadata.ts:59-61`, `src/shared/secure-file.ts:113-123`). The comparison is a plain `===`, not constant-time.
- **WebSocket:** bound to `127.0.0.1` unless a network device is connected. Widening to `0.0.0.0` happens only for pairing and refuses a pinned host (`runtime-rpc-lifecycle.ts:172`, `runtime-rpc-network-exposure.ts:8-33`). Default port 6768 (`runtime-rpc-pairing-types.ts:20-24`).
- **Pairing and devices:**
  - Pairing URL/QR plus revocable per-device tokens or device-key proofs (`mobile-e2ee-auth-validation.ts:6-9`).
  - tweetnacl box E2EE (`src/shared/paired-e2ee-client-handshake.test.ts:1-17`).
  - Throttling for unpaired devices (`unpaired-device-auth-throttle.ts`).
  - Phone methods are allowlisted, and the routing table is the allowlist (`runtime-rpc-mobile-method-allowlist.ts:1-4`).
  - Caller scopes `owner|mobile|runtime-paired` with per-method permissions; pairing admin is never delegated (`src/main/runtime/rpc/rpc-caller-scope.ts:7-20`).
- **Origin header:** not checked anywhere in the WS transport.
- **Identity env:** injected session identity is "valid only on the same host/user: refuse claims across SSH, pairing or WSL" (`agent-session-caller-env.ts:1`).

---

## Transferable to Herdr (host process + Herdr mod)

1. **Commands**
   - Keep a small host-owned command table: `/model` `/thinking` `/compact` `/new`(=fresh child) `/resume`(=mod session picker over `~/.pi/agent/sessions`) `/name`(=`set_session_name`). Send everything else as text.
   - Build `/` from `get_commands` after the session opens; don't block on it.
   - For `/login` and `/settings`: if `get_state.model.provider==='unknown'`, show "run `pi` → `/login` in a terminal". Better: a mod button that opens a herdr-core terminal running `pi`, so the user can `/login` there, then restart the host child. Retry "No API key found" replies a few times.
2. **`custom()` hangs**
   - Always offer Stop while a prompt is unacknowledged (`abort` + cancel open dialogs).
   - Auto-cancel unknown `extension_ui_request` methods.
   - Cancel leftover dialogs whenever a run settles.
   - Optionally add a host-side "no events for N s after a `/cmd` prompt" hint row. Orca has none.
   - Consider an allowlist or a `ctx.mode==='tui'` audit of installed extensions. Orca has none.
3. **Decoration**
   - Orca drops it. Herdr can do better cheaply: strip ANSI in the host, then show `setStatus`/`setWidget` as a status strip and `notify` as a toast/row in the mod.
   - Render unknown tools as a generic row with text-only output, and keep `details` as raw JSON behind an expander.
4. **Pi versions**
   - Probe `pi --version` on each host start; allow `unknown`; set a minimum that has `agent_settled`.
   - Record `{dir,raw}` RPC captures per Pi release and replay them through the host's normalizer in CI.
   - Treat new reply fields as optional, ignore unknown event types, keep oversized-head recovery.
   - **Composer:** recall from the transcript (no separate history). `@` via a host-side file index (the mod can't walk the tree with 30 s `exec` cheaply; let the host serve file search over the socket). Persist drafts in the host or mod storage.
5. **Images**
   - The mod clipboard is text-only, so paste must be path-based: drag-drop/picker gives a path → the host reads it, sniffs magic bytes, applies Orca's caps (5 MiB / 20 / 20 MiB) and sends base64 `images[]`.
   - Tool-result images: the host could write them to temp files and send the mod a path to display. Orca doesn't.
6. **Identity and messaging**
   - Project `working/attention/idle` in the host from turn state + pending dialogs + `get_state` idle probe, and publish it to Herdr's agent-status/labels so the sidebar and notifications work.
   - Expose `send`/`history`/`subscribe` on the host socket so `hc` / other agents can message a GUI agent as a queued, idempotent turn tagged with `from`, and read a bounded journal tail.
7. **Rendering**
   - Coalesce deltas in the host (~50–60 ms) and send cursor-qualified *snapshots*, not deltas.
   - The mod needs list virtualization, a stick-to-bottom threshold, collapsible tool runs with disclosure state kept outside rows, and search over the host journal. Server-side find avoids the DOM-only limitation.
8. **Remote**
   - Mirror Orca: run the host on the machine that owns the files/session (via a herdr-core terminal there) and connect the mod over WS.
   - Add client pings (10 s) with a 25 s dead timeout, plus cursor resubscribe with a `reset`+tail page on gaps. Make sends idempotent with `clientOperationId`.
9. **Supervision**
   - The host should own Pi under a process group and die with its herdr terminal. Copy the ppid-poll / stdin-end → TERM → KILL ladder.
   - On child exit, finalize the open turn as `interrupted`, mark unacked sends `unknown`, and re-spawn with `--session <file>` on the next send.
   - Write a resume marker at quit so the mod can offer "Continue" (a continuation prompt, not a replay).
10. **Session files**
    - Copy the ownership guard: the host records "I own <file>" (pid + start time). Herdr wrappers/`hc` refuse `pi --session <owned>` and targetless `-c/-r` while it is live.
    - Terminal→GUI = close the terminal Pi, wait for proven exit, then start the host with `--session`.
    - GUI→terminal = `--fork` (copy) by default.
    - On reopen, diff `get_entries` against the journal cursor and insert a "continued outside" divider.
11. **Unsolicited turns**
    - Treat `agent_start` while idle as a host-minted turn.
    - Match user `message_end` echoes to queued sends.
    - **Render `role:custom` messages with `display:true`**. Orca's live path drops them; easy win.
12. **Transport security**
    - Prefer a Unix socket (0600, in a 0700 dir) between mod and host if the mod can dial one. Otherwise TCP on 127.0.0.1 with a ≥24-byte random token in a 0600 file the mod reads via `exec`.
    - Compare in constant time.
    - Add an Origin/Host check if the mod uses WebSocket (Orca lacks one). Never widen to 0.0.0.0 without pairing.
