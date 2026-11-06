# Claude Code as a structured, long-lived agent

How the host drives **Claude Code** behind the same chat UI that shows Pi.
This research feeds [`providers.md`](../providers.md).

**Sources** (every claim below cites one of these):
- **CLI.** `claude --version` → `2.1.303 (Claude Code)`, plus `claude --help` (quoted as *help*).
- **SDK types.** `@anthropic-ai/claude-agent-sdk@0.3.317` (`npm pack` into a temp dir, `manifest.json` → CLI `2.1.317`). Cited as `sdk.d.ts:N`, `sdk-tools.d.ts`, `sdk.mjs`. The SDK is a wrapper around the same CLI, so its `.d.ts` is the schema of the wire.
- **Docs.** code.claude.com: [headless](https://code.claude.com/docs/en/headless), [sessions](https://code.claude.com/docs/en/agent-sdk/sessions), [user input](https://code.claude.com/docs/en/agent-sdk/user-input), [permissions](https://code.claude.com/docs/en/agent-sdk/permissions), [skills and commands](https://code.claude.com/docs/en/agent-sdk/slash-commands).
- **Upstream apps.** Clones at the commits in `sources/COMMITS.txt`: Paseo `packages/server/src/server/agent/providers/claude/`, Orca `src/main/claude/`, T3 `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`.
- **Real runs.** Recorded on this machine with `--model haiku` (which resolves to `claude-haiku-5-5`) in a temp dir, scrubbed. They are in [`samples/claude/`](samples/claude/), one record per line as `{dir: in|out|meta, t: ms, rec}`:
  - `main.jsonl`: text, bash, Write+Edit, a deny, an interrupt mid-tool, a steer, the control ops, `/compact`;
  - `extra.jsonl`: an image, summarized thinking, a subagent, AskUserQuestion, WebSearch, Read, a missing tool;
  - `resume.jsonl`: resume, effort, models, local slash commands;
  - `fork.jsonl`: `--fork-session`;
  - `queue.jsonl`: queued sends, `command_lifecycle`, `session_state_changed`, interrupt with `cancel_queued`;
  - `tail.jsonl`: live bash output through `get_task_output`;
  - `transcript-on-disk.jsonl`: the session file on disk, with payload-heavy records reduced.

  The driver script was a scratch `probe.mjs`, not kept. It spawned the §1 argv and answered every ask after 300 ms.

---

## 1. The interface to use

**Use `claude -p` in stream-json mode on stdio: JSONL in, JSONL out, plus the control protocol.** This is the only long-lived, structured,
bidirectional interface the CLI has. It is what the TypeScript SDK spawns, and the SDK builds exactly this argv (`sdk.mjs`, `initialize()`):
`["--output-format","stream-json","--verbose","--input-format","stream-json", …, "--permission-prompt-tool=stdio", …, "--include-partial-messages"]`.
All three upstream apps run it, through the SDK's `query()`:
- Paseo `claude/query.ts:1-117`;
- Orca `claude-stream-json-connection.ts:45` ("Orca's resolved user CLI; the SDK falls back to a bundled binary"), with the argv snapshot at `src/main/runtime/__snapshots__/structured-agent-launch-parity.test.ts.snap:500-525`;
- T3 `ClaudeAdapterV2.ts:1610-1655`.

What else exists, and why not:
- The TUI. Scraping it is not structured.
- `-p` with a text prompt: one-shot.
- `--output-format json`: a single result.
- `--remote-control` / `--bg` / `attach`: a hosted bridge for claude.ai, not a local API.

**Speak the protocol directly, not through the SDK runtime.** The record types come from `sdk.d.ts`, used as dev-only `import type`. Reasons:
- **It is the user's CLI.** The SDK package ships its own ~300 MB native CLI as a per-platform optional dependency (`package.json` `optionalDependencies`, `manifest.json`). We want the user's CLI, with its own auth, settings, plugins and updates. With `pathToClaudeCodeExecutable` the SDK spawns that CLI anyway, so the SDK doesn't shield us from CLI changes.
- **The protocol is small.** We'd write `initialize`, `user`, `control_request`/`control_response` and `control_cancel_request` (`sdk.d.ts:4026`, `5276-5337`).
- **We get the raw records.** Our fake agent and fixtures need them, and the samples are already in that form.
- **The SDK is a fallback.** If the raw path ever breaks, swap the transport for `query({options:{pathToClaudeCodeExecutable, spawnClaudeCodeProcess}})`. It yields the same `SDKMessage` records, so the mapper stays.

### Launch argv (recommended)

```
claude -p --output-format stream-json --verbose --input-format stream-json
       --include-partial-messages --replay-user-messages
       --permission-prompt-tool stdio --permission-mode <mode>
       --thinking-display summarized
       [--model <alias|id>] [--effort <level>] [--resume <id> [--fork-session]] [--session-id <uuid>]
cwd = chat cwd
env = process.env − NODE_OPTIONS (as sdk.mjs does), + CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1
```

- `--include-partial-messages` turns on the token deltas (*help*; `stream_event` at `main.jsonl:15-21`).
- `--replay-user-messages` echoes every user message the CLI accepts, as `{type:"user", isReplay:true, uuid}` (`extra.jsonl:15`). It is the only signal that a queued or steered message was actually taken.
- `--permission-prompt-tool stdio` sends permission prompts as `can_use_tool` control requests on stdout (`main.jsonl:50`). The SDK passes `=stdio` when `canUseTool` is set.
- `--thinking-display summarized` is a hidden flag that the SDK passes (`sdk.mjs` `--thinking-display`, and Orca's snapshot). Without it, thinking deltas are empty: `"thinking":""` with `thinking_display:"updates"` (`main.jsonl:30`). With it you get text (`extra.jsonl:19`).
- `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` makes the CLI emit `system/session_state_changed` (`queue.jsonl:13`), the authoritative turn-over signal (`sdk.d.ts:6220`). Paseo sets it (`agent.ts:3654`), and so does Orca (snapshot env).
- **Don't** pass `--bare`. It turns off OAuth and keychain (*help*). Don't pass `--no-session-persistence` either: it only works with `--print` (*help*), and Paseo found it silently ignored in stream-json mode (`agent.ts:3055-3058`).
- After spawning, write `{"type":"control_request","request_id":"r1","request":{"subtype":"initialize"}}` (`main.jsonl:2`). The response (`main.jsonl:11`) carries:
  - `commands[]`, `models[]`, `agents[]`, `account`;
  - `current_permission_mode`, `claude_code_version`, `pid`;
  - `capabilities` and `pending_permission_requests`.

  Then the first `user` message starts a turn. `system/init` arrives at the start of **every** turn (7 times in `main.jsonl`) with `session_id`, `model`, `tools`, `mcp_servers`, `slash_commands`, `permissionMode` and `capabilities` (`main.jsonl:13`; `sdk.d.ts:6294-6370`).

**Auth.** The CLI reads the user's own login: the claude.ai OAuth in the keychain or `~/.claude`.
- `init.apiKeySource:"none"` means OAuth (`main.jsonl:13`; `sdk.d.ts:6298`).
- Check before spawning with `claude auth status` (JSON: `loggedIn`, `authMethod`, `apiProvider`).
- Failures arrive as `assistant.error:"authentication_failed"` and its sibling values (`sdk.d.ts:3819`), and as `result.is_error`.
- Sign-in itself is a TUI hand-off (`claude auth login`).

**Trust.** `-p` skips the workspace trust dialog (*help*). The TUI hand-off does not: it showed "Quick safety check: Is this a project you … trust?" in the same folder.

**Versions.** CLI 2.1.303. SDK 0.3.317 is newer (it bundles 2.1.317). Paseo is maintained against SDK 0.3.246 (`claude/options.ts:47`), Orca and T3 against ^0.3.284 (their `package.json`). Feature-detect with `init.capabilities`, which here is `interrupt_receipt_v1, interrupt_cancel_queued_v1, interrupt_send_now_v1, msg_lifecycle_v1, …` (`main.jsonl:13`; `sdk.d.ts:6363-6367`). Don't sniff versions.

## 2. Mapping to the normalized events

The wire is one JSON object per line, and the types are `SDKMessage` (`sdk.d.ts:5637`). Lines have to be split on `\n` only, as with Pi.

### Run and queue

| normalized | native |
|---|---|
| `run_started` | We send `user` (`main.jsonl:12`). Then `session_state_changed {state:"running"}` (`queue.jsonl:13`) and `system/status {status:"requesting"}` (`main.jsonl:14`). A turn **we didn't send** is autonomous. It starts the same way, and `command_lifecycle started` names its uuid if it was queued (`queue.jsonl:106`). Causes: a background task wakes the agent (Paseo `agent.ts:4087-4093`), ScheduleWakeup/Cron/Monitor, or a queued send. |
| `run_settled {aborted, error}` | `session_state_changed {state:"idle"}` (`queue.jsonl:120`). The fallback is `result` plus `queued_turn_count:0`. `result` is "exactly one per turn … the turn-complete signal" (`sdk.d.ts:6057` doc), but more turns may follow (`queued_turn_count`, background wakes). Aborted: `result.subtype:"error_during_execution"`, `terminal_reason:"aborted_tools"`, `is_error:true` (`queue.jsonl:153`). |
| `queue_changed` | `{type:"command_lifecycle", command_uuid, state: queued\|started\|completed\|cancelled}` (`queue.jsonl:40,106,119,145,148`), gated by capability `msg_lifecycle_v1`. Keep `uuid → text` ourselves, since we chose the uuid when sending. |

### Messages

| normalized | native |
|---|---|
| `user_message` | The echo `{type:"user", isReplay:true, uuid, message}` (`extra.jsonl:15`). The CLI also writes `type:"user"` records of its own: tool results, the `[Request interrupted by user for tool use]` marker (`main.jsonl:192`), the compaction summary and `<local-command-stdout>` (`main.jsonl:273-274`). Classify by content. Only `isReplay` records are user prompts. |
| `assistant_delta` | `{type:"stream_event", event:{type:"content_block_delta", index, delta:{type:"text_delta",text}\|{type:"thinking_delta",thinking}}, parent_tool_use_id, api_message_id}` (`main.jsonl:17`, `extra.jsonl:19`). Key by (`api_message_id`, `index`). The `signature_delta` and `input_json_delta` records carry no text. |
| `assistant_block_end` | `content_block_stop {index}`, then a full `{type:"assistant", message:{id, model, content:[ONE block], stop_reason:null}}` (`main.jsonl:18`). The CLI "emits one assistant message per completed content block, so several … share message.id" (`sdk.d.ts:3727`). Replace our accumulated text with that block. |
| `assistant_end` | `stream_event message_delta {delta:{stop_reason}, usage}` then `message_stop` (`main.jsonl:20-21`), one per API call. `stop_reason`: `end_turn`, `tool_use`, `max_tokens`, … The turn total is on `result` (`stop_reason`, `usage`, `duration_ms`). A truncated message has `aborted:true` (`sdk.d.ts:3766`). `model` is `message.model` (`claude-haiku-5-5`), and local commands use `"<synthetic>"` (`resume.jsonl:137`). |
| thinking progress | `system/thinking_tokens {estimated_tokens}` (`main.jsonl:29`) is for a spinner, while the thinking text is redacted. Pitfall from T3 (`ClaudeAdapterV2.ts:1840`): Claude ≥5.1 in `updates` display "emits at most one pre-tool text block as thinking". |

### Tools

**Start.** `stream_event content_block_start {content_block:{type:"tool_use", id, name, input:{}}}`, then `input_json_delta` chunks (`main.jsonl:37`). The parsed input comes on the `assistant` record (`main.jsonl:34`).

**Permission.** If an ask is needed, `control_request can_use_tool` arrives between the tool_use and its execution (`main.jsonl:50`). See §3.

**Progress.**
- No bash output streams by default. `tool_progress {tool_use_id, elapsed_time_seconds}` exists (`sdk.d.ts:6535`), but none arrived in our runs.
- A foreground Bash longer than ~3 s becomes a task: `system/task_started {task_id, tool_use_id, task_type:"local_bash"}` (`main.jsonl:187`).
- `control_request get_task_output {task_id}` then returns the output so far, `{output, total_bytes, truncated}` (`tail.jsonl:37-40`, verified: 6 lines after 2.5 s, 8 after 4.5 s). That is our `tool_progress`, by polling every ~1 s.

**End.** A `type:"user"` record (`main.jsonl:52`) with:
- `message.content[]`: `{type:"tool_result", tool_use_id, content: string | blocks (text, image), is_error}`;
- `tool_use_result`: the tool's structured Output (`sdk.d.ts:6651`; per-tool types in `sdk-tools.d.ts`);
- `tool_result_meta[]`: `{id, permission_decision:{decision, source}}`, or `non_execution_kind: "permission-rule" | "user-rejected"` for a deny or an interrupt (`main.jsonl:140,191`).

**Exit code.** Bash has no structured exit code. Its error text starts `Exit code 2\n…` with `is_error:true` (`main.jsonl:216`). Parse `^Exit code (\d+)`, otherwise 0 when `!is_error`.

**Diffs.**
- `Edit` → `tool_use_result.structuredPatch:[{oldStart,oldLines,newStart,newLines,lines:["-one","+two",…]}]`, `originalFile`, `oldString` and `newString` (`main.jsonl:104`). This becomes our unified diff.
- `Write` → `{type:"create"|"update", content, structuredPatch, originalFile}` (`main.jsonl:86`).
- Either may also carry `gitDiff.patch` (`sdk-tools.d.ts` FileEditOutput).

**Built-in tools.** This session advertised 28 in `init.tools` (`main.jsonl:13`):
`Task, AskUserQuestion, Bash, CronCreate, CronDelete, CronList, DesignSync, Edit, EnterPlanMode, EnterWorktree, ExitPlanMode, ExitWorktree, ListAgents, Monitor, NotebookEdit, PushNotification, Read, RemoteTrigger, ReportFindings, ScheduleWakeup, SendMessage, Skill, TaskStop, ToolSearch, WebFetch, WebSearch, Workflow, Write`.
- Some tools are **deferred**: the model loads them with `ToolSearch {query:"select:WebSearch"}` (`extra.jsonl:78-86`). So tool names show up that `init.tools` didn't announce.
- `init.tools` says `Task`, but the model calls it **`Agent`** (`extra.jsonl:263`).
- `Grep`, `Glob` and `TodoWrite` exist in `sdk-tools.d.ts` but **not in this build**: "No such tool available: Grep … use `grep` via the Bash tool" (`extra.jsonl:448`). The classifier must be name-driven and tolerant.

| tool | args (`sdk-tools.d.ts`) | result `tool_use_result` | ToolDetail |
|---|---|---|---|
| `Bash` | `command, timeout?, description?, run_in_background?` | `{stdout, stderr, interrupted, backgroundTaskId?, returnCodeInterpretation?, gitOperation?}` (`main.jsonl:52`) | `bash` |
| `Read` | `file_path, offset?, limit?, pages?` | `{type:"text", file:{filePath, content, …}}`; the text has `N\t` line prefixes (`extra.jsonl:431`) | `read` |
| `Edit` | `file_path, old_string, new_string, replace_all?` | `structuredPatch`, `originalFile` (`main.jsonl:104`) | `edit` |
| `Write` | `file_path, content` | `{type, structuredPatch, originalFile}` | `write`, or `edit` when `type:"update"` |
| `NotebookEdit` | notebook cell edit | `NotebookEditOutput` | `edit` |
| `Glob` / `Grep` (when present) | `pattern, path?` / `pattern, path?, glob?, output_mode?, -n …` | `{filenames, numFiles}` / `{mode, filenames, content?}` | `search` |
| `WebFetch` | `url, prompt` | `{code, result, bytes, url}` | `generic` (url) |
| `WebSearch` | `query, allowed_domains?, blocked_domains?` (+ `mode`) | `{query, results:[{tool_use_id, content:[{title,url}]}\|string], durationSeconds}`, and the text "Web search results for query…" (`extra.jsonl:394`) | `search` (web) |
| `Agent` / `Task` | `description, prompt, subagent_type?, model?, run_in_background?` | the final report "[Subagent hand-back] …" (`extra.jsonl:274`) | `generic`, with a subagent row |
| `AskUserQuestion` | `questions:[{question, header, options:[{label, description}], multiSelect}]` | `{questions, answers}`, and "Your questions have been answered…" | becomes an `ask` (§3) |
| `TodoWrite` / `TaskCreate`/`TaskUpdate`/`TaskList` | `todos:[{content,status,activeForm}]` / `subject, description, status…` | `{oldTodos,newTodos}` / `{task:{id,subject}}` | becomes a plan widget |
| `EnterPlanMode` / `ExitPlanMode` | `{}` / `{plan?, allowedPrompts?}` | `ExitPlanModeOutput` | the ExitPlanMode ask is a plan approval card |
| `Skill`, `ToolSearch`, `Monitor`, `Cron*`, `ScheduleWakeup`, `Workflow`, `SendMessage`, `TaskStop`, worktree tools, … | various | various | `generic` |

**MCP tools.** They are named `mcp__<server>__<tool>`.
- `can_use_tool` carries `mcp_server:{name, source}` (`sdk.d.ts:5064`). Trust decisions go on `source`, not on the name (`sdk.d.ts` CanUseTool doc).
- Results are text, image or `resource_link` blocks.
- Server status is in `init.mcp_servers[{name,status,source}]` (`main.jsonl:13`: plugin servers show `needs-auth` or `failed`) and in `control mcp_status`.
- MCP elicitation arrives as `control_request {subtype:"elicitation", message, mode:"form"|"url", requested_schema}` (`sdk.d.ts:4037`). That is an `ask` of kind input/form.

**Todo and plan updates.** None run in this build: TodoWrite was absent, `extra.jsonl:86`. When present, map TodoWrite `input.todos`, or TaskCreate/TaskUpdate, onto a `widget {key:"todos"}`. `ExitPlanMode` arrives as `can_use_tool` and must render as "Approve plan / Keep planning".

**Subagents.**
- The Agent tool_use (`extra.jsonl:263`), then `system/task_started {task_type:"local_agent", subagent_type, spawn_depth, prompt}` (`extra.jsonl:267`).
- `system/task_progress {description, last_tool_name, usage}` (`extra.jsonl:269`), `task_updated {patch:{status}}`, and `task_notification {status, summary, output_file}`.
- The subagent's own messages carry `parent_tool_use_id` = the Agent call id and `agent_id` (`extra.jsonl:270`). Nest them under the parent tool card, never in the main timeline.
- `background_tasks_changed` is a level signal with REPLACE semantics (`sdk.d.ts:3830`).
- Transcripts live in `<session>/subagents/agent-<id>.jsonl`.

**Web search** is a client tool (above) with a permission ask (`extra.jsonl:387-394`). It counts in `usage.server_tool_use.web_search_requests`.

### Errors, usage and compaction

**Errors and retries.**
- `system/api_retry {attempt, max_retries, retry_delay_ms, error_status, error}` (`sdk.d.ts:3708`) → `retry`.
- `assistant.error` is one of `authentication_failed | rate_limit | overloaded | billing_error | model_not_found | max_output_tokens | …` (`sdk.d.ts:3819`).
- `result.is_error` with `subtype: error_during_execution | error_max_turns | error_max_budget_usd` and `errors[]` (`sdk.d.ts:5992`). T3: "The SDK can report API failures as subtype 'success' with is_error set" (`ClaudeAdapterV2.ts:3723`).
- `result.startup_failure_reason` gives a fixable startup error, e.g. `session_held_by_background` (`sdk.d.ts` SDKStartupFailureReason).
- `rate_limit_event` (`main.jsonl:22`) → a notice when `status != "allowed"`.
- `system/permission_denied` covers auto-denials (`sdk.d.ts:5835`).
- `system/notification {key,text,priority}` and `system/informational {content, level}` (`sdk.d.ts:5541,5783`) → `notice`.
- On process exit we have stderr and the exit code. The CLI exited **1** after its last turn was an aborted one (`queue.jsonl:155`), so a non-zero exit is not by itself a crash.

**Usage, cost and context.**
- Per API call: `message_delta.usage` (`main.jsonl:20`).
- Per turn: `result.usage` ("MAIN AGENT LOOP ONLY", `sdk.d.ts:6000`).
- `result.modelUsage[model] = {inputTokens, outputTokens, cacheRead…, costUSD, contextWindow:1000000, maxOutputTokens}` is cumulative **per process** (`main.jsonl:249`; `sdk.d.ts:1499`). `result.total_cost_usd` is too: it is a running total, not a sum. T3 notes it restarts at zero with each new process (`ClaudeAdapterV2.ts:4198`).
- On a subscription, `costBasis:"list"` is an estimate.
- Context now: `control get_context_usage {detail:"summary"}` → `{totalTokens, maxTokens, percentage, categories[]}` (`main.jsonl:251`). That is cheap and exact, so call it after each `result`.

**Compaction.** Send `/compact [instructions]` as a user message. Sequence (`main.jsonl:261-275`):
1. `status {status:"compacting"}`;
2. SessionStart:compact hooks;
3. `status {status:null, compact_result:"success"}`;
4. `init`;
5. `system/compact_boundary {compact_metadata:{trigger:"manual"|"auto", pre_tokens:29369, post_tokens:2713, duration_ms}}`;
6. the summary arrives as a user record "This session is being continued…" (it is `isCompactSummary` on disk, `transcript-on-disk.jsonl:134`);
7. `result {num_turns:0}`.

Auto-compaction follows the same path with `trigger:"auto"`. The threshold is `get_context_usage.autoCompactThreshold`.

**Hooks and decorations.** The user's hooks run, and their events are on the wire even without `--include-hook-events`: `system/hook_started` and `hook_response {hook_name, output, exit_code, outcome}` (`main.jsonl:3-10`). Map them to `status {key:"hook"}` while they run. Their output can be large.

## 3. Commands

### Prompts and turns

**Prompt with images.**
```json
{"type":"user","message":{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"…"}},{"type":"text","text":"…"}]},"parent_tool_use_id":null,"uuid":"<ours>","priority":"next"}
```
Seen at `extra.jsonl:12`; the answer was "Red". `uuid` is ours to choose. It comes back on the echo, on `command_lifecycle` and on `result.user_message_uuids` (`queue.jsonl:117`).

**Steer or queue mid-turn.** Write another `user` record while a turn runs. `priority` (`sdk.d.ts:6652`) decides what happens:
- `"next"`: folds into the running turn at the next tool boundary. One turn, one result: BANANA was answered in the same reply as the ping (`main.jsonl:213` → `245`). This was also the behaviour without a priority. The CLI's default depends on a feature flag (the `iwt()` function in the binary: `?"next":"later"`), so **always set it**.
- `"later"`: a follow-up. It runs as its own turn after the current one: `command_lifecycle queued` → `started` → `completed`, and a separate `result` (`queue.jsonl:40,105-119`).
- `"now"`: interrupts the turn and runs at once (`interrupt_send_now_v1`).
- To take back one queued message: `control cancel_async_message {message_uuid}` (`sdk.d.ts:4018`).

**Interrupt (Esc).** `control interrupt {cancel_queued:true}` → `{still_queued:[], cancelled:[uuid…]}` (`queue.jsonl:147-149`). Then come:
- `task_notification stopped`;
- a `tool_result` "The user doesn't want to proceed…";
- the user marker `[Request interrupted by user for tool use]`;
- `result error_during_execution` (`queue.jsonl:150-153`).

Without `cancel_queued`, queued sends survive and are listed in `still_queued` (`main.jsonl:188-189`). "Abort and restore the composer" = `cancel_queued:true`, then put back our own text for the `cancelled` uuids.

**Kill.** Close stdin and wait. If the process lingers, kill the **process tree**: Paseo and Orca tree-kill because the SDK "may only kill the direct child" (Paseo `agent.ts:3034-3053`).

### Permissions and questions

**Answer a permission prompt.** The request:
```json
{"type":"control_request","request_id":"<cli's>","request":{"subtype":"can_use_tool","tool_name":"Bash","display_name":"Bash","input":{…},"description":"…","permission_suggestions":[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"touch marker.txt && ls"}],"behavior":"allow","destination":"localSettings"},{"type":"setMode","mode":"acceptEdits","destination":"session"}],"blocked_path":"…","tool_use_id":"toolu_…"}}
```
That is `main.jsonl:50`, with all fields at `sdk.d.ts:5061-5121`. The answer:
```json
{"type":"control_response","response":{"subtype":"success","request_id":"<same>","response":{"behavior":"allow","updatedInput":{…},"toolUseID":"toolu_…"}}}
```
- **Allow once:** the answer above (`main.jsonl:51`).
- **Always:** add `updatedPermissions: [<the suggestion>]`. `destination: localSettings` persists to `.claude/settings.local.json`, and `session` lasts for this process only ([user-input](https://code.claude.com/docs/en/agent-sdk/user-input) "Approve and remember").
- **Deny:** `{"behavior":"deny","message":"…"}`, optionally with `interrupt:true` (`main.jsonl:139-140`). The model sees the message.
- Honour the request's flags: `suppress_always_allow_rule` hides "Always", `default_to_no` means no default focus, and `requires_user_interaction` (`sdk.d.ts:5085-5115`).
- `decision_reason` may contain ANSI, so strip it.
- The CLI can withdraw an ask with `control_cancel_request {request_id}` (`sdk.d.ts:4026`). Close the card when it does.

**Permission modes.**
- The values are `default | acceptEdits | plan | auto | dontAsk | bypassPermissions` (`sdk.d.ts:2586`). *help* lists `manual` where the SDK has `default`, and `default` worked (`main.jsonl:13`).
- Change it live with `control set_permission_mode {mode}` → `{mode}` plus `system/status {permissionMode}` (`main.jsonl:253-254`).
- `bypassPermissions` needs `--allow-dangerously-skip-permissions` at launch (`sdk.d.ts` doc on `set_permission_mode`).
- `dontAsk` never prompts.
- Some asks always come through, even under bypass: AskUserQuestion, and MCP tools marked `requiresUserInteraction` ([permissions](https://code.claude.com/docs/en/agent-sdk/permissions)).
- The user's settings may default to `auto`: the TUI opened with "auto mode on". So **pass `--permission-mode` explicitly**.

**AskUserQuestion** arrives as `can_use_tool` with `tool_name:"AskUserQuestion"` (`extra.jsonl:326`). Answer `allow` with `updatedInput: {questions, answers:{[question]: label | labels | free text}}` (`extra.jsonl:327`). The `select` ask covers it, with an "Other" text field.

`request_user_dialog` is only sent for the `supportedDialogKinds` we declare in `initialize` (`sdk.d.ts:5311`). Declare none, which is what we did.

### Models, effort and thinking

**List models.** `initialize.models[]` or `control list_models` (`resume.jsonl:132`). Each entry is `{value, resolvedModel, displayName, description, supportsEffort, supportedEffortLevels, supportsAdaptiveThinking, supportsFastMode, supportsAutoMode, supportsThinkingOff}`. The values are aliases (`default`, `opus`, `fable`, `sonnet`, `haiku`) plus pinned ids.

**Set the model.** `control set_model {model}` (`main.jsonl:255`) or `/model sonnet` (`resume.jsonl:145`, which replies "Set model to Sonnet 5.5 for this session only"). The next `init.model` confirms it.

**Effort ("thinking level").** `low | medium | high | xhigh | max` per model (`sdk.d.ts:724`).
- At launch: `--effort`.
- Live: `control apply_flag_settings {settings:{effortLevel}}` (`resume.jsonl:130`; `sdk.d.ts:3058`).
- Thinking on or off (`--thinking=disabled|adaptive` in the SDK argv) needs a **new process** (T3 `ClaudeAdapterV2.ts:1440`).
- `set_max_thinking_tokens` is deprecated (`sdk.d.ts:3030`).

### Sessions

**Compact.** `/compact [instructions]` (above).

**New session.** Restart the process without `--resume`. That is the cleanest. `/clear` in-process emits `conversation_reset {new_conversation_id}` (`sdk.d.ts:5419`), and the next `init.session_id` changes.

**Where sessions live.** `~/.claude/projects/<cwd with every non-alphanumeric → '-'>/<session-id>.jsonl` (or under `$CLAUDE_CONFIG_DIR`). Long names are truncated plus a hash ([sessions](https://code.claude.com/docs/en/agent-sdk/sessions)). Subagents go in `<id>/subagents/agent-<agentId>.jsonl`.

**Format** (`transcript-on-disk.jsonl`). One record per line:
- `type: user | assistant` carry `{uuid, parentUuid, isSidechain, message (API shape), toolUseResult, timestamp, entrypoint:"sdk-cli", version}`;
- the other types are `attachment, queue-operation (enqueue/dequeue/remove), custom-title, agent-name, last-prompt, cost-state, mode, system/compact_boundary, system/local_command, api-request*`.

**History replay.** `--resume` replays **nothing** on stdout: only hook records, `session_title_changed` and the initialize reply before our first prompt (`resume.jsonl:3-13`). We read the file ourselves:
1. Follow the `parentUuid` chain of the main thread (`isSidechain:false`).
2. Turn `assistant` blocks plus the matching `user` tool_result/`toolUseResult` into the same items as live.
3. At a `compact_boundary`, show a compaction notice and the `isCompactSummary` user record.
4. Take `custom-title` for the name.

Paseo does this (`agent.ts:6443-6500`, `transcript-history.ts`). The SDK's `getSessionMessages(id,{dir})` (`sdk.d.ts:935`) is pure JS and an alternative.

**List sessions.** Scan that directory, or call SDK `listSessions({dir, includeProgrammatic:true})` (`sdk.d.ts:1150-1186`). Our sessions are `entrypoint:"sdk-cli"`. Pickers that copy the terminal's `/resume` hide them: `includeProgrammatic:false` "for parity with terminal /resume" (`sdk.d.ts:1176-1186`). So our own picker must include them.

**Resume.** `--resume <id>` (`resume.jsonl:1`). The model kept the context and answered "two".

**Fork.** `--resume <id> --fork-session` gets a new id (`fork.jsonl:9`: `73412b22…`, against the original `eb6b47aa…`). The SDK's `forkSession(id,{upToMessageId})` forks from a given message (`sdk.d.ts:871`).

**Rename.** `control rename_session {title, source:"host"}` → `system/session_title_changed {title}` (`main.jsonl:257-259`). It is persisted as `custom-title`. `-n/--name` sets it at launch.

### Slash commands

**List them.** `initialize.commands[] = {name, description, argumentHint}` (`main.jsonl:11`: 91 entries, skills included). Also `init.slash_commands`, and `init.terminal_slash_commands` (`doctor, color, focus, reload-plugins`: hide these). The CLI pushes `commands_changed` with REPLACE semantics (`sdk.d.ts:3870`).

**Run them.** Send `/name args` as user text.
- **Local commands** answer with no model turn: an `assistant` with `model:"<synthetic>"`, `local_command_run` and markdown text, then `result {local_command:"context", result:<text>, num_turns:0}` (`resume.jsonl:137-146`: `/context`, `/cost`, `/model`). Paseo surfaces `result` text when the turn streamed none (`agent.ts:5005-5020`).
- **TUI-only commands:** `/theme` → "/theme isn't available in this environment." (`resume.jsonl:149`). Hand off to the TUI for `/login`, `/config`, `/theme` and the like.
- **Unknown names** go to the model as plain text (`resume.jsonl:195`; [docs](https://code.claude.com/docs/en/agent-sdk/slash-commands) "Dispatch commands by name").
- Skills (`/skill-name`) and `/compact`, `/clear` and `/rename` all work over stdin.

## 4. Capability column

| capability | Claude Code |
|---|---|
| `steer` | **yes**. `priority:"next"` folds mid-turn, `"later"` queues a follow-up, `"now"` interrupts and runs. The queue is visible through `command_lifecycle`, and an item is cancelled with `cancel_async_message` |
| `thinkingLevels` | effort `low…max` per model (`supportedEffortLevels`), set live. On/off needs a restart. Thinking text needs `--thinking-display summarized` |
| `permissions` + `permissionModes` | **yes**: `can_use_tool` with Allow once / Always (suggestions) / Deny. Modes: `default, acceptEdits, plan, auto, dontAsk, bypassPermissions` (bypass only when launched with it allowed) |
| `extensionUi` | partial: hook start/response, `notification`, `informational`. No statusline, no widgets |
| `compact` / `rename` / `fork` | yes (`/compact [instr]`) / yes (`rename_session`) / yes (restart with `--fork-session`; from a message via `forkSession(upToMessageId)`) |
| `images` in prompts | yes (base64 image blocks; PDFs as `document` blocks) |
| `slash` | `initialize.commands` (+ `commands_changed`). Hide `terminal_slash_commands`, and hand interactive-only ones to the TUI |
| `tui` | `claude --resume <id>` in the chat cwd |
| extra | `tool_progress` by polling `get_task_output`; `usage` from `get_context_usage`; `subagents` nested by `parent_tool_use_id` |

## 5. TUI hand-off

**The argv.** `claude --resume <session-id>`, run in the chat's cwd. Add `--permission-mode <same>` to keep the mode.
- This was verified with an SDK-created session. The TUI showed its whole history, including the local-command output, and continued it.
- The workspace trust prompt can appear first.
- A bare `--resume` opens a picker that hides our `sdk-cli` sessions, so always pass the id.
- `claude --continue` is "most recent in cwd" and ambiguous.

**Two processes on one session are not safe, and nothing stops them.**
- While a stream-json process held session `eb6b47aa…`, a second `claude -p --resume eb6b47aa… "Reply with OK"` ran under the **same** session id, answered "OK", and appended to the same file.
- An interactive `claude --resume` of that id also opened it, with no "copy" notice.
- The CLI does have a fork-on-conflict path, "is open in another Claude Code process, so this started a copy as …" (strings in the 2.1.303 binary). It applies to background (`--bg`/respawn) sessions: `resume_session_live_elsewhere`, and `startup_failure_reason: session_held_by_background`.

**The CLI's live-process registry is `~/.claude/sessions/<pid>.json`**, e.g. `{pid, sessionId, cwd, kind:"interactive", entrypoint:"sdk-cli", status:"idle", …}`. It is written while a process runs, and stale files remain after a SIGKILL. **Our guard:**
1. Before spawning on a session, scan that directory for files with that `sessionId` and a live `pid`. If one exists, offer "Fork" or "Take over" instead.
2. On hand-off, stop our process first: close stdin, wait for exit, tree-kill on timeout. Then run the TUI, and respawn with `--resume` after it exits. This is what Pi's `handoff`/`resume` ops already do.

**How the upstream apps guard it.**
- Orca serialises acquisitions per session inside its own app (`structured/claude-structured-session-acquisition.ts:54`, `acquisitions.start(sessionId)`).
- Paseo tree-kills on close (`agent.ts:3034-3053`).
- None of them checks the CLI's registry.

## 6. What a GUI can't get from this interface

| gap | how we and the upstream apps cope |
|---|---|
| Streaming bash output | Poll `get_task_output` once `task_started` arrives (the first ~3 s show nothing). Otherwise the card shows a spinner and `elapsed`. |
| Thinking text in the default display | `--thinking-display summarized` (Orca snapshot; T3 `ClaudeAdapterV2.ts:1574-1576`). Redacted thinking stays a token counter. |
| History on resume | Read the JSONL transcript ourselves (Paseo `transcript-history.ts`). |
| A structured Bash exit code | Parse `Exit code N`. |
| TUI-only commands (`/login`, `/config`, `/theme`, `/doctor`, `/terminal-setup`, the `/resume` picker, statusline) | Hand off to the TUI, or rebuild them from control ops: models, effort, mode, rename, and context via `get_context_usage`. |
| The statusline and custom Ink UI | Not on the wire. Orca installs its own statusline and hook scripts to observe state (`claude/statusline-install.ts`, `hook-service.ts`). We don't need to. |
| `request_user_dialog` tool dialogs | Only sent for kinds we declare, so declare none and those tools fall back. |
| Auth flows | `claude auth login` in a terminal. |
| A reliable "is it idle" between turns | `session_state_changed` (env flag). Background wakes start turns we didn't send (Paseo `agent.ts:4087-4093`). |
| Who else holds the session | The registry check (§5). |

## 7. Recommended adapter design

`host/providers/claude/`:
- **`process.ts`.** Spawn per §1, keeping stdin, stdout and stderr all piped. **Always drain stderr** (T3 `ClaudeAdapterV2.ts:377`) and keep a 4 KiB tail for `exited`.
  - Use LF-only framing with the 8 MiB record cap the Pi adapter already has.
  - Send `initialize` with a 30 s timeout: MCP servers can delay it (T3 `ClaudeAdapterV2.ts:328`).
  - Then emit `session`, `model` and `capabilities`.
- **`control.ts`.** Track request ids for outbound control requests (`r<n>`) and route each `control_response` by `response.request_id`.
  - Handle inbound `control_request`s: `can_use_tool` and `elicitation`.
  - Reply `{subtype:"error"}` to any subtype we don't handle, **except** `request_user_dialog`, which must stay unanswered (`sdk.d.ts:5313`).
  - Honour `control_cancel_request`.
- **`mapper.ts`.** A pure function: `SDKMessage → normalized events` (§2). Keep its state per (`api_message_id`, `index`).
  - Never let subagent records (`parent_tool_use_id` set) open top-level items.
  - Dedupe the `can_use_tool` echo that `--replay-user-messages` produces: our own `control_response` comes back on stdout (`extra.jsonl:328`).
- **`history.ts`.** Read the transcript (§3) and run it through the same item builder.
- **`sessions.ts`.** List sessions from `~/.claude/projects/<enc(cwd)>/`, check the live registry, and handle rename/fork.
- **Commands.** `prompt` → `user` with our uuid and a `priority` (`auto` means `next` while working, otherwise just send). `abort` → `interrupt{cancel_queued:true}`. `answer` → `control_response`. `setModel` → `set_model`. `setThinking` → `apply_flag_settings{effortLevel}`. `compact` → `/compact`. `newSession` → restart. `switchSession` → restart with `--resume`. `setName` → `rename_session`. `tuiCommand` → `["claude","--resume",id]`.

### Pitfalls to copy (avoid the bug) or avoid

1. **Detect turn end.** `result` ends a turn, `session_state_changed idle` ends the run. Don't treat `message_stop` as the end of a turn: one turn makes many API calls.
2. **Assistant records.** They come one block at a time and share a `message.id`. Don't concatenate them as separate messages.
3. **Usage counters.** `total_cost_usd` and `modelUsage` are cumulative per process and reset when a new process starts. Remember the last value at a restart and add it to the new ones.
4. **Priority.** Always set `priority`, since the default is behind a feature flag.
5. **The `Task`/`Agent` name.** `init.tools` says `Task`, the model calls `Agent`. Both mean subagent.
6. **Deferred tools.** Tools loaded with `ToolSearch` don't appear in `init.tools`.
7. **Local commands.** Their output is a synthetic assistant message plus `result.result`. Show it once.
8. **`--bare`** breaks OAuth.
9. **`--no-session-persistence`** is ignored in this mode. Delete the transcript if a chat must be ephemeral (Paseo `agent.ts:3055`).
10. **`NODE_OPTIONS`.** Remove it from the child env, as the SDK does: the Node inspector or ESM loaders break the CLI.
11. **Command-line JSON.** Don't put large inline JSON in argv for MCP config on Windows (Paseo `query.ts` note on `shell:false`). We don't need `--mcp-config`.
12. **The CLI refuses some commands.** `sleep 30 && echo` was "Blocked … use Monitor with an until-loop" (seen in a first probe run that wasn't kept). Fake-agent scripts shouldn't rely on sleep.
13. **Exit codes.** The exit code is 1 when the last turn was aborted (`queue.jsonl:155`). Treat it as an error only when it comes with no `result`, or with a `startup_failure_reason`.
14. **Settings files.** Plugins and the user's hooks load, as in their TUI. Settings files that fail validation are **skipped silently** in `-p` (*help*). Surface `init.plugin_errors`.

### Fake agent for tests

A small Node script, `test/fake-claude.mjs`, that speaks the same protocol. The host gets it through a `CLAUDE_BIN` override. The scripts replay **recorded** record sequences from `samples/claude/*.jsonl` (the `out` records), with fresh `session_id`/uuids, keyed by the prompt text. What to script:
1. **`initialize`** → a recorded response. Delay it, or reply with an error, to test timeouts.
2. **Text turn.** Deltas, then the block-end assistant record, `message_delta`, `result`, and `session_state_changed idle`.
3. **Tool turn with an ask.** Emit `can_use_tool` and **block** until the matching `control_response` arrives. Then emit a tool_result whose content and `tool_use_result` depend on allow or deny, including `updatedPermissions` echoed into the next ask being skipped.
4. **Edit turn.** A `structuredPatch` → a diff card.
5. **Long Bash.** `task_started` after N ms. Answer `get_task_output` with growing output.
6. **Interrupt.** While "running", an `interrupt` → `task_notification stopped`, the interrupted marker, `result error_during_execution`, idle. With `cancel_queued`, emit `command_lifecycle cancelled` for each queued uuid.
7. **Mid-turn sends.** `priority:"next"` → fold: one result, with both uuids in `user_message_uuids`. `"later"` → `command_lifecycle queued/started/completed` and a second turn.
8. **`/compact`** → the status and `compact_boundary` sequence. **`/context`** → a synthetic assistant message and a `local_command` result. **`/theme`** → the "isn't available" result.
9. **Subagent.** Records with `parent_tool_use_id`, plus the `task_*` records.
10. **AskUserQuestion and ExitPlanMode asks.** A `control_cancel_request` that withdraws an ask.
11. **Failures.** An `api_retry` notice, then an `assistant.error:"rate_limit"` with `result.is_error`. A garbage stdout line. A record over 8 MiB. A crash mid-turn (exit 1 with a stderr tail). Exit on stdin EOF.
12. **Resume.** The fake writes a transcript JSONL that `history.ts` must rebuild into the same items as the live run. **The test compares the live and resumed item lists.**

Live check (one run per release): the probe, which replays these scenarios against the real CLI with `--model haiku` and diffs the record *types* and *shapes* against the fixtures, so protocol drift shows up.
