# herdr-chat wire protocol (v1)

The contract between **herdr-chat-host** (Node, owns `pi --mode rpc`) and its
clients (the Herdr mod `chat` (folder `herdr-app/mods/chat`), the `herdr-chat-host inspect` CLI, tests).
Both sides change only together. Bump `v` on breaking changes.

## Transport

- TCP on `127.0.0.1`. The host listens on an OS-assigned port (`listen(0)`).
- JSONL framing: one JSON object per record, UTF-8, terminated by `\n`.
  Split on `\n` only. Never treat U+2028/U+2029 as separators.
- The first client record must be `hello` within 5 s, else the host closes the
  socket. A wrong token closes the socket without a reply. Compare tokens in
  constant time.
- Several clients may be connected at once. They all get the same records.

## Chat registry (discovery)

The host writes `<stateDir>/chats/<chat>.json` with mode 0600:

```json
{ "v": 1, "chat": "c-1a2b3c4d", "pid": 4242, "port": 51234, "token": "<64 hex>",
  "cwd": "/abs/dir", "sessionFile": "/abs/x.jsonl" | null, "terminal": "t7" | null,
  "startedAt": 1793700000000, "agentVersion": "1.5.0" | null }
```

- `stateDir` is passed on the host command line (`--state-dir`). The mod uses
  `appHome() + "/data/herdr-chat"`.
- **Atomic write:** write a temp file, then rename it over the old one.
- `terminal` is `$HC_TERMINAL_ID` of the host's terminal.
- On clean exit the host rewrites the file with `pid: null, port: null` and
  keeps `sessionFile`, so a client can restart the chat on the same session.
- A client treats the host as alive only after a successful `hello`/`welcome`.
  A `pid` alone doesn't prove it.

## Records: client → host

```jsonc
{"t":"hello","v":1,"token":"…","client":"mod"|"cli"|"test"}
{"t":"req","id":"r1","op":"<op>", ...args}          // see Ops
```

## Records: host → client

```jsonc
{"t":"welcome","v":1,"chat":"c-…","host":{"pid":1,"version":"0.1.0"}}
{"t":"snapshot","seq":12,"state":ChatState,"items":Item[],"hasOlder":false}
{"t":"patch","seq":13,"state":{…partial ChatState},"upsert":[Item…],"remove":["id"]}
{"t":"res","id":"r1","ok":true,"data":…}            // or {"ok":false,"error":"text"}
{"t":"toast","level":"info"|"warning"|"error","text":"…"}
{"t":"bye","reason":"…"}
{"t":"ping"}                                      // every 15 s; clients ignore it (keeps idle sockets readable)
```

- `snapshot` is sent right after `welcome`, and again whenever the host
  replaces its whole timeline (new session, switch session). `items` holds the
  newest `MAX_SNAPSHOT_ITEMS` (200) items, oldest first. `hasOlder` says
  whether more exist; fetch them with `history`.
- `seq` grows by 1 for every snapshot and patch.
- A `patch` applies to the client's copy in this order:
  1. Shallow-merge `state` into the client's `ChatState`. A key set to `null`
     clears it.
  2. Upsert each item by `id`: replace it whole if known, else append. New
     items always come after existing ones in timeline order.
  3. Drop the `remove` ids.
- **Ordering:** before every `res`, the host flushes pending state and items, so
  an op's effects (e.g. `phase: "handoff"`) arrive before its `res`.
- **Coalescing:** the host flushes changed items and state at most every
  50 ms. Changes to `phase`, `dialog`, `queue` and errors flush immediately.
  An item is always sent whole (bounded, see Limits), never as a diff.

## ChatState

```ts
type ChatState = {
  phase: "starting" | "idle" | "working" | "compacting" | "handoff" | "exited" | "error";
  error: string | null;          // last fatal or startup error, plain text
  cwd: string;
  sessionFile: string | null;
  sessionName: string | null;
  agentVersion: string | null;
  model: { provider: string; id: string; name: string; reasoning: boolean; contextWindow: number | null;
           input: string[] } | null;
  thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | null;
  usage: { contextTokens: number | null; contextWindow: number | null; percent: number | null;
           cost: number | null } | null;
  queue: { steering: string[]; followUp: string[] };
  dialog: Dialog | null;         // the oldest open extension dialog; answer it to see the next
  dialogsPending: number;        // open dialogs, including `dialog`
  statuses: { key: string; spans: Span[] }[];             // extension setStatus, key order
  widgets: { key: string; placement: "aboveEditor" | "belowEditor"; lines: Span[][] }[];
  title: string | null;          // extension setTitle (ANSI stripped)
  editorText: string | null;     // extension set_editor_text; client puts it in the composer, then calls ack_editor_text
  commands: Command[];           // the slash menu, built-ins first
};

type Span = { text: string; fg?: string; bg?: string; bold?: true; dim?: true; italic?: true; underline?: true };
// fg/bg: "ansi0".."ansi15" (the theme's ANSI colors), "#rrggbb", or (v2) "syn:<token>" for syntax highlighting.
// Tokens: keyword, string, number, literal, function, title, type, class, comment, variable, attr, property,
// meta, tag, punctuation, operator, regexp, symbol, built_in, params, section, bullet, link, emphasis, strong,
// addition, deletion. The client maps them to theme colors (visual-v2.md §3).

type Dialog = {
  id: string;                    // Pi's extension_ui_request id
  method: "select" | "confirm" | "input" | "editor";
  title: string; message?: string; options?: string[]; placeholder?: string; prefill?: string;
  timeoutAt?: number;            // epoch ms, when Pi auto-resolves it
};

type Command = {
  name: string;                  // without "/"
  description: string;
  source: "builtin" | "extension" | "prompt" | "skill";
  handler: "host" | "client";    // client: the mod handles it (pickers, terminal hand-offs)
  args?: string;                 // hint, e.g. "[instructions]"
  argv?: string[];               // a terminal utility's command (/login, /settings)
  input?: string;                // a command that opens the agent's terminal: typed there once it's idle ("/login")
};
```

## Item (timeline)

Each item has `id` (stable for its lifetime), `kind` and `ts` (epoch ms).

```ts
type Item =
  | { id; kind: "user"; ts; text: string; images: number; imagePaths?: string[];
      source: "composer" | "external" | "queued" | "extension"; from?: string;
      skill?: { name: string; command: string; path?: string; body?: string } }
  | { id; kind: "assistant"; ts; text: string; streaming: boolean;
      stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted"; error?: string; autonomous?: true;
      blocks?: Block[];           // v2: `text` split for rendering; absent = one markdown block
      model?: string;             // v2: "provider/id" that produced it
      durationMs?: number;        // v2: message_start → message_end
      usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number | null } }
  | { id; kind: "thinking"; ts; text: string; streaming: boolean; durationMs?: number }
  | { id; kind: "tool"; ts; toolCallId: string; name: string;
      title: string;              // one line: "$ ls -la", "Read src/x.ts:10-40", "Edit src/x.ts", "mcp figma · get_file"
      status: "pending" | "running" | "done" | "error";
      args: string;               // pretty JSON, bounded
      output: string;             // text output, bounded (tail kept); ANSI stripped
      outputTruncated: boolean;   // full text via op "tool_output"
      durationMs?: number;
      images?: string[];          // absolute paths of images in the result, saved by the host
      outputLines?: Span[][];     // v2: `output` as styled lines: bash keeps ANSI colors, read is syntax highlighted
                                  //     by the file's extension (same bounds as `output`)
      detail: ToolDetail }
  | { id; kind: "notice"; ts; level: "info" | "warning" | "error";
      source: "notify" | "retry" | "compaction" | "extension_error" | "host" | "queue";
      text: string; spans?: Span[] }
  | { id; kind: "custom"; ts; customType: string; text: string };   // display:true custom messages

// v2: assistant text split into render blocks by the host (fences in the order they appear).
type Block =
  | { type: "markdown"; text: string }
  | { type: "code"; lang: string | null; code: string; open: boolean;   // open: fence not closed yet (streaming)
      lines?: Span[][] }                                                // syntax highlighted, one Span[] per line (≤ 2000 lines)
  | { type: "mermaid"; source: string; open: boolean;
      svg?: string;                 // abs path of the rendered SVG (closed blocks only), themed by `set_theme`
      ascii?: Span[][];             // box-drawing fallback (when SVG fails)
      error?: string };

type ToolDetail =
  | { type: "bash"; command: string; exitCode?: number | null }
  | { type: "read"; path: string; offset?: number; limit?: number }
  | { type: "edit"; path: string; diff: string | null;             // unified diff text when known
      added?: number; removed?: number;                             // v2: line counts
      diffLines?: { kind: "hunk" | "add" | "del" | "ctx" | "meta"; old?: number; new?: number; spans: Span[] }[] }  // v2: highlighted
  | { type: "write"; path: string; bytes?: number }
  | { type: "search"; tool: string; query?: string; path?: string } // grep, find, ls
  | { type: "generic"; server?: string; tool: string };             // MCP (mcp__server__tool) and anything else
```

- **Order:** items are in timeline order. For one assistant response, the
  thinking, text and tool items appear in Pi's `contentIndex` order. A tool
  item is created at `toolcall_start`, or at `tool_execution_start` if that
  comes first, and finished at `tool_execution_end`.
- **History:** the same items are rebuilt from history (`get_messages` on
  resume), so live and resumed timelines look the same.
- **Images:**
  - The host saves the images in tool results, and those attached to user messages, as files: `<stateDir>/images/<chat>/<item id>-<n>.<png|jpg|gif|webp>`.
  - It lists them in `images` / `imagePaths` (absolute paths). These are at most 8 per item.
  - The mod shows them with `image()`, using a path relative to the app home when it can.
  - Base64 never goes over the wire.
- **Skills:** a message that runs a skill carries `skill`, and `text` is only
  what the person wrote after it. The mod draws the skill as a pill (a click
  shows `body`, what the agent got). `command` is what the person types to run
  it again, without the slash: Pi `skill:<name>`, Claude Code and Codex
  `<name>`. The host takes it from Pi's expanded `<skill …>` block, Codex's
  `skill` input item, or a leading `/<command>` that names one of the chat's
  `skill` commands (`host/skill.ts`). The transcript prints `/<command> text`.
- **Autonomous runs:** an assistant response whose run the user didn't start
  gets `autonomous: true`, preceded by a notice (`source: "host"`) naming the
  cause when known. Examples: an extension wake, a queued follow-up, a
  subagent report.

## Ops (`{"t":"req","id","op",...}`)

| op | args | data | notes |
|---|---|---|---|
| `send` | `text`, `images?: string[]` (abs paths), `mode?: "auto"\|"steer"\|"followUp"` | `{disposition: "started"\|"queued"\|"handled"\|"pending"}` | `auto`: steer while working, else prompt. `followUp` while working: held by the host until the run settles (v3.2). A leading `/name` that is a host built-in runs that built-in. Pi's prompt reply can come late or never (an extension command waiting on a dialog or `custom()`), so the host answers with Pi's `disposition` if it arrives within 1.5 s, else `pending`. Later failures arrive as a toast + notice |
| `abort` | | `{restored: string[]}` | `clear_queue` then `abort`. `restored` is the queued text, for the composer: the steers, then the follow-ups |
| `dialog_answer` | `dialog`, one of `value` / `confirmed` / `cancelled: true` | `{}` | |
| `ack_editor_text` | | `{}` | clears `state.editorText` |
| `models` | | `{models: {provider,id,name,reasoning,enabled}[]}` | `enabled` = in the user's `enabledModels` |
| `set_model` | `provider`, `modelId` (or `model: "provider/id"`) | `{}` | not `id`: that is the request's own id |
| `set_thinking` | `level` | `{}` | |
| `compact` | `instructions?` | `{}` | |
| `new_session` | | `{}` | then a new snapshot |
| `set_name` | `name` | `{}` | |
| `sessions` | | `{sessions: {path,name,firstMessage,modified,messageCount}[]}` | Pi sessions for this cwd, newest first |
| `switch_session` | `path` | `{}` | then a new snapshot |
| `fork_points` | | `{points: {id, text}[]}` | the person's messages in this session, newest first, as typed (a skill as its `/command`). Refused when the agent can't fork (`capabilities.fork`) |
| `fork` | `point` | `{text}` | a new session holding what came before that message (the agent's own fork: Pi `fork`, Claude Code `--fork-session --resume-session-at`, Codex `thread/fork`); the original is unchanged. Then a new snapshot, and `text` (the message, as typed) is the client's to put in its composer |
| `files` | `query`, `limit?` | `{files: string[]}` | cwd-relative paths, fuzzy-ranked. `git ls-files` (else a bounded walk), cached and refreshed every 30 s |
| `clipboard_image` | | `{path: string \| null}` | saves the clipboard image to a temp PNG (macOS: osascript «class PNGf») |
| `history` | `before` (item id), `limit?` | `{items, hasOlder}` | older items |
| `tool_output` | `item` | `{text}` | full output, up to 1 MiB |
| `handoff` | | `{sessionFile}` | stops Pi (aborts first if working), releases the lock, phase → `handoff` |
| `resume` | | `{}` | after a handoff, or to restart Pi: `--session <sessionFile>` (re-reads auth and settings) |
| `shutdown` | | `{}` | stop Pi and the host (closing the chat) |
| `set_theme` | `colors: {background, foreground, muted, border, accent, ansi0..ansi15}`, `dark: boolean` | `{}` | v2: colors for host-rendered SVGs (mermaid). Re-renders the closed mermaid blocks and sends them as upserts |

## Built-in slash commands (in `state.commands`, `source: "builtin"`)

| name | handler | does |
|---|---|---|
| `model` | client | opens the model picker (`models` / `set_model`) |
| `thinking` | client | opens the thinking picker (`set_thinking`) |
| `compact` | host | `compact` with the rest of the line as instructions |
| `new` (alias `clear`) | host | `new_session` |
| `name` | host | `set_name` |
| `resume` | client | sessions picker (`sessions` / `switch_session`) |
| `reload` | host | `resume` (restart Pi on the same session) |
| `copy` | client | last assistant text to the clipboard |
| `tui` | client | hand off to Pi's TUI in a terminal pane (`handoff`, then `resume` when it exits) |
| `login`, `settings`, `scoped-models` | client | run `pi --no-session` in a terminal pane, then `resume` once it exits |
| `fork` | client | a picker of `fork_points`, then `fork` |
| `tree`, `export`, `hotkeys` | client | like `tui` (they need the session in Pi's TUI) |

Anything else starting with `/` goes to Pi as prompt text: extension
commands, prompt templates and `skill:` commands.

## Host ↔ Herdr (the host's own terminal)

- **Status (stdout):** OSC 7501, same states as Pi's TUI:
  `working` (run or compaction), `blocked` (open dialog; `msg` = its title),
  `done`, `error`, `idle`. Always `app=pi`. Format:
  `ESC ] 7501 ; state=…:app=pi[:msg=<base64>] ESC \`.
- **Input (stdin, raw mode, bracketed paste on with `ESC[?2004h`):** text
  pasted by `hc send` is submitted on `\r` as `send` with
  `source: "external"`. A leading `<hc from="t7 name">…</hc>` sets `from`.
  `ESC` alone or `Ctrl-C` → `abort`.
- **Title (stdout):** OSC 0 with the chat's title. That is the session name, else the extension `setTitle`, else the first user message trimmed to 60 chars, else "Pi". Herdr names notifications after it.
- **Screen:** an append-only plain transcript for `hc read`:
  `> user text`, the final assistant text, one line per tool
  (`· $ ls -la ✓`), notices. No full-screen redraw.

## Limits

| What | Limit |
|---|---|
| tool `output` in an item | tail 16 KiB (`outputTruncated: true`) |
| `args` | 4 KiB |
| tool output kept by the host | 1 MiB |
| assistant/thinking text per item | 256 KiB (head kept, then a truncation marker) |
| snapshot items | 200 |
| record size, both directions | 8 MiB; larger records are dropped and logged |
| code block highlighting | 2000 lines per block, 60k spans per item |
| `diffLines` | 256 KiB of diff |
| mermaid source | 32 KiB |

v2 wire details:
- `diffLines[].spans` exclude the `+`/`-`/space marker; `kind` says which.
- `old`/`new` are omitted when the hunk header has no line positions.
- A code or mermaid block is `open` only while its item is streaming.
- A tool-only assistant message's `usage`/`durationMs` carry over to the next item with text, so a run's assistant items add up to the run.
- Mermaid SVGs are flattened for native renderers (resvg): no `var()`, `color-mix`, `@import` or `foreignObject`; generic font families; a background rect.


## v3: providers (Pi, Claude Code, Codex)

The wire stays the same. Everything below is additive, and Pi chats keep
working unchanged.

### ChatState additions

```ts
provider: "pi" | "claude" | "codex";
providerName: string;                 // "Pi", "Claude Code", "Codex"
capabilities: {
  steer: boolean;                     // a message mid-run is folded into the current run
  followUp: boolean;                  // a message mid-run can wait for the run to end
  thinkingLevels: string[];           // the picker's levels for the current model; [] = no picker
  permissions: boolean;               // the agent asks for approval itself (permission dialogs)
  permissionModes: { id: string; label: string; description?: string }[];  // [] = no mode chip
  extensionUi: boolean;               // statuses/widgets can arrive (Pi extensions)
  compact: boolean; rename: boolean; fork: boolean;
  compactInstructions: boolean;       // /compact takes instructions (Codex: no)
  images: boolean;                    // the current model takes images
  cost: boolean;                      // usage.cost is meaningful (Codex: tokens only)
  tui: boolean;                       // a TUI hand-off exists
};
permissionMode: string | null;        // current id from capabilities.permissionModes
```

`state.commands` (the slash menu) is per provider. The host merges its
built-ins with the agent's commands:
- Pi: `get_commands`;
- Claude: `initialize.commands`, minus the terminal-only ones;
- Codex: skills plus `~/.codex/prompts`.

### Dialog additions

```ts
// method "permission": the agent asks before running a tool.
{ id; method: "permission"; title: string; message?: string;
  tool?: { name: string; title: string; detail?: ToolDetail; args?: string };   // what will run, rendered like a tool card header
  choices: { id: string; label: string; kind: "allow" | "allow_always" | "deny" | "other"; description?: string }[];
  timeoutAt?: number }
// method "questions": the agent asks the user (Claude AskUserQuestion, Codex requestUserInput).
{ id; method: "questions"; title: string;
  questions: { id: string; header?: string; question: string;
               options: { label: string; description?: string }[]; multiSelect: boolean; allowOther: boolean }[] }
```

`dialog_answer` takes, as well as `value` / `confirmed` / `cancelled`:
- for `permission`: `choice` (a choice id), plus an optional `message` (the reason for a deny, or feedback for the agent);
- for `questions`: `answers: { [questionId]: string | string[] }`.

### Item additions

```ts
// any item: `parent?: string`, the id of the tool item (a subagent) whose run produced it.
// The client nests it under that card, collapsed.
| { id; kind: "plan"; ts; explanation?: string;
    steps: { text: string; status: "pending" | "in_progress" | "completed" }[] }      // a todo list or plan update; replaced in place
// tool items: status may be "declined" (a permission was denied or the tool was blocked by a rule)
ToolDetail +=
  | { type: "web"; tool: "fetch" | "search"; url?: string; query?: string }
  | { type: "agent"; description: string; agentType?: string }                        // subagent (Claude Agent/Task, Codex collab)
```

### Ops

| op | args | notes |
|---|---|---|
| `set_permission_mode` | `mode` | one of `capabilities.permissionModes` |
| `models` | | as before. The list is the provider's, and `set_model` takes that provider's ids |

### The launcher and the registry

- Chat props become `{chat, cwd, provider}`, default `pi`. The host is started as `serve --provider <p>`.
- The registry records `provider`.
- OSC 7501 reports `app=<provider>`.
- The TUI hand-off argv comes from the adapter: `pi --session <f>`, `claude --resume <id>`, `codex resume <threadId>`.


### Built-in commands per provider (v3)

- **Wording.** `state.commands` built-ins depend on the provider. Descriptions use `providerName`, e.g. "/reload restarts Claude Code".
- **Offered by capability:**
  - `thinking` needs `thinkingLevels`;
  - `compact` needs `compact` (its `[instructions]` argument `compactInstructions`; without it, `/compact <text>` is refused);
  - `name` needs `rename`;
  - `fork` needs `fork` (the adapter has `forkPoints` and `fork`);
  - `tui` needs `tui`.
- **Terminal utilities** (`login`, `settings`, `scoped-models`) are offered only when the adapter has an argv for them. The menu entry carries it as `Command.argv`, and the client runs that argv in a terminal in the chat's cwd (no pane: a dialog over the chat shows it), then sends `resume`.
- **What to type** (`Command.input`): for a utility or a TUI command, the client types it into the terminal once the agent is idle (`hc wait`, then `hc send --if idle`), so the person lands on that screen. A TUI command's is `/<name>`; a utility's is the adapter's `tuiInput(name)` (Pi: `/login`, `/settings`, `/scoped-models`; Claude Code: `/config` for `settings`).

  | provider | login | settings |
  |---|---|---|
  | Pi | `pi --no-session` | `pi --no-session` |
  | Claude | `claude auth login` | `claude` |
  | Codex | `codex login` | not offered |

  Pi also offers `scoped-models` (`pi --no-session`).
- **TUI commands**: the agent's commands that work only in its own TUI, from the adapter's `tuiCommands()` (Pi: its built-ins RPC doesn't run, such as `tree`, `export`, `share`, `session`; Claude Code: its terminal-only commands such as `doctor`, `theme`, `statusline`; Codex: its TUI's, such as `init`, `status`, `review`, `diff`, `mcp`; each minus those the chat has its own way for). Offered when `tui`; each is a `/tui`-style hand-off that types `/<name>`.
- **Op `utility {name}`** returns `{argv}`, or errors with "<Agent> has no /<name>".
- An agent command named like a built-in stays hidden. A built-in that isn't offered is sent to the agent as text.


## v3.1: hand-off watch, session conflicts, report senders (feedback round 1)

## ChatState

```ts
phase: … | "conflict";               // new value: another live writer has the session; the agent is not started
handoff: { argv: string[]; terminal: string | null; since: number } | null;
  // set by `handoff` (argv = the TUI command, terminal = null until `handoff_started`), cleared on resume
conflict: { chat: string | null; terminal: string | null; pid: number | null } | null;
  // chat/terminal/pid of the other chat's host (from its session lock);
  // chat: null = an agent process outside any chat (Claude Code's ~/.claude/sessions registry, Codex "active writer"; pid null when Codex doesn't say)
queue: { steering: string[]; followUp: string[];
         steeringFrom?: (string | null)[]; followUpFrom?: (string | null)[] };
  // aligned with the texts: the `from` of an `hc send` report (e.g. "t7 review"), null = the user. Present only when some entry has a sender.
```
`handoff` and `conflict` flush immediately (like `phase`).

## Ops

| op | args | data | notes |
|---|---|---|---|
| `handoff` | | `{sessionFile, argv}` | as before, plus: `state.handoff` is set and the host watches the hand-off. Pi's argv is now `["env", "HERDR_CHAT_HANDOFF=<stateDir>/handoff/<chat>.json", "pi", "--session", <file>]`. Asking again during a hand-off returns the same argv. Refused in `conflict` |
| `handoff_started` | `terminal` (the TUI terminal's hc address) | `{}` | from then on the host polls `hc get <terminal> --json` every 2 s. Idempotent: a reloaded mod can send it again. Error if not in a hand-off |
| `resume` | | `{}` | works at any time. From a hand-off: reads `<stateDir>/handoff/<chat>.json`; if its `sessionFile` differs and exists, resumes that one (registry updated, an info notice). If the TUI still runs, resumes anyway with a warning notice. In `conflict`: re-checks, stays in conflict (no error) if still held |
| `take_over` | | `{}` | in `conflict` with another chat: connects to it through its registry, sends `shutdown`, waits for its pid to exit (15 s), then opens the session. Errors: "…outside a chat (pid N). Quit it there, then use resume." when `conflict.chat` is null; "Can't reach the other chat…" / "…did not close…" |
| `new_session` | | `{}` | in `conflict`: leaves it and starts a new session |
| `switch_session` | `path` | `{}` | a path another chat holds → stops the agent, phase `conflict` on that path (timeline emptied). In `conflict`: tries `path` |

## Hand-off watch (host)

- `terminal` reported: `hc` says `finished` or `not_found` → wait until the TUI pid (from the hand-off file) and any process on the session are gone → resume by itself. `hc` errors 5x in a row → falls back to the process watch below.
- No terminal within 60 s: resume when no live process is on the session: the hand-off file's pid, the agent's guard (Claude registry), else a `ps` scan for a pi/claude/codex process whose argv has the session (the argv's last arg).
- Independent of clients: works with no mod connected.
- Refused ops in `handoff`: "Pi is open in the terminal UI (terminal t7). Quit it there, or use resume (Return to chat) to come back."
- Refused ops in `conflict`: "This session is open in another chat (terminal t7). Go to that chat, or use take_over to move it here." / "This session is open in Claude Code outside a chat (pid N). Quit it there, then use resume."

## Built-ins

`transcript` (handler `client`, "Show the plain transcript"), after `copy`, for every provider.

## Host env (tests, tuning)

`HERDR_CHAT_HC` (hc binary, default `hc`), `HERDR_CHAT_HANDOFF_POLL_MS` (2000), `HERDR_CHAT_HANDOFF_GRACE_MS` (60000).

## Notes for the mod

1. Send `handoff_started {terminal}` right after `hc run` returns the TUI's address, and again after a reload if `state.handoff` is set. You can drop the mod's own TUI watch and its `resume` on exit: the host resumes by itself.
2. The settings' `<agent>.tui` replaces the program after the `env K=V…` prefix (Pi's argv starts `env HERDR_CHAT_HANDOFF=…`).
3. Show the "Return to chat" banner from `phase === "handoff"` / `state.handoff`. Show the conflict banner from `state.conflict`: "Go to that chat" when `conflict.chat` is set (registry `<chat>.json` → its terminal), else only "Quit it there"; "Take over" → `take_over`.
4. After `take_over`, the other chat's host sends `bye {reason: "shutdown"}` and exits. Its mod should treat that as the chat being closed.
5. Report cards: the queued user item keeps `from` (source `queued`), and the queue chip can read `queue.steeringFrom[i]`.

## v3.2: the steering and follow-up lanes

Steering goes to the agent as before. **Follow-ups are held by the host**: a
`send {mode: "followUp"}` while the agent works never reaches the agent. When
the run settles, the host sends the oldest one as the next prompt (its user
item has `source: "queued"`), one per run: the next waits for that run to
settle. Between them the terminal status stays `working` (no `done`). The
same for every provider, so remove, edit and move work alike.

- **Stopped or failed run:** the follow-ups are not sent. `abort` returns them
  in `restored`, after the steers. A run stopped from elsewhere, a failed run,
  an agent exit, `resume`, a conflict: they go to `state.editorText` (the
  composer).
- **Idle:** `mode: "followUp"` just sends. A held command (`/compact`, `/name …`)
  runs when its turn comes; one that answers without a run lets the next go.
- **Reconnect:** the held follow-ups are in `state.queue`, so a snapshot has them.
- **Host restart:** they live in the host's memory only and are lost, like the
  steers in the agent's queue (the agent restarts too).

### ChatState

```ts
queue: {
  steering: string[]; followUp: string[];          // the texts, oldest first; followUp = the agent's own, then the host's
  // Present when a lane has something, aligned with the texts:
  steeringIds?: (string | null)[]; followUpIds?: (string | null)[];  // the host's message id; null = not the host's (no ×, ⇄ or edit)
  steeringRemovable?: boolean[]; followUpRemovable?: boolean[];      // the host can take it back now (show ×, allow edit and ⇄)
  steeringFrom?: (string | null)[]; followUpFrom?: (string | null)[]; // as in v3.1
};
```

Which steers can be taken back, per provider (`ProviderAdapter.canRemoveQueued` / `removeQueued`):

| Provider | How | When |
|---|---|---|
| Pi | `clear_queue`, then the others re-sent as steers, in order | every entry of Pi's queue is the host's (it has their text and images) |
| Claude Code | `control cancel_async_message {message_uuid}` | until the CLI dequeues it (`cancelled: false` → "Too late") |
| Codex | no: `turn/steer` has no way back | never; only a follow-up the adapter holds (sent while compacting or between turns) |

Held follow-ups can always be taken back.

### Ops

`message`, not `id`: `id` is the request's own.

| op | args | data | notes |
|---|---|---|---|
| `queue_remove` | `message` (an id from `state.queue`) | `{}` | the row's ×. Errors: "That message is no longer queued", "<Agent> can't take back a message it already has…", "Too late: <Agent> already took that message." |
| `queue_edit` | `message` | `{text, images: string[]}` | the row leaves the queue; the client puts `text` and the image paths in the composer. Sending again queues it anew |
| `queue_move` | `message`, `to: "steer" \| "followUp"` | `{}` | the row's ⇄. A follow-up is sent as a steer now; a steer the agent gives back joins the follow-ups' tail. Already in that lane: nothing happens |

## v3.3: sub-agent chats (no wire change)

The wire protocol is unchanged. What's new is how a host starts and how the mod
finds and treats it ([research/subagent-chat.md](research/subagent-chat.md)).

### The host as a sub-agent: `herdr-chat-host run`

`bin/herdr-chat-subagent [--provider pi|claude|codex] [--session <f>] [--cwd <d>] [-- <agent args>]`
(= `herdr-chat-host run …`) is what a parent agent's `hc run` starts, directly or
through the hc templates `pi-chat`, `claude-chat`, `codex-chat`. It `serve`s with:

- `--chat c-<8 hex>`: a fresh id each time (`--chat` is refused: a known id resumes that chat's session);
- `--state-dir ${HERDR_APP_HOME:-~/.config/herdr-app}/data/herdr-chat`, where the mod reads the registry;
- the agent from install's `mods/chat/config.json` and the person's `data/herdr-chat/settings.json`
  (host/settings.ts: `<agent>.command`, `<agent>.args` before the caller's args, `env` and
  `<agent>.env` for keys the caller didn't set), and `node` and `hc` from install's config;
- `--cwd`: the terminal's folder unless given.

Before it serves, it labels its own terminal (`hc label $HC_TERMINAL_ID …`):

| Label | Value | Read by |
|---|---|---|
| `herdr-chat.chat` | the chat id | the mod (`hostTerminal`), chat-agents, chat-menu |
| `herdr-chat.role` | `subagent` (a chat's own host: `host`) | `sweepOrphans` ends only `role=host` terminals |
| `herdr-chat.provider` | `pi` / `claude` / `codex` | the dialog's `provider` prop |

A failed label is a `! hc label …` line on the transcript; the host serves its parent anyway.
The transcript's second line is a hint: `sub-agent chat · in Herdr: right-click → Open as chat`.

### Mod props for a sub-agent's chat

| Props | Where | The view |
|---|---|---|
| `{chat, peek: <address>, provider?}` | a `dialog` overlay 0.8 × 0.8 (chat-agents' row click, chat-menu's Open as chat); `then: "tab"` goes straight on to Open as tab | no place lookup, no layout-document writes, no tab rename, no seen marks |
| `{chat, subagent: <address>, provider?, cwd?}` | a tab (Open as tab): `tab.new` in the parent's space, the chat pane alone | the host is never adopted as the tab's pane (closing a tab ends its panes' terminals) |

Both: the connection only attaches (never starts a host); `close()` never reaps,
and `healHost` never restarts, a host that has a `parent`; hand-offs (`/tui`,
`/login`…) are refused with a hint; a gone host shows "The sub-agent ended" with
no Restart; the header bar shows name, status, "from <parent>" (and in the
dialog ↗ Open as tab, ✕). In the dialog Esc stops a run, cancels a dialog or
closes a menu as in a tab, and closes the dialog when there's nothing to stop.
The dialog's debug dump is `debug/<chat>.peek.json`. Commands:
`chat.click:peek:tab|peek:close`, `chat-agents.peek:<address>` (a row's
click), `chat-agents.menu:<address>` (the right-click menu for a terminal),
`chat-menu.pick:<n>` (its n-th chat item).
