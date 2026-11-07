#!/usr/bin/env bash
# Install herdr-chat (Pi, Claude Code and Codex as a native GUI chat) into the Herdr desktop app.
# The root install.sh runs this: from a clone (./install.sh), or from a release it
# downloaded and unpacked (the curl one-liner).
#
#   ./install.sh               install the mods, the keys, sub-agent chats, the Pi lock extension
#   ./install.sh --uninstall   undo it (running chats keep running until closed)
#
# Options:
#   --no-layout        leave your layout alone (sub-agents then keep their TUI peek,
#                      and only the "open" key is bound: the others need the layout)
#   --take-agents-slot when another plugin's mod is in the layout's agents block,
#                      put chat-agents there anyway (uninstall gives it back)
#   --take-menu        the same for another plugin's terminal_menu
#   --no-subagents     no hc templates and no sub-agents note in the agents'
#                      instruction files (--no-templates: the same)
#
# Keys: the "global" part of data/herdr-chat/keys.json in the app home (KEYS.md):
#   {"global": {"open": "cmd-i", "pi": null, "claude": null, "codex": null}}
#   open: the "New chat with…" launcher (default cmd-i; cmd-j a when cmd-i is
#   taken); pi/claude/codex: that agent's chat at once (unbound by default).
#   A chord you choose replaces what had it; uninstall puts that back.
#
# What it does, in the app home ($HERDR_APP_HOME, else ~/.config/herdr-app):
#   - copies every folder in mod/ into mods/ (only over folders it made itself,
#     marked with a .herdr-chat file) and writes mods/chat/config.json
#     (absolute paths of the host, node, hc and each agent it finds on PATH,
#     and herdr-chat's version; your own settings go in data/herdr-chat/settings.json,
#     which install never writes: README "Settings")
#   - checks Herdr's and herdr-core's versions against the tested ones
#     (package.json "herdr"): newer warns, older than the minimum is refused
#   - runs `herdr-app check` on each mod before changing anything else
#   - chat-agents and chat-menu get their install-time copy of Herdr's shipped
#     agents list and right-click menu (install/mods.ts); one whose shipped mod
#     changed shape is left out, with the reason
#   - your layout (the personal one on screen, else your copy of Herdr's, else
#     a clone): its agents block shows chat-agents (a chat sub-agent's click
#     opens the chat), its root terminal_menu is chat-menu (Open as chat,
#     Continue as chat), its floating list gets an empty new-chat block (the
#     new-chat.* commands); recorded in data/herdr-chat/install-layout.json.
#     A slot another plugin holds is left to it, with what that costs
#   - the keys into keys.json's global section (install/keys.ts), the file
#     rewritten only if unchanged since it was read; recorded in
#     data/herdr-chat/install.json so --uninstall restores exactly that
# And in herdr-core's templates ($XDG_CONFIG_HOME, else ~/.config, /herdr-core/templates):
#   - pi-chat.md, claude-chat.md, codex-chat.md (each agent found): `hc run … pi-chat "<task>"`
#     starts a sub-agent the person can open as a chat (only over files it wrote)
# And in each agent's instruction file, when that agent is installed (its folder exists):
#   - a marked block telling it to start sub-agents that way (install/instructions.ts):
#     Pi ~/.pi/agent/AGENTS.md, Claude Code ~/.claude/CLAUDE.md, Codex ~/.codex/AGENTS.md
# And in Pi's agent dir ($PI_CODING_AGENT_DIR, else ~/.pi/agent):
#   - installs extensions/herdr-chat-lock.ts (keeps the TUI from writing a
#     session a chat has open; labels a Pi TUI's terminal with its session,
#     for Continue as chat)
set -euo pipefail

# ROOT: the tree to install from (a clone, or an unpacked release). LINK: the path
# the chat's config and the templates name for it: for a release, the "current"
# link, so the next update's host is the one new chats start.
ROOT="${HERDR_CHAT_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
LINK="${HERDR_CHAT_LINK:-$ROOT}"
# A release has the host and install scripts built to JS (no TypeScript, no npm install);
# a clone runs the TypeScript itself (Node 24+).
if [ -f "$ROOT/host/main.js" ]; then EXT=js; else EXT=ts; fi
INSTALL_CMD="${HERDR_CHAT_INSTALL_CMD:-./install.sh}"
APP_HOME="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
PI_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
STATE="$APP_HOME/data/herdr-chat"
MARK=".herdr-chat"

say() { printf 'herdr-chat: %s\n' "$*"; }
die() { printf 'herdr-chat: %s\n' "$*" >&2; exit 1; }

UNINSTALL=0 LAYOUT=1 SUBAGENTS=1 TAKE=()
TPL_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/herdr-core/templates"
TPL_MARK="installed-by: herdr-chat"
PROVIDERS="pi claude codex"
while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) UNINSTALL=1 ;;
    --key|--replace-pi-key) die "$1 is gone: the keys are in $STATE/keys.json, \"global\": {\"open\": \"cmd-i\", \"pi\": \"cmd-j p\"} (see mod/chat/KEYS.md)" ;;
    --no-layout) LAYOUT=0 ;;
    --take-agents-slot|--take-menu) TAKE+=("$1") ;;
    --no-subagents|--no-templates) SUBAGENTS=0 ;;
    -h|--help) awk 'NR > 1 && /^set -e/ { exit } NR > 1' "$0"; exit 0 ;;
    *) die "unknown option $1" ;;
  esac
  shift
done

[ -d "$APP_HOME" ] || die "no Herdr app home at $APP_HOME (start the app once, or set HERDR_APP_HOME)"

MODS=()
for d in "$ROOT"/mod/*/; do [ -f "$d/mod.json" ] && MODS+=("$(basename "$d")"); done
[ "${#MODS[@]}" -gt 0 ] || die "no mods in $ROOT/mod"

ours() { [ ! -e "$1" ] || [ -f "$1/$MARK" ]; }

if [ "$UNINSTALL" = 1 ]; then
  # The layout first: it must stop naming chat-agents / chat-menu before they go.
  node "$ROOT/install/layout.$EXT" uninstall "$APP_HOME" || die "the layout couldn't be restored; nothing else removed"
  for p in $PROVIDERS; do
    f="$TPL_DIR/$p-chat.md"
    if [ -f "$f" ] && grep -qx "$TPL_MARK" "$f"; then rm -f "$f"; say "removed $f"; fi
  done
  node "$ROOT/install/instructions.$EXT" uninstall "$APP_HOME" || say "the sub-agents notes couldn't be taken out (see above)"
  node "$ROOT/install/keys.$EXT" uninstall "$APP_HOME" || die "keys.json couldn't be restored; mods left in place"
  for m in "${MODS[@]}"; do
    t="$APP_HOME/mods/$m"
    if [ -d "$t" ] && ours "$t"; then rm -rf "$t"; say "removed mods/$m"; fi
  done
  ext="$PI_DIR/extensions/herdr-chat-lock.ts"
  if [ -f "$ext" ] && cmp -s "$ext" "$ROOT/extension/herdr-chat-lock.ts"; then rm -f "$ext"; say "removed $ext"; fi
  say "uninstalled (open chats keep running until their tabs close; chat records stay in $STATE)"
  exit 0
fi

# --- requirements ------------------------------------------------------------------
command -v hc >/dev/null || die "hc (herdr-core) not on PATH"
NODE="$(command -v node || true)"; [ -n "$NODE" ] || die "node not on PATH"
# package.json's engines: a clone's >= 24 (it runs TypeScript), a release's lower (built JS).
NODE_MIN=$(sed -n 's/.*"node": *">= *\([0-9][0-9]*\).*/\1/p' "$ROOT/package.json" | head -1)
"$NODE" -e 'process.exit(+process.versions.node.split(".")[0] >= +process.argv[1] ? 0 : 1)' "${NODE_MIN:-24}" ||
  die "node >= ${NODE_MIN:-24} needed$([ "$EXT" = ts ] && echo " to install from a clone (it runs the TypeScript)"), have $("$NODE" --version) ($NODE)"
VERSION=$("$NODE" -e 'process.stdout.write(require(process.argv[1]).version)' "$ROOT/package.json")
# The agents on PATH (any of them will do), recorded for chats: a core terminal lacks the login PATH.
AGENTS_FOUND=()
for p in $PROVIDERS; do
  path="$(command -v "$p" || true)"
  printf -v "BIN_$p" '%s' "$path"
  [ -z "$path" ] || AGENTS_FOUND+=("$p")
done
[ "${#AGENTS_FOUND[@]}" -gt 0 ] || die "no agent on PATH: install Pi (pi), Claude Code (claude) or Codex (codex) first"
APP="${HERDR_APP_BIN:-$(command -v herdr-app || true)}"
[ -n "$APP" ] || for c in /Applications/*.app/Contents/MacOS/Herdr; do [ -x "$c" ] && APP="$c" && break; done
[ -n "$APP" ] || die "herdr-app not found (set HERDR_APP_BIN)"
HERDR_CHAT_INSTALL_CMD="$INSTALL_CMD" "$NODE" "$ROOT/install/compat.$EXT" check --app "$APP" --hc "$(command -v hc)" || exit 1
APP_VER=$("$NODE" "$ROOT/install/compat.$EXT" app-version "$APP")
for m in "${MODS[@]}"; do ours "$APP_HOME/mods/$m" || die "mods/$m exists and isn't herdr-chat's; not touching it"; done

# --- the host's runtime dependencies (package.json "dependencies") ------------------
# A release has them bundled into host/main.js (and no "dependencies").
if [ "$EXT" = ts ] && "$NODE" -e 'const d=Object.keys(require(process.argv[1]).dependencies||{}); process.exit(d.length?0:1)' "$ROOT/package.json"; then
  if ! (cd "$ROOT" && "$NODE" -e 'const fs=require("fs"); for (const d of Object.keys(require("./package.json").dependencies)) if (!fs.existsSync("node_modules/"+d+"/package.json")) process.exit(1)') 2>/dev/null; then
    say "installing the host's dependencies (npm install --omit=dev)"
    (cd "$ROOT" && npm install --omit=dev --no-audit --no-fund --loglevel=error) || die "npm install failed"
  fi
fi

# --- mods: copy to a staging folder, check, then swap in ---------------------------
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/herdr-chat-stage.XXXX")"
trap 'rm -rf "$STAGE"' EXIT
for m in "${MODS[@]}"; do
  cp -R "$ROOT/mod/$m" "$STAGE/$m"
  touch "$STAGE/$m/$MARK"
done
# chat-agents / chat-menu: the shipped agents list and menu they extend, copied now (install/mods.ts checks them).
bases=$("$NODE" "$ROOT/install/mods.$EXT" bases "$APP_HOME/mods" "$STAGE") || die "install/mods.$EXT failed"
KEEP=()
for m in "${MODS[@]}"; do
  why=$("$NODE" -e 'const r=JSON.parse(process.argv[1]); process.stdout.write(r[process.argv[2]] ?? "")' "$bases" "$m")
  if [ -n "$why" ] && [ "$why" != ok ]; then
    say "not installing mods/$m: Herdr $APP_VER changed what it copies: $why (sub-agents keep Herdr's own behaviour there; tell herdr-chat which Herdr this was)"
    rm -rf "$STAGE/$m"
  else KEEP+=("$m"); fi
done
MODS=("${KEEP[@]}")
has_mod() { case " ${MODS[*]} " in *" $1 "*) return 0 ;; esac; return 1; }
HC="$(command -v hc)"
"$NODE" -e 'const [path, host, node, hc, version, pi, claude, codex] = process.argv.slice(1);
const agents = Object.fromEntries(Object.entries({ pi, claude, codex }).filter(([, v]) => v));
require("fs").writeFileSync(path, JSON.stringify({ host, node, hc, version, ...agents }, null, 2) + "\n")' \
  "$STAGE/chat/config.json" "$LINK/bin/herdr-chat-host" "$NODE" "$HC" "$VERSION" "$BIN_pi" "$BIN_claude" "$BIN_codex"
for m in "${MODS[@]}"; do
  "$APP" check "$STAGE/$m" >/dev/null 2>&1 || { "$APP" check "$STAGE/$m" || true; die "mods/$m failed herdr-app check; nothing installed"; }
done
mkdir -p "$APP_HOME/mods"
for m in "${MODS[@]}"; do
  rm -rf "$APP_HOME/mods/$m"
  mv "$STAGE/$m" "$APP_HOME/mods/$m"
  say "installed mods/$m"
done

# --- layout: a chat sub-agent's click opens the chat; new-chat's commands -------------
mkdir -p "$STATE"
DIRECT=0
# What the install changed, for the summary at the end.
S_LAYOUT="left as it is (--no-layout)" S_NOTES="none (--no-subagents)" S_TEMPLATES="none (--no-subagents)" S_EXT="none (Pi isn't installed)"
if [ "$LAYOUT" = 1 ]; then
  args=()
  has_mod chat-agents || args+=(--no-agents)
  has_mod chat-menu || args+=(--no-menu)
  if out=$("$NODE" "$ROOT/install/layout.$EXT" install "$APP_HOME" --app "$APP" "${args[@]+"${args[@]}"}" "${TAKE[@]+"${TAKE[@]}"}"); then
    printf '%s\n' "$out"
    case "$out" in *"new-chat's keys"*) DIRECT=1 ;; esac
    S_LAYOUT=$(printf '%s\n' "$out" | sed 's/^herdr-chat: //; s/^layout //' | paste -sd '|' - | sed 's/|/; /g')
  else
    say "layout not changed (see above): sub-agents keep their TUI peek"
    S_LAYOUT="not changed (see above)"
  fi
fi

# --- keys: data/herdr-chat/keys.json's "global" into keys.json ---------------------------
keyargs=()
[ "$DIRECT" = 1 ] || keyargs+=(--no-direct)
out=$("$NODE" "$ROOT/install/keys.$EXT" install "$APP_HOME" "${keyargs[@]+"${keyargs[@]}"}") || die "keys.json not changed (see above)"
printf '%s\n' "$out" | sed '$d'
SUMMARY=$(printf '%s\n' "$out" | tail -1)

# --- hc templates: sub-agents that open as chats -----------------------------------
if [ "$SUBAGENTS" = 1 ]; then
  mkdir -p "$TPL_DIR"
  wrote=()
  for p in "${AGENTS_FOUND[@]}"; do
    f="$TPL_DIR/$p-chat.md"
    if [ -f "$f" ] && ! grep -qx "$TPL_MARK" "$f"; then say "$f exists and isn't herdr-chat's; not touching it"; continue; fi
    wrote+=("$p-chat")
    case "$p" in pi) name="Pi" ;; claude) name="Claude Code" ;; codex) name="Codex" ;; esac
    cat >"$f" <<TPL
---
description: $name as a sub-agent the person can open as a chat in Herdr (its row in the agents list). Give it the task in hc run.
command: '$LINK/bin/herdr-chat-subagent' --provider $p
$TPL_MARK
---
You are a sub-agent: another agent started you with hc run and gave you the task below. Stay within it. The person may also write to you here.
TPL
  done
  say "templates: $(for p in "${AGENTS_FOUND[@]}"; do printf '%s-chat ' "$p"; done)in $TPL_DIR"
  S_TEMPLATES="${wrote[*]:-none (those files belong to something else)} in $TPL_DIR"
  if out=$("$NODE" "$ROOT/install/instructions.$EXT" install "$APP_HOME"); then
    printf '%s\n' "$out"
    S_NOTES=$(printf '%s\n' "$out" | sed -nE 's/.*sub-agents note (is up to date )?(in|to) //p' | paste -sd ',' - | sed 's/,/, /g')
    S_NOTES=${S_NOTES:-none (no agent installed)}
  else
    printf '%s\n' "$out"
    say "the sub-agents notes weren't written (see above)"
    S_NOTES="not written (see above)"
  fi
fi

# --- Pi lock extension --------------------------------------------------------------
if [ -n "$BIN_pi" ] && [ -d "$PI_DIR" ]; then
  mkdir -p "$PI_DIR/extensions"
  cp "$ROOT/extension/herdr-chat-lock.ts" "$PI_DIR/extensions/herdr-chat-lock.ts"
  say "installed $PI_DIR/extensions/herdr-chat-lock.ts"
  S_EXT="$PI_DIR/extensions/herdr-chat-lock.ts (restart running Pi TUIs to load it)"
fi

tilde() { printf '%s' "$1" | sed "s|$HOME/|~/|g"; }
say "done: herdr-chat $VERSION from $(tilde "$LINK"). What it changed:"
printf '  layout     %s\n  notes      %s\n  templates  %s\n  extension  %s\n  keys       %s\n' \
  "$(tilde "$S_LAYOUT")" "$(tilde "$S_NOTES")" "$(tilde "$S_TEMPLATES")" "$(tilde "$S_EXT")" "$SUMMARY"
