# pi-chat spike: go/no-go

**Go.** Each question below was run in a private Herdr app (herdr-app
0.1.12, hc 0.1.17, macOS 26.5.1, own `HERDR_APP_HOME` and `HC_SESSION`).
The runs used `tests/e2e/spike/run.sh` and the throwaway mod
`tests/e2e/spike/mod/pi-chat-spike`. The raw results and screenshots are in
`results/`.

**Rendering choice:** our own measured scroller. It builds only the visible
rows, as ordinary elements, so cards can have their own handlers. Each row's
height is measured with `on_size_change`. While sticky, the last row is
pinned to the bottom. `list()` is ruled out because `track_scroll` is ignored
on it, so it can't stick to the bottom.

## (a) A mod `net` socket streaming JSONL for minutes

A Node TCP server (`stream-server.mjs`) sent 50 records/s for 190 s. Every
100th record was ~200 KiB and every 7th carried U+2028/U+2029, emoji and CJK.
The mod split on byte `\n` and decoded each line with `Buffer`.

| | |
|---|---|
| records | 9 488 (20 MB) |
| dropped / duplicated / unparsable | 0 / 0 / 0 |
| 200 KiB records | 94, all intact |
| U+2028 records intact | 1 342 / 1 342 |
| latency (send → parsed in the mod) | p50 0 ms, p95 1 ms, p99 2 ms, max 54 ms |
| server restart | EOF seen at once (`read()` → null). Reconnected 6 s later, on backoff 250 → 2000 ms, to the new port from the port file |

- The mod keeps reading while the window isn't drawn: tasks run, `render()` doesn't.
- **Catch:** `fs.readFile` in a mod is limited to `$HOME` ("outside every granted read root"). The E2E app home is under `/tmp`. `readTextFile` from `herdr` works anywhere, so the mod reads the registry and config with it.

## (b) 150 markdown items, the last one streaming at 50 ms flushes

The items mix headings, paragraphs, lists, fenced code, tables and tool
cards. The last item grows by 40 chars every 50 ms (a ~20 KiB answer, then
loops). "CPU" is the app process's CPU time over 15 s, from `ps`. "FPS HUD"
is `gpui-fps`'s `fps_monitor()` element, visible in each screenshot.
(`show_fps_monitor()` fails in Herdr: "needs a ShellRoot as the window's
first view".)

| variant | CPU idle | CPU streaming | render() avg / max | frame (HUD) | sticks to bottom | handlers in rows |
|---|---|---|---|---|---|---|
| `list()` | 6.0 % | 11.3 % | 0.14 / 1.1 ms (+ 6.9 item calls, 0.12 ms/frame) | 2.7 ms, p95 3.5 ms, 0 % drops | **no**: `track_scroll` is ignored on `list()` (warning) | no (`on_item_click` per list only) |
| all items as ordinary elements | 18.9 % | 44.3 % | 0.85 / 1.5 ms | 3 ms | (no scroll handle) | yes |
| **own measured scroller** | 4.1 % | 18.7 % | 0.21 / 0.8 ms | 3.0 ms, p95 3.9 ms, 0 % drops | **yes**, anchored at the bottom | yes |

- The 50 ms flush timer kept time in every variant: p50 53 ms, p95 55–57 ms, max 61 ms. The UI thread was never saturated.
- In the measured scroller, `on_size_change` fired 176 times in 20 s. A known row growing while sticky needs no second render: it's pinned with `bottom(0)`.
- Scrolling up unsticks it, and wheel-scrolling back to the bottom re-sticks (`b-measured-3-scrolled-up.png`).
- `list()` would be the cheapest, but a chat can't use it. It can't scroll from code, and clickable tool cards would need `on_item_click` with one handler per row.
- Screenshots: `b-list-2-streaming.png` (`list()` stays at the top), `b-measured-2-streaming.png` (pinned to the streaming answer), `b-flex-2-streaming.png`.

## (c) The host's terminal as a Herdr agent

A stand-in host (`standin-host.py`) reports OSC 7501 `app=pi` and changes
state on `hc send`.

- `hc run --bg --no-parent --label herdr.space=<s> --label herdr.tab=<chat tab> …` is **adopted as a pane** in the chat's tab within a second.
- **`terminal.park` loses agent status.** It removes the pane *and* the `herdr.space`/`herdr.tab` labels (`c3-parked-get.json`). The terminal leaves `agents()`, the tab's status goes `null` and no toast fires (`c3-parked-live.json`). Parking can't be used.
  - Later (feedback round 1, row 11): parking is now used on purpose while other panes share the chat's tab, and the chat posts its own toasts to make up for the lost status. See `../REPORT.md`, "Hosts out of sight (row 11)".
- **Chosen instead: keep the host as an adopted pane and zoom the chat pane** (`pane.zoom`). With the chat zoomed:
  - `agents()` lists the host (`app: pi`, working → blocked → done) and the tab's status follows (`c5-zoom-working-live.json`);
  - the blocked toast fires (`overlays: ["toast"]`, `c6-status.json`), and done shows when the person looks elsewhere.
- **Cost:** an agents-list click runs `pane.focus {pane: <host pane>}` and lands on the host's transcript pane. The mod fixes this: when focus lands on the host's pane, it focuses its own pane and re-zooms, unless the person asked for the transcript (header button).
- `hc send` to a *blocked* host is refused without `--force`. That's normal hc behaviour for agents with an open dialog.

## (d) `Textarea`

- **Enter** inserts a newline, *then* fires `submit {shift: false}`. **Shift+Enter** inserts a newline and fires `submit {shift: true}`. **Cmd+Enter** fires `submit {secondary: true}`. Alt/Ctrl+Enter do nothing.
- Up, Down and Enter never reach a wrapper's `on_key_down`. Only their `on_key_up` arrives, after the Textarea moved the cursor.
- **The fix:** `cx.bind_keys` with context `"<Ours> > Input"`, plus `key_context("<Ours>")` on the wrapper, beats the Textarea's own bindings. Our action gets up/down/enter and **no newline is inserted** (`d-textarea-bindings.json`). Esc and Tab bind on `"<Ours>"` directly.
- The composer switches its wrapper's context between `PiChatMenu` (menu open), `PiChatEmpty` (Up/Down walk history) and `PiChatComposer` (Enter sends, Shift+Enter is a newline).
- `set_auto_grow(1, 8)`: 39 → 186 px, 21 px a row, then it scrolls inside.
- Focus: running a mod command with `herdr-app do` blurs the Textarea, and Tab with nothing bound moves focus away. The mod refocuses on its `focus` command.

## Harness notes (for every E2E run)

- **The private window draws only while the screen is unlocked and the window is frontmost.** Mod tasks, keys (CGEventPostToPid) and commands still work without it, so every check is data-based. The mod writes its debug dump from state changes, not from render.
- **Visual passes:** `lib.sh` `visible`/`hidden` record the frontmost app's pid and bring the private app forward (`front.py`, NSRunningApplication). Afterwards they give the front back to that pid. Every start and end goes to `run.log`, with a 170 s cap per activation.
  - If the private app takes the front at launch, it's handed back at once.
  - With the screen locked, activation is skipped and shots are marked stale.
- The window position comes from a private `window.json` (40, 60, 1280×820). System Events can't see this app's windows.
- Mods copied into the private home need ~1–2 s before `tab.new {mod}` accepts them.
