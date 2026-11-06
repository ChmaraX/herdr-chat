# Paseo vs the 12 Pi-GUI problems

Repo: a clone of `paseo` (the commit is in `COMMITS.txt`). Pi adapter: `packages/server/src/server/agent/providers/pi/` (shortened below to `pi/`). Builds on `findings-paseo.md`; facts covered there are not repeated.

Architecture recap: a resident daemon owns `pi --mode rpc` as a stdio child. App, CLI and MCP tools are WebSocket clients of that daemon. So "host" in Herdr terms maps to Paseo's daemon.

## Summary

| # | Problem | Solved? | Mechanism (one line) | Key path:line |
|---|---|---|---|---|
| 1 | TUI built-ins over RPC | partial | A few commands are rebuilt in the GUI (`/compact`, `/autocompact`, `/new`/`/clear`, `/quit`, model, thinking, rewind, fork, import). `/login`, `/settings`, `/export`, `/name`, `/hotkeys` (Pi's) have no equivalent | `pi/agent.ts:128-141, 1675-1700`; `app/src/client-slash-commands/index.ts:17-36` |
| 2 | `ctx.ui.custom()` hangs | partial | No detection of `custom()`. Slash commands that don't start a run are completed by a `get_state` probe. The prompt ack has a 60 s RPC timeout, and the bridge's own commands time out at 30 s | `pi/agent.ts:1327-1355, 1784-1806, 116-117`; `jsonl-rpc-process.ts:165-175` |
| 3 | Extension decoration / renderers | partial | `notify` becomes a timeline notification. `setStatus`/`setWidget`/`setTitle`/`set_editor_text` are dropped. Custom messages become a plain-text tool row. Per-extension adapters map known extension tools | `pi/agent.ts:2085-2123, 1014-1015, 2488-2503`; `providers/custom-message.ts:4-25`; `pi/extensions/registry.ts:12-23` |
| 4 | Version drift + composer | partial | `COMPAT(...)` shims keyed on "Unknown command" errors. Fixtures record their Pi version. No min-version gate. The composer has history recall, `@` file mentions (daemon dir search), `/` autocomplete (`get_commands`), persisted drafts and rebindable shortcuts. No external editor | `pi/agent.ts:238-246`; `pi/rpc-types.ts:170`; `app/src/composer/recall.ts:12`; `app/src/hooks/use-agent-autocomplete.ts:446-470` |
| 5 | Images | yes | Clipboard paste, picker and drag-drop. Sent as base64 `images[]` over WS, then as Pi `prompt.images` only if `model.input` has `"image"`. Otherwise saved to a file and sent as a path hint. Byte caps only, no count cap | `protocol/src/messages.ts:1249-1265`; `pi/agent.ts:383-436`; `provider-image-output.ts:70-72` |
| 6 | Status + inter-agent messaging | yes | The daemon derives lifecycle and attention, routes notifications by client presence (push, in-app, dock badge, sound). CLI `paseo send/logs/attach/wait` and Agent-MCP `create_agent`/`send_agent_prompt`/`get_agent_activity` | `agent-manager.ts:5230-5253, 4970`; `agent-attention-policy.ts:43-79`; `agent/tools/paseo-tools.ts:709-717` |
| 7 | Long-transcript perf/UX | yes | Daemon coalescer at 60 ms, app reducer at one frame / 48 ms, paced reveal, windowed and virtualized list, sticky-bottom controller, collapsible tool groups and turns, daemon-side find, copy back to Markdown | `agent-stream-coalescer.ts:4`; `session-stream-reducers.ts:20, 1873-1874`; `agent-stream/web-virtualization.ts:9`; `bottom-anchor-controller.ts:3` |
| 8 | Remote | yes | One daemon per machine. Clients use direct WS, an SSH `-W` stdio tunnel, or an E2EE relay (Noise NK). Reconnect with backoff plus paged catch-up | `protocol/src/ssh-transport.ts:63-82`; `SECURITY.md:12-30`; `client/src/daemon-client.ts:1398-1401` |
| 9 | Supervision | partial | Pi is a non-detached child, stopped with a SIGTERM→SIGKILL tree kill. An exit mid-turn becomes `turn_failed`. Resume from JSONL is lazy. Opt-in "resume on startup" sends `Resume working.`. Idle runtimes are reaped after 1 h. An exit between turns is not surfaced for Pi | `jsonl-rpc-process.ts:236-262`; `pi/agent.ts:2192-2215, 1632-1647`; `docs/agent-lifecycle.md:17-33, 49` |
| 10 | Session-file concurrency | partial/no | Inside Paseo: one runtime per agent, reload closes the old process before resuming, and already-imported sessions are filtered out of import. Against an external `pi --session`: no lock and no detection. "Copy resume command" puts `pi --session <id>` on the clipboard and leaves the GUI runtime running | `docs/agent-lifecycle.md:45-47`; `agent/import-sessions.ts:154-160`; `app/src/utils/provider-command-templates.ts:23-25`; `screens/workspace/workspace-screen.tsx:2127-2150` |
| 11 | Unsolicited turns | yes | An `agent_start` with no foreground turn becomes an autonomous run with a synthesized turn id. The injected extension reports every Pi user entry, including ones injected by extensions. Custom messages render as rows | `agent-manager.ts:529-532, 4942-4958`; `pi/agent.ts:2232-2252, 736-752`; `docs/timeline-sync.md:258-275` |
| 12 | Local transport security | yes (opt-in pw) | Binds 127.0.0.1. Host-header allowlist and Origin check on WS upgrade. Optional bcrypt password sent in `hello`, plus a per-run 0600 `local-credential` file. Per-run capability token for `/mcp/agents`. Principals and permissions for paired devices | `websocket-server.ts:941-973`; `session-admission-auth.ts:10-32`; `local-credential.ts:13-17`; `bootstrap.ts:706-713`; `auth.ts:115-155` |

---

## 1. Built-in TUI commands

Pi RPC commands Paseo actually sends (`pi/cli-runtime.ts:122-262`): `prompt`, `steer`, `clear_queue`, `compact`, `set_auto_compaction`, `abort`, `get_state`, `get_available_models`, `set_model`, `set_thinking_level`, `get_session_stats`, `get_commands`, `extension_ui_response`. It never sends `new_session`, `fork`, `switch_session`, `set_session_name`, `export_html`, `bash` or `follow_up` (`pi/rpc-types.ts:133-146`).

How each TUI command is covered:

| TUI cmd | Paseo | How |
|---|---|---|
| `/compact [instr]`, `/autocompact on\|off\|toggle` | yes | Advertised as built-ins merged into `get_commands` output (`pi/agent.ts:128-166`). Intercepted by `tryHandleOutOfBand` (`pi/agent.ts:1675-1700`) and run as `compact` / `set_auto_compaction` RPCs, with result text emitted as assistant rows (`pi/agent.ts:1867-1972`) |
| `/new`, `/clear` | rebuilt | Client-side command: archive the agent and open a fresh draft with the same provider, model, thinking and features (`app/src/client-slash-commands/index.ts:27-35, 67-81`). It is a new Paseo agent and a new Pi process, not Pi's `new_session` |
| `/quit`, `/exit`, `/q` | rebuilt | Client-side "archive agent" (`client-slash-commands/index.ts:18-26`) |
| `/model`, thinking | GUI picker | `set_model` / `set_thinking_level` (`pi/agent.ts:1703-1721`). The catalog comes from a throwaway Pi process: `get_available_models` + `get_state` (`pi/agent.ts:2780-2830`) |
| `/tree` | partial | Only "rewind to a user message", through the injected `/paseo_tree` command calling `ctx.navigateTree` (`pi/agent.ts:769-788, 1604-1630`). There is no tree browser |
| `/fork` | rebuilt | "Fork" builds a `chat_history` text attachment of the timeline up to a boundary and seeds a new draft agent with it (`app/src/hooks/use-fork-agent.ts:25-80`; `server/session.ts:8353-8383`; `agent/activity-curator.ts:363`). It is a new agent with pasted context, not a Pi branch |
| `/resume` | rebuilt | Sessions screen and import sheet. Pi JSONL files on disk are scanned and ranked by mtime (`pi/session-descriptor.ts:73-110, 260-269`) and resumed via `--session` |
| `/reload` | rebuilt | `paseo agent reload` restarts the provider process (`cli/src/commands/agent/reload.ts:27`; `docs/agent-lifecycle.md:45`) |
| `/copy` | GUI | Per-message and per-turn copy buttons (`app/src/components/message.tsx:537-540, 652`) |
| `/session` (stats) | GUI | Usage display polled through `get_session_stats`, falling back to `get_state` (`pi/usage-poller.ts:28`; `pi/cli-runtime.ts:209-240`) |
| `/hotkeys` | own | Paseo's own rebindable shortcuts (`app/src/screens/settings/keyboard-shortcuts-section.tsx:23, 84-100`). Pi keybindings are irrelevant in a GUI |
| `/name` | own | Paseo-owned agent title (metadata generation and agent update). Pi's session name is never set |
| `/login`, auth | **not addressed** | No OAuth flow and no `auth.json` writer. The only touch is a diagnostic row "Auth config (~/.pi/agent/auth.json): found / not found" (`pi/agent.ts:2865-2880`). The user must run `pi` → `/login` in a terminal |
| `/settings` (Pi `settings.json`) | **not addressed** | Paseo has its own provider settings: enable/disable per provider (`app/src/screens/settings/providers-section.tsx:394-397`) and `config.json` `agents.providers.pi` with `command`, env, profiles and `options` (`docs/custom-providers.md:1-60`). Pi options are only `sessionDir`, `rpcTimeoutMs` and `extensionTimeoutMs` (`pi/agent.ts:120-126`) |
| `/export`, `/share` | **not addressed** | — |
| `/hotkeys`, `/changelog`, `/scoped-models`, theme | **not addressed** | — |

Any other `/x` typed in the composer goes to Pi as a `prompt`. Pi runs extension, skill and prompt-template commands itself. Paseo's internal `paseo_tree` / `paseo_capture_entries` commands are not filtered from `get_commands` output (`pi/agent.ts:150-166`; no filter found elsewhere), so they can show up in autocomplete. `commandCache` is declared and read but never assigned (`pi/agent.ts:1220, 1666-1673`), so every autocomplete open spends a `get_commands` round-trip.

**Transferable to Herdr**
- The host advertises a merged command list: `get_commands` plus host built-ins (`compact`, `autocompact`, `new`, `quit`, `model`, `rewind`). The host intercepts built-ins before they reach `prompt`.
- `/login`: Paseo has no answer. Options: (a) the mod opens a herdr-core terminal running `pi` and types `/login`; (b) for API-key providers, the host writes `auth.json` itself, since the mod `exec` cannot take stdin.
- `/settings`: render a small form over `~/.pi/agent/settings.json` from the host. Reload means restarting Pi with `--session`.
- `/new`, `/fork`: prefer Pi's native `new_session` / `fork` RPC over Paseo's "new agent + pasted history". Paseo did it its way because its agent identity is per-process.
- Filter host-internal bridge commands out of autocomplete. Paseo doesn't.

## 2. `ctx.ui.custom()` → undefined / hanging extension commands

- No detection, allowlist or per-extension adapter for `custom()`. `rg 'custom\('` in `pi/` finds nothing.
- Pi 1.5 replies to `prompt` only after preflight. For a `/ext` command that is after `_tryExecuteExtensionCommand` resolves (`pi-coding-agent/dist/core/agent-session.js:1658-1663`, `dist/modes/rpc/rpc-mode.js:298-317`). A command that awaits forever therefore withholds the ack. Paseo's `prompt` uses the default request deadline, `rpcTimeoutMs` = 60 s (`pi/agent.ts:117`; `jsonl-rpc-process.ts:165-175`). After that the turn fails with `"Pi RPC request timed out phase=prompt …"` (`pi/agent.ts:1356-1388`). Pi itself keeps running the stuck handler.
- No-turn completion: if the ack says `agentInvoked:false`, or a `prompt_result` event says so, the turn completes locally and buffered `command_output`/notify text is emitted (`pi/agent.ts:1345-1352, 1773-1782, 2167-2185`). Without that field, slash prompts get a `get_state` probe after the ack. If nothing is streaming and no `agent_start` arrived, the turn is closed (`pi/agent.ts:1327, 1353-1355, 1784-1806`).
- **Drift:** Pi 1.5's ack carries `{disposition:"handled"|"queued"|"started"}` (`agent-session.js:1662, 1693, 1711`), not `agentInvoked`. Paseo's typed field (`pi/rpc-types.ts:12-15`) is never set on 1.5, so only the probe path runs.
- Paseo's own bridge commands use a separate 30 s `extensionTimeoutMs` (`pi/agent.ts:116, 1982-1991`).
- Extension dialogs carrying a `timeout` are auto-resolved by Pi. Paseo does nothing special for them.

**Transferable to Herdr**
- Read `disposition` from Pi 1.5's prompt ack: `handled` means no turn will come. Keep the `get_state.isStreaming` probe as a fallback.
- Put a deadline on the ack, then show "extension command didn't return; it may use TUI-only UI". Offer "abort" (`abort` RPC) and "restart Pi with `--session`".
- Optional: the host scans `get_commands` `sourceInfo` and greys out commands from extensions known to call `custom()` (a curated denylist). Paseo has nothing like it.

## 3. Extension decoration and custom renderers

- `notify` becomes `{type:"notification", level, message}` (`pi/agent.ts:2085-2110`). It is checked first for Paseo's own base64 markers and adapter markers (`pi/agent.ts:2086-2097`). The message is **not** ANSI-stripped. Only the `command_output` text is (`pi/agent.ts:7, 2138`).
- `setStatus`, `setWidget`, `setTitle`, `set_editor_text` reach `mapExtensionUiRequestToPermission`, hit `default: return null` (`pi/agent.ts:1014-1015`) and are dropped (`pi/agent.ts:2121-2123`). The docs say so: "Fire-and-forget extension UI requests such as notifications are intentionally ignored … unless Paseo grows first-class UI" (`docs/providers.md:90`).
- `role:"custom"` messages (`pi.sendMessage`) render as a synthetic, expandable `tool_call` with `detail:{type:"plain_text"}` and `customType` as the name, unless `display:false` (`pi/agent.ts:2488-2503`; `providers/custom-message.ts:4-25`). Extension `renderMessage`/`renderCall`/`renderResult` are never used.
- Per-extension adapters exist (10 of them, `pi/extensions/registry.ts:12-23`). Contract hooks: `mapToolCall`, `mapCustomMessage`, `mapDialog`, `onToolStart` (approval gates), `poll`, and a `runtimeBridge` JS snippet injected into the Paseo extension (`pi/extensions/contract.ts:56-83`; injected at `pi/agent.ts:708`). Example: the gotgenes bridge listens to `subagents:child:session-created` and notifies the child session file (`pi/extensions/gotgenes-pi-subagents/runtime-bridge.ts:8-32`). Everything else falls back to the generic `unknown` tool card.

**Transferable to Herdr**
- Show `setStatus` (keyed) and `setWidget` (string lines) in a status strip and a widget area above or below the composer. Show `setTitle` as the tab title. Paseo drops all of these, so Herdr can do better here for little cost. Strip or parse ANSI SGR in the host before sending. GPUI markdown won't render escapes.
- Copy the adapter registry pattern: `{toolName → renderer}` in the mod, keyed by extension id from `get_commands.sourceInfo`. Fall back to a plain-text card.
- Copy `runtimeBridge`: the host's injected Pi extension can host per-extension JS that reports state RPC omits, via `ctx.ui.notify` markers.

## 4. Version maintenance + composer

**Versions**
- No minimum version and no startup version check. `pi --version` is run only for the diagnostics screen (`providers/diagnostic-utils.ts:403-418`).
- Capability probing works by matching the error string: `"Unknown command: steer"` → steer unavailable (`pi/agent.ts:238-246`), `"Unknown command: clear_queue"` → skip (`pi/agent.ts:1546`). `get_session_stats` falls back to `get_state` (`pi/cli-runtime.ts:209-240`). MCP support is probed from `get_commands` `sourceInfo` (`pi/agent.ts:2917-2940`; `docs/providers.md:78-80`).
- Shims are tagged with dates: `COMPAT(piCumulativeMessageUpdate)` (`pi/rpc-types.ts:170`), `piAgentSettled` (`pi/agent.ts:2349`), `piSteerFallback`, `piClearQueueFallback`, `subagent-log` (adapters). Removal policy: `docs/protocol-compatibility.md`.
- Contract fixtures: each adapter ships recorded RPC/JSONL fixtures with provenance. Example: `{"package":"@earendil-works/pi-coding-agent examples/extensions/todo.ts","version":"0.87.1","sourceCommit":…,"piVersion":"0.84.4","captureDate":…}` (`pi/extensions/pi-example-todo/fixtures/rpc-session.json:2-9`). The policy is in `docs/providers.md:72`. There is a fake Pi (`pi/test-utils/fake-pi.ts`) and real-binary e2e tests (`daemon-e2e/pi.real.e2e.test.ts`, `pi-rewind.real.e2e.test.ts`).
- Gap: fixtures are pinned to Pi 0.84.x. Pi 1.5's `disposition` ack (see §2) is not modelled.

**Composer**
- Input history: Up/Down on an empty composer walks this agent's sent messages, newest first, read from the timeline. The first edit releases the arrows (`app/src/composer/recall.ts:7-51`; wired at `composer/index.tsx:2000-2008`).
- `@` file mention: `findActiveFileMention` (`app/src/utils/file-mention-autocomplete.ts:20-46`) → daemon `directory_suggestions_request` (`limit:50`, files+dirs, 15 s stale, debounced) (`app/src/hooks/use-agent-autocomplete.ts:446-470`; `server/session.ts:3105`). It inserts a quoted relative path and drops the `@` (`file-mention-autocomplete.ts:48-57`).
- `/` autocomplete: daemon `listCommands` → Pi `get_commands` merged with built-ins and plugin client commands (`use-agent-autocomplete.ts:435-441, 483-490`; `agent-manager.ts:1222-1233`).
- Drafts: zustand `persist` to AsyncStorage, including attachments (`app/src/stores/draft-store/index.ts:2-3, 69`).
- Keybindings: one binding table with user overrides (`docs/keyboard-shortcuts.md:3`; `keyboard-shortcuts-section.tsx:23`).
- External `$EDITOR`: **not addressed** (no hits). Fullscreen composer only (`composer/input/fullscreen-exit.ts`).

**Transferable to Herdr**
- The host runs `pi --version` at start, refuses below a floor, and exposes `{piVersion, features}` to the mod. Probe new RPCs by error string like Paseo does, and tag every shim.
- Record JSONL fixtures from real Pi 1.5 RPC sessions with provenance, and replay them through the host's mapper in tests.
- Feed the composer from the host: history from the transcript, `/` from `get_commands`, `@` from a host-side file walk (the mod's `exec` 30 s limit makes `rg --files` per keystroke too slow; cache it in the host). Persist drafts in mod storage.

## 5. Images

- Inputs: clipboard (`app/src/composer/clipboard-image.ts:12-29`, PNG data URL), native paste (`composer/native-pasted-image.ts`), picker (`hooks/use-image-attachment-picker.ts`, normalized to JPEG/PNG in `picked-image-normalizer.ts:18-31`), drag-drop (`composer/attachments/drop.ts:28-40` splits non-raster files from raster images).
- Wire: `send_agent_message.images: [{data: base64, mimeType}]` (`protocol/src/messages.ts:1249-1265`).
- To Pi: `prompt.images[]` only when `model.input` includes `"image"` (`pi/agent.ts:405-420`; `docs/providers.md:76`, which notes text-only models persist rejected images into the JSONL). Otherwise the image is materialized to a temp file and the prompt gets `[Image available at: <path>]` (`pi/agent.ts:383-393`).
- Caps: WS message ≤100 MiB, relay frame ≤32 MiB (`protocol/src/websocket-message-limit.ts:2-5`). Materialization ≤128 MiB per image (`providers/provider-image-output.ts:70-72, 149-150`). File uploads ≤50 MiB (`app/src/attachments/upload-limit.ts:2`). No image-count cap and no downscaling found.
- Tool-result images: see `findings-paseo.md` §3 (`pi/tool-call-mapper.ts:247-279`).

**Transferable to Herdr**
- The mod has a text-only clipboard, so image paste has to go through the host: a host command reads the OS clipboard (`pngpaste` / `osascript`) into a temp file and returns its path. A file-picker equivalent is "path input" plus a host read.
- The host owns the `model.input` check and the path-hint fallback, and should add a downscale and count cap. Paseo has neither.

## 6. Status, notifications, inter-agent messaging

- Lifecycle `initializing/idle/running/error/closed` comes from provider events (`docs/agent-lifecycle.md:5-13`). Attention `{finished|error|permission}` is set when status moves running→idle or into error (`agent-manager.ts:5230-5253`) or on a permission request (`agent-manager.ts:4970`). It is cleared by the client's `workspace.clear_attention` when the chat is read (`docs/agent-lifecycle.md:293-299`).
- Notification routing: heartbeats report `{appVisible, lastActivityAt, focusedAgentId}`. A present client focused on the agent suppresses the notification. Otherwise the most recently active client gets an in-app notification. Push is sent only if no client was active in the last 3 min, and never for `error` (`server/agent-attention-policy.ts:3, 43-83`). Presence is never a delivery gate (`docs/timeline-sync.md` "Presence is not delivery").
- OS surfaces: dock badge via IPC `setBadgeCount` (`desktop/src/window/window-manager.ts:181-187`; `desktop/src/preload.ts:79`), sound toggle (`app/src/desktop/settings/desktop-settings.ts:17, 34`), desktop notifications section, native push (`app/src/push-notifications/`).
- Workspace sidebar status aggregates agent states per workspace (`docs/agent-lifecycle.md:285-291`).
- External control:
  - CLI: `paseo run/ls/send/logs -f/attach/wait/stop/inspect` (`cli/src/commands/agent/*.ts`, e.g. `logs.ts:15-20`, `attach.ts:146`).
  - Agent MCP at `/mcp/agents`: `create_agent`, `send_agent_prompt`, `get_agent_status`, `get_agent_activity`, `list_agents`, `create_workspace` (`agent/tools/paseo-tools.ts:709-717`). It reaches Pi through MCP injection (findings §6).
  - Remote children via `serverId` (`docs/connected-hosts.md` "Delegating agents").
  - Agent-to-agent messages are XML-encoded with provenance and sender attribution, and the delivery id is the call id, so echoes don't duplicate (`docs/timeline-sync.md:267-275`).
  - Queued delivery, finish subscriptions persisted to `finish-subscriptions.json`, at-least-once wakeups (`docs/agent-lifecycle.md:145-175`).

**Transferable to Herdr**
- The host derives `working/blocked(permission)/idle/done(attention)/error` from Pi events (`agent_start`/`agent_settled`/`extension_ui_request` dialog) and publishes it as herdr-core agent status. Herdr's sidebar and notifications already exist, so the host only maps state. Copy the "focused + visible client suppresses notifications" rule.
- Messages in from other agents: expose a small host API, e.g. `hc send <terminal>` lines on the host's stdin or a host socket command, that maps to `prompt` (or `steer` while running). Transcript out: let other tools read the Pi JSONL path the host publishes, or `hc read` a host "transcript" command. Tag injected prompts with sender provenance like Paseo's XML.

## 7. Long transcripts

- Cadence: daemon `AgentStreamCoalescer`, leading + trailing, ≤1 message per 60 ms per agent (`agent/agent-stream-coalescer.ts:4`; `docs/agent-stream-performance.md:9-17`). The app reducer commits once per rAF, with a 48 ms timer as the ceiling so it still advances in hidden tabs (`app/src/timeline/session-stream-reducers.ts:20, 1873-1874`). Reveal is paced from backlog, the store keeps full text, the first sighting renders whole, and leaving streaming snaps the reveal (`docs/agent-stream-performance.md` "Invariants").
- Bounded items: tool calls 64 KiB, other items 256 KiB, truncated with a marker (`docs/timeline-sync.md:24-33`). Web render cap is 32 000 chars per message (agent-stream-performance invariants).
- Virtualization: native uses an inverted FlatList (`agent-stream/strategy-native.tsx:265, 611`). Web mounts a recent window of 20 items and partially virtualizes at ≥100 items with height estimates (`agent-stream/history-window.ts:4`; `web-virtualization.ts:9-11`). Initial load is about 40 projected items in whole turns, with backward pagination (`docs/timeline-sync.md` "Gap recovery"). Memoized rows keep streaming cost flat (perf doc invariants).
- Stick-to-bottom: `BottomAnchorMode = "sticky-bottom" | "detached"`, with explicit requests (`initial-entry`, `resume`, `jump-to-bottom`, `message-sent`, `rewind`) blocked until history and viewport are measurable (`agent-stream/bottom-anchor-controller.ts:3-27`).
- Collapse: per-call and per-group expansion store (`app/src/tool-calls/expansion.ts:13-30`). Whole-turn collapse with a tools summary line (`agent-stream/turn-collapse/model.ts:10-20`).
- Selection and copy: web maps the DOM selection across messages back to Markdown with turndown+gfm (`app/src/assistant-selection-copy/content.web.ts:1-25`). Native rules are in `docs/native-text-selection.md`.
- Find-in-chat: daemon-side `agent.timeline.search.request` returns locations, and the client reveals and counts them (`server/session.ts:2913, 8120-8143`; `app/src/agent-stream/chat-find/model.ts:1-30`).
- Measured by `app/e2e/browser/agent-stream-smoothness.spec.ts` (smoothness CoV + p95 stall).

**Transferable to Herdr**
- The host coalesces deltas (leading + trailing, ~50–60 ms) and sends whole bounded items. Truncate tool output in the host.
- The mod keeps a full-text model, renders a window of N recent items, and paginates older turns from the host. Collapse tool groups by default. Pin to bottom only in "sticky" mode, detach on user scroll.
- Find: run the search in the host over the transcript, since the mod may not render everything. Copy: if GPUI has no cross-widget selection, offer per-message and per-turn "copy as Markdown".

## 8. Remote

- Model: run a daemon on each machine. Pi always runs local to its daemon.
- Transports:
  - Direct WS over TCP or unix socket/pipe (`server/config.ts:476-490`).
  - Desktop SSH: spawns `ssh -T -o BatchMode=yes -o ConnectTimeout=10 -o ClearAllForwardings=yes -o ExitOnForwardFailure=yes [-p] -W 127.0.0.1:<port> host` and bridges WS through stdio (`protocol/src/ssh-transport.ts:63-82`; `desktop/src/daemon/local-transport.ts:220`). It needs a daemon already running remotely and key-based auth (BatchMode).
  - Relay: the daemon dials out; Noise NK E2EE, counter-nonced records, pairing QR carries the daemon pubkey in a URL fragment (`SECURITY.md:12-40`).
  - Daemon-to-daemon "connected hosts" with routed scopes (`docs/connected-hosts.md:1-40`).
- Reconnection: client reconnect with `baseDelayMs`/`maxDelayMs` backoff (`client/src/index.ts:103-107`; `client/src/daemon-client.ts:1398-1401, 1533-1598`). After reconnect, the live stream plus `after`-cursor paged catch-up until `hasNewer:false` (`docs/timeline-sync.md:47-56`). App-level ping/pong (`websocket-server.ts:2582-2588`). 8/64 MiB outbound high-water termination (findings §8; `timeline-sync.md:24-26`).
- Latency: a canonical submitted-prompt row with client message id gives an optimistic row that is reconciled on ack (`docs/timeline-sync.md:250-256`). Paced reveal hides lumpy arrival.

**Transferable to Herdr**
- Run the host on the remote machine next to Pi, and have the mod connect over an SSH `-W` tunnel started by a herdr-core terminal. The mod can't spawn long processes; a terminal can. Make the host protocol resumable from a sequence cursor so a dropped socket is cheap.

## 9. Process supervision

- Spawn: plain child with stdio pipes, not detached (`providers/jsonl-rpc-process.ts:65-73`). If the daemon dies, stdin hits EOF and Pi exits. Close does stdin.end → SIGTERM → 2 s → SIGKILL tree-kill → 1 s (`jsonl-rpc-process.ts:18-19, 236-262`). An invalid frame closes the process rather than skipping state (`jsonl-rpc-process.ts:95-99`). The stderr tail is kept for errors.
- Pi crash mid-turn: `process_exit` → reject pending bridge results → `turn_failed` with the exit and stderr text (`pi/cli-runtime.ts:104-106`; `pi/agent.ts:2192-2215`). **Between turns** the method returns early (`pi/agent.ts:2195-2197`), so the agent looks idle. The docs list this failure mode and say only Claude and OMP report it (`docs/agent-lifecycle.md:98-105`).
- Resume: runtimes are lazy. `ensureAgentLoaded()` re-runs `pi --mode rpc --session <file>` on open or prompt (`docs/agent-lifecycle.md:37-44`). `applyResumeModel` re-applies the model if it is still available (`pi/agent.ts:2753-2778`). Idle reaping after 1 h is vetoed by `canStopRuntime` (streaming, compaction, pending dialogs, steer, queue) (`pi/agent.ts:1632-1647`; `docs/agent-lifecycle.md:49-61, 84`).
- Daemon restart: records that were running are repaired to `closed`. Opt-in `agents.resumeOnStartup` reopens them and sends `Resume working.`; best effort, no exactly-once (`docs/agent-lifecycle.md:15-33`). The in-flight run is lost.
- Orphans: provider helper processes go into a managed-process ledger and are reconciled at boot by PID+identity, never by name sweeps (`docs/providers.md:124-128`). Pi itself isn't in the ledger; it relies on being a child.
- App quit: desktop stops the daemon it manages unless `keepRunningAfterQuit`, which defaults to false (`desktop/src/daemon/quit-lifecycle.ts:55-57`; `desktop/src/settings/desktop-settings.ts:39`). Agents die with the daemon and resume lazily next time.

**Transferable to Herdr**
- In Herdr the host is a herdr-core terminal process, so it survives the GUI and the mod. Keep Pi as a non-detached child of the host. On Pi exit at any time, not just mid-turn, emit an error row and offer "restart from session file". Paseo's between-turns gap is worth closing.
- Write `{pid, sessionFile, startedAt}` to a host state file so a restarted host can find or kill a leftover Pi. On host restart, never auto-resend the last prompt; show "interrupted" and let the user continue.

## 10. Session-file concurrency / GUI↔terminal handoff

- Within Paseo:
  - One runtime per agent. Reload closes the old Pi **before** resuming, because "an idle provider process can still own an exclusive writer"; a close failure blocks the replacement (`docs/agent-lifecycle.md:45-47`).
  - Import filters sessions already imported as Paseo agents (`agent/import-sessions.ts:154-160`), so two Paseo agents can't adopt one JSONL.
  - History-only resume of a session whose cwd is gone runs Pi on a **temp copy** (`pi/agent.ts:630-641, 2705-2712`; `providers/resume-process-cwd.ts:6-13`). The copy is the only write isolation in the codebase.
- Against an external `pi --session`: **not addressed**. No lockfile, no PID check, no mtime watch. The tab menu's "Copy resume command" copies `pi --session <id>` (`app/src/utils/provider-command-templates.ts:23-25`; `screens/workspace/workspace-screen.tsx:2127-2150`) and does not stop or close the GUI runtime. Running it while Paseo's Pi is alive (idle runtimes stay up to 1 h) gives two writers.
- Terminal → GUI is import only (findings §7). Import does not check whether a terminal `pi` still has the file open.

**Transferable to Herdr**
- The host takes an advisory lock (`<session>.jsonl.lock` holding the host PID) and refuses to open a locked session unless the PID is dead. Pi won't honour it, so also check with `lsof`/`pgrep -f "pi .*--session <file>"` before opening.
- Handoff GUI→terminal: the host sends `abort` if running, closes Pi, waits for exit, releases the lock, then starts `pi --session <file>` in a herdr-core terminal. Terminal→GUI: the reverse, after the terminal Pi exits. Herdr owns both terminals and can sequence this; Paseo can't.

## 11. Unsolicited / self-started turns

- Pi side: `agent_start` and `turn_start` always set `activeTurnStarted` and emit `thread_started`/`turn_started` even with no `activeTurnId` (`pi/agent.ts:2232-2252`). Events then carry `turnId: undefined` (`pi/agent.ts:1769-1771`).
- Daemon side: a `turn_started` with no foreground turn gets `turnId = autonomous-<uuid>` (`agent-manager.ts:529-532`). It is tracked with `runs.trackAutonomousRun`, flips lifecycle to `running` and clears attention (`agent-manager.ts:4942-4958`). Autonomous runs are observed, not gated by stop/cancel (`docs/providers.md:576-578`). They show as normal turns: "Every canonical run owns a visible turn, including heartbeats and agent notifications" (`docs/timeline-sync.md:258-270`).
- User rows in self-started runs: the injected extension queues every `role:"user"` `message_end`, so steer, follow-up and extension-sent user messages are all included. It reports each with its entry id via a notify marker on the next assistant `message_start` or `turn_end` (`pi/agent.ts:704-752`). The adapter emits them as `user_message` and correlates with pending steers by text (`pi/agent.ts:2025-2048`).
- Extension `sendMessage` custom rows: rendered as tool rows. If no run started, the turn is completed (`pi/agent.ts:2488-2507`).
- Subagent wake-ups: native subagent adapters follow child JSONL (findings §8). Paseo-managed children wake parents through finish subscriptions, at least once (`docs/agent-lifecycle.md:154-175`).
- Paseo does not use Pi's `follow_up` RPC. Its queued agent messages are daemon-side (`docs/agent-lifecycle.md:147-152`).

**Transferable to Herdr**
- The host treats any `agent_start` without a pending client prompt as an "autonomous" turn with a host-minted id, and broadcasts it like any other. The mod renders a small "started by extension/queue" marker.
- Capture user entries from Pi with an injected extension, as Paseo does, so extension-injected prompts show up. Or rely on `message_start` with `role:"user"` in Pi 1.5 RPC events if those carry the text.

## 12. Local transport security

- Bind: default TCP `127.0.0.1:6767`; unix socket or Windows pipe optional (`server/config.ts:476-490`). The docs warn that loopback with no password means any local process can drive it (`SECURITY.md:49`).
- WS upgrade: Host header checked against an allowlist (localhost, `*.localhost`, IP literals, plus configured names); otherwise `403 Host not allowed` (DNS-rebinding guard). Origin must be absent, allowlisted or same-origin (`websocket-server.ts:941-973`; `SECURITY.md:73`). Non-browser clients send no Origin and pass.
- Admission: if a password hash exists, `hello.auth` must carry the bcrypt-verified password or the per-run `local-credential` token (32 random bytes, file mode 0600, removed on shutdown, read by CLI and desktop only when the listen target matches) (`session-admission-auth.ts:10-32`; `local-credential.ts:13-28`; `SECURITY.md:51-53`). With no password every client is `owner`.
- `/mcp/agents` has a per-run random capability token injected only into local agent configs, compared in constant time (`bootstrap.ts:706-713`; `auth.ts:115-155`). Downloads use short-TTL capability tokens (`bootstrap.ts:700-702`).
- Per-client authority: principals, credentials, pairing invitations, and semantic permissions (`daemon.read`, `workspace.write`, …) (`docs/permissions.md:5-30`).

**Transferable to Herdr**
- The host listens on a unix socket in a 0700 dir, or `127.0.0.1:0` (random port). It writes `{port, token}` to a 0600 file. The mod reads it via `exec cat` and sends the token in its first frame; the host rejects anything else. Check the Host header and reject any Origin on WS (the mod sends none).
- Use a per-host-run token, constant-time compare, and no session data before auth. That is Paseo's `local-credential` pattern with auth mandatory instead of opt-in.
