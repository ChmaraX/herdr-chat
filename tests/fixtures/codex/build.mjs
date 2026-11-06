// Builds replay fixtures from the research samples (docs/dev/research/samples/codex/*.jsonl).
//   node tests/fixtures/codex/build.mjs
// The samples are segments of longer probe runs: each opens with the previous
// segment's turn/completed and some end before their own. This keeps one
// segment per fixture, drops the borrowed head, closes an unfinished last
// turn the way Codex would, and thins the MCP-startup noise. Samples are
// already scrubbed (home → ~, account ids, email).
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLES = join(HERE, "..", "..", "..", "docs", "dev", "research", "samples", "codex");

const FIXTURES = {
  "text.jsonl": "01-init-thread-start-text.jsonl",
  "shell-approval.jsonl": "03-shell-with-approval.jsonl",
  "file-edit.jsonl": "04-file-edit.jsonl",
  "resume-approvals.jsonl": "06-resume-and-approvals.jsonl",
  "interrupt.jsonl": "07-interrupt-mid-tool.jsonl",
  "steer.jsonl": "08-steer.jsonl",
  "reasoning-websearch.jsonl": "11-reasoning-websearch-subagent.jsonl",
};

for (const [out, src] of Object.entries(FIXTURES)) {
  const lines = readFileSync(join(SAMPLES, src), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const note = lines.find((l) => l.dir === "note");
  let body = lines.filter((l) => l.dir !== "note");
  // The previous segment's tail, before this segment's first request.
  const first = body.findIndex((l) => l.dir === "out" && l.msg?.method && l.msg.id !== undefined);
  if (first > 0 && body[first].msg.method !== "initialize") body = body.slice(first);
  let mcp = 0;
  body = body.filter((l) => !(l.msg?.method === "mcpServer/startupStatus/updated" && ++mcp > 3));
  // Close a last turn the recording cut off.
  const started = body.filter((l) => l.msg?.method === "turn/started").map((l) => l.msg.params);
  const completed = new Set(body.filter((l) => l.msg?.method === "turn/completed").map((l) => l.msg.params.turn.id));
  const open = started.filter((p) => !completed.has(p.turn.id));
  let t = body.at(-1)?.t ?? 0;
  for (const p of open) {
    t += 5;
    body.push({ t, dir: "in", msg: { method: "thread/status/changed", params: { threadId: p.threadId, status: { type: "idle" } } } });
    body.push({ t, dir: "in", msg: { method: "turn/completed", params: { threadId: p.threadId, turn: { ...p.turn, status: "completed", completedAt: p.turn.startedAt, durationMs: 1 } } } });
  }
  const head = { dir: "note", msg: `Built by build.mjs from docs/dev/research/samples/codex/${src}${open.length ? " (closed the last turn the sample cut off)" : ""}. ${note?.msg ?? ""}` };
  writeFileSync(join(HERE, out), [head, ...body].map((l) => JSON.stringify(l)).join("\n") + "\n");
  console.log(`${out}: ${body.length} records`);
}
