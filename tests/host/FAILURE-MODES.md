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

## Reconnect

| Failure | Test |
|---|---|
| A client reconnecting mid-stream misses items or gets duplicates | `terminal.test.ts` "reconnect mid-stream": second client's final copy equals the first's |
| Two clients see different timelines | `terminal.test.ts` "reconnect mid-stream": the same items and state |

## History

| Failure | Test |
|---|---|
| Resumed timeline differs from the live one | `resume.test.ts`: the same item kinds, texts, tool titles, statuses and details |
| `hasOlder` paging loses or repeats items | `ops.test.ts` "history paging" |

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
