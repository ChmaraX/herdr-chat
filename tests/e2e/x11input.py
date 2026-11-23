"""Real keyboard and mouse input on a private X display (XTest), in the Herdr
window's pixels: the test box's one input path. The e2e flows use it through
lib.sh's keys/wheel, and the box's live-app verbs (tests/box/box click…) call it
directly. Run it on a private display only: X input goes to whatever window has
the focus there.

Adapted from herdr-app's scripts/sandbox-input.py (Apache-2.0,
https://github.com/herdrdev/herdr-app): the same verbs, coordinates and
`sequence` JSON, so a scene written for Herdr's sandbox plays here too.
Changes: Xvfb's display (`sequence` still keeps one connection), a scroll verb
(buttons 4/5), `press`/`lift` take a button, the pointer file is written by
every verb, the window is found by WM_NAME or _NET_WM_NAME, and `spec` takes
keys.py's specs so a flow presses the same keys on macOS and Linux.

  move x0 y0 x1 y1 [steps]   glide the pointer, no buttons
  click x y [button]         button: 1 left (default), 2 middle, 3 right
  drag x0 y0 x1 y1 [steps]   press, glide, release
  scroll x y dy              dy notches: positive up (toward history), negative down
  hold|release <keysym>...   keep keys down across commands, e.g. `hold Control_L`
  type <text>                type it (keys of the X keymap; shift as needed)
  key <keysym> [mods...]     one key, e.g. `key Return`, `key l Control_L`
  spec <SPEC>...             keys.py's specs: a macOS keycode with `:cmd,shift,ctrl,alt`,
                             a name (`enter`, `esc`…), or `text:<letters>`; `cmd` is Super
                             (GPUI reads a binding's `cmd-` as Super on Linux)
  sequence '<json>'          a scene over one connection: [["move",x0,y0,x1,y1,steps],
                             ["click",x,y],["hold","Control_L"],["release","Control_L"],
                             ["press"],["lift"],["key","Return"],["type","hi"],
                             ["scroll",x,y,dy],["sleep",s]]

BOX_POINTER_FILE: where the pointer (window px) and cursor shape (arrow,
pointer, grab) are written after each move, for `box record` to draw the
cursor on its frames."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

from Xlib import X, XK, display
from Xlib.ext import xtest

d = display.Display()
root = d.screen().root
NET_WM_NAME = d.intern_atom("_NET_WM_NAME")


def title(w):
    try:
        n = w.get_full_property(NET_WM_NAME, 0)
        if n and n.value:
            return n.value.decode() if isinstance(n.value, bytes) else str(n.value)
        return w.get_wm_name()
    except Exception:
        return None


def find(w):
    if title(w) == "Herdr":
        return w
    for c in w.query_tree().children:
        r = find(c)
        if r:
            return r
    return None


win = find(root)
if win is None:
    sys.exit("no Herdr window on this display")
pos = win.translate_coords(root, 0, 0)
ox, oy = -pos.x, -pos.y

pointer_file = os.environ.get("BOX_POINTER_FILE")
state = {"x": 0, "y": 0, "cursor": "arrow"}
if pointer_file and Path(pointer_file).exists():
    try:
        state.update(json.loads(Path(pointer_file).read_text()))
    except ValueError:
        pass


def publish():
    if pointer_file:
        f = Path(pointer_file)
        tmp = f.with_suffix(".new")
        tmp.write_text(json.dumps(state))
        tmp.replace(f)


def to(x, y):
    xtest.fake_input(d, X.MotionNotify, x=int(ox + x), y=int(oy + y))
    d.sync()
    state["x"], state["y"] = int(x), int(y)
    publish()


def glide(x0, y0, x1, y1, steps=24):
    steps = max(1, int(steps))
    for i in range(steps + 1):
        to(x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps)
        time.sleep(0.016)


def button(n, down):
    xtest.fake_input(d, X.ButtonPress if down else X.ButtonRelease, n)
    d.sync()


def click(x, y, b=1):
    to(x, y)
    time.sleep(0.2)
    button(b, True)
    time.sleep(0.05)
    button(b, False)


def scroll(x, y, dy):
    to(x, y)
    time.sleep(0.05)
    b = 4 if dy > 0 else 5
    for _ in range(abs(int(dy))):
        button(b, True)
        button(b, False)
        time.sleep(0.02)


def placed(sym):
    """The keycode for a keysym, and whether Shift reaches it there. The keymap
    can hold a keysym twice: Xvfb's has `less` unshifted on the ISO key and
    shifted on comma. Unshifted wins, and Shift goes with the keycode it belongs
    to (pressing Shift with the other keycode types `greater`)."""
    places = d.keysym_to_keycodes(XK.string_to_keysym(sym))
    if not places:
        sys.exit(f"no key for keysym {sym!r} (X keysym names: Return, Escape, Control_L, a, V…)")
    keycode, index = min(places, key=lambda p: (p[1] % 2, p[1], p[0]))
    return keycode, index % 2 == 1


def key(sym, mods=()):
    k, shifted = placed(sym)
    held = [placed(m)[0] for m in mods]
    if shifted and "Shift_L" not in mods and "Shift_R" not in mods:
        held.append(placed("Shift_L")[0])
    for m in held:
        xtest.fake_input(d, X.KeyPress, m)
    xtest.fake_input(d, X.KeyPress, k)
    xtest.fake_input(d, X.KeyRelease, k)
    for m in reversed(held):
        xtest.fake_input(d, X.KeyRelease, m)
    d.sync()
    time.sleep(0.03)


# Every printable ASCII character's X keysym name (XK's latin1 names).
NAMES = {" ": "space", "\n": "Return", "\t": "Tab"}
for _name in dir(XK):
    if _name.startswith("XK_"):
        _v = getattr(XK, _name)
        if 0x21 <= _v <= 0x7e and chr(_v) not in NAMES:
            NAMES[chr(_v)] = _name[3:]


def type_text(text):
    i = 0
    while i < len(text):
        name = NAMES.get(text[i])
        if name is None:
            # A run of characters beyond ASCII (é→, emoji): one xdotool call, which maps each
            # one's keysym in for the moment (one call a character dropped the second of two).
            j = i
            while j < len(text) and text[j] not in NAMES:
                j += 1
            subprocess.run(["xdotool", "type", "--delay", "60", text[i:j]], check=True)
            time.sleep(0.1)
            i = j
            continue
        key(name)  # Shift comes with the keycode where the keysym is shifted
        i += 1


def hold(syms, down):
    for sym in syms:
        xtest.fake_input(d, X.KeyPress if down else X.KeyRelease, placed(sym)[0])
    d.sync()
    if "Control_L" in syms or "Control_R" in syms:
        state["cursor"] = "pointer" if down else "arrow"
        publish()


# keys.py's specs: macOS virtual keycodes (its LETTERS and NAMES) -> X keysyms.
MAC = dict(zip("asdfhgzxcv bqweryt123465=97-80]ou[ip lj'k;\\,/nm.", range(51)))
MAC[" "] = 49
MAC["`"] = 50
MAC_CODE = {v: k for k, v in MAC.items()}
MAC_EXTRA = {36: "Return", 53: "Escape", 48: "Tab", 51: "BackSpace", 126: "Up", 125: "Down", 123: "Left",
             124: "Right", 56: "Shift_L", 115: "Home", 119: "End", 116: "Prior", 121: "Next", 117: "Delete"}
SPEC_NAMES = {"enter": "Return", "esc": "Escape", "backslash": "backslash", "tab": "Tab", "backspace": "BackSpace",
              "up": "Up", "down": "Down", "left": "Left", "right": "Right", "slash": "slash", "space": "space"}
SPEC_MODS = {"cmd": "Super_L", "ctrl": "Control_L", "shift": "Shift_L", "alt": "Alt_L"}


def spec(s):
    if s.startswith("text:"):
        type_text(s[5:])
    else:
        k, _, mods = s.partition(":")
        if k in SPEC_NAMES:
            sym = SPEC_NAMES[k]
        else:
            c = int(k)
            sym = MAC_EXTRA.get(c) or NAMES.get(MAC_CODE[c], MAC_CODE[c])
        held = [SPEC_MODS[m] for m in filter(None, mods.split(","))]
        if sym == "Shift_L":
            # A lone Shift (`56` or `56:shift`, as the flows prime key bindings with it).
            held = [m for m in held if m != "Shift_L"]
        key(sym, held)
    time.sleep(0.12)


cmd = sys.argv[1] if len(sys.argv) > 1 else ""
if cmd == "sequence":
    for action in json.loads(sys.argv[2]):
        c, *a = action
        if c == "sleep":
            time.sleep(a[0])
        elif c == "move":
            glide(*a)
        elif c == "click":
            click(*a)
        elif c in ("hold", "release"):
            hold(a, c == "hold")
        elif c in ("press", "lift"):
            state["cursor"] = "grab" if c == "press" else "arrow"
            publish()
            button(int(a[0]) if a else 1, c == "press")
        elif c == "key":
            key(a[0], a[1:])
        elif c == "type":
            type_text(a[0])
        elif c == "scroll":
            scroll(*a)
        else:
            sys.exit(f"unknown sequence command {c}")
elif cmd == "type":
    type_text(" ".join(sys.argv[2:]))
elif cmd == "key":
    key(sys.argv[2], sys.argv[3:])
elif cmd in ("hold", "release"):
    hold(sys.argv[2:], cmd == "hold")
elif cmd == "spec":
    for s in sys.argv[2:]:
        spec(s)
else:
    args = [float(x) for x in sys.argv[2:]]
    if cmd == "move":
        glide(*args[:5])
    elif cmd == "click":
        click(args[0], args[1], int(args[2]) if len(args) > 2 else 1)
    elif cmd == "drag":
        to(args[0], args[1])
        time.sleep(0.2)
        state["cursor"] = "grab"
        button(1, True)
        time.sleep(0.2)
        glide(*args[:5])
        time.sleep(0.1)
        button(1, False)
        state["cursor"] = "arrow"
        publish()
    elif cmd == "scroll":
        scroll(*args[:3])
    else:
        sys.exit(f"unknown input command {cmd!r}")
time.sleep(0.1)
