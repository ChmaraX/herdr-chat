#!/usr/bin/env bash
# Run every e2e flow on its own in box <item> (run.sh stops at a flow's first
# FAIL, so one run of all of them shows only the first). Prints one line a flow
# and writes <proof>/<item>/each/summary.tsv. Usage: tests/box/each.sh <item> [flows...]
set -uo pipefail
BOX="$(cd "$(dirname "$0")" && pwd)/box"
item=${1:?item}; shift
flows=("$@")
if [ ${#flows[@]} = 0 ]; then
  # Every flow but the live ones (they need the person's real logins and network).
  read -ra flows <<<"$(grep -ho 'want [a-z0-9-]*' "$(dirname "$0")/../e2e/"*.sh | awk '{print $2}' | sort -u | grep -v '^live' | tr '\n' ' ')"
fi
root=${BOX_PROOF_DIR:-$HOME/.cache/herdr-chat-box}/$item/each
mkdir -p "$root"; : >"$root/summary.tsv"
for f in "${flows[@]}"; do
  s=$SECONDS
  "$BOX" run "$item" --run "each/$f" "$f" >"$root/$f.out" 2>&1; rc=$?
  log="$root/$f/run.log"
  pass=$(grep -c '^PASS' "$log" 2>/dev/null); skip=$(grep -c '^SKIP' "$log" 2>/dev/null); fail=$(grep -m1 '^FAIL' "$log" 2>/dev/null | cut -c1-140)
  printf '%s\t%s\t%s\t%s\t%ss\t%s\n' "$f" "$([ $rc = 0 ] && echo ok || echo FAIL)" "$pass" "$skip" "$((SECONDS - s))" "$fail" | tee -a "$root/summary.tsv"
done
