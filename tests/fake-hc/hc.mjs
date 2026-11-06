#!/usr/bin/env node
// fake-hc: the `hc get <terminal> --json` the host's hand-off watch calls, and `hc label` (logged).
// A terminal is $FAKE_HC_DIR/<address>.json (its `hc get` JSON, e.g.
// {"state":"live"}); a missing file is "no such terminal" (exit 3), as hc does.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.FAKE_HC_DIR;
const argv = process.argv.slice(2);
// `hc label <terminal> k=v…` (the sub-agent launcher labels itself): one JSON line in $FAKE_HC_DIR/label.log.
if (dir && argv[0] === "label" && argv[1]) {
  appendFileSync(join(dir, "label.log"), JSON.stringify({ terminal: argv[1], labels: argv.slice(2) }) + "\n");
  process.exit(process.env.FAKE_HC_LABEL_FAIL ? 1 : 0);
}
if (!dir || argv[0] !== "get" || !argv[1]) {
  process.stderr.write("fake-hc: only `get <terminal> --json`\n");
  process.exit(2);
}
let t;
try {
  t = JSON.parse(readFileSync(join(dir, `${argv[1]}.json`), "utf8"));
} catch {
  process.stdout.write(JSON.stringify({ error: { kind: "not_found", message: `no terminal "${argv[1]}"` } }) + "\n");
  process.exit(3);
}
process.stdout.write(JSON.stringify({ address: argv[1], ...t }) + "\n");
