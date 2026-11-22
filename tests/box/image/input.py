# Fake pointer and key input for the box's private X display (XTest), in the
# Herdr window's pixels. Run through `tests/box/box`, not directly.
#
# Adapted from herdr-app's scripts/sandbox-input.py (Apache-2.0,
# https://github.com/herdrdev/herdr-app): the same verbs, coordinates and
# `sequence` JSON, so a scene written for Herdr's sandbox plays here too.
# Changes: Xvfb's display (no Xwayland device reset, though `sequence` still
# keeps one connection), a scroll verb (buttons 4/5), `press`/`lift` take a
# button, the pointer file is written by every verb (not only for clips), and
# the window is found by WM_NAME or _NET_WM_NAME.
#
#   move x0 y0 x1 y1 [steps]   glide the pointer, no buttons
#   click x y [button]         button: 1 left (default), 2 middle, 3 right
#   drag x0 y0 x1 y1 [steps]   press, glide, release
#   scroll x y dy              dy notches: positive up (toward history), negative down
#   hold|release <keysym>...   keep keys down across commands, e.g. `hold Control_L`
#   type <text>                type it (keys of the X keymap; shift as needed)
#   key <keysym> [mods...]     one key, e.g. `key Return`, `key l Control_L`
#   sequence '<json>'          a scene over one connection: [["move",x0,y0,x1,y1,steps],
#                              ["click",x,y],["hold","Control_L"],["release","Control_L"],
#                              ["press"],["lift"],["key","Return"],["type","hi"],
#                              ["scroll",x,y,dy],["sleep",s]]
#
# BOX_POINTER_FILE: where the pointer (window px) and cursor shape (arrow,
# pointer, grab) are written after each move, for `box record` to draw the
# cursor on its frames.
import json
import os
from pathlib import Path
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


def code(sym):
    c = d.keysym_to_keycode(XK.string_to_keysym(sym))
    if not c:
        sys.exit(f"no key for keysym {sym!r} (X keysym names: Return, Escape, Control_L, a, V…)")
    return c


def key(sym, mods=()):
    held = [code(m) for m in mods]
    for m in held:
        xtest.fake_input(d, X.KeyPress, m)
    k = code(sym)
    xtest.fake_input(d, X.KeyPress, k)
    xtest.fake_input(d, X.KeyRelease, k)
    for m in reversed(held):
        xtest.fake_input(d, X.KeyRelease, m)
    d.sync()
    time.sleep(0.03)


# Every printable ASCII character's X keysym name (XK.load_keysym_group's latin1 names).
NAMES = {" ": "space", "\n": "Return", "\t": "Tab"}
for _name in dir(XK):
    if _name.startswith("XK_"):
        _v = getattr(XK, _name)
        if 0x21 <= _v <= 0x7e and chr(_v) not in NAMES:
            NAMES[chr(_v)] = _name[3:]


def type_text(text):
    i = 0
    while i < len(text):
        ch = text[i]
        name = NAMES.get(ch)
        if name is None:
            # A run of characters beyond ASCII (é→, emoji): one xdotool call, which maps each
            # one's keysym in for the moment (one call a character dropped the second of two).
            j = i
            while j < len(text) and text[j] not in NAMES:
                j += 1
            import subprocess
            subprocess.run(["xdotool", "type", "--delay", "60", text[i:j]], check=True)
            time.sleep(0.1)
            i = j
            continue
        keysym = XK.string_to_keysym(name)
        codes = d.keysym_to_keycodes(keysym)
        shifted = codes and any(index % 2 for _, index in codes)
        key(name, ["Shift_L"] if shifted or ch.isupper() else [])
        i += 1


def hold(syms, down):
    for sym in syms:
        xtest.fake_input(d, X.KeyPress if down else X.KeyRelease, code(sym))
    d.sync()
    if "Control_L" in syms or "Control_R" in syms:
        state["cursor"] = "pointer" if down else "arrow"
        publish()


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
