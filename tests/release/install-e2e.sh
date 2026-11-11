#!/usr/bin/env bash
# The release install end to end, on a scratch home in /tmp (HOME,
# HERDR_APP_HOME, XDG_CONFIG_HOME, PI_CODING_AGENT_DIR): never the person's own.
#
#   tests/release/install-e2e.sh        (npm run test:install)
#
# Builds two release archives (this tree as package.json's version, and as the next patch),
# then, the way the curl one-liner runs it (install.sh on stdin, `sh -s --`):
#   1. installs the first from --from <archive>: the files land, the chat's host
#      is …/herdr-chat/current/bin/herdr-chat-host, `current` is that version, the
#      summary names the layout, notes, templates, extension and keys;
#   2. the unpacked mods pass `herdr-app check`; the installed host (built JS, on
#      the node the install found) serves fake-pi and answers one prompt;
#   3. a tampered archive is refused and changes nothing;
#   4. updates to the second from --from <dir>: `current` moves, the first is
#      kept, "open chats keep the old version", the running host keeps serving;
#   5. --uninstall: every file outside the share dir is back byte for byte, and
#      the share dir is gone.
# Node: $E2E_NODE, else the oldest Node 20 nvm has, else node on PATH: the
# install and the host then run on it (the release's minimum).
# Needs herdr-app (its check and --version) and hc on PATH; no app runs.
# Artifacts: tests/artifacts/release/ (the log, the outputs, the before/after hashes).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
ART="$REPO/tests/artifacts/release"
rm -rf "$ART" && mkdir -p "$ART"
LOG="$ART/install-e2e.log"
D="$(mktemp -d /tmp/herdr-chat-release-e2e.XXXXXX)"
PASSES=0
step() { printf '\n== %s\n' "$*" | tee -a "$LOG"; }
ok() { PASSES=$((PASSES + 1)); printf 'ok   %s\n' "$*" | tee -a "$LOG"; }
fail() { printf 'FAIL %s\n' "$*" | tee -a "$LOG"; echo "scratch dir kept: $D" | tee -a "$LOG"; exit 1; }
check() { local what=$1; shift; if "$@" >>"$LOG" 2>&1; then ok "$what"; else fail "$what"; fi; }

command -v herdr-app >/dev/null || fail "herdr-app not on PATH"
command -v hc >/dev/null || fail "hc not on PATH"
APP_BIN="$(command -v herdr-app)" HC_BIN="$(command -v hc)"
v20=$(ls "$HOME/.nvm/versions/node" 2>/dev/null | grep '^v20\.' | sort -t. -k2,2n | head -1 || true)
NODE="${E2E_NODE:-${v20:+$HOME/.nvm/versions/node/$v20/bin/node}}"
NODE="${NODE:-$(command -v node)}"
step "scratch $D, node $("$NODE" --version) ($NODE), $("$APP_BIN" --version)"

# --- two releases ------------------------------------------------------------------------
V1=$(node -p 'require(process.argv[1]).version' "$REPO/package.json")
V2=$(node -p 'const [a,b,c]=process.argv[1].split(".").map(Number); [a,b,c+1].join(".")' "$V1")
DIST="$D/dist"
node "$REPO/scripts/build.mjs" --out "$DIST" >>"$LOG"
node "$REPO/scripts/build.mjs" --out "$DIST" --version "$V2" >>"$LOG"
cp "$DIST/SHA256SUMS" "$ART/SHA256SUMS"
check "two archives and their SHA256SUMS ($V1, $V2)" sh -c "cd '$DIST' && shasum -a 256 -c SHA256SUMS"
check "the archive has no TypeScript to run and no node_modules" sh -c "! tar -tzf '$DIST/herdr-chat-$V1.tar.gz' | grep -E '(host|install)/.*\\.ts\$|node_modules/'"

# --- a scratch home ---------------------------------------------------------------------
export HOME="$D/home" HERDR_APP_HOME="$D/app" XDG_CONFIG_HOME="$D/config" PI_CODING_AGENT_DIR="$D/pi"
unset XDG_DATA_HOME CLAUDE_CONFIG_DIR CODEX_HOME HERDR_APP_BIN HERDR_CHAT_NODE
for v in $(env | sed -nE 's/^((HC|HERDR)_[A-Z_]*)=.*/\1/p'); do [ "$v" = HERDR_APP_HOME ] || unset "$v"; done
BIN="$D/bin"
mkdir -p "$BIN" "$HOME/.codex" "$XDG_CONFIG_HOME" "$PI_CODING_AGENT_DIR" "$HERDR_APP_HOME/layouts" "$D/work"
ln -s "$NODE" "$BIN/node"
ln -s "$REPO/tests/fake-pi/fake-pi.mjs" "$BIN/pi" # the install wants pi on PATH; this one is fake
ln -s "$APP_BIN" "$BIN/herdr-app"
ln -s "$HC_BIN" "$BIN/hc"
export PATH="$BIN:/usr/bin:/bin:/usr/sbin:/sbin"
echo "codex rules" >"$HOME/.codex/AGENTS.md"
echo '{"layout:main": {}}' >"$HERDR_APP_HOME/installed.json"
echo '{"layout": "mine"}' >"$HERDR_APP_HOME/shared.json"
# The layout and keys.json as the app writes them (2-space JSON): the uninstall
# gives back their content, and so their bytes in that format.
pretty() { "$NODE" -e 'process.stdout.write(JSON.stringify(JSON.parse(require("fs").readFileSync(0, "utf8")), null, 2) + "\n")'; }
pretty >"$HERDR_APP_HOME/layouts/mine.json" <<'JSON'
{
  "type": "row", "id": "root", "cloned_from": { "name": "main", "version": "0.1.11" },
  "children": [
    { "type": "column", "id": "sidebar", "size": { "px": 268 }, "children": [
      { "type": "block", "id": "agents", "min": 90, "size": { "weight": 1 }, "content": { "mod": "agents" } }
    ] },
    { "type": "block", "id": "main", "content": { "pane": { "gap": 8 }, "tab": "active" } }
  ],
  "floating": [{ "id": "x-sync", "edge": "bottom", "align": "end", "content": { "mod": "other", "props": { "role": "sync" } } }]
}
JSON
pretty >"$HERDR_APP_HOME/keys.json" <<'JSON'
{
  "global": { "cmd-b": "layout.toggle:sidebar", "cmd-k": "mod.open:picker" },
  "terminal": { "cmd-c": "terminal.copy" }
}
JSON
# Not compared: the share dir (checked on its own) and the scratch home's herdr-core
# state (the install's `herdr-app check` of the chat mod starts that home's core).
snap() { (cd "$D" && find home app config pi -type f ! -path 'home/.local/share/*' ! -path 'home/.local/state/herdr-core/*' | LC_ALL=C sort | while read -r f; do shasum -a 256 "$f"; done); }
snap >"$ART/before.sha256"
HOST_PID=
# The host, and the core `herdr-app check` started for the scratch home.
cleanup() { [ -z "$HOST_PID" ] || kill "$HOST_PID" 2>/dev/null || true; "$HC_BIN" server stop >>"$LOG" 2>&1 || true; }
trap cleanup EXIT
BASE="$HOME/.local/share/herdr-chat"
# The one-liner's shape: the script on stdin, from a folder that isn't a clone.
oneliner() { (cd "$D/work" && sh -s -- "$@" <"$REPO/install.sh"); }

# --- 1. install the first release ----------------------------------------------------------
step "install $V1 (sh -s -- --app --from <archive>)"
oneliner --app --from "$DIST/herdr-chat-$V1.tar.gz" >"$ART/install-1.out" 2>&1 || { cat "$ART/install-1.out" >>"$LOG"; fail "install $V1"; }
cat "$ART/install-1.out" >>"$LOG"
CFG="$HERDR_APP_HOME/mods/chat/config.json"
cfg() { "$NODE" -p "require(process.argv[1])[process.argv[2]]" "$CFG" "$1"; }
check "unpacked to $BASE/$V1, current → $V1" test "$(readlink "$BASE/current")" = "$V1" -a -f "$BASE/$V1/host/main.js"
check "mods chat and new-chat installed, ours (.herdr-chat)" test -f "$HERDR_APP_HOME/mods/chat/.herdr-chat" -a -f "$HERDR_APP_HOME/mods/new-chat/.herdr-chat"
check "config.json host is current's herdr-chat-host" test "$(cfg host)" = "$BASE/current/bin/herdr-chat-host"
check "config.json version $V1, node the one the install found" test "$(cfg version)" = "$V1" -a "$(cfg node)" = "$BIN/node"
check "config.json build is the installed host's (herdr-chat-host build)" test "$(cfg build)" = "$("$NODE" -p 'JSON.parse(process.argv[1]).build' "$("$BASE/current/bin/herdr-chat-host" build)")"
check "config.json: a release, updated by the one-liner" test "$(cfg channel)" = release -a -n "$(cfg update | grep -F 'install.sh | sh -s --')"
check "templates start current's herdr-chat-subagent" grep -qx "command: '$BASE/current/bin/herdr-chat-subagent' --provider pi" "$XDG_CONFIG_HOME/herdr-core/templates/pi-chat.md"
check "the Pi lock extension installed" cmp "$PI_CODING_AGENT_DIR/extensions/herdr-chat-lock.ts" "$REPO/extension/herdr-chat-lock.ts"
check "the sub-agents note in Codex's AGENTS.md" grep -q "herdr-chat:subagents begin" "$HOME/.codex/AGENTS.md"
check "the layout gets new-chat's floating copy" grep -q '"mod": "new-chat"' "$HERDR_APP_HOME/layouts/mine.json"
check "keys.json binds the launcher" grep -q '"cmd-i": "mod.open:new-chat"' "$HERDR_APP_HOME/keys.json"
for row in layout notes templates extension keys; do
  check "the summary's $row line" grep -Eq "^  $row +[^ ]" "$ART/install-1.out"
done

# --- 2. the unpacked mods and the built host -------------------------------------------------
step "herdr-app check on the unpacked mods; the built host answers a prompt"
# chat-agents and chat-menu load the install-time copy of the app's own mods
# (agents-base.js, menu-base.js), which a scratch home without a running app
# doesn't have: the install leaves them out, and says so.
for m in "$BASE/current/herdr-app/mods"/*/ "$HERDR_APP_HOME/mods"/*/; do
  [ -f "$m/main.js" ] || continue
  case $m in "$BASE"/*/herdr-app/mods/chat-agents/|"$BASE"/*/herdr-app/mods/chat-menu/) continue ;; esac
  check "herdr-app check ${m#"$D"/}" herdr-app check "$m"
done
check "the install said why chat-agents and chat-menu are left out" grep -q "not installing mods/chat-agents: .*start the app once" "$ART/install-1.out"
HOST="$(cfg host)"
STATE="$D/state"
HERDR_CHAT_NODE="$(cfg node)" "$HOST" serve --chat e2e --cwd "$D/work" --state-dir "$STATE" --pi "$BIN/pi" -- --session-dir "$D/sessions" >"$ART/host.out" 2>&1 &
HOST_PID=$!
"$HOST" send --chat e2e --state-dir "$STATE" "hello from the release" >>"$LOG" 2>&1 || fail "send a prompt to the built host"
answered() { "$HOST" inspect --chat e2e --state-dir "$STATE" 2>/dev/null | grep -q '"ok: hello from the release"'; }
for _ in $(seq 50); do answered && break; sleep 0.2; done
check "the built host (node $("$(cfg node)" --version)) answered: ok: hello from the release" answered
check "the host runs the release's JS, not TypeScript" sh -c "ps -ax -o args= | grep -q '$BASE/current/host/main.js serve --chat e2e'"

# --- 3. a tampered archive --------------------------------------------------------------
step "a tampered archive is refused"
mkdir -p "$D/bad"
cp "$DIST/SHA256SUMS" "$D/bad/"
cp "$DIST/herdr-chat-$V2.tar.gz" "$D/bad/" && printf 'x' >>"$D/bad/herdr-chat-$V2.tar.gz"
before=$(snap)
if oneliner --app --from "$D/bad/herdr-chat-$V2.tar.gz" >"$ART/tampered.out" 2>&1; then fail "the tampered archive installed"; fi
cat "$ART/tampered.out" >>"$LOG"
check "it says so" grep -q "does not match its SHA-256" "$ART/tampered.out"
check "nothing changed: current still $V1, no $V2 folder, every file the same" sh -c "[ \"\$(readlink '$BASE/current')\" = '$V1' ] && [ ! -e '$BASE/$V2' ] && [ \"\$1\" = \"\$2\" ]" _ "$before" "$(snap)"

# --- 4. update ------------------------------------------------------------------------------
step "update to $V2 (sh -s -- --app --from <dir>: its newest)"
oneliner --app --from "$DIST" >"$ART/install-2.out" 2>&1 || { cat "$ART/install-2.out" >>"$LOG"; fail "update to $V2"; }
cat "$ART/install-2.out" >>"$LOG"
check "current → $V2, $V1 kept beside it" test "$(readlink "$BASE/current")" = "$V2" -a -d "$BASE/$V1"
check "config.json: version $V2, host still current's" test "$(cfg version)" = "$V2" -a "$(cfg host)" = "$BASE/current/bin/herdr-chat-host"
check "it says open chats keep the old version" grep -q "updated $V1 → $V2 .*open chats keep the old version until you reopen them" "$ART/install-2.out"
"$HOST" send --chat e2e --state-dir "$STATE" "still there" >>"$LOG" 2>&1 || fail "send after the update"
still() { "$HOST" inspect --chat e2e --state-dir "$STATE" 2>/dev/null | grep -q '"ok: still there"'; }
for _ in $(seq 50); do still && break; sleep 0.2; done
check "the chat started before the update still answers" still
kill "$HOST_PID" 2>/dev/null || true
wait "$HOST_PID" 2>/dev/null || true

# --- 5. uninstall ----------------------------------------------------------------------------
step "uninstall (sh -s -- --uninstall)"
oneliner --uninstall >"$ART/uninstall.out" 2>&1 || { cat "$ART/uninstall.out" >>"$LOG"; fail "uninstall"; }
cat "$ART/uninstall.out" >>"$LOG"
check "the share dir is gone" test ! -e "$BASE"
# What stays by design: the chat's own records in data/herdr-chat (the README's uninstall says so).
snap | grep -v ' app/data/herdr-chat/' >"$ART/after.sha256"
check "every other file byte for byte as before (before.sha256 = after.sha256)" diff "$ART/before.sha256" "$ART/after.sha256"
check "no mods of ours left" sh -c "! ls -d '$HERDR_APP_HOME'/mods/* 2>/dev/null"
(cd "$D" && find app/data -type f 2>/dev/null) >"$ART/left-in-data.txt" || true

step "all passed: $PASSES checks"
cleanup
rm -rf "$D"
