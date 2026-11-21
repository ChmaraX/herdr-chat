# How the host can fail, and which test exercises it

Written before the tests, then pointed at the tests that landed. Each row names
the test that has to catch it; "not covered" rows are known gaps
(a read-only test audit listed them; its notes are in git history).

## Framing (Pi → host, client → host)

| Failure | Test |
|---|---|
| Splitting on U+2028/U+2029 (readline) corrupts a record | `stream.test.ts` "coalescing and U+2028" (long-markdown has both separators inside a quote) |
| A record split across chunks | every streaming test (Pi output arrives in arbitrary pipe chunks); `lifecycle.test.ts` "oversized record" |
| A CRLF line ending | not covered |
| A record over 8 MiB buffers without bound or kills the stream | `lifecycle.test.ts` "oversized record": a 9 MiB tool update mid-tool; the tool and the answer still finish |
| An oversized record loses the head that says which tool it was | `lifecycle.test.ts` "oversized record": the tool item keeps its title and ends `done` |
| Non-JSON on Pi's stdout | `lifecycle.test.ts` "oversized record" sends a garbage line too |
| A client sends junk or the wrong token, or never says hello | `terminal.test.ts` "auth" |

## Ordering

| Failure | Test |
|---|---|
| Items out of `contentIndex` order (thinking, text, tool calls of one message) | `stream.test.ts` "multi-tool turn" asserts the exact kind sequence |
| A tool item created twice (at `toolcall_start` and at `tool_execution_start`) | "multi-tool turn": one item per `toolCallId` |
| The `prompt` reply after `agent_start` or after a dialog | `dialogs.test.ts` "an extension command's dialog outside a run" (`/rpc-input` replies only after its dialog) |
| `seq` gaps | every test that writes an artifact: `Host.artifact()` asserts each client's `seqErrors` is empty; `terminal.test.ts` "keepalive" (pings don't count) |
| A patch before the snapshot | `terminal.test.ts` "reconnect mid-stream": the second client's first records are `welcome`, `snapshot` |

## The user's prompt

| Failure | Test |
|---|---|
| The prompt shows only when the agent echoes it (Claude at `message_start`, Codex after its prompt hooks: 0.6–3.5 s) | `prompt-echo.test.ts`: the user item within 150 ms, before any answer (fake-claude scripted, the `extra.jsonl` and Codex `text.jsonl` replays); E2E `claude` "the prompt shows before the answer starts" |
| The echo adds a second item instead of confirming the shown one | `prompt-echo.test.ts`: one user item, the same id, after the echo |
| An expanded skill's echo is dropped or added beside the prompt | `prompt-echo.test.ts` "pi: a skill's echo": one item with Pi's text |
| Several skills: the agent runs only the first (Pi and `claude -p` each expand one), the rest reach it as the first one's arguments | `skills.test.ts` "pi: three skills…" (the model gets one run of Pi's blocks), "claude: several skills…" (each a `/name` for the Skill tool, nothing slash-led in front), "codex: several skills…" (a `skill` input each) |
| A later skill without a file (Pi gives none, or it's gone) is dropped and the message goes without it | `skills.test.ts` "pi: a later skill Pi gives no file for…": the send fails, Pi gets nothing, the item goes |
| The pills shown and the skills sent differ (a skill named twice, a list the adapter splits by on its own) | `skills.test.ts`: `/skill:tdd /skill:tdd once` (Pi) and `/tdd /tdd once` (Claude) reach the agent once, shown once |
| Several pills come back out of order, or a resumed session shows fewer | `skills.test.ts`: the three pills in order, live and resumed (Pi, Claude); `fork_points` and the session list give them as typed |
| A rejected prompt stays on the timeline | `prompt-echo.test.ts` "pi: … a prompt Pi rejects" |
| Esc before the turn starts loses the prompt or doubles it | `prompt-echo.test.ts` "claude: Esc before the turn starts" |
| A fake echoes in an order the real agent doesn't (hiding the above) | `fake-fidelity.test.ts`: each fake against a real recording |

## Coalescing

| Failure | Test |
|---|---|
| One patch per delta (redraw storms) | `stream.test.ts` "coalescing": hundreds of deltas → under half as many patches, and no more than one per ~40 ms on average. The gap between two patches is not asserted |
| An urgent change (dialog, phase) waits for the timer | not covered (`dialogs.test.ts` waits for the dialog but doesn't time it) |
| A final state lost in the last batch | every test asserts the final items |

## Settling

| Failure | Test |
|---|---|
| Treating `agent_end` as done (retries, compaction follow it) | `lifecycle.test.ts` "an autonomous run": retry and compaction inside a run; phase stays working until settled |
| A `handled` command leaves phase `working` forever | `dialogs.test.ts` "an extension command's dialog outside a run" |
| A missing `agent_settled` (lost or old Pi) hangs the chat | `lifecycle.test.ts` "a lost agent_settled": the get_state probe settles it |
| A dialog racing the settle: dialog lost or status not `blocked` | `dialogs.test.ts` "an extension command's dialog outside a run": a dialog with no run; status `blocked`, answer still delivered |
| A dialog's timeout: Pi resolves it but the card stays | `dialogs.test.ts` "a select and a confirm with a timeout": the confirm times out and disappears |

## Abort and queue

| Failure | Test |
|---|---|
| `abort` without `clear_queue` first: Pi runs the queued text after the abort | `steer-abort.test.ts` "abort mid-tool with a queue": commands are `clear_queue` then `abort`; no new run starts; `restored` has the queued text |
| A tool left `running` after an abort | `steer-abort.test.ts` "abort mid-tool with a queue": the tool ends `error` |
| Abort while a dialog is open hangs Pi | `steer-abort.test.ts` "Esc while a dialog is open" |
| A steer shows up twice (queue strip and timeline) or never | `steer-abort.test.ts` "steer during a tool": queue strip while queued, then one `queued` user item |

## Composer images (`attachments.test.ts`; E2E `thumb`)

| Failure | Test |
|---|---|
| A pasted or dropped image the chat can't show before it's sent (the app shows only files under its home) | `attach_image` answers a path under `<stateDir>/attachments/<chat>`, a copy of the file; E2E `thumb`: the chip draws it, a click enlarges it |
| An enlarged chip opening at a guessed size (the mod can't read raster files) | `attach_image` answers the copy's pixel size; E2E `misc`: the chips of a 600×200 and a 400×900 drop carry their sizes |
| `clipboard_image` saving a paste outside the chat's attachments | macOS: not covered (a test machine's clipboard holds no image). Linux: `clipboard-linux.test.ts` "on Wayland": a stand-in `wl-paste`'s PNG lands in `<stateDir>/attachments/<chat>` with its size |
| Linux: text, a fake PNG or a failing `wl-paste` taken for an image, or a file left behind | `clipboard-linux.test.ts` "on Wayland": each answers `{path: null}`, and no file is written |
| Linux: `xclip` never asked when Wayland's tool is missing (XWayland), or asked instead of `wl-paste` on Wayland | `clipboard-linux.test.ts`: with only xclip installed and both displays set, xclip's PNG; with both installed and only `WAYLAND_DISPLAY`, wl-paste's |
| Linux: no `wl-paste`/`xclip`, or a host with no display variables (herdr-core started outside the session), shown as "no image" | `clipboard-linux.test.ts` "on X11": `clipboard_image` fails with "Image paste needs wl-paste (wl-clipboard) or xclip (xclip)" / "…a Wayland or X11 session…"; the mod shows that message |
| Linux: a large image not shrunk when ImageMagick is there, or a failing or garbage-writing `magick`/`convert` sending a broken image | `clipboard-linux.test.ts` "shrink": stand-ins on PATH; `magick` first, `convert` when it fails, the original when both fail or write a non-PNG or empty file. "with the real ImageMagick" runs where `magick` is installed |
| A dropped file that isn't an image (or can't be read) staged anyway, or refused without a word | `attach_image` rejects a `.txt`, a `.png` that isn't one, a missing file, with `send`'s messages; E2E `thumb`: the drop shows the reason at once and makes no chip |
| A dropped file whose name is too long for the copy's prefix | `attach_image` shortens the name and keeps its extension |
| A drop, then Enter before the copy is made: the message goes without the image, which lands in the next one | E2E `thumb`: with the host paused, drop then send: the message carries the image, the composer stays empty |
| ✕ deleting the person's own file | `detach_image` on the dropped file leaves it; E2E `thumb` checks the dropped file after ✕ |
| ✕ deleting a file a held follow-up or a queued steer still sends | both keep their images through `detach_image`; after `queue_edit` takes the follow-up back, ✕ removes it |
| A host that ends while the chat stays open deleting the composer's images (a take-over's `shutdown`, a restart that falls back to a kill) | `take_over` from another chat, then SIGTERM: the files stay, and the next host has them; E2E `thumb`: `hc kill` on the host, Restart, the chip's image is sent |
| Attachments left behind when the chat closes | E2E `thumb`: closing the pane of a chat with a live host removes its folder at once; a chat whose host was killed, then its pane closed: another chat's host removes the folder (`sweep_attachments`, from that chat's orphan sweep), and keeps its own |

All of the Linux rows run on any OS (`HERDR_CHAT_PLATFORM=linux`, stand-ins on PATH). What only a Linux machine shows: the real `wl-paste`/`xclip` reading a real session's clipboard, and the chat's Linux keys and paste keys in a Linux Herdr app (no e2e there; `tests/e2e/` drives macOS).

## Crashes and lifecycle

| Failure | Test |
|---|---|
| Pi exits mid-run: items stuck streaming/running | `lifecycle.test.ts` "Pi crashes mid-run" |
| Pi exits while idle and nobody notices | `lifecycle.test.ts` "Pi exits between turns" |
| A crash leaves no way back | `lifecycle.test.ts` "Pi crashes mid-run": the next send restarts Pi on the same session |
| Pi never answers at startup (an extension dialog in `session_start`) | `dialogs.test.ts` "startup dialog" |
| Pi is slow or silent at startup with no dialog | not covered (the 10 s hint and the 45 s error) |
| Leftover processes after shutdown | `ops.test.ts` "shutdown": registry `pid: null`, the Pi pid is gone |
| The lock not released, or released when another host holds it | `handoff.test.ts` "forks and exits" (released for the TUI); `conflict.test.ts` (the holder keeps it; taken once it's released); `ops.test.ts` "/new"; `lifecycle.test.ts` "Pi crashes mid-run" |
| The hand-off never ends (the mod's watch is lost) | `handoff.test.ts`: the host resumes when the TUI's terminal finishes, is killed, with no mod connected, and after a mod reload |
| The chat resumes the old session after a fork or /resume in the TUI | `handoff.test.ts` "forks and exits" |
| Resuming while the TUI still writes the session | `handoff.test.ts` "terminal is killed": waits for the TUI's pid |
| Two chats write one session | `conflict.test.ts`: phase `conflict`, `take_over`; Claude's registry; `codex-lifecycle.test.ts` active writer |
| Two hosts serve one chat (two starts at once: both register, both start an agent on the session) | `one-host.test.ts` "N hosts started at once": one serves, the registry names it, the rest exit 3 with the error, one agent process; E2E `one-host`: six restarts under mod reloads, one host each, none refused |
| Two takers of a dead host's claim both win; a reused pid keeps a dead claim (`claim.test.ts` tests the module itself: whole hosts start ~100 ms apart, too far apart to race for one claim) | `claim.test.ts`: 8 contenders at one instant, 12 rounds through fresh, released, SIGKILLed and pid-reused claims; `one-host.test.ts` "SIGKILL", "pid reuse" |
| The chat's live host can't be reached: something else wrote or removed its registry entry (a 0.5.0 duplicate's exit), and the mod starts hosts the claim refuses | `one-host.test.ts` "keeps the registry naming it": the entry overwritten, then deleted, is written back and a client works; E2E `one-host`: the claim holder is the host left after the sweep, none refused |
| A dead host's session lock, its pid now another process's, keeps the chat in `conflict` | `one-host.test.ts` "a session lock left by a host of this chat that died": a 0.6 lock (another start time) and a pre-0.6 lock (the pid isn't a host of the chat) |
| A restart can't start (the old host's claim not released) | `one-host.test.ts` "a restart": shutdown then a new host, SIGTERM then a new host; `after-pid.test.ts` |
| A second host from before the claim shares the chat's session | `one-host.test.ts` "a host from before the claim": the new host is in `conflict`, starts no agent; E2E `one-host`: the sweep ends the host the registry doesn't name |

## Reconnect

| Failure | Test |
|---|---|
| A client reconnecting mid-stream misses items or gets duplicates | `terminal.test.ts` "reconnect mid-stream": second client's final copy equals the first's |
| Two clients see different timelines | `terminal.test.ts` "reconnect mid-stream": the same items and state |

## The mod's WebSocket (`transport.test.ts`; E2E `sockets`, `stall`)

The mod talks to its host over a WebSocket (`wsPort`), because Herdr never
releases a mod's `net` socket once its build reloads or its view closes.

| Failure | Test |
|---|---|
| A record reaches JSONL clients but not the WebSocket client, or arrives changed | `transport.test.ts` "same records": over a turn with tools, the WebSocket client's records equal the JSONL client's, one record per message |
| A request over the WebSocket gets no reply, or the reply goes to another client | "same records": the WebSocket client's `send` and `get_state` are answered on it, and only on it |
| A wrong token or no hello over the WebSocket is let in | "refused": no welcome, closed |
| A web page opens a WebSocket to the host's port | "refused": a handshake with an `Origin` gets no upgrade |
| The registry keeps a dead `wsPort` after a clean exit | "same records": `wsPort` set while it runs, null after |
| Herdr keeps a socket per mod reload or closed chat (the app runs out of descriptors) | E2E `sockets`: after reloads and a closed tab, Herdr holds one socket per open chat |
| A chat open across the upgrade (its host predates `wsPort`) can't connect | E2E `sockets`: a v0.3.0 host, reached over TCP |
| The app's JS thread is busy while the agent streams, 8 messages wait unread, and Herdr's runtime closes the link (a reconnect, a full snapshot, requests fail "disconnected") | `transport.test.ts` "a stalled reader": a client that ACKs nothing through a whole turn gets at most 4 messages and keeps its connection; E2E `stall`: 0.4–3.2 s stalls while streaming, `connects N->N` and `snapshots N->N` on the WebSocket and on TCP |
| Records held back for a stalled client arrive out of order, twice or not at all | "a stalled reader": once it ACKs again, its records equal the JSONL client's, with no `seq` gap, and its requests are answered |
| A client that stops reading or ACKing for good makes the host buffer without bound | not covered (the 64 MiB cut-off has no test, on either transport) |
| An ACK the runtime fails to send leaves the host a slot short for good (4 lost and the chat hangs) | not covered (the mod reconnects when an ACK's write fails; Herdr's command queue can't be filled from a test) |

## History

| Failure | Test |
|---|---|
| Resumed timeline differs from the live one | `resume.test.ts`: the same item kinds, texts, tool titles, statuses and details |
| `hasOlder` paging loses or repeats items | `ops.test.ts` "history paging" |
| Claude Code's task list (TaskCreate/TaskUpdate/TaskList) isn't the chat's plan, or has a step for a task that isn't there | `claude-session.test.ts` "the task list … is the chat's plan": live and resumed, with a subagent's update, an unknown task, a deletion and a rename |
| An empty TaskList (the agent checks before it plans) makes an empty "0 of 0" plan | the same test: the "Any tasks?" turn has no plan |
| A plan's calls fill the transcript with a marker row each | the same test: one marker for a turn of 3 creates, 4 updates and a deletion; `codex-turns.test.ts` "each turn's plan": a status change makes none |
| A finished plan stays after the next message, or a resume brings it back | `claude-session.test.ts` "resume from the transcript": cleared live and on resume; `codex-turns.test.ts` "each turn's plan" |
| A subagent's plan replaces the chat's | `claude-session.test.ts` "resume from the transcript" (TodoWrite), `codex-turns.test.ts` "each turn's plan": the subagent's is a card in its group |
| A Codex resume loses the plan: `thread/turns/list` has no `update_plan` item | `codex-turns.test.ts` "each turn's plan": rebuilt from the rollout |
| The rollout's records differ from what the parser expects (codex-cli 0.163 writes `update_plan` as code mode's `exec` JS, not a `function_call`), or its turn ids differ from `thread/turns/list`'s | `codex-rollout.test.ts` "code mode's update_plan calls": a real 0.163 rollout (`tests/fixtures/codex/plan-rollout*`) against what the app-server sent live and listed |
| A Codex turn with a steer: a plan after the steer is replayed before it, and the steer clears it as finished | `codex-rollout.test.ts` (the real steered turn: plans after user message 1 and 2); `codex-turns.test.ts` "a plan finished by a steer" |
| A long Codex turn: its plan sits far from its `task_started` record | `codex-rollout.test.ts` "40 MiB after its turn started": the file is read line by line from the start |
| A Codex fork's rollout holds only its own turns (its history is the source's, `session_meta.history_base`), so a resumed fork loses the plan | `codex-rollout.test.ts` "a fork's file" (a real 0.163 fork); `codex-turns.test.ts` "a fork keeps the plan", live and after a restart |
| A Codex thread with no rollout file (`thread.path` null) or one that can't be read | `codex-rollout.test.ts`: a missing file has no plans; the history goes on without them |
| An empty plan update while a plan shows leaves the strip or its marker as it was | `codex-turns.test.ts` "a plan finished by a steer": `Plan cleared`, in the same turn and from an earlier one, live and resumed |
| A message the agent rejects clears a finished plan | `codex-turns.test.ts` "a plan finished by a steer": the plan stays after a rejected send |
| A background agent changes the task list after the next user message, or TodoWrite and the task list both feed the plan: the resume places the change before that message, so it ends on another plan | `claude-session.test.ts` "a background agent's last task change after the next message" |
| A subagent's plan whose card isn't on the timeline shows as a top-level card | the same test: a TodoWrite from an unknown subagent makes no card |
| A Codex subagent's plan card is missing after a resume (its thread's rollout path isn't known to the history) | not covered (the card is live only, as before) |
| A subagent's task change is lost live: its live result has only the text, no `tool_use_result` (`tests/fixtures/claude/extra.jsonl:271`) | the same test, and "a background agent's task changes": fake-claude sends nested results the same way |
| TaskList's list doesn't replace the plan, or later updates don't build on it | the same test: the "Check the list" snapshot drops a task, renames one and changes statuses, then an update to a task only the snapshot had |
| After a resume, the plan stops updating or loses the tasks from before it | the same test: a new task and an update after the resume land on the same plan |
| History puts a background agent's steps at its Agent card, before the main-thread tasks they change, so the resumed plan drops the change | "a background agent's task changes": live and resumed, the agent's update to a task the main thread created after launching it |
| Steps follow result order, not the CLI's task-id order (a TaskCreated hook holds one result back) | the same test: task 3's result lands before task 2's |
| A fork mixes the original's tasks with its own: Claude Code keys the list by session id, so the fork's starts empty and gives out id 1 again | the same test: the fork's first task replaces the plan, live and after a reload of the fork (its transcript holds the original's tasks) |
| A subagent's TaskList: live it has only text, which the plan doesn't read; on resume its transcript resets the plan | not covered (the two differ only when the plan had drifted from the CLI's list) |
| A transcript over 32 MiB: `readTranscript` reads only its first 32 MiB for the whole resumed timeline, so later tasks are missing from the plan and updates to them are dropped | not covered (pre-existing cap, `sessions.ts`) |

## Terminal

| Failure | Test |
|---|---|
| `hc send` text arrives in pieces or the `<hc from>` envelope leaks into the prompt | `terminal.test.ts` "hc send": chunked bracketed paste → one user item with `from` |
| ESC alone vs an escape sequence; ESC ESC and Ctrl-C | `terminal.test.ts` "hc send": an arrow key doesn't abort; a lone ESC, ESC ESC and Ctrl-C each abort once; Ctrl-C drops the typed draft |
| OSC status wrong (no `blocked` for dialogs, no `done`) | `dialogs.test.ts`, `stream.test.ts` assert the OSC sequence |

## Rich content (v2)

How rich rendering can fail a user, and what covers it (`rich.test.ts` drives `scenarios/rich.json` through the real host, live then resumed):

| Failure | Covered by |
|---|---|
| A fence split wrong while streaming (prose swallowed into code, a block flickering between types) | the patches seen mid-stream: `markdown code:ts(open)`, then `… mermaid(open)` |
| A fence inside a list item not recognised, or its indentation left in the code | the `~~~sh` block in item 1, dedented; the list prose around it intact |
| Spans that don't spell the text (lost or doubled characters at scope edges) | `lines`/`outputLines` joined equal `code`/`output` |
| A keyword not marked, or nested scopes colouring a whole region (outer wins) | `export` is `syn:keyword`, `parse` `syn:function`, the comment `syn:comment` |
| An SVG a native renderer can't draw (CSS variables, `color-mix()`, web fonts, `foreignObject`) or labels as paths | the SVG has no `var(`/`color-mix`/`@import`/`foreignObject`; each label is a `<text>`; checked by hand with resvg (`tests/artifacts/host/rich-flowchart.resvg.png`) |
| `set_theme` not re-sending diagrams, or re-highlighting everything | the answer is upserted before the reply with a new SVG; its code block unchanged |
| ANSI colours lost, or escapes leaking into `output` | `✗ rejects junk` is `ansi1` in `outputLines`; `output` has no ESC |
| Diff numbering off by one, counts wrong, a hunk header parsed as a line | the exact `diffLines` kinds and old/new numbers; `+2 −1` |
| Usage of a tool-only message lost (run totals too low) | item 2's input = 2000 + 2400 |
| History differs from live (blocks, SVG path, metadata) | the resumed host's rich fields deep-equal the live ones; the SVG is re-rendered after the image folder is cleared |
| A huge answer making a record over 8 MiB | span budget per item (60k spans, later blocks lose `lines`), 2000 lines per block, diff text 256 KiB (not tested: a size bound) |
| Mermaid that beautiful-mermaid can't parse | ASCII art, else the source, plus `error` (checked by hand: `pie`) |

## Fork (`fork.test.ts`; `fork-live.test.ts` with LIVE=1 on the real agents)

| Failure | Covered by |
|---|---|
| The fork keeps the chosen message, or drops the one before it | the timeline after the fork is the messages before it; live: the forked agent remembers APPLE, not BANANA |
| The original session changes | its file is byte-for-byte the same after the fork and the next prompt |
| The chat stays on the old session (file, lock, timeline), so the next prompt lands there | a new `sessionFile`; the next prompt is in the fork's file, not the original's |
| A skill comes back as Pi's expanded block | `fork_points` and the reply give `/skill:diagnose the crash` |
| An extension cancels Pi's fork and the chat half-switches | the error, and the same session and timeline |
| Claude Code's fork is lost before its first prompt (its transcript isn't written yet): a /reload or the history shows nothing | the history up to the fork from the original; a /reload starts the same `--fork-session --resume-session-at` |
| Claude Code resumes at the wrong record | `--resume-session-at` is the answer to the message before |
| Codex forks through the wrong turn, or takes the config's default effort | `thread/fork lastTurnId` is the turn before; the effort is the one set before the fork |

## The branch (`git.test.ts`)

`ChatState.git`: the branch of the chat's folder, shown under the composer.

| Failure | Covered by |
|---|---|
| A folder that isn't a repo errors, or shows a stale branch | "not a repo, then one": `git` is null, no error notice |
| A repo made during the chat (`git init`) never shows | the same test: its unborn branch once the next run settles |
| A switch outside a run (the agent's bash, another terminal) shows only at the next turn | "the branch follows switches": a new branch, a rename, with no run |
| Detached HEAD breaks it | the same test: `detached`, `name` the commit |
| A linked worktree: its HEAD is under `.git/worktrees/<name>`, so watching the main `.git` misses its switches | "a linked worktree": a switch inside it updates; one in the main checkout doesn't |
| A folder below the repo's top | the worktree test runs in a subfolder |

## Updates (`update.test.ts`; E2E `update`, `update-release`)

A chat whose host started before an install runs older code (protocol.md v3.5).

| Failure | Covered by |
|---|---|
| The welcome, the registry and `herdr-chat-host build` disagree, so the install's build never matches a host's and every chat looks outdated | `update.test.ts` "the build"; `install-e2e.sh`: config.json's build is the installed host's |
| A restart's shutdown hangs on a client that never closes its side, so the new host never starts | `update.test.ts` "shutdown ends the host even when a client never closes its side" |
| A host from before 0.3 hangs on its way out (it had that bug) | not covered: the chat kills a host terminal that's still live 5 s after its shutdown |
| A chat restarts without the person's answer | E2E `update`: A's host pid unchanged until Restart |
| A restart loses the conversation | E2E `update`: the same session file and the same messages after the restart |
| A working chat is cut off mid-turn | E2E `update`: B keeps its old host while working, restarts once stopped |
| A sub-agent's host is restarted (its parent loses it) | E2E `update`: the sub-agent's pid and terminal unchanged |
| A chat waiting on its own sub-agents restarts, and their reports go to a dead terminal | not covered (quiet() requires no live child of the host's terminal) |
| A new host still on another build restarts again and again | E2E `update`: no second restart; not covered: a host that comes back on another build |
| A clone's edited host code makes every chat look outdated | not covered (a host started after `installedAt` never counts) |
| Later is ignored, or asks again on every reload | E2E `update`: no restart after Later, no question after a reload |
| A failed update looks like success, or is silent | E2E `update-release`: the dialog stays open on exit 7 |
| The release check runs more than once a day | E2E `update-release`: no question after a reload |
| A release tag runs as shell (`0.9.0;cmd`) | not covered (only `X.Y.Z` is offered, and it's an argument) |

## /resume's sessions (`sessions.test.ts`)

| Failure | Covered by |
|---|---|
| Only the newest 100 sessions exist | 402 Pi sessions: every one is listed, newest first, and an old one is found by a search |
| Another folder's sessions in this folder's list (a Pi `--session-dir` holds every folder's flat) | one store, two folders, for Pi, Claude Code and Codex: this folder's list has only its own; every folder's has both, each with its folder and `here` |
| The agents search differently | the same queries on all three: every word, case-insensitive; name and first message before folder; this folder's list ignores its own path |
| Codex's list stops after its first page | `FAKE_CODEX_PAGE=1`: one thread per page, both threads listed |
| A line bigger than one read (a 1.5 MiB brief inlined in the first message, 3 MB of tool output) loses the first message or miscounts | that session: `@/tmp/big.md summarise it`, 3 messages (tool output isn't one) |
| A rename, a deleted session or a new one doesn't show | after `refresh`: the new name, the file gone, the new one first; without `refresh`, what was read before (protocol) |
| `pi @brief.md` rows show the brief | `@/tmp/review/brief.task.md go` |

## Continue as chat: the TUI's process (`tui-process.test.ts`, `tui-session.test.ts`; E2E `tui-under-command`, `tui-in-place`)

| Failure | Covered by |
|---|---|
| The agent runs under the terminal's own command (`fish -ic 'claude; exec fish -i'`), not as its foreground: not found | `tui-process.test.ts` "viewer" (sh → sh → pi); E2E `tui-under-command` step 2 |
| The agent is Herdr's foreground (`pi` typed in zsh, a shim run as `sh …/pi`), but the walk picks another or none | `tui-process.test.ts` "foreground" (argv[1] of any program, as before); `tui-session.test.ts`; E2E `tui-in-place` |
| Two agents in the terminal's group (`pi & pi`): one is picked and gets SIGTERM | `tui-process.test.ts` "two" (refused, both named); E2E `tui-under-command` step 1 (the toast, neither signalled) |
| An agent in a background or stopped job (`set -m`) taken for the TUI on screen | `tui-process.test.ts` "job" |
| A program naming the agent in its arguments (`less pi.js`) taken for it | `tui-process.test.ts` "viewer" (argv[1] counts only for node and bun) |
| The program's path has a space (`My Tools/pi`) | `tui-process.test.ts` "path with a space"; E2E `tui-under-command` step 2. A *script* path with a space isn't matched (`ps` has one line, cut at the space): not covered |
| The foreground pid Herdr reported is gone | `tui-process.test.ts` "gone" |
| `ps` fails, times out or prints more than 16 MB: a half-read table | `processTable` throws ("can't read the process table"), never a partial table: not covered by a test |
| A deep or wide tree hides a second agent behind a cap | none: the walk covers the whole tree in memory (no cap) |
| The shell's command goes on after the agent (`pi; sleep 5`) and its pane closes under it | `tui-process.test.ts` "busy: next command"; E2E `tui-under-command` step 3 (the toast, the pane stays) |
| A process left in the group from before (`(sleep &); pi`) is missed | `tui-process.test.ts` "busy: already there" |
| A helper keeps the group busy: the interactive shell's own (its rc's `… &`, a prompt daemon) or the agent's leftover (an MCP server), so the pane never closes | `tui-process.test.ts` "idle"; E2E `tui-under-command` step 4 (rc `sleep 600 &`, the pane closes). A helper an rc starts in the shell's own group (`setopt no_monitor`) keeps the pane, with its toast: not covered |
