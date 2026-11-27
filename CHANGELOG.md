# Changelog

## [0.7.1](https://github.com/ChmaraX/herdr-chat/compare/v0.7.0...v0.7.1) (2026-11-27)


### Bug Fixes

* **update:** the release lookup sends a User-Agent, so updates are offered ([#69](https://github.com/ChmaraX/herdr-chat/issues/69)) ([a08e293](https://github.com/ChmaraX/herdr-chat/commit/a08e2938b4b35766d1651604e904e0a45414e2e0))

## [0.7.0](https://github.com/ChmaraX/herdr-chat/compare/v0.6.0...v0.7.0) (2026-11-27)


### Features

* **agy:** add Antigravity CLI provider via ACP ([#50](https://github.com/ChmaraX/herdr-chat/issues/50)) ([aef04ec](https://github.com/ChmaraX/herdr-chat/commit/aef04ec4803c42edf6992a579ed52d559e1b8fc2))
* **box:** box run --script-file runs a script from outside the worktree ([#55](https://github.com/ChmaraX/herdr-chat/issues/55)) ([2bc8de7](https://github.com/ChmaraX/herdr-chat/commit/2bc8de76f3a93ead98e0a71b11fd9a9897852877))
* **chat:** expand a bash permission's full command on click ([#60](https://github.com/ChmaraX/herdr-chat/issues/60)) ([754b25a](https://github.com/ChmaraX/herdr-chat/commit/754b25af24d80b17cec2bcbcb15db121fd192458))
* **claude:** name the model opusplan is using, follow the permission mode ([#59](https://github.com/ChmaraX/herdr-chat/issues/59)) ([94df4f9](https://github.com/ChmaraX/herdr-chat/commit/94df4f9ceeecb7fccb8381310e485381cf562ea4))
* **new-chat:** Terminal entry, hide uninstalled agents, fit dialog ([#58](https://github.com/ChmaraX/herdr-chat/issues/58)) ([38260e2](https://github.com/ChmaraX/herdr-chat/commit/38260e20c747380941efa93890ee816dcfea147b))
* run on Windows (Git Bash install) ([#62](https://github.com/ChmaraX/herdr-chat/issues/62)) ([b069440](https://github.com/ChmaraX/herdr-chat/commit/b0694403bd259df6b997e90376ea5e4ecc921d81))


### Bug Fixes

* **chat:** a dialog with a multi-line title keeps its options and the chat in view ([#52](https://github.com/ChmaraX/herdr-chat/issues/52)) ([7c18b61](https://github.com/ChmaraX/herdr-chat/commit/7c18b61b8420c56a6be2dc1d97cbdd327000b5b9))
* **chat:** a restart keeps the conversation on screen, its pin, and loads sessions over 8 MiB ([#67](https://github.com/ChmaraX/herdr-chat/issues/67)) ([7226faa](https://github.com/ChmaraX/herdr-chat/commit/7226faadd2e33bc4872601618a38ad8828424009))
* **chat:** restore draft to composer when a sent message is rejected ([#54](https://github.com/ChmaraX/herdr-chat/issues/54)) ([ccd864e](https://github.com/ChmaraX/herdr-chat/commit/ccd864ed2d8439a23335163c80b3c50b80cd0fbc))
* **chat:** the plan card's reason field asks what should change ([#41](https://github.com/ChmaraX/herdr-chat/issues/41)) ([bf4ed58](https://github.com/ChmaraX/herdr-chat/commit/bf4ed586d5764e3f830231167f096ca03ced6908))
* **claude:** a Code Mode session isn't taken over by a chat, which Claude Code would refuse ([#39](https://github.com/ChmaraX/herdr-chat/issues/39)) ([044ec6d](https://github.com/ChmaraX/herdr-chat/commit/044ec6d1eecad448a0db7ed815781cf03d2b42bb))
* **claude:** display configured ANTHROPIC_MODEL and settings model ([#49](https://github.com/ChmaraX/herdr-chat/issues/49)) ([ad9ed39](https://github.com/ChmaraX/herdr-chat/commit/ad9ed399daa5e74e1ddf6331441b15a676b5cec4))
* **install:** preserve symlinks when editing keys.json and layouts ([#48](https://github.com/ChmaraX/herdr-chat/issues/48)) ([176ec38](https://github.com/ChmaraX/herdr-chat/commit/176ec381087573bcb62789f92a3bab09c37245b9))
* **new-chat:** the update question no longer blocks the app or stacks ([#40](https://github.com/ChmaraX/herdr-chat/issues/40)) ([14fd564](https://github.com/ChmaraX/herdr-chat/commit/14fd56414e0c419b1a7f0575efa3401c8681fdaf))
* **update:** chats restart onto an update as they are opened, not all at once ([#68](https://github.com/ChmaraX/herdr-chat/issues/68)) ([2184996](https://github.com/ChmaraX/herdr-chat/commit/2184996f6a40297f4ccf818d60726d108c0da089))


### Performance Improvements

* **chat:** open new chats faster, Codex ready before model/list ([#61](https://github.com/ChmaraX/herdr-chat/issues/61)) ([6f0e8f9](https://github.com/ChmaraX/herdr-chat/commit/6f0e8f9c33b5a68823d166f53645ad4622ec50f2))

## [0.6.0](https://github.com/ChmaraX/herdr-chat/compare/v0.5.0...v0.6.0) (2026-11-21)


### Features

* **chat:** a message can run several skills, every pill on Pi, Claude Code and Codex ([#35](https://github.com/ChmaraX/herdr-chat/issues/35)) ([914c7ec](https://github.com/ChmaraX/herdr-chat/commit/914c7ec66a7d9585789d8a754374aa6ee04364be))
* run on Linux (follow-up to [#30](https://github.com/ChmaraX/herdr-chat/issues/30)) ([#45](https://github.com/ChmaraX/herdr-chat/issues/45)) ([1393101](https://github.com/ChmaraX/herdr-chat/commit/1393101b7d6faf6b55978defbfd4f53937e992d2))


### Bug Fixes

* **chat:** Continue as chat and New chat say why they can't in another machine's space (follow-up to [#31](https://github.com/ChmaraX/herdr-chat/issues/31)) ([#44](https://github.com/ChmaraX/herdr-chat/issues/44)) ([ca9a2b8](https://github.com/ChmaraX/herdr-chat/commit/ca9a2b86f2747ae337560bbea0e097408d8bb067))
* **chat:** Continue as chat finds an agent its terminal's own command started (follow-up to [#32](https://github.com/ChmaraX/herdr-chat/issues/32)) ([#43](https://github.com/ChmaraX/herdr-chat/issues/43)) ([1308ddc](https://github.com/ChmaraX/herdr-chat/commit/1308ddc2e13d5536eb9f3fb42012a4746a7e361c))
* **chat:** the chat scrolls evenly at any UI zoom (follow-up to [#33](https://github.com/ChmaraX/herdr-chat/issues/33)) ([#42](https://github.com/ChmaraX/herdr-chat/issues/42)) ([07a8b11](https://github.com/ChmaraX/herdr-chat/commit/07a8b11c143d852ca66dc7ede2890221ce23c272))
* **host:** one host process per chat: a second host of a chat refuses, and restarts start one ([#37](https://github.com/ChmaraX/herdr-chat/issues/37)) ([7b6cce2](https://github.com/ChmaraX/herdr-chat/commit/7b6cce26537f15bbdf68ab5041a349e98f524645))

## [0.5.0](https://github.com/ChmaraX/herdr-chat/compare/v0.4.0...v0.5.0) (2026-11-17)


### Features

* **chat:** /resume lists every session, for every agent, with This folder / All folders ([#25](https://github.com/ChmaraX/herdr-chat/issues/25)) ([478786b](https://github.com/ChmaraX/herdr-chat/commit/478786be5264d7a37c09fb94f6a9225904c1a8a2))
* **chat:** the model picker has a tab per model provider, so two logins of one service are two tabs ([#26](https://github.com/ChmaraX/herdr-chat/issues/26)) ([e44a0ef](https://github.com/ChmaraX/herdr-chat/commit/e44a0ef900dd25315369fa4a45654141dbb053f9))

## [0.4.0](https://github.com/ChmaraX/herdr-chat/compare/v0.3.0...v0.4.0) (2026-11-15)


### Features

* **chat:** answer question cards from the keyboard (↑↓, Enter, Space) ([#22](https://github.com/ChmaraX/herdr-chat/issues/22)) ([ed6e88f](https://github.com/ChmaraX/herdr-chat/commit/ed6e88fa6673dfd25ffd67165129737881f40b21))
* **chat:** pasted and dropped images show as thumbnails in the composer ([#23](https://github.com/ChmaraX/herdr-chat/issues/23)) ([7d42f60](https://github.com/ChmaraX/herdr-chat/commit/7d42f60ceeba48afb69b42d4008905312276dd2d))
* **chat:** the agent's plan in a strip above the composer; Claude's task list feeds it ([#20](https://github.com/ChmaraX/herdr-chat/issues/20)) ([63e4d64](https://github.com/ChmaraX/herdr-chat/commit/63e4d64bb3c630b58d52c49b73fbbeebefa232d6))


### Bug Fixes

* **chat:** a sent image appears once, at its real aspect ratio, with no jump ([#24](https://github.com/ChmaraX/herdr-chat/issues/24)) ([a5810ee](https://github.com/ChmaraX/herdr-chat/commit/a5810ee9da2b5a283b18ec6b95e79bffaba6ade9))
* **chat:** the thinking timer shows once, not twice ([#21](https://github.com/ChmaraX/herdr-chat/issues/21)) ([ba0db69](https://github.com/ChmaraX/herdr-chat/commit/ba0db699906b13f5b6e336cfe9cd22d77c84d6dd))
* installs and closed chats no longer leak sockets until every chat sticks at "Starting…" ([#17](https://github.com/ChmaraX/herdr-chat/issues/17)) ([ae28634](https://github.com/ChmaraX/herdr-chat/commit/ae28634258ffa9b5b1749bf11ff134ca9cb25659))

## [0.3.0](https://github.com/ChmaraX/herdr-chat/compare/v0.2.0...v0.3.0) (2026-11-12)


### Features

* offer updates, and restart open chats on the new version ([#10](https://github.com/ChmaraX/herdr-chat/issues/10)) ([20205cc](https://github.com/ChmaraX/herdr-chat/commit/20205cc9a54d4739678020cfd1bf0706fa983338))
* the branch under the composer, a click copies it ([#9](https://github.com/ChmaraX/herdr-chat/issues/9)) ([fcdd5bc](https://github.com/ChmaraX/herdr-chat/commit/fcdd5bc1c5b81c35c4d0441d6c2f8cd368b7b610))


### Bug Fixes

* chat keys keep working after Herdr's keys.json is saved ([#7](https://github.com/ChmaraX/herdr-chat/issues/7)) ([de073ca](https://github.com/ChmaraX/herdr-chat/commit/de073ca1a930a5cee73b02e16e19b2b2ea4a336f))

## [0.2.0](https://github.com/ChmaraX/herdr-chat/compare/v0.1.3...v0.2.0) (2026-11-10)


### Features

* code blocks scroll sideways by their scrollbar and select text for ⌘C ([ebbd5e1](https://github.com/ChmaraX/herdr-chat/commit/ebbd5e149b8da8cffbde0ba8277afc025ba77995))


### Bug Fixes

* a chat in a folder that doesn't exist says so and stops retrying ([6fef487](https://github.com/ChmaraX/herdr-chat/commit/6fef4876e36fbd465ef524d8e9706851d9ea7cff))

## [0.1.3](https://github.com/ChmaraX/herdr-chat/compare/v0.1.2...v0.1.3) (2026-11-10)


### Bug Fixes

* a chat whose host became a shell starts a new host ([e7023a5](https://github.com/ChmaraX/herdr-chat/commit/e7023a5d697b1d1b0f9012fe725880d4ec372493))

## [0.1.2](https://github.com/ChmaraX/herdr-chat/compare/v0.1.1...v0.1.2) (2026-11-09)


### Bug Fixes

* a turn's last answer is in the terminal before it reports done ([eca95ee](https://github.com/ChmaraX/herdr-chat/commit/eca95eeeb9562abeec8fd3433352e411a87a3d58))
* the mods live in herdr-app/mods, so herdr.dev/mods lists herdr-chat ([f09eb19](https://github.com/ChmaraX/herdr-chat/commit/f09eb19bfe095c9c639e9e6393a6db47068f1eab))

## [0.1.1](https://github.com/ChmaraX/herdr-chat/compare/v0.1.0...v0.1.1) (2026-11-09)


### Bug Fixes

* works with Herdr 0.1.14: sub-agent rows open as chats again, and no newer-than-tested warning ([e5b1f2a](https://github.com/ChmaraX/herdr-chat/commit/e5b1f2a941e090a70ce5c87b4c5b54d0b8a5f609))

## 0.1.0 (2026-11-09)


### Features

* `/tui` opens the agent's own TUI on the same session; quit it and the chat continues. ([eab837c](https://github.com/ChmaraX/herdr-chat/commit/eab837c43580be88f170f5ac70e5a2b76ca8d722))
* A chat is a normal Herdr agent: its status shows in the agents list and tab bar, other agents can `hc send` to it, and `hc read` shows a transcript. ([eab837c](https://github.com/ChmaraX/herdr-chat/commit/eab837c43580be88f170f5ac70e5a2b76ca8d722))
* A click on a diagram or image opens it in a viewer with zoom and pan: ⌘ or Ctrl + scroll zooms around the pointer, `+` `-` `0` (fit) `1` (100 %) and the header's buttons too, from 10 % to 800 %; scroll or drag pans. Diagrams stay sharp when zoomed. ([eab837c](https://github.com/ChmaraX/herdr-chat/commit/eab837c43580be88f170f5ac70e5a2b76ca8d722))
* A native chat in a Herdr tab for Pi, Claude Code and Codex. Each runs as the CLI you already use, with your login, settings, extensions, skills and sessions. ([eab837c](https://github.com/ChmaraX/herdr-chat/commit/eab837c43580be88f170f5ac70e5a2b76ca8d722))
* an edit waiting for approval shows its diff in the approval card ([bfeaac4](https://github.com/ChmaraX/herdr-chat/commit/bfeaac47415cdd1cce1df82462860b2efaa21831))
* Continue as chat for Claude Code and Codex TUIs, and every agent's terminal-only commands in the / menu ([31657f8](https://github.com/ChmaraX/herdr-chat/commit/31657f88128b89332820a4e59a1f10d0c3c41836))
* Continue as chat: an idle Pi TUI, a sub-agent or a top-level one, becomes a chat on the same session. ([eab837c](https://github.com/ChmaraX/herdr-chat/commit/eab837c43580be88f170f5ac70e5a2b76ca8d722))
* Keys: ⌘I opens the "New chat…" launcher (⌘J A when ⌘I is taken). You can bind keys for a Pi, Claude Code or Codex chat, and for Continue as chat. The chat's own keys can be rebound. ([eab837c](https://github.com/ChmaraX/herdr-chat/commit/eab837c43580be88f170f5ac70e5a2b76ca8d722))
* Pickers for the model, thinking effort and permission mode, a `/` command menu, `@` file mentions, and pasted or dropped images. ([eab837c](https://github.com/ChmaraX/herdr-chat/commit/eab837c43580be88f170f5ac70e5a2b76ca8d722))
* skill pills, terminal commands in a dialog, and /fork for Pi, Claude Code and Codex ([152de44](https://github.com/ChmaraX/herdr-chat/commit/152de4459cfdef7bedefd9faf85b90b315c7e52f))
* Streaming answers with highlighted code and Mermaid diagrams, tool cards with diffs, and approval cards: allow once, always, or deny with a reason. ([eab837c](https://github.com/ChmaraX/herdr-chat/commit/eab837c43580be88f170f5ac70e5a2b76ca8d722))
* Sub-agent chats: `hc run … pi-chat`, `claude-chat` or `codex-chat` starts a helper that opens as a chat from its row in the agents list or from the right-click menu. ([eab837c](https://github.com/ChmaraX/herdr-chat/commit/eab837c43580be88f170f5ac70e5a2b76ca8d722))
* The install checks Herdr's version: it warns on a Herdr newer than the tested 0.1.13 and refuses one older than 0.1.12. ([eab837c](https://github.com/ChmaraX/herdr-chat/commit/eab837c43580be88f170f5ac70e5a2b76ca8d722))
* The install leaves another plugin's agents list or right-click menu alone and says what that costs. `--take-agents-slot` and `--take-menu` take them anyway, and uninstall gives them back. ([eab837c](https://github.com/ChmaraX/herdr-chat/commit/eab837c43580be88f170f5ac70e5a2b76ca8d722))
* The one-line install, `curl -fsSL https://raw.githubusercontent.com/ChmaraX/herdr-chat/main/install.sh | sh -s -- --app`, downloads the release, checks it against the release's SHA256SUMS and installs it: no clone, no npm install, Node 20 or later. It adds the mods, keys, layout edits, hc templates and a small Pi extension that keeps a TUI from writing a session a chat has open. Run it again to update. `--uninstall` puts back exactly what it changed. In a clone, `./install.sh` does the same from the clone. ([eab837c](https://github.com/ChmaraX/herdr-chat/commit/eab837c43580be88f170f5ac70e5a2b76ca8d722))
* Two queues above the composer: Enter steers the current run, Alt+Enter queues a follow-up for after it. Click a queued message to edit it, move it to the other queue, or remove it. ([eab837c](https://github.com/ChmaraX/herdr-chat/commit/eab837c43580be88f170f5ac70e5a2b76ca8d722))


### Bug Fixes

* a startup dialog the agent resolved by its timeout closes when the agent starts ([d731b0b](https://github.com/ChmaraX/herdr-chat/commit/d731b0b57df195d6dd6f598d8625e57cfb62f0a6))
