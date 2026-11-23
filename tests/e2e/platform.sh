# The platform's input, in one place: macOS (the host) or Linux (the test box,
# tests/box). Sourced by lib.sh and dev-ctl.sh; needs E2E (this folder), PY (a
# python3, with pyobjc's Quartz on macOS) and APP_PID (when a function runs).
#
#   keys SPEC...       keys.py's specs: macOS posts them to the app's process (keys.py),
#                      Linux types them on the box's display (x11input.py spec, XTest)
#   click X Y          a left click at window pt X, Y (macOS: posted to the app's process)
#   wheel X0:X1 Y DY   one real wheel step up at row Y. macOS: DY pt at the first point of
#                      X0..X1 no other window covers (it moves your pointer for a moment,
#                      so flows run it only with E2E_WHEEL=1). Linux: one notch at X0 on the
#                      box's own pointer (DY is ignored: X11 wheels have notches, not pixels)
#   PK                 the modifier the app's own keys use here, as a keys.py modifier:
#                      macOS's ⌘ (cmd), Ctrl elsewhere (ctrl)
OS=$(uname -s)
if [ "$OS" = Darwin ]; then
  PK=cmd
  keys() { "$PY" "$E2E/keys.py" "$APP_PID" "$@"; }
  click() { "$PY" "$E2E/click.py" "$APP_PID" "$1" "$2"; }
  wheel() { "$PY" "$E2E/wheel.py" "$APP_PID" "$@"; }
else
  PK=ctrl
  keys() { python3 "$E2E/x11input.py" spec "$@"; }
  click() { python3 "$E2E/x11input.py" click "$1" "$2"; }
  wheel() { python3 "$E2E/x11input.py" scroll "${1%%:*}" "$2" 1; }
fi
