# Recorded Pi RPC fixtures

Real `pi --mode rpc` sessions (Pi 1.5.0, `anthropic/claude-haiku-4-5`,
`--thinking low`), recorded by `record.ts` in a temp cwd with a temp
`--session-dir`. Extensions, skills, prompt templates, context files, MCP and
themes are off (`--no-extensions …`) to keep them small and stable; `dialog`
adds Pi's `examples/extensions/rpc-demo.ts`.

Each line is `{"t": ms, "dir": "in" | "out", "rec": {...}}`: `in` is what the
recorder sent, `out` is what Pi wrote. Home and temp paths are scrubbed to
`/home/user` and `/tmp/pi-fixture`, signatures to `"sig"`, and system
messages to a stub. `fake-pi` replays them (`FAKE_PI_REPLAY`, see
`tests/fake-pi/README.md`); `tests/host/fixtures.test.ts` drives each one
through the real host.

| Fixture | What it pins |
|---|---|
| `text-only` | thinking + text, usage in `get_session_stats` |
| `bash-read` | two tool calls run in parallel, interleaved updates, `structuredContent.exit_code` |
| `edit` | the edit tool's `details.patch` (unified) and `details.diff` |
| `steer` | `prompt` with `streamingBehavior: "steer"` during `sleep 3`: `queue_update`, then the user message after the tool |
| `abort` | a queued follow-up, `clear_queue`, then `abort` mid-bash: "Command aborted", then an empty assistant message with `stopReason: "error"` / "This operation was aborted", `agent_settled {aborted: true}`, and the `abort` reply last |
| `dialog` | `/rpc-input` (input dialog outside a run, `disposition: "handled"` only after the answer); a `select` from a `tool_call` hook **after** `tool_execution_start`; a blocked tool without `durationMs` |
| `resume` | `--session` on an existing session: `get_messages` history, then a new turn |

Re-record when Pi changes: `node tests/fixtures/record.ts [name …]`.
