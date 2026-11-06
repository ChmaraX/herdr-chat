# Recorded Codex app-server fixtures

Real `codex -c notify=[] app-server` sessions (codex-cli 0.163.0,
`gpt-5.6-luna`), replayed by `tests/fake-codex` (`FAKE_CODEX_REPLAY`). Each
line is `{"t", "dir": "out" | "in" | "stderr" | "mark" | "note", "msg"}`:
`out` is what the client sent, `in` what Codex wrote. Home paths are `~`,
account ids, email and installation ids are scrubbed.

| Fixture | Source | What it pins |
|---|---|---|
| `text` | research sample 01 | handshake, `thread/start`, a text turn, token usage |
| `shell-approval` | sample 03 | `commandExecution` wrapped in `zsh -lc`, `requestApproval` with `availableDecisions` (no `decline`), `listFiles` action |
| `file-edit` | sample 04 | `fileChange` add (whole file) and update (bare hunks), `item/fileChange/requestApproval` without a diff, `turn/diff/updated` |
| `resume-approvals` | sample 06 | `thread/resume {excludeTurns}` + `thread/turns/list` (5 turns, an interrupted leftover), then accept / decline / retry approvals |
| `interrupt` | sample 07 | `turn/interrupt` mid-command: the item never completes, `turn/completed interrupted` |
| `steer` | sample 08 | `turn/steer` mid-message: the steer as a `userMessage` in the same turn; steer while idle → `-32600` |
| `reasoning-websearch` | sample 11 | `summary` deltas with parts, `webSearch` (empty query at start), several turns |
| `mcp-tool` | `record.mjs` | an `mcpToolCall` through a one-tool MCP server (`-c mcp_servers.echo…`) |
| `subagent` | `record.mjs` | `collabAgentToolCall` spawnAgent/wait, the child thread's events on its own `threadId` |
| `plan-mode` | `record.mjs` | `collaborationMode: plan`: `item/tool/requestUserInput` (with `isOther`), then a `plan` item streamed by `item/plan/delta` |

- `node tests/fixtures/codex/build.mjs` rebuilds the sample-based ones from `docs/dev/research/samples/codex/` (one segment each, the borrowed head dropped, a cut-off last turn closed).
- `hc exec --cwd "$PWD" node tests/fixtures/codex/record.mjs [name …]` re-records the others with the real CLI and the user's login: the cheapest model, effort low, a temp cwd, `ephemeral` threads. Run it under `hc exec`: Codex's code-mode host may not start from an agent's shell. Re-record when Codex updates, and diff.
