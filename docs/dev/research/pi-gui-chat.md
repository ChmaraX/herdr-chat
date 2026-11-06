# Pi as a native GUI chat in Herdr: feasibility research

**Question.** Herdr (the GPUI desktop app) currently shows Pi as a TUI in a
terminal pane. Can it show Pi as a real GUI chat (streamed markdown, tool-call
cards, diffs, approvals, a composer) instead, and how did Orca, T3 Code and
Paseo do it?

**Short answer.** Yes. Pi ships a protocol built for exactly this
(`pi --mode rpc`), and all three reference apps use it. None of them scrape
the TUI. Herdr mods can draw everything a chat needs and can hold a
streaming TCP/WebSocket connection. They cannot own a long-lived child
process, though, so Pi needs a small **host** process. A herdr-core terminal
is a good home for it: it survives the window closing, it shows up in the
agents list, and other agents can still `hc send` / `hc read` it. The one
real design choice is whether the GUI *replaces* the TUI (headless RPC,
which is what all three apps do) or sits *beside* a live TUI on the same
process (a bridge extension; nobody does this).

Sources:
- Pi 1.5.0 docs (the `docs/` folder of the installed `@earendil-works/pi-coding-agent` package).
- Herdr's generated `~/.config/herdr-app/{AGENTS.md,herdr.d.ts,gpui-kit.d.ts}`.
- Source of the three apps, at the commits in [`sources/COMMITS.txt`](sources/COMMITS.txt).
- A live RPC probe against the author's Pi setup ([`rpc-probe/probe.mjs`](rpc-probe/probe.mjs)). Its recording isn't kept: it held that setup's whole system prompt.
- Per-app deep dives with `path:line` citations, in [`sources/`](sources/).

---

## 1. What Pi offers a GUI (verified)

| Interface | What it is | Fit for Herdr |
|---|---|---|
| Interactive (`pi`) | The TUI | Today's setup |
| `--mode json` | One-shot JSONL event stream, then exit | No: it can't take more input |
| **`--mode rpc`** | Long-lived JSONL over stdin/stdout: commands → responses + session events + extension-UI sub-protocol | **Yes.** Docs list "IDEs, and custom user interfaces" as the use case (`docs/rpc.md:3`) |
| SDK (`createAgentSession`) | In-process Node/Bun | Possible, but the CLI's built-in extensions (codemode, MCP, tool_search) must be added by hand (`docs/sdk.md` "Configuring a session") |

What RPC gives you (`docs/rpc-commands.md`, `docs/json.md`, `docs/rpc-extension-ui.md`):

- **Prompting:** `prompt` takes `images[]` and `streamingBehavior: steer|followUp`. Its response carries `disposition: started|queued|handled`. There are also `steer`, `follow_up`, `abort` and `clear_queue`. `clear_queue` followed by `abort` is the documented way to build Esc.
- **State and config:** `get_state`, `get_messages`, `set_model`, `get_available_models`, `set_thinking_level`, `compact`, `get_session_stats`, and `get_commands`, which lists extension commands, prompt templates and skills.
- **Sessions:** `new_session`, `switch_session {sessionPath}`, `fork {entryId}`, `clone`, `get_tree`, `set_session_name`. `get_entries {since}` treats an entry id as a **durable cursor** for catching up after a reconnect.
- **Events:**
  - `message_start/update/end`. Updates are delta-only on the wire: `text_*`, `thinking_*`, `toolcall_*`.
  - `tool_execution_start/update/end`, which includes `durationMs`.
  - `turn_*`, `agent_start/end`, and **`agent_settled`**, the only "Pi won't continue on its own" signal.
  - `queue_update`, `compaction_*`, `auto_retry_*`, `entry_appended`, `extension_error`.
- **Extension UI:** `select/confirm/input/editor` arrive as blocking requests that the client answers with `extension_ui_response`. `notify/setStatus/setWidget/setTitle/set_editor_text` are fire-and-forget.
- **Lost in RPC** (`docs/rpc-extension-ui.md` "Limitations"): `ctx.ui.custom()` returns `undefined`, and component widgets, footers, headers, custom editors and theme switching do nothing. Built-in TUI commands (`/settings`, `/tree`, `/login`, `/hotkeys`…) are not in `get_commands` and won't run through `prompt`.
- **Framing pitfall:** split only on LF. Node's `readline` also splits on U+2028/U+2029 and corrupts records (`docs/rpc.md` "Framing").

### Probe against the author's setup

[`rpc-probe/probe.mjs`](rpc-probe/probe.mjs) started
`pi --mode rpc --no-session --model anthropic/claude-haiku-4-5` with the full
user extension set and recorded every record (78 records; the recording
isn't kept). It ran
`get_state` and `get_commands`, then a prompt that calls bash. Results:

- All 13 packages loaded and stderr was empty. `get_commands` returned 162 entries: 50 extension commands, 5 prompt templates, 107 skills.
- First record about 1.7 s after spawn. From prompt to `agent_settled`: 2.7 s.
- The bash tool streams `tool_execution_update` records. `tool_execution_end.result.structuredContent` carries `{output, exit_code, truncated, wall_time_seconds}`, so a shell card gets its exit code without parsing text.
- 23 `extension_ui_request` records arrived without a prompt asking for them (1 notify, 12 setStatus, 10 setWidget). They came from plannotator, queue-steer, mcp, cursor, cached-compaction and fff.
- Status text contains **raw ANSI** (`\x1b[38;2;…m🔌 MCP: 6 servers enabled`). The GUI has to strip ANSI or map it to theme colors.
- `entry_appended` delivered pi-activity-feed's custom entries. Its TUI cards are inert in RPC mode, which is expected, since the GUI draws its own cards.

How many of the installed extensions call the API that breaks in RPC
(`ctx.ui.custom()`, counted with `rg`): pi-mcp-adapter 5 (its `/mcp` panels;
its own code checks whether the mode can show an overlay,
`pi-mcp-adapter/commands.ts:46`), pi-herdsman 2, pi-workflows 1, everything
else 0. Dialog-based flows (`select/confirm/input/editor`) do survive RPC.

## 2. How Orca, T3 Code and Paseo do it

Details and citations are in `sources/findings-*.md`. I re-checked the
launch lines myself: Orca `src/main/pi/rpc-launch.ts:106-112`, T3
`packages/provider-pi/src/server/mcpInjection.ts:262-268`, Paseo
`packages/server/src/server/agent/providers/pi/runtime.ts:123`.

| | Orca (Electron) | T3 Code (server + web) | Paseo (daemon + Expo) |
|---|---|---|---|
| Launch | `pi --mode rpc`, rejects caller `--mode/--session/--fork`, **full access only** (`rpc-launch.ts:59`) | `pi --mode rpc`, reserved flags filtered | `pi --mode rpc` |
| Owner of the Pi process | Electron main | Server | Daemon |
| UI transport | Runtime RPC (WebSocket/long-poll) to renderer and phone | WebSocket to an event-sourced projection | One WebSocket, many clients |
| Normalized model | `ProviderTimelineEvent` → durable journal (`message, tool-call, diff, approval, question, status, turn`) | `OrchestrationV2TurnItem` union (`command_execution, file_change, dynamic_tool, reasoning, approval_request…`) | `AgentTimelineItem` + typed `ToolCallDetail` (`shell, read, edit, write, search, sub_agent, todo, unknown`) |
| Unknown or MCP tools | Generic `other` row (text blocks only; `details` ignored); `mcp__server__tool` humanized | `dynamic_tool` | `unknown` |
| Approvals | Pi has none natively. `confirm` → approval card; `select/input/editor` → question card; compare-and-set so only one client's answer counts | **Injected extension's `tool_call` hook** enforces permission modes via `ctx.ui.confirm` | Dialogs → "question" permissions |
| Decoration (`notify/setStatus/setWidget`) | Dropped (`rpc-dialog-callbacks.ts:11`) | `notify` → system notice | `notify` shown or ignored |
| Steer | Automatic: `working ? 'steer' : 'followUp'` (`rpc-turns.ts:66`) | `prompt {streamingBehavior:"steer"}` | Native `steer` RPC |
| Turn done | `agent_settled` + `get_state` idle probe | `agent_settled` + "settle probe" (`get_state` re-injected) | Waits for `agent_settled`; `agent_end` isn't final |
| History | Pi session file + `get_entries` branch walk, plus its own journal and a resume cursor | `switch_session` by file path; `--fork` CLI for forks | Reads the Pi JSONL directly; `--session <file>` to resume |
| Injected Pi extension | No (its "visuals" skill is for other agents; structured Pi explicitly gets none, `rpc-launch.ts:28-34`) | Yes: permissions, its own MCP server, system prompt, skill chips | Yes: system prompt, entry capture for rewind, MCP; replies hidden in `notify` as base64 markers |
| TUI for the same session | Separate surface; they meet through the **same session file** (`rpc-launch.ts:56`), not a live handoff | No | Imports terminal-started sessions; no live handoff |

What all three agree on, which makes it safe to copy:

1. Run `pi --mode rpc`, owned by a long-lived process, never by the view. The
   view is a client that can reconnect.
2. Pi's session file is the shared identity: `--session <file>` resumes,
   `--fork <file>` branches. A GUI session and a terminal session can hand
   off through it.
3. Normalize into one timeline: user, assistant text, reasoning, tool call
   (running → done/failed, with a typed detail per tool and a generic
   fallback), question/approval, notice, compaction, retry.
4. Accumulate text and reasoning deltas per `(message ordinal, contentIndex)`
   and flush on a timer. T3 uses 50 ms. Replace the result with the `*_end`
   or `message_end` content when it arrives.
5. A turn is finished only at `agent_settled`, never at `agent_end`, because
   retries and compaction can follow `agent_end`.
6. Cap record sizes and drop or trim oversized ones rather than buffering
   without limit (T3 `rpc.ts:91-133`, Orca `rpc-protocol.ts:63-95`).
7. Extension dialogs are the only approval UX Pi has. Build question and
   approval cards for them.

Two things the apps hit that Pi 1.5 may have since fixed (to verify in the
spike): T3 and Orca poll `get_state` to confirm idle, and T3 matches
command-only prompts that never settle. Pi 1.5's `prompt` response now says
`disposition: "handled"` when no run starts (`docs/rpc.md` "Run lifecycle").
T3 doesn't read `disposition` at all (`rg disposition` in
`packages/provider-pi` finds nothing).

## 3. What Herdr gives a mod (verified in the type files)

**Can do:**
- **Streaming sockets:** `import net from "net"` gives `connect(host, port)` → `read()/write()/close()`, and `import { WebSocket } from "websocket"` gives a client (`gpui-kit.d.ts:22139-22167`). Reads run in a `cx.spawn` loop.
- **Rich text:**
  - `TextView.markdown(id, text)` (`gpui-kit.d.ts:20707`).
  - `EditorState`/`Editor` for read-only, syntax-highlighted code and diffs (`:21437-21459`).
  - `TextareaState`/`Textarea` and `InputState`/`Input` for the composer.
  - `Collapsible`, `Accordion`, `Popover`, `Tabs`, `Progress`.
- **Long lists:** `list()` handles rows of unknown height, measured lazily, for a mixed transcript. `uniform_list` and `v_virtual_list` have `scroll_to_bottom()` (`:20298-20360`, `:21305`).
- **App integration:**
  - `openOverlay` for dialogs and popups, and `notify` for toasts.
  - `shared` state, `nextCommand` keys, `focusable` panes.
  - `run("pane.split", {mod, props})` and `tab.new {mod}`, so a chat can be a pane or a whole tab.
  - `terminals()`, with labels, is live data.
  - `hc([...])`.

**Can't do:**
- **Own a process:** `exec` has a 30 s limit, an 8 MiB output cap and **no stdin** (`herdr.d.ts:10-13`, `exec` at line 13; gitview RECIPE "Watch out"). There's also no `setTimeout`, no webview/DOM and no Unix sockets (`net` is host and port only).
- **Rows with handlers in virtual lists** ("no handlers and no retained state inside it", `gpui-kit.d.ts:20307`). herdr-gitview hit this and wrote its own scroller that draws only the visible rows ([herdr-gitview](https://github.com/ChmaraX/herdr-gitview)'s `herdr-app/RECIPE.md`, "Watch out"). Expandable tool cards need the same.
- **Cheap redraws:** every `cx.notify()` redraws the whole window (`AGENTS.md` "Animate natively"). Streaming has to be batched, about one notify per 30–60 ms, never one per delta.
- **Inline images from base64:** `image()` takes paths under `~/.config/herdr-app`, so tool-result images must be written to a file first. `fs` writes are allowed under that folder.

**herdr-core terminals as the host's home** (`hc --skill`, `AGENTS.md` "The model"):
- They outlive the window, and `--keep` recovers with a shell, never by re-running.
- They run on other machines with `--on m`.
- Labels are visible to mods through `terminals()`.
- A terminal that reports **OSC 7501** is an *agent*: it gets status, attention sounds, the agents list and `hc wait`. Pi already emits OSC 7501 (`docs/terminal-setup.md` "Program status"), and a host can emit the same thing for its RPC child.
- `hc send <t>` pastes text onto its stdin, and `hc read <t>` reads its screen.

## 4. Architecture options

### A. Headless RPC host (what all three apps do)

```
herdr-core terminal (label pi-chat.port, OSC 7501)
  └─ pi-chat-host (Node)  ──spawns──▶  pi --mode rpc [--session <file>]
        │ loopback TCP, token, JSONL                (stdin/stdout)
        ▼
  mods/pi-chat pane  (timeline, composer, dialogs, pickers)
```

- The host relays Pi's own RPC records almost verbatim and adds `hello`,
  `snapshot` (the current run's records) and a cursor, so a reopened pane
  catches up. History comes from `get_messages` or `get_entries {since}`.
- The host keeps the hc contract alive:
  - It emits OSC 7501 from Pi's events, so Herdr's agents list and sounds work.
  - It treats a line that arrives on its PTY stdin (`hc send t7 "…"`) as a `prompt`/`steer`.
  - It prints a plain-text transcript so `hc read` stays useful.

  Other agents can then keep delegating to it exactly as they do today.
- **Pros:** fully GUI, the path every reference app proved out, a clean
  protocol, and it can run on remote machines (see open questions).
- **Cons:**
  - The `ctx.ui.custom()` panels are lost (`/mcp`, two herdsman pickers, one workflows UI).
  - Built-in TUI commands (`/settings`, `/tree`, `/login`, `/resume`, the model picker) must be rebuilt from RPC commands (`get_available_models`, `get_tree`, `fork`, `switch_session`). There is no RPC for `/settings` or `/login`.
  - Escape hatch: **"Open in terminal"** stops the host and runs `pi --session <file>` in the same tab. "Back to chat" restarts the host on that file. This is the session-file handoff Orca relies on.

### B. Live TUI and GUI on one process (bridge extension)

Run ordinary interactive `pi` in its terminal, plus a Pi extension that opens
the same loopback protocol:

- **Out:** it forwards `pi.on(...)` events. The SDK events include cumulative `partial` snapshots, which should be stripped down to the deltas.
- **In:** it maps commands to `pi.sendUserMessage(text, {deliverAs, expandPromptTemplates})`, `ctx.abort()`, `pi.setModel()` and `pi.setThinkingLevel()`. Operations that need command context (`newSession`, `fork`, `navigateTree`) can go through a hidden `/herdr-chat-*` command, which `sendUserMessage(..., {expandPromptTemplates: true})` dispatches (`docs/extensions.md` "pi.sendUserMessage").

- **Pros:**
  - Zero feature loss: `/settings`, `/tree`, `/mcp`, plannotator and herdsman all keep working in the TUI next to the GUI.
  - The existing Herdr integration is unchanged: the OSC status Pi already emits, `hc send`, sub-agents.
  - It's unique to Herdr, since Herdr is a terminal host first. None of the three apps can do this.
- **Cons:**
  - Other extensions' dialogs render **only in the TUI**. The GUI can only notice them via `ui_prompt_start/end` and offer "answer in terminal".
  - There are two places to type.
  - The extension API isn't a remote-control API, so every gap is ours to maintain.
  - A bug in the bridge runs inside Pi's process.

### C. Own SDK host (`createAgentSession`)

Maximum control, but we'd re-implement what the CLI already wires up
(built-in MCP, codemode, tool_search, trust, resources) and follow Pi's
internals across releases. Not recommended. RPC already exposes what a GUI
needs.

## 5. Recommendation

1. **Pick the protocol first:** Pi's own RPC records plus three host records
   (`hello`, `snapshot`, `cursor`). Both A and B can serve it, so the GUI
   doesn't depend on that choice.
2. **Build A first**, because it matches "fully GUI" and is proven three
   times. Put in it:
   - the host: spawn and supervise, relay with LF framing and size caps, a token, OSC 7501, `hc send`/`hc read` compatibility;
   - the timeline: user, assistant markdown, reasoning collapsible, tool cards (bash with exit code and streamed output, read, edit/write as a diff in `Editor`, generic JSON for MCP/unknown);
   - question and approval cards for dialogs;
   - a status/widget strip with ANSI stripped;
   - composer controls: steer while working / follow-up when idle, Esc = `clear_queue` + `abort`, model and thinking pickers, `/` autocomplete from `get_commands`;
   - "Open in terminal" through the session file.
3. **Try B afterwards** as an opt-in "TUI-backed chat" for people who live in
   TUI-only extensions. It reuses the same mod.

## 6. Risks and how the reference apps handle them

Each risk of option A, with what Orca, T3 Code and Paseo built for it and
the Herdr plan: [pi-gui-chat-problems.md](pi-gui-chat-problems.md).

## 7. Open questions for a spike

- **Redraw cost:** can a mod stream about 50 tokens/s through
  `TextView.markdown` with 50 ms batches without visible lag or battery
  drain? (`herdr-app check` doesn't run async tasks, so this needs the
  running app or a sandbox home.)
- **Agent identity:** if the host terminal has no pane (parked) and only the
  chat pane is visible, where do the agents list and `agent.focus` go? Herdr
  may need a way to say "this mod pane presents terminal t7". Otherwise, keep
  the host in a tiny pane next to the chat.
- **Remote spaces:** a mod's `net.connect` reaches this machine. For a host
  on `vps`, the options are:
  - long-polling `hc exec --on vps -- pi-chat-host poll --since <cursor>` (each call under 30 s), which works over herdr-core's existing connection;
  - asking Herdr for a stream or port-forward capability for mods. hc's API already has attach channels (`hc schema` → `AttachResult`).
- **Settle:** is `disposition` plus `agent_settled` enough in Pi 1.5, or do
  we still need T3's and Orca's `get_state` idle probe?
- **Permissions:** like Orca, start with full access. Add T3-style
  permission modes (a `tool_call` hook → `ctx.ui.confirm`) only if wanted.
