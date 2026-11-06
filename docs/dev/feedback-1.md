# User feedback round 1: issues and decisions

The user's report after trying v1 (the screenshots aren't kept):

| # | Issue | Root cause / decision |
|---|---|---|
| 1 | The model picker doesn't scroll with the mouse | Pickers and menus need wheel scrolling |
| 2 | No keybinds for the pickers | **Chat-scoped shortcuts.** Defaults ship in `mod/chat/keys.default.json`, user overrides go in `~/.config/herdr-app/data/pi-chat/keys.json`, and the mod binds them in its own key context, so they never steal keys from terminals. The same actions work for every provider (capability-gated: an action the agent doesn't support shows a short toast). Tooltips and menus show the bound keys. Only "new chat" is a global Herdr key (`keys.json`, added by install). |
| 3 | Esc doesn't close the model picker | Picker focus and key handling |
| 4 | Pi subagent reports show as "Steer" and look like a user reply | `hc send` reports (`<hc from=…>`) get their own look: a left-aligned **report card** ("↩ from t7 review", markdown body, collapsed when long). The queue chip reads "Report from t7 review" instead of "Steer" |
| 5 | Composer too close to the last output | Add bottom padding between the timeline and the composer |
| 6 | The working spinner looks laggy, low fps | Use a native rotating SVG (`svg(...).spin()`, like Herdr's own `workspace-chrome/spinner.svg`), not braille `.frames` |
| 7 | Pickers and menus shift the layout | Draw them as **overlays** above the composer (absolute, on top), never in the flow. Click outside closes |
| 8 | The ⋯ menu is too much | Remove it. `/tui`, `/transcript`, `/resume` and `/copy` stay as slash commands |
| 9, 10 | "Pi is open in the terminal UI" never clears, even for /models | The hand-off state was stuck: the mod's TUI watch was lost when the mod reloaded. The **host** now owns the hand-off: it watches the TUI terminal and resumes on its own when it ends. The banner gets a **Return to chat** button. After a Pi TUI hand-off, the chat resumes the session the TUI ended on (fork or /resume in the TUI): the lock extension reports it |
| 9b | "This session is also open in another chat" | Two chats were open on one session. The host **refuses** a session held by another live host: a conflict banner offers **Go to that chat** or **Take over** |
| 11 | cmd-e (nvim) shows extra panes | Host panes sit behind the zoomed chat, so any split unzooms and reveals them. Also several hosts were in one tab (12). **Keep host panes out of sight** even when the user splits the chat tab. (First done by parking the host while split; now its pane is hidden in the layout document and never parked: [`research/split-glitch.md`](research/split-glitch.md).) |
| 12 | The Pi chat tab shows the Claude icon | A new chat's host was adopted into the **wrong tab** (the Claude host `t12n` went into the "Hello" tab). The mod must know its own tab for sure. It also self-heals: if its host sits in another tab, it restarts the host in its own tab on the same session |
