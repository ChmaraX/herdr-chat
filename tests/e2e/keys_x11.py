"""keys.py's twin for Linux (X11): `keys_x11.py SPEC...`, the same SPECs
(a macOS virtual keycode, optionally `:cmd,shift,ctrl,alt`; a key name;
`text:<letters>`), pressed with xdotool on $DISPLAY: real X input (XTest),
through the app's keymap, focus and IME like a person's keys. `cmd` presses
Super: in a binding, GPUI reads `cmd-` as the platform key, which is Super on
Linux (gpui keystroke.rs: cmd|super|win), so a flow's `cmd-alt-p` binding and
its `35:cmd,alt` press meet on both platforms. Chords that should be Ctrl on
Linux say `ctrl`. Run it on a private display only (the test box): X input
goes to whatever window has the focus there."""
import subprocess
import sys
import time

# macOS virtual keycodes (keys.py's LETTERS and NAMES) -> X keysyms.
MAC = dict(zip("asdfhgzxcv bqweryt123465=97-80]ou[ip lj'k;\\,/nm.", range(51)))
MAC[" "] = 49
MAC["`"] = 50
CODE = {v: k for k, v in MAC.items()}
SYM = {"=": "equal", "-": "minus", "]": "bracketright", "[": "bracketleft", "'": "apostrophe", ";": "semicolon",
       "\\": "backslash", ",": "comma", "/": "slash", ".": "period", " ": "space", "`": "grave"}
NAMES = {"enter": "Return", "esc": "Escape", "backslash": "backslash", "tab": "Tab", "backspace": "BackSpace",
         "up": "Up", "down": "Down", "left": "Left", "right": "Right", "slash": "slash", "space": "space"}
EXTRA = {36: "Return", 53: "Escape", 48: "Tab", 51: "BackSpace", 126: "Up", 125: "Down", 123: "Left", 124: "Right",
         56: "Shift_L", 115: "Home", 119: "End", 116: "Prior", 121: "Next", 117: "Delete"}
MODS = {"cmd": "super", "ctrl": "ctrl", "shift": "shift", "alt": "alt"}


def keysym(code):
    if code in EXTRA:
        return EXTRA[code]
    ch = CODE[code]
    return SYM.get(ch, ch)


def xdo(*args):
    subprocess.run(["xdotool", *args], check=True)


for spec in sys.argv[1:]:
    if spec.startswith("text:"):
        # xdotool types each character with the right keysym (Shift included).
        xdo("type", "--delay", "30", spec[5:])
    else:
        key, _, mods = spec.partition(":")
        sym = NAMES[key] if key in NAMES else keysym(int(key))
        if sym == "Shift_L" and not mods:
            xdo("key", "shift")  # a lone Shift (the flows use it to prime key bindings)
        else:
            chord = "+".join([MODS[m] for m in filter(None, mods.split(","))] + [sym])
            xdo("key", chord)
    time.sleep(0.12)
