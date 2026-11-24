#!/usr/bin/env bash
# One run in the box, from a fresh snapshot: `runbox.sh <rev> <out> <script> [args...]`.
# stdin: the worktree's files, NUL-separated (sync.sh copies them from /work). Then
# <out> is emptied and the script runs from ~/src as `<script> <out> [args...]`
# (run.sh takes its artifacts dir first). The host pulls <out> when it ends.
# Runs under exclusive.sh, so this process holds the box until the script exits.
set -euo pipefail
rev=$1 out=$2 script=$3; shift 3
/opt/box/sync.sh "$rev" >&2
rm -rf "$out"; mkdir -p "$out"
cd "$HOME/src"
exec "$script" "$out" "$@" </dev/null
