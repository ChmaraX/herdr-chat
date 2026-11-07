# herdr-chat visual pass (v2)

The user's direction after trying v1: it works, now make the chat **look and
feel** like a first-class chat app. This spec is the target. The protocol
additions it needs are in `protocol.md` (marked v2).

References studied, for *patterns* rather than code; from clones of each
repo at the commits in [`research/sources/COMMITS.txt`](research/sources/COMMITS.txt):
- T3 Code `apps/web/src/components/chat/`: `ComposerFooterControls.tsx`, `ContextWindowMeter.tsx`, `ProviderModelPicker.tsx`, `MessagesTimeline.tsx`, `TimelineWorkGroupRows.tsx`, `MessageCopyButton.tsx`, `markdownStreamBlocks.ts`.
- Orca `src/renderer/src/components/native-chat/`: `NativeChatMessageList*`, `native-chat-transcript-work-runs.ts`, `NativeChatReasoningRow.tsx`, `NativeChatDiffCard.tsx`, `NativeChatMarkdown.tsx`, `NativeChatModelCombobox.tsx`.
- Paseo `packages/app/src/agent-stream/`: `view.tsx`, `turn-footer.tsx`, `turn-collapse/`, and `styles/theme.ts` (`DEFAULT_CONTENT_MAX_WIDTH = 820`).

## 1. Composer owns the controls

Every major app puts the session controls at the bottom with the input. The
composer becomes a single rounded card:

```
┌──────────────────────────────────────────────────────────────────┐
│ Message Pi…                                                        │  textarea (grows 1–10 rows)
│ [image chips]                                                      │
├──────────────────────────────────────────────────────────────────┤
│ ◆ Claude Opus 5.5 ▾   ✦ high ▾   ◔ 23%   $0.42      ⋯ status   ⏎ │  footer row
└──────────────────────────────────────────────────────────────────┘
```

- **Left:** the model chip (picker), the thinking chip (picker), and the context meter: a small ring or bar with the %. The tooltip gives tokens/window and the session cost.
- **Right:** extension status (see 4), then the primary button: send, or ■ stop while working.
- **The header goes away.** The chat title lives in the Herdr tab. The TUI and Transcript actions move into a small `⋯` menu in the composer footer (or a subtle top-right overlay icon). Herdr already draws a pane header.
- **Queue and steer chips** sit just above the composer card, inside the same column.
- **The hint line** ("Enter sends…") shows only while the composer is empty and focused. It is dim, 11 px.

## 2. A centered content column

- Timeline, dialogs, queue strip and composer share one column: `max_w(800)`, centered, 24 px side padding. Below ~600 px it shrinks to the pane width with 12 px padding.
- Assistant prose and code fill the column. User messages are right-aligned bubbles, at most 85% of the column.
- The scrollbar stays at the pane's edge, not the column's.

## 3. Rich content: code, mermaid, diffs, output

- **Code blocks** are cards:
  - a top strip with the language label and a copy button (✓ for 1.5 s after copying);
  - a monospace body in `settings().font_family`, **syntax highlighted**, horizontal overflow scrollable or wrapped;
  - a cap of 30 lines collapsed, with "Show all N lines".

  The host splits assistant text into blocks and highlights code into spans
  (`syn:<token>` colors). The mod maps those tokens to theme colors:

  | Token | Color |
  |---|---|
  | keyword | `ansi5` |
  | string | `ansi2` |
  | number, literal | `ansi3` |
  | function, title | `ansi4` |
  | type, class | `ansi6` |
  | comment | `dim`, italic |
  | variable, attr, property | `foreground` |
  | meta, tag | `ansi1` |
  | punctuation, operator | `muted` |

  Prose stays in `TextView.markdown`.
- **Mermaid:** a closed ```` ```mermaid ```` block renders as a diagram image (host SVG) with a "Show source" toggle and a click to enlarge (overlay window). If the SVG fails, the host's ASCII box art in monospace takes its place. While the fence is still streaming, show the source as a code block.
- **Diffs (edit tool):** line-number gutter, +/− tints, syntax highlighting inside lines, hunk headers dim. Collapsed cards show `Edit src/x.ts  +3 −1`.
- **read tool:** the expanded card shows the file excerpt highlighted by extension, with line numbers.
- **bash:** the command in mono with a `$` prompt. Output keeps its **ANSI colors** (host spans), with the exit code as a chip, red when non-zero.
- **Images:** inline thumbnails with rounded corners, max 320 px wide, click to enlarge.

## 4. Extension status: generic and quiet

We can show only what any extension sends through Pi's standard UI API:
`setStatus` (short keyed text), `setWidget` (keyed text lines), `notify`,
`setTitle`, and the four dialogs. TUI-only APIs (`ctx.ui.custom()`,
`setFooter`, `setHeader`, custom editors) don't exist over RPC, for any app.
So the design is **extension-agnostic**: no per-extension code. It is
keyed, ANSI-to-theme, compact, and never in the way.

- **Statuses** are small dim chips at the right of the composer footer, in key order. Each is truncated to ~28 chars with its full text in a tooltip, and emoji are kept.
  - When they don't fit, `+N` opens a popover listing every status: key, full text.
  - Empty statuses are hidden.
  - A status can be hidden from its popover row (persisted per key in `localStorage`), with "show hidden" at the bottom.
- **Widgets** (multi-line) live in a collapsible tray above the composer. Each shows a one-line summary (key + first line) and expands to its lines. The open/closed state is remembered per key. `belowEditor` widgets go in the tray too, under it.
- **notify** becomes a Herdr toast, plus a dim notice row in the timeline: warnings and errors only, since info would be noise.

## 5. Message actions: time and copy

- On hover over a user or assistant message, an action row fades in under it (Orca/T3 pattern):
  - a timestamp: relative ("2m") under 1 h, else "14:32", the absolute date and time in a tooltip;
  - **copy**: the message's markdown;
  - for user messages, also **edit and resend**, which puts the text in the composer.
- Assistant messages also show a subtle **turn footer** after the last block of a run: `Claude Opus 5.5 · 12.4s · 1.2k tok · $0.03`, dim, 11 px (Paseo's `turn-footer`).

## 6. More that makes it feel right

- **Work groups** (Orca `work-runs`, T3 `TimelineWorkGroupRows`, and the user's own pi-declutter):
  - consecutive tool cards and thinking inside one assistant response fold into one row, e.g. `Ran 3 commands · read 2 files · edited 1 file · 14s`, with the status icon of the worst result;
  - click to expand the cards;
  - the group that is running stays open and shows the live card;
  - a finished group collapses unless it failed.
- **Thinking:**
  - while it streams, a shimmering "Thinking…" (native `.loop("opacity")`) with elapsed seconds;
  - once done, "Thought for 6s", collapsed and expandable, with the text in dim italic.
- **A live activity line** at the bottom of the timeline while working: `● Running bash · 8s`, `● Waiting for you`, `● Compacting…`. Use the spinner and native animation, no timers.
- **Empty state** for a new chat: "Pi" and the cwd, with the composer centered vertically.
- **Clickable file paths** in tool cards (read/edit/write) open the file in an editor:
  - herdr-nvim when installed (look for `mods/herdr-nvim` and its CLI, the way gitview's `nvim.js` does);
  - else `$EDITOR` in a terminal pane right of the chat.
- **Spacing and type:** prose 14 px on a 22 px line, UI chrome 12–13 px, code 12.5 px in the terminal font. One radius scale: 6, 10 and 14 px (the user's bubble: 16).
  - Spacing is on one scale (4, 6, 8, 12, 16, 20, 28), in one place (`mod/chat/space.js`): 28 px above a user message, 16 px after it; 12 px between an answer's paragraphs, lists, code, tables and diagrams; headings 20 px above, 6 px below; 8 px between tool rows or groups and the prose around them; 6 px between cards in a group.
  - The hover actions and the run's footer sit in a 20 px row inside the 28 px turn gap, so a turn has the same spacing with or without them. On an answer in the middle of a run they show over its last line instead.
- **Motion:** new items fade in (120 ms). Group expand and collapse animate height (`.transition`). The stick-to-bottom scroll stays instant.

## Out of scope for v2

Remote machines, text selection across messages, find-in-chat.
