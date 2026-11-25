// The `pi --version` cache: keyed by the binary's real path and mtime, shared across chats.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, utimesSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piVersionCache } from "../../host/providers/pi/adapter.ts";

test("pi version cache: a miss, a hit, and a new binary (mtime) forgets it", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-ver-"));
  const bin = join(dir, "pi");
  writeFileSync(bin, "#!/bin/sh\n");
  chmodSync(bin, 0o755);
  try {
    const c = piVersionCache(bin)!;
    c.write("9.9.9"); // (the shared file may hold another binary's entry: this one replaces it)
    assert.equal(piVersionCache(bin)!.read(), "9.9.9");
    const later = new Date(Date.now() + 5000);
    utimesSync(bin, later, later);
    assert.equal(piVersionCache(bin)!.read(), null, "an updated binary is probed again");
    assert.equal(piVersionCache(join(dir, "missing")), null, "an unresolvable command isn't cached");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
