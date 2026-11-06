"""`front.py get` prints the frontmost app's pid; `front.py PID` brings that
app to the front (NSRunningApplication.activate). Used only around the
visual passes (lib.sh `visible` / `hidden`): the private app forward, then
the person's app back. Never sends input anywhere. Needs pyobjc (AppKit)."""
import sys
import time

import AppKit

ws = AppKit.NSWorkspace.sharedWorkspace()
if sys.argv[1] == "get":
    app = ws.frontmostApplication()
    print(app.processIdentifier() if app else "")
    sys.exit(0)
pid = int(sys.argv[1])
app = AppKit.NSRunningApplication.runningApplicationWithProcessIdentifier_(pid)
if app is None:
    sys.exit(1)
opts = AppKit.NSApplicationActivateAllWindows | getattr(AppKit, "NSApplicationActivateIgnoringOtherApps", 2)
for _ in range(10):
    app.activateWithOptions_(opts)
    time.sleep(0.15)
    front = ws.frontmostApplication()
    if front and front.processIdentifier() == pid:
        sys.exit(0)
sys.exit(1)
