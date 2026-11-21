"""wheel.py's twin for Linux (X11, the test box): `wheel_x11.py X0:X1 Y DY`, real
scroll-wheel events at window point (X0, Y) of the private app's window ("Herdr"),
through X's own pointer (xdotool: move, then buttons 4 up / 5 down). The box's
display is its own, so this moves nobody's pointer. X11 has no pixel deltas: one
click is one wheel notch, which GPUI turns into a line's worth of scroll; DY is
how many notches (positive = up, toward history). X1 is unused (macOS needs it to
find an uncovered point; nothing covers the box's window). Prints X0."""
import subprocess
import sys

(x0, _), y, dy = sys.argv[1].split(":"), float(sys.argv[2]), int(sys.argv[3])
wid = subprocess.run(["xdotool", "search", "--name", "^Herdr$"], capture_output=True, text=True).stdout.split()
if not wid:
    sys.exit("refused: no Herdr window on this display")
geo = dict(l.split("=") for l in subprocess.run(["xdotool", "getwindowgeometry", "--shell", wid[0]], capture_output=True, text=True).stdout.split())
subprocess.run(["xdotool", "mousemove", str(int(geo["X"]) + int(float(x0))), str(int(geo["Y"]) + int(y))], check=True)
subprocess.run(["xdotool", "click", "--repeat", str(abs(dy)), "--delay", "20", "4" if dy > 0 else "5"], check=True)
print(x0)
