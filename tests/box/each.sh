#!/usr/bin/env bash
# Run every e2e flow on its own in box <item> (run.sh stops at a flow's first
# FAIL, so one run of all of them shows only the first). Prints one line a flow
# and writes <proof>/<item>/each/summary.tsv. Usage: tests/box/each.sh <item> [flows...]
set -uo pipefail
BOX="$(cd "$(dirname "$0")" && pwd)/box"
item=${1:?item}; shift
flows=("$@")
if [ ${#flows[@]} = 0 ]; then
  # Every flow an `if want <flow> [|| want <flow>…]` line names, but the live ones (real logins, network).
  read -ra flows <<<"$(grep -hE '^\s*if want [a-z0-9-]+' "$(dirname "$0")/../e2e/"*.sh | grep -oE 'want [a-z0-9-]+' | awk '{print $2}' | sort -u | grep -v '^live' | tr '\n' ' ')"
fi
root=${BOX_PROOF_DIR:-$HOME/.cache/herdr-chat-box}/$item/each
mkdir -p "$root"
summary=$(mktemp)
for f in "${flows[@]}"; do
  s=$SECONDS
  out=$("$BOX" run "$item" --run "each/$f" "$f" 2>&1); rc=$?
  printf '%s\n' "$out" >"$root/$f/box.out" 2>/dev/null || true
  log="$root/$f/box/run.log"
  pass=$(grep -c '^PASS' "$log" 2>/dev/null); skip=$(grep -c '^SKIP' "$log" 2>/dev/null); fail=$(grep -m1 '^FAIL' "$log" 2>/dev/null | cut -c1-140)
  printf '%s\t%s\t%s\t%s\t%ss\t%s\n' "$f" "$([ $rc = 0 ] && echo ok || echo FAIL)" "${pass:-0}" "${skip:-0}" "$((SECONDS - s))" "$fail" | tee -a "$summary"
done
mv "$summary" "$root/summary.tsv"
