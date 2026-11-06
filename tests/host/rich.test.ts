import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { startHost, idle, Host, ARTIFACTS } from "./harness.ts";

const text = (spans: any[]) => spans.map((s) => s.text).join("");
const done = (c: any) => idle(c) && c.items.some((i: any) => i.kind === "assistant" && i.text.startsWith("Done:") && !i.streaming);

/** A well-formed XML check: every tag closes in order. Enough to catch a broken SVG without a parser. */
function wellFormed(xml: string): boolean {
  const stack: string[] = [];
  for (const m of xml.replace(/<!--[\s\S]*?-->/g, "").replace(/<style>[\s\S]*?<\/style>/g, "<style/>").matchAll(/<(\/?)([A-Za-z][\w:-]*)\b[^>]*?(\/?)>/g)) {
    if (m[1]) {
      if (stack.pop() !== m[2]) return false;
    } else if (!m[3]) stack.push(m[2]!);
  }
  return stack.length === 0;
}

/** The rich fields of an item, as the mod renders them. */
function rich(items: any[]): any[] {
  return items
    .filter((i) => i.kind === "assistant" || i.kind === "tool")
    .map((i) =>
      i.kind === "assistant"
        ? { kind: i.kind, blocks: i.blocks, model: i.model, usage: i.usage, durationMs: i.durationMs }
        : { kind: i.kind, name: i.name, outputLines: i.outputLines, detail: i.detail },
    );
}

test("rich content: blocks mid-stream and done, highlighting, mermaid SVG, ANSI output, diff, metadata; the same from history", async () => {
  const h = await startHost({ name: "rich", scenario: "rich.json", speed: 2 });
  let live: any[];
  let svgPath: string;
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "Write the parser" });
    await c.waitFor(done, 20_000, "the run");

    // ---- mid-stream: what the patches showed while the first answer streamed
    const answerId = c.items.find((i) => i.kind === "assistant")!.id;
    const streamed = c.records
      .filter((r) => r.t === "patch")
      .flatMap((r) => r.upsert)
      .filter((i: any) => i.id === answerId && i.streaming)
      .map((i: any) => i.blocks.map((b: any) => `${b.type}${b.lang ? ":" + b.lang : ""}${b.open ? "(open)" : ""}`).join(" "));
    assert.ok(streamed.length >= 5, `streamed in several patches (${streamed.length})`);
    assert.ok(streamed.includes("markdown code:ts(open)"), `an open ts fence while streaming: ${JSON.stringify(streamed)}`);
    assert.ok(streamed.includes("markdown code:ts markdown mermaid(open)"), "the ts block closes, the mermaid fence is open");
    const openTs = c.records.flatMap((r) => (r.t === "patch" ? r.upsert : [])).find((i: any) => i.id === answerId && i.blocks?.[1]?.open);
    assert.ok(openTs.blocks[1].lines.length > 0, "an open block is highlighted too");
    assert.ok(!openTs.blocks.some((b: any) => b.type === "mermaid" && b.svg), "no SVG for an open mermaid fence");

    // ---- done
    const answer = c.items.find((i) => i.id === answerId)!;
    assert.deepEqual(
      answer.blocks.map((b: any) => [b.type, b.lang ?? null, b.open]),
      [["markdown", null, undefined], ["code", "ts", false], ["markdown", null, undefined], ["mermaid", null, false], ["markdown", null, undefined], ["code", "sh", false], ["markdown", null, undefined]],
    );
    const [, ts, , mermaid, steps, sh, after] = answer.blocks;
    assert.equal(ts.code, 'export function parse(input: string): number {\n  // trim first\n  return input.trim().length * 2;\n}');
    assert.deepEqual(ts.lines[0][0], { text: "export", fg: "syn:keyword" });
    assert.ok(ts.lines[0].some((s: any) => s.text === "parse" && s.fg === "syn:function"), "function name");
    assert.ok(ts.lines[0].some((s: any) => s.text === "number" && s.fg === "syn:built_in"), "built-in type");
    assert.deepEqual(ts.lines[1], [{ text: "  " }, { text: "// trim first", fg: "syn:comment" }]);
    assert.equal(ts.lines.map(text).join("\n"), ts.code, "spans spell the code");
    // The ~~~ fence inside the list item, dedented; the list around it stays prose.
    assert.equal(sh.code, "npm install parser");
    assert.match(steps.text, /^Steps:\n\n1\. Install it:$/);
    assert.equal(after.text, "2. Run the checks below.");

    // Mermaid: a themed SVG file a native renderer can draw.
    svgPath = mermaid.svg;
    assert.match(svgPath, new RegExp(`^${h.stateDir}/images/c-test/mermaid-[0-9a-f]{16}\\.svg$`));
    const svg = readFileSync(svgPath, "utf8");
    assert.ok(wellFormed(svg), "the SVG is well-formed");
    assert.match(svg, /^<svg [^>]*viewBox="[\d. ]+"/);
    for (const label of ["Read input", "Valid?", "Parse", "Error", "yes", "no"]) assert.ok(svg.includes(`>${label}</text>`), `label ${label} is real <text>`);
    assert.doesNotMatch(svg, /var\(|color-mix|foreignObject|@import/, "no CSS variables, web fonts or HTML");
    assert.ok(svg.includes('fill="#1e1f22"'), "dark default background before any set_theme");
    mkdirSync(ARTIFACTS, { recursive: true });
    copyFileSync(svgPath, join(ARTIFACTS, "rich-flowchart.svg"));

    // ---- bash: ANSI colors survive in outputLines; `output` stays plain
    const bash = c.items.find((i) => i.kind === "tool" && i.name === "bash")!;
    assert.equal(bash.detail.exitCode, 1);
    assert.doesNotMatch(bash.output, /\u001b/);
    const red = bash.outputLines.flat().find((s: any) => s.text.includes("rejects junk"));
    assert.deepEqual(red, { text: "✗ rejects junk", fg: "ansi1" });
    assert.ok(bash.outputLines.flat().some((s: any) => s.text === "✓" && s.fg === "ansi2"));
    assert.equal(bash.outputLines.map(text).join("\n"), bash.output, "outputLines spell output");

    // ---- read: highlighted by the file's extension
    const read = c.items.find((i) => i.kind === "tool" && i.name === "read")!;
    assert.deepEqual(read.outputLines[0][0], { text: "export", fg: "syn:keyword" });
    assert.equal(read.outputLines.map(text).join("\n"), read.output);

    // ---- edit: numbered, typed, highlighted diff lines and counts
    const edit = c.items.find((i) => i.kind === "tool" && i.name === "edit")!;
    assert.equal(edit.detail.added, 2);
    assert.equal(edit.detail.removed, 1);
    assert.deepEqual(
      edit.detail.diffLines.map((l: any) => [l.kind, l.old ?? null, l.new ?? null, text(l.spans)]),
      [
        ["meta", null, null, "--- src/parse.ts"],
        ["meta", null, null, "+++ src/parse.ts"],
        ["hunk", null, null, "@@ -1,4 +1,5 @@"],
        ["ctx", 1, 1, "export function parse(input: string): number {"],
        ["del", 2, null, "  return input.trim().length * 2;"],
        ["add", null, 2, "  const s = input.trim();"],
        ["add", null, 3, "  return s.length * 2;"],
        ["ctx", 3, 4, "}"],
      ],
    );
    assert.ok(edit.detail.diffLines[5].spans.some((s: any) => s.text === "const" && s.fg === "syn:keyword"));

    // ---- assistant metadata: model, time, usage; the tool-only message's usage carries to the next text
    const answers = c.items.filter((i) => i.kind === "assistant");
    assert.equal(answers.length, 2);
    for (const a of answers) {
      assert.match(a.model, /^[\w-]+\/[\w.-]+$/);
      assert.ok(a.durationMs > 0, "durationMs");
    }
    assert.equal(answers[0].usage.input, 1500);
    assert.equal(answers[1].usage.input, 2000 + 2400);
    assert.ok(answers[1].usage.cost > 0);
    assert.equal(answers[1].blocks.length, 1);
    live = structuredClone(c.items);

    // ---- set_theme: the closed mermaid block is re-rendered with the new colors and re-sent
    const before = c.records.length;
    await c.req("set_theme", { colors: { background: "#fafafa", foreground: "#202020", muted: "#707070", border: "#d0d0d0", accent: "#0050d0" }, dark: false });
    const up = c.records.slice(before).filter((r) => r.t === "patch").flatMap((r) => r.upsert).find((i: any) => i.id === answerId);
    assert.ok(up, "the answer was re-sent before the reply");
    const themed = up.blocks[3].svg;
    assert.notEqual(themed, svgPath);
    assert.ok(readFileSync(themed, "utf8").includes('fill="#fafafa"'));
    assert.deepEqual(up.blocks[1], answer.blocks[1], "code blocks are unchanged");
    h.artifact("rich", { mermaidSvg: readFileSync(svgPath, "utf8").length, themedSvg: themed });
  } finally {
    await h.stop();
  }

  // ---- history: a restarted host shows the same rich items (default theme again)
  const again = await new Host({ name: "rich-again", scenario: "rich.json", speed: 2, dir: h.dir }).start();
  try {
    const c = again.client;
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "tool"), 10_000, "history loaded");
    assert.deepEqual(rich(c.items), rich(live));
    assert.ok(existsSync(svgPath), "the SVG is rendered again after the image folder was cleared");
    again.artifact("rich-resumed");
  } finally {
    await again.stop();
  }
});
