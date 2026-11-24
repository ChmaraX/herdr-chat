#!/usr/bin/env bash
# Replace the snapshot (~/src) with the worktree (/work, mounted read-only): the
# files the host lists on stdin, NUL-separated (its tracked and untracked files
# that git doesn't ignore, plus node_modules), so the snapshot holds what the
# run's stamp says. The snapshot is a git repo the e2e scripts and tests can
# write and run git in; /tmp/worktree.bundle (the host sends it first) gives it
# the worktree's history and release tags (flows that run an old release's host
# use them, git archive v0.5.0).
# $1: the worktree's commit as the host saw it (written to ~/src/.box-rev).
set -euo pipefail
src=$HOME/src
rm -rf "$src"
mkdir -p "$src"
tar -C /work --null -T - -cf - | tar -C "$src" -xf -
printf '%s\n' "${1:-unknown}" >"$src/.box-rev"
git -C "$src" init -q
if [ -s /tmp/worktree.bundle ]; then
  git -C "$src" fetch -q /tmp/worktree.bundle 'refs/tags/*:refs/tags/*' 'HEAD:refs/heads/base' 2>/dev/null &&
    git -C "$src" symbolic-ref HEAD refs/heads/base && git -C "$src" read-tree base
fi
git -C "$src" add -A >/dev/null 2>&1
git -C "$src" -c user.email=box@local -c user.name=box commit -qm "snapshot ${1:-}" >/dev/null 2>&1
[ -d "$src/node_modules" ] || echo "note: no node_modules in the worktree; run npm ci --ignore-scripts there first (the box has no network)" >&2
echo "synced $(cat "$src/.box-rev")"
