"""A real scroll-wheel event over the private app: `wheel.py PID X0:X1 Y DY`.

One wheel event of DY pt (kCGScrollEventUnitPixel; positive = up, toward
history) at the first point X0, X0 + 10, … X1 on row Y of PID's window that no
other window covers (window pt, as in `herdr-app shot`). Prints the X used.
GPUI takes no scroll event posted to its pid (CGEventPostToPid, click.py), and
one posted at the session's event tap reaches the window under the pointer
only, so the pointer is moved there for the event and put back right after
(about 0.1 s). That is the one thing here that touches the person's pointer:
the flow runs it only with E2E_WHEEL=1. It refuses (exit 2, nothing posted)
when another window covers every point, so it can never scroll one of your
windows.
Needs pyobjc (Quartz)."""
import sys
import time

import Quartz

pid, (x0, x1), y, dy = int(sys.argv[1]), map(float, sys.argv[2].split(":")), float(sys.argv[3]), int(sys.argv[4])
wins = Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionOnScreenOnly, Quartz.kCGNullWindowID)


def contains(w, px, py):
    b = w["kCGWindowBounds"]
    return b["X"] <= px < b["X"] + b["Width"] and b["Y"] <= py < b["Y"] + b["Height"]


ours = next((w for w in wins if w.get("kCGWindowOwnerPID") == pid and w.get("kCGWindowLayer") == 0 and w["kCGWindowBounds"]["Width"] > 200), None)
if ours is None:
    sys.exit("refused: the private window isn't on screen")
bx, by = ours["kCGWindowBounds"]["X"], ours["kCGWindowBounds"]["Y"]
x = x0
while x <= x1:
    top = next(w for w in wins if w.get("kCGWindowLayer") == 0 and contains(w, bx + x, by + y))  # front to back
    if top.get("kCGWindowOwnerPID") == pid:
        break
    x += 10
else:
    print(f"refused: other windows cover row {y:g} from x {x0:g} to {x1:g}", file=sys.stderr)
    sys.exit(2)
pt = Quartz.CGPointMake(bx + x, by + y)
was = Quartz.CGEventGetLocation(Quartz.CGEventCreate(None))
Quartz.CGWarpMouseCursorPosition(pt)
time.sleep(0.05)
ev = Quartz.CGEventCreateScrollWheelEvent(None, Quartz.kCGScrollEventUnitPixel, 1, dy)
Quartz.CGEventSetLocation(ev, pt)
Quartz.CGEventPost(Quartz.kCGSessionEventTap, ev)
time.sleep(0.05)
Quartz.CGWarpMouseCursorPosition(was)
print(f"{x:g}")
