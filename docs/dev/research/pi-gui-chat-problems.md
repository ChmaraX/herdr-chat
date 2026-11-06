# The 12 risks of a GUI-only Pi chat, and how Orca, T3 Code and Paseo handle them

Follow-up to [pi-gui-chat.md](pi-gui-chat.md). That doc recommends option A:
a host process runs `pi --mode rpc` inside a herdr-core terminal, and a Herdr
mod renders the chat. This doc takes each risk raised against option A and
looks up what the three reference apps actually built for it.

Sources:
- One deep dive per app (`problems-*.md`) plus the earlier overviews (`findings-*.md`), all in [`sources/`](sources/), at the commits in [`sources/COMMITS.txt`](sources/COMMITS.txt). Each file cites `path:line`.
- Before writing this I re-read a sample of the key citations myself:
  - Orca: `structured-agent-session-composer.ts:19-33`, `structured-session-ownership.ts:224-241`, `rpc-history-catch-up.ts:42`, `rpc-launch.ts:28-34`.
  - T3: `status.ts:60-69`, `adapter.ts:84-87`, `adapter.ts:2683-2686`.
  - Paseo: `ssh-transport.ts:63-82`, `agent-stream-coalescer.ts:4`, `agent-manager.ts:527-533`.
- Herdr facts come from `~/.config/herdr-app/{herdr.d.ts,gpui-kit.d.ts}` and from experiments on this machine.

**Bottom line:** nine of the twelve have a proven answer in at least one app.
For two more, Herdr can do better than all three, *because* it is a terminal
host: TUI-only commands (#1) and the GUI↔terminal handoff (#10). Three gaps
are open everywhere:
- **Nobody detects a hung `ctx.ui.custom()` (#2).** Everyone settles for a Stop button that works.
- **Nobody locks Pi session files (#10).** Orca's guard is the best of the three.
- **Nobody offers an external `$EDITOR` (#4).**

## Summary

| # | Problem | Best upstream answer | Who | Herdr plan |
|---|---|---|---|---|
| 1 | TUI built-ins missing over RPC | Host-owned `/model /effort /clear /compact /resume /name`. The other 162 commands (extension commands, templates, skills) pass through as prompt text. `/login` and `/settings` are sent to a terminal by **everyone** | Orca, T3 | Same table. **Herdr opens the TUI for the rest** |
| 2 | `ctx.ui.custom()` hangs | No detection anywhere. Stop works while a prompt is unacked; leftover dialogs are cancelled when a run settles | Orca, T3 | Copy those, and add a "no ack after N s" hint with "Open in TUI" |
| 3 | Decoration and renderers | `notify` → row. `setStatus`/`setWidget` are **dropped by all three**. Per-extension tool adapters exist (Paseo has 10) | Paseo | Host keeps the last status/widget per key, converts ANSI to spans, mod shows a status strip |
| 4 | Version churn, composer | Min version + re-probe every launch. Recorded RPC captures replayed in CI. History from the transcript, `@` from a host-side file index, `/` from `get_commands`. No `$EDITOR` anywhere | T3, Orca | Same. `$EDITOR` through a herdr-core terminal |
| 5 | Images | Paste/drop/picker → file → base64 `prompt.images`. Caps: Orca 5 MiB/20/20 MiB; T3 10 MiB, 2000 px. Path hint for text-only models | all | `paste_other` event → host saves the clipboard PNG via `osascript` → same pipeline |
| 6 | Agent status and inter-agent messaging | Host derives status. CLI and agents get `send` (queued, idempotent, tagged with the sender) and `read` (bounded journal) | all | Host emits OSC 7501, keeps `hc send`/`hc read` working, cloned `agents` mod routes clicks to the chat pane |
| 7 | Long transcripts | 50–60 ms coalescing in the host, virtualized list, stick-to-bottom threshold, collapse state kept outside rows, find run in the host, per-message copy | all | Same. Own scroller for clickable rows |
| 8 | Remote | Run the host *on* the remote machine. SSH `-W` stdio tunnel or relay. Ping/dead timeouts, cursor catch-up | Paseo, T3 | Host on the remote via `hc run --on`; SSH-forward terminal for the mod |
| 9 | Crashes, supervision | Process group + liveness-checked TERM→KILL. Exit → turn "interrupted". Resume with `--session`. "Continue" prompt, never a replay | T3, Orca | herdr-core terminal supervises the host; host supervises Pi |
| 10 | Session-file concurrency | **No lock anywhere.** Orca refuses `pi --session <owned>` and a bare `pi -c/-r` in the commands it launches, waits for the terminal Pi to *exit* before adopting, and forks on chat→terminal | Orca | Ownership guard + a lock-aware Pi extension (covers typed commands too) + Herdr-sequenced handoff |
| 11 | Turns the user didn't start | Paseo/Orca adopt `agent_start` while idle as an autonomous turn. T3 adopts it or kills Pi | Paseo | Adopt and render, with a "started by …" marker |
| 12 | Local transport security | Unix socket 0600 or loopback + random token in a 0600 file, Host/Origin checks, per-client scopes | Orca, Paseo | Loopback + 256-bit token in a 0600 file + constant-time compare |

---

## 1. Built-in TUI commands over RPC

**You were right:** commands work in all three. They split into three kinds:

1. **Pi's own command list** (`get_commands`: extension commands, prompt
   templates, `skill:`). These go to Pi as plain `prompt` text and run
   natively. That's 162 commands on this machine. Orca settles a send as
   command-only when the reply says `disposition:'handled'`
   (`orca src/main/pi/rpc-prompt-delivery.ts:156-159`).
2. **Built-ins the host re-implements**, which is the part RPC omits. Orca
   puts `model`, `effort`, `clear` and `compact` ahead of Pi's list
   (`structured-agent-session-composer.ts:19-33`) and replaces `/resume`
   with its own session-history picker. Which built-ins each app covers, and
   how:
   - **`/model`, thinking:** `set_model` / `set_thinking_level`. The catalog comes from a throwaway `pi --mode rpc --no-session` calling `get_available_models`.
   - **`/compact [instr]`:** the `compact` RPC. Paseo also has `/autocompact` via `set_auto_compaction`.
   - **`/new`, `/clear`:** T3 sends `new_session`. Orca starts a fresh child. Paseo creates a new agent.
   - **`/resume`:** `--session <file>` or `switch_session`. Paseo and Orca also import terminal-started sessions from `~/.pi/agent/sessions`.
   - **`/name`:** `set_session_name` (T3, Orca).
   - **`/fork`:** T3 runs a short-lived `pi --mode rpc --no-extensions --no-tools --fork <file>` (`adapter.ts:3099-3144`).
   - **`/tree`:** nobody has a tree browser. Paseo can rewind through its injected extension's command calling `ctx.navigateTree`.
   - **`/session`:** `get_session_stats`.
   - **`/copy`, `/hotkeys`, `/quit`, `/reload`:** handled by the GUI itself.
3. **Built-ins none of them offer:** `/login`, `/settings`, `/trust`,
   `/hotkeys` (Pi's), `/export`, `/scoped-models`.
   - Orca's copy literally says "run `pi`, then `/login`" (`agent-session-sign-in.ts:9`).
   - T3 detects missing auth (no discovered models, then `pi auth check --json --no-refresh` on Pi ≥0.84.1) and tells the user the same (`status.ts:251-292`).
   - Orca treats `get_state.model.provider==='unknown'` as "not signed in", and retries a "No API key found" reply up to 8× before failing.

**Herdr solution.**
- Use Orca's host-owned table (`model`, `thinking`, `compact`, `autocompact`, `new`, `resume`, `name`, `fork`) and pass everything else to Pi.
- For the third kind, Herdr is a terminal app, so **open the real TUI**:
  - `/login`, `/settings`, `/trust`, `/scoped-models`: open a herdr-core terminal running `pi --no-session` (it doesn't touch the chat's session file), then restart the RPC child with `--session <file>` so the new auth or settings apply.
  - `/tree`, `/export`: these need the session itself, so do the handoff in #10. Alternatively, a small injected extension command calling `ctx.navigateTree` (Paseo's trick) covers rewind without leaving the GUI.
- Auth detection: T3's discovery count + `pi auth check`, plus Orca's `provider==='unknown'` check.

## 2. `ctx.ui.custom()` → hung extension command

**Nobody solves the root cause.** Pi 1.5 replies to `prompt` only after an
extension command finishes, so an `await custom()` never replies (Paseo
traced this into Pi's `agent-session.js:1658-1663`). Mitigations:

- **Treat the reply as an event; never wait on it.** T3, `adapter.ts:2683-2686`: "Pi acks `prompt` only after slash-command expansion completes, and extension commands may block on user dialogs indefinitely."
- **Stop works while a send is unacknowledged:** `abort` + cancel the open dialogs (Orca `rpc-session-adapter.ts:147-159`). T3 escalates to killing the process group, with a 15 s cap.
- **Cancel leftover dialogs** whenever a run settles (Orca `rpc-session.ts:119`). Auto-cancel unknown `extension_ui_request` methods (Orca `rpc-dialog-callbacks.ts:26-33`).
- **Honour a dialog's `timeout`** (T3's synthetic expiry event; Orca ignores it).
- **Deadline:** Paseo gives up waiting for the reply after 60 s. Its bridge commands get 30 s.
- **No extensions for helper processes:** T3 passes `--no-extensions --no-tools` to every throwaway Pi it starts, after the user's args.

**Herdr solution.** All of the above, plus what nobody does:
- After a `/command` with no reply, no `agent_start` and no `extension_ui_request` within ~10 s, show "this command may need Pi's terminal UI", with **Open in TUI** (the #10 handoff) and **Stop**.
- Optionally keep a small list of commands known to call `custom()`: today `/mcp`, two herdsman pickers and one workflows panel. Mark them "opens in terminal" in `/` autocomplete.

## 3. Extension decoration and custom renderers

- **`setStatus`/`setWidget`/`setTitle` are dropped by all three.**
  - Orca: `const DECORATION = new Set([...])`, then `return` (`rpc-dialog-callbacks.ts:11,23`).
  - T3 logs "Ignoring pi extension UI update" (`adapter.ts:1326-1333`).
  - Paseo's docs say "intentionally ignored … unless Paseo grows first-class UI".
- **`notify`:** a row in Paseo and T3. T3 drops it outside a turn and loses the level. Neither strips ANSI.
- **ANSI parsing exists, for command output only:** T3's `packages/shared/src/terminalOutput.ts` is a small SGR emulator that turns escapes into styled spans.
- **Per-extension renderers:** Paseo has an adapter registry of 10 (`pi/extensions/registry.ts:12-23`). Its hooks are `mapToolCall`, `mapCustomMessage`, `mapDialog` and `onToolStart`, plus an injected `runtimeBridge` snippet. T3 has one (`subagent`). Orca has none: unknown tools become a generic `other` row (text only, `details` ignored).
- **Custom messages:** Paseo renders `role:"custom"` (`pi.sendMessage`) as a plain-text card. Orca's live path drops it.

**Herdr solution (better than all three, for little cost):**
- The host keeps the **last value per key** for `setStatus`, `setWidget` and `setTitle` and sends it to the mod as state.
- It converts SGR codes to spans (port T3's `terminalOutput.ts`) and strips any other escape sequences.
- The mod shows a status strip under the composer and a widget area, and uses `setTitle` as the tab name.
- `notify` becomes a toast or row, with its level, even outside a turn.
- Keep Paseo's adapter-registry shape (`toolName → renderer`, generic fallback with the raw `details` behind an expander) and render `display:true` custom messages.

## 4. Pi version churn; composer features

**Versions**
- **Minimum version:**
  - T3: `MINIMUM_PI_VERSION = "0.80.5"` ("get_entries arrived in 0.80.3 and agent_settled … 0.80.4", `status.ts:60-69`), plus per-feature gates (`pi auth check` ≥0.84.1).
  - Orca: minimum `0.84.0`, re-probed **on every launch** "because the PATH binary may have changed" (`rpc-launch-resolution.ts:48-49,198-206`).
  - Paseo: no minimum. It probes by matching "Unknown command: X" errors, and every shim is tagged `COMPAT(...)`.
- **Recorded fixtures:**
  - T3: `apps/server/scripts/record-pi-rpc-replay-fixture.ts` records real RPC hermetically into `pi_transcript.ndjson` with the `piVersion` (8 scenarios: steering, compaction, rollback, interrupt mid-tool…).
  - Orca: scrubbed Pi 1.0.4/1.3.0 captures replayed through its real turn reducer (`rpc-capture-replay.test.ts`).
- **Drift warning:** Paseo's fixtures are pinned to Pi 0.84 and don't model 1.5's `disposition`. T3 ignores `disposition`. Orca reads it.

**Composer:** every app built these. None has an external `$EDITOR`.
- **History:** Up/Down on an empty draft walks the sent prompts, read from the transcript, not a separate store (Orca, Paseo, T3).
- **`@file`:** the server runs the search (T3 `git ls-files`, Paseo directory suggestions, Orca the workspace quick-open index), never the client.
- **`/` menu:** host built-ins merged with `get_commands`, cached per cwd (T3 refreshes it with a throwaway `--no-session` Pi). Filter the host's own bridge commands out; Paseo forgets to.
- **Drafts:** persisted per chat.

**Herdr solution.**
- Floor `>=1.5` (we rely on `disposition`), probed at every host start.
- T3-style fixture recorder, replayed through the host's normalizer in CI.
- Composer:
  - `Textarea` with inline tokens (`InputContent.tokens`, `gpui-kit.d.ts:20672-20674`) for `@file` and `skill` chips.
  - The host serves file search (the mod's `exec` is too slow per keystroke).
  - History from the transcript, drafts in mod storage.
- `$EDITOR`: open a herdr-core terminal on a temp file and read it back when it exits. Herdr can offer this; the others can't.

## 5. Images

- **Paste/drop/picker → local file → base64 `prompt.images[]`.**
  - Orca sniffs magic bytes, rejects URLs, caps at 5 MiB/image, 20 images, 20 MiB total plus the RPC line limit (`rpc-prompt.ts:15-18,55-124`).
  - T3 caps at 10 MiB/image and 80 MiB/message, and downscales to a 2000 px longest edge.
  - Paseo sends images only if `model.input` includes `"image"`. Otherwise it saves a file and sends `[Image available at: <path>]`.
- **Tool-result images:**
  - T3: at most 8, base64 stripped from the wire and served by reference.
  - Paseo: pulled out before the result is stringified.
  - Orca: dropped.

**Herdr solution.**
- The mod clipboard is text-only (`gpui-kit.d.ts:345-348`; image paste is frame-only, `herdr.d.ts:314`). But `Input`/`Textarea` emit **`paste_other`** when "a paste found no text (an image, say)" (`gpui-kit.d.ts:21340,21409`).
- On that event, the mod asks the host to save the clipboard image. The command is `osascript … write (the clipboard as «class PNGf»)`; no `pngpaste` needed.
- Drag-drop gives paths via `.on_drop` (`event.paths`).
- The host applies Orca's checks and T3's downscale, plus Paseo's text-only fallback.
- Tool-result images: the host writes them under `~/.config/herdr-app/…` so the mod can `image()` them.

## 6. Agent status and inter-agent messaging

- **Status:**
  - Orca: any pending approval/question → `attention`; owed work → `working`; else `idle`.
  - T3: priority `approval > input > waiting > working > failed > ready`.
  - All three confirm idle from `agent_settled` and/or a `get_state` probe.
- **Notifications:** Paseo suppresses them when a visible client is focused on that agent; sends push only if no client was active in 3 min.
- **Other agents → GUI agent:**
  - Orca: the `orca orchestration send` CLI finds the runtime through a 0600 metadata file and delivers "each message whole, as its own ordinary message: the chat's queue holds it behind running work". The `operationId` makes retries idempotent and the sender shows as `from`. Reads come from a bounded journal served in PTY-style pages (`structured-worker-terminal-read.ts`).
  - T3: `t3 thread send|show --wait` and an OAuth-gated MCP (`t3_thread_send/read/wait`). `send` never interrupts.
  - Paseo: `paseo send/logs/attach/wait` and an agent MCP.

**Herdr solution.** Herdr already has the CLI: `hc`. So the host must
*impersonate a well-behaved hc agent*:
- **Status:** emit OSC 7501 (`working/blocked/done/idle/error`, the same states Pi's TUI reports, `docs/terminal-setup.md`) from RPC state. Herdr's sidebar, sounds and toasts then work unchanged.
- **Input:** treat a line pasted on the host's PTY stdin (`hc send t7 "…"`) as a queued `prompt` (or `steer` while running), tagged with the sender (the `<hc from=…>` prefix). This keeps herdsman and child-agent reports working.
- **Reading:** print a plain transcript to the PTY so `hc read` stays meaningful.
- **Click routing:** clone the stock `agents` mod (`mod.clone`). Its click handler is `run("pane.focus", {pane: a.pane})` (`mods/agents/main.js:301,345`). Route terminals labelled `pi-chat.pane=<id>` to the chat pane.

## 7. Long transcripts

- **Coalescing:**
  - Host side: Paseo 60 ms (`agent-stream-coalescer.ts:4`), Orca 60 ms, T3 50 ms.
  - Client side: Orca and Paseo re-batch at 48 ms or once per frame.
  - Orca sends *cursor-qualified snapshots, not deltas*, so duplicate batches converge.
- **Size limits:** Paseo caps tool items at 64 KiB and other items at 256 KiB. T3 omits tool bodies on the wire and fetches them on expand. History pages are about 1 MiB / 500 rows.
- **Virtualization:**
  - Lists: TanStack (Orca), LegendList (T3), windowed list (Paseo).
  - Stick-to-bottom: Orca uses a 48 px threshold ("never reattach a parked reader from geometry alone"); Paseo's modes are `sticky-bottom|detached`.
  - Collapse state: Orca keeps disclosure state outside the virtualized rows.
- **Streaming markdown:** T3 re-parses only the last block (`markdownStreamBlocks.ts`).
- **Find and copy:** Paseo runs find in the server; T3 and Orca search the DOM. Copy is per message everywhere.

**Herdr solution.**
- The host coalesces at about 50 ms and sends bounded snapshots. That also covers Herdr's rule that every `cx.notify()` redraws the whole window.
- The mod renders the last N turns and pages older ones from the host.
- Rows in Herdr's virtual lists can't have handlers (`gpui-kit.d.ts:20307`), so clickable tool cards use an own visible-rows scroller like herdr-gitview's `scroller.js`, with collapse state kept outside the rows.
- Find runs in the host. Copy is per message, "copy as markdown".

## 8. Remote machines

- **Paseo:** one daemon per machine. Desktop reaches it through `ssh -T -o BatchMode=yes … -W 127.0.0.1:<port> host` used as a stdio tunnel (`ssh-transport.ts:63-82`), or an E2EE relay. It reconnects with backoff and catches up by cursor.
- **T3:** an ordered list of routes, each checked before credentials are sent; jittered backoff; dead-socket probes (3 s on LAN, 15 s elsewhere); SSH-launched servers.
- **Orca:** Pi chat runs only on the local machine. Remote means running `orca serve` on that machine and pairing to it. Liveness: ping every 10 s, declare dead after 25 s.

**Herdr solution.**
- Run the host on the remote machine with `hc run --on <machine>`, next to Pi and its session files.
- **`hc exec` can't be the tunnel.** I checked: it buffers stdout *and* `-i` stdin until the command exits.
- Instead, a local herdr-core terminal runs an SSH forward (Paseo's `-W` arguments, or `-N -L`) to the host's port. `m1` is an SSH machine (`hc machine ls`). The mod connects to the local end.
- For `--via` machines (no SSH), fall back to long-polling: `hc exec --on m -- pi-chat-host poll --since <cursor>`, each call under 30 s.
- Copy Orca's 10 s ping / 25 s dead timeout and the cursor catch-up.

## 9. Crashes and supervision

- **Process teardown:**
  - T3 spawns Pi detached (its own process group) and registers a finalizer right away. Teardown is SIGTERM, 1 s, then SIGKILL to the *group*, checking liveness before each signal because PIDs get reused (`rpc.ts:171-237`).
  - Orca adds a detached supervisor that polls `ppid` every 100 ms, so a dead owner still gets its child reaped.
- **Crash mid-run:** the turn ends as "Pi process exited unexpectedly" (T3) or `session.ended {state:'interrupted'}` (Orca). Unconfirmed sends become `unknown`. The next send resumes with `--session`.
  - **Paseo gap:** an exit *between* turns isn't surfaced.
- **Restart:** T3 and Orca offer "continue where you left off" as a **new** prompt, never a replay. T3 caps it at 3 in 5 min. Orca writes resume markers (`quit|update`) at teardown.

**Herdr solution.** herdr-core already supervises the terminal, which
outlives the window. The host spawns Pi in its own process group with T3's
checked teardown and surfaces *any* exit, closing Paseo's gap. It writes
`{pid, sessionFile}` so a restarted host can find a leftover Pi, and offers
Orca/T3-style "Continue".

## 10. Session-file concurrency and GUI↔terminal handoff

- **Pi has no writer lock.** Orca says so in a comment: "Pi has no writer lock; terminal writes are safe only while chat Pi is stopped" (`rpc-history-catch-up.ts:42`). T3 and Paseo have none either.
- **Orca's guard is the best of the three:**
  - `assertLegacyAiVaultResumeCommandAllowed` parses every shell command Orca itself launches or sends.
  - It refuses `pi --session <owned file>` and also a bare `pi -c/-r` ("A targetless resume could open any owned session", `structured-session-ownership.ts:224-241`).
  - One writer per chat is decided fail-closed by PID + start time + spawn token.
  - Terminal→chat waits for the terminal Pi's *proven exit* (30 s timeout) and checks the file's header `id`/`cwd`.
  - Chat→terminal always **forks** ("This chat stays unchanged").
  - On reopen, writes made outside are imported behind a "continued outside" divider.
  - **Limit:** it can't see commands a user types into a shell.
- **Paseo:** closes the old Pi *before* reloading. Its "Copy resume command" is unsafe while the GUI's Pi is alive.

**Herdr solution (stronger than Orca's):**
1. The host takes a sidecar lock `<session>.jsonl.herdr-lock` (pid, start time, terminal address).
2. A tiny **lock-aware Pi extension** in the user's normal Pi config checks it on `session_start` and refuses or warns. Since every TUI Pi loads it, this also covers commands typed by hand, which Orca can't see. The host's own child skips the check via an env var.
3. Herdr runs both sides, so it can sequence the handoff: GUI→TUI = wait until idle → `abort` if needed → stop the child → release the lock → `hc run … pi --session <file>`. TUI→GUI = wait for that terminal to exit (`hc wait`) → retake the lock → start the child with `--session`.
4. On reopen, diff `get_entries {since}` (Pi's durable cursor) and add Orca's "continued outside" divider.

## 11. Turns the user didn't start

- **Paseo:** `turn_started` with no foreground turn gets `turnId = autonomous-<uuid>` (`agent-manager.ts:527-533`) and is shown like any other turn: "Every canonical run owns a visible turn, including heartbeats and agent notifications".
- **Orca:** opens a host-minted turn, and user echoes consume queued sends. But it *drops* `role:custom` messages live, so a wake's `subagent-notify` text isn't drawn.
- **T3:** buffers it as a "wake" and offers it to a continuation queue. With no handler it kills Pi: "…stopped to prevent invisible tool execution" (`adapter.ts:84-87`).

**Herdr solution.** Paseo's approach: adopt and render, labelled by cause
("started by extension / queued follow-up / subagent"), and render
`display:true` custom messages. User echoes are already in the RPC stream:
`message_start` with `role:"user"` carries the text (seen in
the [RPC probe](pi-gui-chat.md#probe-against-the-authors-setup)). This matters here because pi-workflows,
herdsman and monitors all start turns on their own.

## 12. Local transport security

- **Orca:** a Unix socket chmod 0600 plus `randomBytes(24)` sent with every request, published in a 0600 file inside a 0700 dir. The comparison is a plain `===` and there is no Origin check on WebSocket.
- **Paseo:** binds `127.0.0.1`, keeps a Host-header allowlist (a DNS-rebinding guard) and checks Origin. Auth is an *optional* password or a per-run 0600 `local-credential`.
- **T3:** an HMAC bootstrap token, short-lived WebSocket tickets, a scope on every RPC, and a per-Pi-session MCP token revoked on release.

**Herdr solution.**
- Mods can't dial Unix sockets (`net.connect(host, port)` only), so: bind `127.0.0.1:0`, write `{port, token}` (256-bit) to a 0600 file, and have the mod send the token as its first frame. Compare in constant time; no data before auth.
- The host's port label (`hc label`) stays discovery-only; the token never goes in a label.
- If messaging tools are added, give each agent a narrower token (T3).

---

## What's still open after this research

1. **Hung `custom()` (#2)** is mitigated, not solved. The real fix belongs in
   Pi: have RPC mode reject `custom()` loudly, or reply to `prompt` before
   running an extension command. That's worth an upstream issue.
2. **Spike-only questions, unchanged from the first doc:**
   - Can GPUI keep up with streaming markdown at 50 ms batches without the whole-window redraw becoming too costly?
   - Is a cloned `agents` mod enough to route clicks to the chat pane?
   - Does `osascript` reliably save pasted screenshots?
3. **Herdr may need small upstream help** for remote spaces reached
   through `--via` machines, where there's no SSH to forward through.
