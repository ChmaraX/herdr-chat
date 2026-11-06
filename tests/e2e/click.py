"""Click in one process's window only: `click.py PID X Y [move | wheel DY]`. X, Y are
points inside the window (as in `herdr-app shot` at scale 1). The events go
to that process (CGEventPostToPid); the real pointer doesn't move. Whether
the app accepts them is what the spike checks. Needs pyobjc (Quartz)."""
import sys
import time

import Quartz

pid, x, y = int(sys.argv[1]), float(sys.argv[2]), float(sys.argv[3])
wins = Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionOnScreenOnly, Quartz.kCGNullWindowID)
win = next(w for w in wins if w.get("kCGWindowOwnerPID") == pid and w.get("kCGWindowLayer") == 0 and w["kCGWindowBounds"]["Width"] > 200)
b = win["kCGWindowBounds"]
pt = Quartz.CGPointMake(b["X"] + x, b["Y"] + y)
if len(sys.argv) > 4 and sys.argv[4] == "move":
    ev = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventMouseMoved, pt, Quartz.kCGMouseButtonLeft)
    Quartz.CGEventPostToPid(pid, ev)
    sys.exit(0)
if len(sys.argv) > 5 and sys.argv[4] == "wheel":
    ev = Quartz.CGEventCreateScrollWheelEvent(None, Quartz.kCGScrollEventUnitPixel, 1, int(sys.argv[5]))
    Quartz.CGEventSetLocation(ev, pt)
    Quartz.CGEventPostToPid(pid, ev)
    sys.exit(0)
for kind in (Quartz.kCGEventMouseMoved, Quartz.kCGEventLeftMouseDown, Quartz.kCGEventLeftMouseUp):
    ev = Quartz.CGEventCreateMouseEvent(None, kind, pt, Quartz.kCGMouseButtonLeft)
    if kind != Quartz.kCGEventMouseMoved:
        Quartz.CGEventSetIntegerValueField(ev, Quartz.kCGMouseEventClickState, 1)
    Quartz.CGEventPostToPid(pid, ev)
    time.sleep(0.05)
