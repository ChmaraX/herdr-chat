# fake-claude

A scriptable stand-in for `claude -p --input-format stream-json --output-format
stream-json --permission-prompt-tool stdio …`. It's Node with no dependencies.
Records are shaped like the real CLI's (`docs/dev/research/samples/claude/`):
- `stream_event` deltas;
- one `assistant` record per finished block;
- `user` tool results with `tool_use_result` and `tool_result_meta`;
- `can_use_tool` control requests that block until answered;
- `command_lifecycle`, `session_state_changed`, and `result`.

The host picks it with `--claude <path>` or `PI_CHAT_CLAUDE`. The tests start
it through `tests/fake-claude/host.ts` (`startClaude`).

## Flags and environment

- Accepted flags:
  - `--session-id <id>`: a new session with this id.
  - `--resume <id>`: an existing transcript. A missing one exits 1 with "No conversation found", as the CLI does.
  - `--model`, `--permission-mode`, `--effort`, `--replay-user-messages` (echoes prompts and control answers), `--version`.
- `CLAUDE_CONFIG_DIR`: where transcripts go, in the real format.
  - The main transcript is `projects/<cwd with non-alphanumerics → '-'>/<id>.jsonl`.
  - Subagent transcripts go in `<id>/subagents/agent-<id>.jsonl`.
  - The live-process registry is `sessions/<pid>.json`.
- `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`: emits `session_state_changed`. The scenario key `"sessionStates": false` turns it off, to test the settle fallback.
- `FAKE_CLAUDE_SCENARIO=<file.json>`: the script, described below.
- `FAKE_CLAUDE_REPLAY=<fixture.jsonl>`: replay a recording, described below.
- `FAKE_CLAUDE_SPEED=<n>`: divides every wait by `n`.
- `FAKE_CLAUDE_LOG=<file>`: every record the host sent, one per line. The first line is `{"type":"_start", argv, env, cwd}`.

## Scenario

```json
{ "turns": [{ "match": "regex", "once": false, "steps": [ … ] }], "default": [ … ],
  "initialize": { "delayMs": 0, "hang": false, "fail": "message" }, "turnStartMs": 600, "ignoreInterrupt": false, "models": [ … ], "commands": [ … ] }
```

`"turnStartMs"` (default 600, divided by the speed; a turn's own `"startMs"` overrides it): how long the model takes to start. As in
the real CLI, the prompt's replay (`--replay-user-messages`) and `message_start` come
together only then (600–1000 ms after the prompt in the recordings, sometimes 2–3.5 s).
`tests/host/fake-fidelity.test.ts` holds this against `v2.jsonl`.

A prompt runs the steps of the first `turns` entry whose `match` it matches.
With no match it runs `default`, which falls back to `[{ "text": "ok: {prompt}" }]`.

Text can use these placeholders: `{prompt}`, `{steers}` (the steers folded in so far), `{model}`, `{effort}`, `{mode}` and `{cwd}`.

### Steps

**Text and thinking**
- `{ "thinking": "…" }`, `{ "text": "…" }`: a streamed block. Consecutive blocks share one message.

**Tools**
- `{ "tool": "Bash", "input": {…}, "result": { "content", "is_error", "tool_use_result" } }`: a `tool_use`, then its result.
  - `"ask"`: ask for permission. The default is to ask for Bash, Write, Edit, WebFetch and WebSearch.
    - `acceptEdits` mode skips the ask for edits, and an "always" rule skips it for that exact command.
    - A deny becomes an `is_error` result with the deny message and `non_execution_kind: "permission-rule"`.
  - `"withdrawAfterMs"`: the CLI withdraws the ask with `control_cancel_request`.
  - `"task": { "lines": [...], "everyMs" }`: a long Bash.
    - It emits `task_started`, then answers `get_task_output` with the output so far, then `task_notification`.
  - `"durationMs"`: the tool takes this long.
- `{ "subagent": { "description", "type", "prompt", "steps": [{ "tool" … } | { "text" }], "report" } }`: an `Agent` call with nested records (`parent_tool_use_id`), a subagent transcript, and a report.
- `{ "todos": [{ "content", "status", "activeForm" }] }`: a `TodoWrite` call.

**Asks**
- `{ "question": { "questions": [...] } }`: `AskUserQuestion` through `can_use_tool`.
- `{ "plan": "markdown" }`: `ExitPlanMode` through `can_use_tool`. `updatedPermissions` `setMode` changes the mode.

**Errors and notices**
- `{ "apiError": "authentication_failed", "text": "…" }`: a synthetic error message and an `is_error` result.
- `{ "retry": { "attempt", "max", "delayMs", "error" } }`: `api_retry`.
- `{ "notice": "…" }`, `{ "rateLimit": "rejected" }`.

**Failures and other runs**
- `{ "hang": true, "ignoreInterrupt": false }`: silence until an interrupt (or forever).
- `{ "crash": 3, "stderr": "…" }`: exit with that code.
- `{ "autonomous": "text", "afterMs": 300 }`: start a turn nobody sent.

### Mid-turn messages and control requests

- **Mid-turn messages:**
  - `priority: "next"`: `command_lifecycle queued`. It is folded in at the next tool boundary (echo + `started`).
  - `priority: "later"`: runs as its own turn after the `result`, without going idle in between.
- **`interrupt`:** answers `{still_queued, cancelled}`; with `cancel_queued`, it emits `command_lifecycle cancelled` for each queued message. It then ends the turn as the CLI does: the tool result "doesn't want to proceed", then `[Request interrupted by user for tool use]`, then `result error_during_execution`, then idle.
- **Local commands:**
  - `/compact [instructions]`: `status compacting`, `compact_boundary`, and a summary record on disk.
  - `/context` and `/cost`: a `<synthetic>` assistant message, an echo of `<command-name>`, and `result.local_command`.
  - `/theme`: "isn't available in this environment".
- **Other control requests it answers:** `initialize`, `set_model`, `set_permission_mode` (+ `status`), `apply_flag_settings`, `get_context_usage`, `rename_session` (+ `session_title_changed`, `custom-title` on disk), `get_task_output`, `list_models` and `cancel_async_message` (drops a queued message of either priority, `{cancelled: false}` once it started). Anything else gets `subtype: "error"`.

## Replay mode

`FAKE_CLAUDE_REPLAY=tests/fixtures/claude/<file>.jsonl` replays a session
recorded from the real CLI, in the research probe's format (`{dir: in|out|meta, t, rec}`).
- **Initialize:** the recorded initialize response answers `initialize`.
- **Turns:** each host prompt replays the recorded turn with the same prompt text, gaps capped at 300 ms.
  - A message the recording sent mid-turn (a steer) stays in its turn.
  - A prompt that arrives early waits for the turn before it.
- **Recorded `can_use_tool`:** sent, and the replay waits for the host's answer. The recorded outcome follows, whatever the answer was.
- **Rewrites:** `session_id`, and the echo's `uuid` (to the host's). A steer's recorded echo waits until the host sent that steer.

The fixtures in `tests/fixtures/claude/`, recorded with CLI 2.1.303 and `--model haiku`:

| file | what it pins |
|---|---|
| `main.jsonl` | No `--replay-user-messages`, no session-state events (the settle fallback). Text, a bash ask, Write + Edit (`structuredPatch` with "\ No newline"), a deny, an interrupt, a steer, control ops, `/compact` |
| `extra.jsonl` | An image prompt, summarized thinking, ToolSearch, an Agent subagent, AskUserQuestion, WebSearch with an ask, Read, a missing tool (Grep) |
| `v2.jsonl` | The recommended argv (replay, summarized thinking, `--session-id`, state events), uuids, `command_lifecycle`, a `next` steer folded mid-turn, plan mode with two denied ExitPlanMode asks and an AskUserQuestion, `/context` |

Two more recordings, not replayed (`later` messages with an interrupt with
`cancel_queued`, and `get_task_output` on a long Bash), are in
`docs/dev/research/samples/claude/{queue,tail}.jsonl`.

They are scrubbed: home paths are `/Users/user`, the account fields are
`<redacted>`, and hook output is truncated.
