#!/usr/bin/env bash
# The box's first process: a private X display (Xvfb :9), then wait. Everything
# else runs with `docker exec` (tests/box/box), which sources /tmp/display.env.
set -euo pipefail
mkdir -p /tmp/xdg && chmod 700 /tmp/xdg
Xvfb :9 -screen 0 1600x1000x24 -nolisten tcp -ac >/tmp/display.log 2>&1 &
for _ in $(seq 100); do DISPLAY=:9 xdpyinfo >/dev/null 2>&1 && break; sleep 0.1; done
DISPLAY=:9 xdpyinfo >/dev/null 2>&1 || { echo "Xvfb did not start" >&2; cat /tmp/display.log >&2; exit 1; }
printf 'export DISPLAY=:9 XDG_RUNTIME_DIR=/tmp/xdg\nunset WAYLAND_DISPLAY\n' >/tmp/display.env
echo ready
exec sleep infinity
