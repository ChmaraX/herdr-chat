# The keymap flow, sourced by run.sh (its helpers and variables; last_user is flows-skills.sh's).

# --- flow `keymap`: Herdr's keys.json is written while the chat mod runs (issue #6) ------------
# Herdr rebuilds the app's keymap on every write to its keys.json, even an unchanged one, and
# that drops the bindings mods added: Enter would type a newline instead of sending. The chat
# puts its own back. Every check is a real key, never the mod's command (that would hide it).
if want keymap; then
  # Press $1 (keys.py specs, primed) until $2 holds. A key the undrawn window dropped changes
  # nothing and is pressed again (up to three times); a newline in the composer means Enter
  # reached the text field with no binding of ours: that fails at once (the send would trim it).
  key_until() {
    local i
    for i in 1 2 3; do
      keys 56:shift $1
      until_ "$2" 3 && return 0
      [ "$(d '"\n" in d["composer"]["text"]')" = False ] || { note "a newline: $(d 'repr(d["composer"]["text"])')"; return 1; }
      note "$1 didn't land ($i)"
      cmd focus; sleep 0.3
    done
    return 1
  }
  # Write Herdr's keys.json as an agent or an editor does. $1: inplace | rename (a temp file
  # moved over it); $2: a global chord to add, or - (the same content again).
  write_keys() {
    python3 - "$HERDR_APP_HOME/keys.json" "$1" "$2" <<'PY'
import json, os, sys
path, how, chord = sys.argv[1:]
keys = json.load(open(path))
if chord != "-":
    keys.setdefault("global", {})[chord] = "tab.new"
text = json.dumps(keys, indent=1)
if how == "rename":
    open(path + ".tmp", "w").write(text)
    os.replace(path + ".tmp", path)
else:
    open(path, "w").write(text)
PY
  }
  # Enter sends what's typed: $1 the prompt, $2 the check's name.
  enter_sends() {
    local prompt="$1" # (the condition is evaluated in key_until, where $1 is the key)
    key_until enter '[ "$(last_user text)" = "$prompt" ]' && ok "$2" || fail "$2"
    expect '[ "$(phase)" = idle ]' "the turn ended" 30
  }
  # Type $1, then the write ($2 $3), then Enter $4 s later.
  send_after_write() {
    type_text "$1"
    write_keys "$2" "$3"
    sleep "$4"
    enter_sends "$1" "$5"
  }
  close_chat() { do_ tab.close --id "$(dbg "$1" 'd["place"]["tab"]')" --confirmed true; }

  step "keymap: Enter sends, then Herdr's keys.json is written while the chat is open"
  CHAT=$(open_chat keymap)
  A=$CHAT
  ready
  type_text "before any write"
  enter_sends "before any write" "Enter sends"
  # The person's text is typed, an agent in this chat edits keys.json, and Enter comes right after.
  send_after_write "after an edit" inplace cmd-alt-shift-9 0.6 "a binding added in place: Enter 0.6 s later sends"
  # An editor's save: a temp file moved over keys.json, twice in quick succession, nothing changed.
  write_keys rename -; sleep 0.15
  send_after_write "after two saves" rename - 1 "two unchanged saves in a burst: Enter 1 s later sends"

  step "keymap: a chat opened after the writes has its keys too"
  CHAT=$(open_chat keymap-2)
  B=$CHAT
  ready
  key_until "46:cmd,shift" '[ "$(d "(d[\"picker\"] or {}).get(\"kind\")")" = model ]' && ok "⇧⌘M opens the model picker (a chat shortcut)" || fail "⇧⌘M did nothing"
  key_until esc '[ "$(d "d[\"picker\"]")" = null ]' && ok "Esc closes it (a composer key)" || fail "Esc didn't close the picker"
  type_text "in a new chat"
  enter_sends "in a new chat" "Enter sends in the new chat"
  shot keymap-1-new-chat 0.3

  step "keymap: a chat closes right after a write, before the bindings go back in"
  CHAT=$A; do_ tab.select --id "$(d 'd["place"]["tab"]')"; sleep 0.5; cmd focus; sleep 0.3
  type_text "after the other chat closed"
  write_keys inplace cmd-alt-shift-7; close_chat "$B"; sleep 0.6
  enter_sends "after the other chat closed" "Enter 0.6 s later sends in the chat left open"

  step "keymap: every chat closed, keys.json written, then a chat opened"
  close_chat "$A"
  for t in $(mod_panes | awk '$3 == "chat" { print $1 }' | sort -u); do do_ tab.close --id "$t" --confirmed true; done # (earlier flows' chats)
  expect '! mod_panes | grep -q " chat "' "no chat is open" 10
  write_keys inplace cmd-alt-shift-8; sleep 1
  CHAT=$(open_chat keymap-3)
  ready
  type_text "after a write with no chat open"
  enter_sends "after a write with no chat open" "Enter sends in it"
  shot keymap-2-reopened 0.3
fi
