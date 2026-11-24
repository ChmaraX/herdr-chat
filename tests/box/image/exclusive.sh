#!/usr/bin/env bash
# Locks in the box, so the things that share it don't overlap:
#   display  the private X display: a run's app and the live app would both take its keys
#   src      the snapshot (~/src): a sync replaces it under whatever runs from it
# A run takes both, `box test` and a sync take src, the live app takes display (it runs
# from its own copy, ~/live).
#
#   exclusive.sh <lock> <what> <command...>  take the lock, then become the command (exec):
#                                            /tmp/box.lock.<lock> holds "<what> <pid>", the
#                                            command's pid (the host stops an interrupted
#                                            run by it, tests/box/box). Nest it for two locks.
#   exclusive.sh --free <lock>               exit 0 when nothing holds the lock
#   exclusive.sh --pid <lock>                the holder's pid, when there is one
# A holder whose pid is gone frees the lock. Busy: exit 75, and say who holds it.
set -euo pipefail
holder() { # prints "<what> <pid>" of a live holder
  local w p
  [ -f /tmp/box.lock."$1"/who ] && read -r w p </tmp/box.lock."$1"/who || return 1
  [ -n "${p:-}" ] && kill -0 "$p" 2>/dev/null || return 1
  echo "$w $p"
}
busy() { echo "box: busy: $1 (pid $2) is using the box's $3: wait for it, or box app down" >&2; exit 75; }
case ${1:-} in
  --free) h=$(holder "$2") && busy $h "$2"; exit 0 ;;
  --pid) h=$(holder "$2") && echo "${h##* }"; exit 0 ;;
esac
lock=$1 what=$2; shift 2
dir=/tmp/box.lock.$lock
if ! mkdir "$dir" 2>/dev/null; then
  h=$(holder "$lock") && busy $h "$lock"
  rm -rf "$dir"
  mkdir "$dir" 2>/dev/null || { echo "box: busy: $lock" >&2; exit 75; }
fi
echo "${what// /_} $$" >"$dir/who"
exec "$@"
