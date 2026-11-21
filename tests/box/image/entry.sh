#!/usr/bin/env bash
# The box's first process: a virtual X display (:9), then wait. Everything
# else runs with `docker exec` (tests/box/box). The app and the core are
# started by the e2e scripts themselves, each run on its own home and session.
set -euo pipefail
mkdir -p /tmp/xdg && chmod 700 /tmp/xdg
Xvfb :9 -screen 0 1600x1000x24 -nolisten tcp -ac >/tmp/xvfb.log 2>&1 &
for _ in $(seq 100); do DISPLAY=:9 xdpyinfo >/dev/null 2>&1 && break; sleep 0.1; done
DISPLAY=:9 xdpyinfo >/dev/null 2>&1 || { echo "Xvfb did not start" >&2; cat /tmp/xvfb.log >&2; exit 1; }
echo ready
exec sleep infinity
