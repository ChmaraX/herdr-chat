#!/usr/bin/env bash
# Copy the read-only worktree (/work) to a writable snapshot (~/src), a git repo
# the e2e scripts and tests can write and run git in.
# node_modules comes along when the worktree has it (`npm ci --ignore-scripts`
# on the host, or `box deps`); nothing is installed here (no network).
# $1: the worktree's commit as the host saw it (written to ~/src/.box-rev).
set -euo pipefail
src=$HOME/src
rm -rf "$src"
mkdir -p "$src"
tar -C /work --exclude=./.git --exclude=./tests/artifacts --exclude=./tests/.venv -cf - . | tar -C "$src" -xf -
printf '%s\n' "${1:-unknown}" >"$src/.box-rev"
git -C "$src" init -q
# The worktree's history and release tags, when the host wrote them (box: /proof/.git.bundle): flows
# that run an old release's host (git archive v0.5.0) need them. The snapshot is a commit on top.
if [ -f /proof/.git.bundle ]; then
  git -C "$src" fetch -q /proof/.git.bundle 'refs/tags/*:refs/tags/*' 'HEAD:refs/heads/base' 2>/dev/null &&
    git -C "$src" symbolic-ref HEAD refs/heads/base && git -C "$src" read-tree base
fi
git -C "$src" add -A >/dev/null 2>&1
git -C "$src" -c user.email=box@local -c user.name=box commit -qm "snapshot ${1:-}" >/dev/null 2>&1
[ -d "$src/node_modules" ] || echo "note: no node_modules in the worktree; run \`box deps\` (or npm ci --ignore-scripts) first" >&2
echo "synced $(cat "$src/.box-rev")"
