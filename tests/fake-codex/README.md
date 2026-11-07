# fake-codex

A scriptable stand-in for `codex app-server`: JSON-RPC 2.0 over LF-framed
JSONL on stdio. Node, no dependencies. The host picks it with
`--codex tests/fake-codex/fake-codex.mjs` or `HERDR_CHAT_CODEX`:

```sh
FAKE_CODEX_SCENARIO=tests/fake-codex/scenarios/tools.json \
  bin/herdr-chat-host serve --provider codex --chat c-test --cwd /tmp/x --state-dir /tmp/s --codex tests/fake-codex/fake-codex.mjs
```

Tests start it through `host.ts` (`codexHost({name, scenario | replay, speed, session, dir, stallMs})`),
which also reads back what the host sent (`requests(method)`, `answers()`).

## Command line and environment

- `[-c key=value]… app-server` serves. `--version` prints `codex-cli 0.163.0`. Any other subcommand (the TUI's `resume <id>`) prints its argv and exits 0.
- `FAKE_CODEX_SCENARIO=<file.json>`: the script (below). Without it every prompt gets `ok: <prompt>`.
- `FAKE_CODEX_REPLAY=<fixture.jsonl>`: replay a recorded real session instead (below).
- `FAKE_CODEX_SPEED=<n>`: divides every wait.
- `FAKE_CODEX_LOG=<file>`: every message received, one JSON per line, after a `{_start, argv, cwd, env}` line.
- `FAKE_CODEX_HOME=<dir>`: where threads persist (`<dir>/sessions/rollout-<ts>-<id>.jsonl`, one JSON thread per file, written at the first turn like Codex). A restarted fake resumes them.

## Behaviour that mirrors Codex 0.163

- `initialize` → `userAgent: "herdr_chat/0.163.0 …"`. `thread/start` → the thread with `path`, settings from the scenario (`approvalPolicy`, `sandbox`, `model`, `effort`), then `thread/started`.
- `turn/start` replies `{turn}` (inProgress), then `thread/status/changed active`, `turn/started`, the `userMessage` item (with `clientId` = `clientUserMessageId`), the script's items, `thread/status/changed idle`, `turn/completed`. A `turn/start` **while a turn runs steers it** and returns the same turn id.
- `turn/steer {expectedTurnId}`: `-32600 "no active turn to steer"` when idle. A steer lands at the next step boundary as a `userMessage` of the same turn; the prompt script matching its text runs there.
- `turn/interrupt` replies `{}`; the running step stops; **a running command never gets `item/completed`**; `turn/completed {status: "interrupted"}`. An open ask gets `serverRequest/resolved`.
- Asks are server→client requests (ids from 0); after the answer comes `serverRequest/resolved`. `decline`/`cancel` complete the command as `declined` (cancel also interrupts) and print Codex's `rejected by user` tool-router ERROR on stderr.
- `thread/resume` loads a persisted thread, or seeds one from the scenario's `history`, else `no rollout found`. `thread/turns/list` pages turns (desc by default, `itemsView: "full"`); an interrupted turn keeps the items that never completed, as they started.
- `thread/settings/update` → `thread/settings/updated`. `thread/compact/start` → a turn with a `contextCompaction` item. `thread/name/set` → `thread/name/updated`. `thread/list` (by cwd, newest first), `thread/read`, `thread/unsubscribe`, `model/list`, `collaborationMode/list`, `skills/list`, `account/read`, `thread/backgroundTerminals/clean`.
- `thread/tokenUsage/updated` after each agent message (`total` cumulative, `last` per request, window 258400).

## Scenario format

```jsonc
{
  "model": "gpt-5.6-luna", "effort": "low",
  "approvalPolicy": "on-request", "sandbox": "workspace-write", "approvalsReviewer": "user",  // the user's config
  "models": [Model…], "skills": [Skill…],
  "history": [Turn…],              // seeds a resumed thread that doesn't exist yet
  "forkEffort": "high",             // the effort a thread/fork takes (the real one takes the config default)
  "prompts": [{"match": "regex", "once": false, "steps": [Step…]}],
  "default": [Step…],
  "resumeError": {"code": -32600, "message": "… active writer"},
  "settingsUpdateUnsupported": true,   // thread/settings/update → -32601 (older Codex)
  "readStatus": {"type": "idle"},      // what thread/read reports (a turn Codex never completes)
  "compactMs": 150, "compactFails": "message",
  "startupNotifications": [msg | {"wait": ms}…]  // sent after thread/started ("{thread}" is replaced)
}
```

### Steps

| Step | Items it emits |
|---|---|
| `{"text", "phase"?, "chunk"?, "every"?}` | `agentMessage` with `item/agentMessage/delta`s |
| `{"reasoning": [part…]}` | `reasoning` with `summaryPartAdded`/`summaryTextDelta` (`[]` = an empty item) |
| `{"command", "output": text \| [chunk…], "exitCode"?, "actions"?, "approval"?: {availableDecisions?, reason?}, "onDecline"?: [Step…], "until": "interrupt", "tick"?}` | `commandExecution` wrapped in `/bin/zsh -lc '…'`, output deltas, an approval request first when `approval` is set |
| `{"fileChange": [{path, kind: add\|update\|delete, diff}], "approval"?: {reason?, grantRoot?}}` | `fileChange`, `item/fileChange/requestApproval`, `turn/diff/updated` |
| `{"mcp": {server, tool, arguments, content, progress?, error?}}` | `mcpToolCall` with `item/mcpToolCall/progress` |
| `{"webSearch": {query, results, action?}}` | `webSearch` (query empty at start, like Codex) |
| `{"imageView": "path"}` | `imageView` (relative to the cwd) |
| `{"subagent": {prompt, steps, answer}}` | `collabAgentToolCall` spawnAgent, the child thread's turn and items on its own `threadId`, then `wait` |
| `{"question": {questions}, "then": {answer: [Step…], "*": …}}` | `item/tool/requestUserInput`; `{answer}` in the next steps is the first answer |
| `{"permissions": {reason, permissions}, "then": {session\|turn\|denied: …}}` | `item/permissions/requestApproval` |
| `{"elicitation": {serverName, mode, message, requestedSchema \| url}, "then": {accept\|decline\|cancel: …}}` | `mcpServer/elicitation/request`; `{content}` is the answer |
| `{"plan": "markdown"}` | `plan` item with `item/plan/delta`s |
| `{"todo": {explanation?, plan: [{step, status}]}}` | `turn/plan/updated` |
| `{"error", "willRetry"?, "details"?}` | `error` notification |
| `{"fail": "message"}` | ends the turn `failed` with that error |
| `{"wait": ms}`, `{"hang": true \| ms}` | silence (a stall) until interrupted |
| `{"waitFor": "steer", "timeout"?}` | waits for a steer |
| `{"emit": msg \| [msg…]}` | raw JSON-RPC messages (`{thread}`, `{turn}` replaced) |
| `{"stderr": "line"}`, `{"crash": code, "stderrBefore"?}` | stderr; exit at once |

## Replay mode

`FAKE_CODEX_REPLAY=tests/fixtures/codex/<name>.jsonl` replays a recorded
session (`{t, dir: out|in|stderr|mark|note, msg}`). `~/.codex` paths become
`FAKE_CODEX_HOME`, the recorded cwd becomes the fake's cwd.

- Playback stops at each recorded request (`turn/start`, `turn/steer`, `turn/interrupt`, `thread/start`, …) until the client sends one of the same method; the recorded reply goes out with the client's id.
- Queries (`model/list`, `skills/list`, `thread/turns/list`, `thread/read`, …) never gate: they get the recorded answer (turn pages in the order asked for), else the scripted default.
- A recorded answer to a server request (an approval) waits for the client's answer to that id; what the client chose doesn't change the recording.
- A recorded `userMessage` echo with no `clientId` gets the `clientUserMessageId` of the client's `turn/start` / `turn/steer` on that thread, in order (the real server echoes it; the recordings sent none).
- A segment cut from a longer run drops the previous turn's tail before its first request.
