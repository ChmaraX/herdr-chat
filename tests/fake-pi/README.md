# fake-pi

A scriptable stand-in for `pi --mode rpc`. Node, no dependencies. It speaks
Pi's RPC protocol on stdin/stdout: LF-framed JSONL, never split on
U+2028/U+2029. Use it wherever the real host would start `pi`:

```sh
FAKE_PI_SCENARIO=tests/fake-pi/scenarios/tools.json \
  bin/pi-chat-host serve --chat c-test --cwd /tmp/x --state-dir /tmp/s --pi tests/fake-pi/fake-pi.mjs
```

## Command line and environment

- Pi's normal flags are accepted and mostly ignored. It reads these:
  - `--session <file>` loads that Pi session file if it exists. Otherwise it starts a session at that path, seeded with the scenario's `history`.
  - `--session-dir <dir>` is where new session files go. The default is `$TMPDIR/fake-pi-sessions/--<cwd>--/`.
  - `--no-session` means no session file.
  - `--model provider/id`, `--thinking <level>` and `--name <name>` set the start state.
  - `--version` prints `1.5.0` and exits.
- `FAKE_PI_SCENARIO=<file.json>`: the script (format below). Without it, every prompt gets the answer `ok: <prompt>`.
- `FAKE_PI_REPLAY=<fixture.jsonl>`: replay a recorded real session instead (see "Replay mode").
- `FAKE_PI_SPEED=<n>`: divides every wait by `n`, including the `timeout` a dialog advertises. Scenarios are written at real speed; tests use 1–5.
- `PI_CHAT_HANDOFF=<file>` (outside the host, without `PI_CHAT_HOST=1`): like the herdr-chat-lock extension in a hand-off TUI, it writes `{sessionFile, pid, at}` there whenever it opens a session (start, `new_session`, `switch_session`).
- `FAKE_PI_LOG=<file>`: appends every command fake-pi receives, one JSON per line, after a first `{"type":"_start", argv, env: {PI_CHAT_HOST, HC_TERMINAL_ID}, cwd}` line. Use it to assert what the host sent, such as `clear_queue` before `abort`.

Like Pi, fake-pi persists messages to its session file (a session header,
then `message` entries, plus `session_info`, `model_change` and
`thinking_level_change`). So a restarted fake-pi with `--session` resumes the
conversation, and `get_messages` returns it.

## Commands it answers

`prompt` (with `images` and `streamingBehavior`), `steer`, `follow_up`,
`abort`, `clear_queue`, `get_state`, `get_messages`, `get_commands`,
`get_available_models`, `set_model`, `set_thinking_level`,
`get_session_stats`, `compact`, `new_session`, `switch_session`,
`set_session_name`, `get_last_assistant_text`, `extension_ui_response`.
Anything else gets `{"success":false,"error":"Unknown command: …"}`.

Behaviour that mirrors Pi 1.5:
- The `prompt` reply comes **before** `agent_start`, with `disposition`:
  - `started` for a new run;
  - `queued` with `streamingBehavior` while a run is active (also emits `queue_update`);
  - `handled` for an extension command, sent **only after the command's steps finish**. A command that opens a dialog gets its reply only once the dialog is answered.
  - A prompt during a run without `streamingBehavior` fails with "Agent is already processing…".
- A run is `agent_start`, `turn_start`, the user message (`message_start`/`message_end`, `role: "user"`), the script's steps, `turn_end`, `agent_end`, `agent_settled {aborted}`.
- Steering is delivered at the next turn: `queue_update` with the queue emptied, then a user message. The next turn starts when an `assistant` step follows a tool call. Steering left at the end of a run, then follow-ups, each get another turn in the same run, answered by the next matching prompt script.
- `abort` interrupts the current step (waits, streaming, a running tool, a dialog). An open tool ends with `isError: true` and "Command aborted"; a streaming message ends with `stopReason: "aborted"`. After tool calls, like Pi 1.5, an empty assistant message follows with `stopReason: "error"` and `errorMessage: "This operation was aborted"`. Then come `turn_end`, `agent_end` and `agent_settled {aborted:true}`. The `abort` reply comes after the settle. Like Pi, messages still queued after an abort start a new run, which is why a client sends `clear_queue` first.
- `compact` emits `compaction_start {reason:"manual"}` and `compaction_end`, then replies with the result.
- `set_session_name` emits `session_info_changed`.
- `get_session_stats` derives `contextUsage` from the last assistant usage and the model's `contextWindow`.

## Scenario format

```jsonc
{
  "description": "free text",
  "model": "anthropic/claude-haiku-4-5",   // or a full Model object; default: the first of "models"
  "models": [Model, ...],                   // get_available_models; a default list of 4 if absent
  "thinkingLevel": "low",
  "sessionName": null,
  "commands": [{"name","description","source"}],  // get_commands; a default list of 3 if absent
  "history": [AgentMessage, ...],           // seeds a new session given with --session (or always, with "historyAlways": true)
  "sessions": {"/abs/path.jsonl": {"history": [...], "name": "x"}},  // extra sessions for switch_session
  "startup": [Step, ...],                   // runs at start
  "startupBlocksStdin": false,              // true: stdin is read only after "startup" ends (Pi runs session_start first)
  "timers": [{"after": 300, "steps": [Step, ...]}],  // after startup; use {"run": [...]} for an autonomous run
  "prompts": [{"match": "regex", "once": true, "steps": [Step, ...]}],  // the first unused match runs
  "default": [Step, ...],                   // when no prompt matches
  "extensionCommands": {"name": [Step, ...]},  // "/name args" → disposition handled; "{args}" is replaced by args
  "rejectPrompts": "regex",                 // a matching prompt fails (success: false), as Pi's do
  "expandPrompts": {"regex": "replacement"}, // the prompt as Pi expands it (a skill, a template): the echo and the turn get this text
  "abort": [Step, ...],                     // extra steps emitted after an aborted run's steps stop
  "compactMs": 150,
  "cancelNewSession": false,
  "cost": 0.0123
}
```

### Steps

| Step | What it does |
|---|---|
| `{"emit": rec}` or `{"emit": [rec, …]}` | Writes any Pi record verbatim. A `message_end` is also persisted |
| `{"raw": "text"}` | Writes raw bytes to stdout (broken framing, garbage lines) |
| `{"wait": ms}` | Sleeps; an abort cuts it short |
| `{"assistant": {...}}` | One streamed assistant message. Fields: `thinking`, `text`, `tools: [{id?, name, args}]`, `blocks: [{kind:"text"\|"thinking", text}]`, `chunk` (chars per delta, 8), `every` (ms per delta, 10), `stopReason`, `errorMessage`, `inputTokens`. It emits `message_start`, then `*_start`/`*_delta`/`*_end` per block in `contentIndex` order (tool calls as `toolcall_start`/`toolcall_delta`/`toolcall_end`), then `message_end` (with `durationMs`, like Pi 1.5). `stopReason` defaults to `toolUse` with tools, else `stop` |
| `{"tool": {...}}` | Runs one tool call: `tool_execution_start`, `tool_execution_update` per entry of `updates` (cumulative text, every `every` ms, 30), `tool_execution_end`, then the `toolResult` message. Fields: `id` (default: the next unrun call of the last assistant message, matching `name` if given), `name`, `args`, `updates: [text]`, `until: "abort"` (tick every `every` ms with `tick`, `{n}` = count, until aborted), `duration` (ms), `output`, `content` (the whole result `content` array, e.g. text plus `{type:"image", data, mimeType}` blocks), `isError`, `exitCode`, `details`, `structuredContent`, `durationMs`. Bash gets `structuredContent {output, exit_code, truncated}` like Pi |
| `{"dialog": {method, title, message?, options?, placeholder?, prefill?, timeout?, id?}, "then": {...}}` | Emits an `extension_ui_request` and waits for its `extension_ui_response`. The answer key is the `value`, `"true"`/`"false"` for confirm, `"cancelled"`, `"timeout"` (Pi auto-resolved after `timeout` ms) or `"aborted"`. `then[answer]` (or `then["*"]`) runs next, with `{answer}` replaced |
| `{"ui": {method, ...}}` | A fire-and-forget `extension_ui_request` (`notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`) |
| `{"custom": {customType, content, display}}` | A `role: "custom"` message (start and end) |
| `{"user": "text"}` | A user message (an extension's `sendUserMessage`) |
| `{"deliverQueue": "steering" \| "followUp"}` | Delivers that queue now |
| `{"retry": {errorMessage, attempt, maxAttempts, delayMs, success, wait}}` | `auto_retry_start`, then `auto_retry_end` |
| `{"compaction": {reason, duration, tokensBefore, tokensAfter, error}}` | `compaction_start`, then `compaction_end` |
| `{"extensionError": {path, event, error}}` | `extension_error` |
| `{"big": {bytes, toolCallId, type}}` | One oversized `tool_execution_update` (or `type`) whose text is `bytes` long (9 MiB default) |
| `{"run": [Step, …]}` | A whole run nobody prompted (an autonomous run) |
| `{"hang": ms?}` | Waits for an abort (or `ms`) |
| `{"crash": code}` | Exits with that code at once |

## Scenarios

| File | What it exercises |
|---|---|
| `scenarios/tools.json` | Every kind of tool in one prompt: thinking, a streamed bash with ANSI output and exit code, read with offset/limit, edit with Pi's `details.patch`, write, grep, find, ls, an MCP tool (`mcp__figma__get_file`), a failing bash. Startup sends ANSI statuses, a widget, a notify and a title |
| `scenarios/long-markdown.json` | A ~6 KB streamed markdown answer (headings, lists, a code block, a table, U+2028/U+2029 inside a quote) after a thinking block |
| `scenarios/dialogs.json` | A select (Allow/Block, 10 s timeout) guarding a bash call, a confirm (5 s timeout), an input. `/rpc-input` is an extension command that opens an input dialog outside a run |
| `scenarios/abort.json` | A bash that ticks every 100 ms until aborted. Prompts containing `quick` answer at once (use them to queue follow-ups and steers) |
| `scenarios/steer.json` | A 1.5 s bash; a steer sent meanwhile arrives as a user message before the next model call |
| `scenarios/autonomous.json` | 300 ms after start, an extension posts a `subagent-notify` custom message and Pi runs on its own, with an auto-retry and a threshold compaction |
| `scenarios/crash.json` | Exit 1 mid-tool for prompts starting with "Run". `/die` makes Pi exit 3 while idle |
| `scenarios/oversized.json` | A 9 MiB `tool_execution_update` mid-tool, then the tool and the answer finish normally |
| `scenarios/startup-dialog.json` | An extension awaits a confirm in `session_start`; stdin is never read, so Pi hangs at startup |
| `scenarios/startup-dialog-timeout.json` | The same with a 12 s timeout: Pi resolves it itself, then works |
| `scenarios/rich.json` | v2 rich content: streamed prose with a `ts` block, a mermaid flowchart and a `~~~sh` fence inside a list item; a bash with ANSI colours (exit 1), a read of a `.ts` file, an edit with a patch (+2 −1), then a closing answer |
| `scenarios/spacing.json` | The timeline's spacing (flow `spacing`): an answer with headings, paragraphs, a list and a code block (`answer`); prose, three tools, prose (`tools`); one-line answers (`first`, `second`); an answer then a warning notify (`warn`) |

## Replay mode

`FAKE_PI_REPLAY=tests/fixtures/<name>.jsonl` replays a session recorded from
real Pi by `tests/fixtures/record.ts`. Each fixture line is
`{"t": ms, "dir": "in" | "out", "rec": {...}}`: `in` is what the recorder
sent, `out` is what Pi wrote.

- `out` records before the first gating command play at start, with their original gaps divided by `FAKE_PI_SPEED`.
- Gating commands (`prompt`, `steer`, `follow_up`, `abort`, `extension_ui_response`, `compact`, `new_session`, `switch_session`, `set_model`, `set_thinking_level`, `set_session_name`): playback stops at each recorded one until the client sends a command of the same type. Then the records after it play. The response to it carries the client's `id`.
- Query commands (`get_state`, `get_messages`, `get_commands`, `get_session_stats`, …) are answered at once from the recording: the latest recorded answer at the current playback position, with the client's `id`. Their recorded responses are skipped during playback.
- Dialog ids are the recorded ones, so answering the replayed `extension_ui_request` by its id works.
