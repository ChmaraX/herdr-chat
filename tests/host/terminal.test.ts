import { test } from "node:test";
import assert from "node:assert/strict";
import { startHost, idle, sleep } from "./harness.ts";

test("hc send: a bracketed paste with an <hc from> envelope, in chunks, becomes one external prompt", async () => {
  const h = await startHost({ name: "hc-send", scenario: "abort.json", speed: 1 });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    // What `hc send` writes: a bracketed paste, then Enter. Split mid-marker on purpose.
    const msg = '<hc from="t7 review">quick: Two bugs in x.rs;\ndetails in /tmp/findings.md</hc>';
    const bytes = `\u001b[200~${msg}\u001b[201~\r`;
    for (const part of [bytes.slice(0, 3), bytes.slice(3, 40), bytes.slice(40, bytes.length - 4), bytes.slice(-4)]) {
      h.writeStdin(part);
      await sleep(15);
    }
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "assistant"), 5000, "answered");
    const user = c.items.find((i) => i.kind === "user");
    assert.equal(user.text, "quick: Two bugs in x.rs;\ndetails in /tmp/findings.md");
    assert.equal(user.source, "external");
    assert.equal(user.from, "t7 review");
    await h.waitTranscript(/^> \[t7 review\] quick: Two bugs in x\.rs;\n  details in \/tmp\/findings\.md$/m);

    // While working: an arrow key (an escape sequence) must not abort; a lone ESC, ESC ESC and Ctrl-C do.
    const tools = () => c.items.filter((i) => i.kind === "tool");
    const build = async (n: number) => {
      h.writeStdin("\u001b[200~start the long build\u001b[201~\r");
      await c.waitFor((x) => x.items.filter((i) => i.kind === "tool" && i.status === "running").length === 1 && tools().length === n, 5000, `build ${n} running`);
    };
    await build(1);
    h.writeStdin("\u001b[A");
    await sleep(300);
    assert.equal(c.state.phase, "working", "an arrow key is not Esc");
    h.writeStdin("\u001b");
    await c.waitFor(idle, 5000, "a lone ESC aborts");
    await build(2);
    h.writeStdin("\u001b\u001b");
    await c.waitFor(idle, 5000, "ESC ESC aborts");
    await build(3);
    h.writeStdin("half typed\u0003");
    await c.waitFor(idle, 5000, "Ctrl-C aborts");
    assert.deepEqual(tools().map((t) => t.status), ["error", "error", "error"]);
    // Typed text with Enter also works; Ctrl-C dropped what was typed before it.
    h.writeStdin("quick typed\r");
    await c.waitFor((x) => x.items.filter((i) => i.kind === "user").length === 5, 5000, "typed prompt");
    assert.equal(c.items.filter((i) => i.kind === "user")[4].text, "quick typed");
    h.artifact("hc-send-bracketed-paste");
  } finally {
    await h.stop();
  }
});

test("reconnect mid-stream: a client that leaves and returns catches up to the same timeline", async () => {
  const h = await startHost({ name: "reconnect", scenario: "long-markdown.json", speed: 2 });
  try {
    const a = h.client;
    await a.waitFor(idle, 10_000);
    await a.req("send", { text: "Write the long report" });
    const b1 = await h.connect("mod");
    await b1.waitFor((x) => x.items.some((i) => i.kind === "assistant" && i.text.length > 200), 5000, "streaming");
    b1.close();
    await sleep(200);
    const b2 = await h.connect("mod");
    // The snapshot alone already holds the partial answer.
    const snapAnswer = b2.items.find((i) => i.kind === "assistant");
    assert.ok(snapAnswer && snapAnswer.streaming && snapAnswer.text.length > 200, "the snapshot carries the streaming item");
    await a.waitFor(idle, 15_000, "done");
    await b2.waitFor(idle, 2000);
    await sleep(100);
    assert.deepEqual(b2.items, a.items, "both clients see the same items");
    assert.deepEqual(b2.state, a.state, "and the same state");
    assert.equal(b2.records[0].t, "welcome");
    assert.equal(b2.records[1].t, "snapshot");
    h.artifact("reconnect-mid-stream", { secondClientRecords: b2.records.length });
  } finally {
    await h.stop();
  }
});

test("auth: wrong token, no hello and junk are closed without a reply", async () => {
  const { connect } = await import("node:net");
  const h = await startHost({ name: "auth", speed: 1 });
  try {
    const port = h.registry!.port!;
    const tryLine = (line: string | null) =>
      new Promise<{ data: string; closedMs: number }>((resolve) => {
        const t0 = Date.now();
        const s = connect(port, "127.0.0.1");
        let data = "";
        s.on("data", (d) => (data += d));
        s.on("connect", () => line !== null && s.write(line));
        s.on("close", () => resolve({ data, closedMs: Date.now() - t0 }));
        s.on("error", () => {});
      });
    const wrong = await tryLine(JSON.stringify({ t: "hello", v: 1, token: "0".repeat(64), client: "test" }) + "\n");
    assert.equal(wrong.data, "");
    const junk = await tryLine("not json\n");
    assert.equal(junk.data, "");
    const silent = await tryLine(null);
    assert.equal(silent.data, "");
    assert.ok(silent.closedMs >= 4500 && silent.closedMs < 7000, `closed after ${silent.closedMs} ms`);
    // The registry is private.
    const { statSync } = await import("node:fs");
    const { registryPath } = await import("../../host/registry.ts");
    assert.equal(statSync(registryPath(h.stateDir, h.chat)).mode & 0o777, 0o600);
  } finally {
    await h.stop();
  }
});

test("keepalive: every client gets a ping on an idle socket and keeps working", async () => {
  const h = await startHost({ name: "ping", speed: 4, env: { PI_CHAT_PING_MS: "200" } });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    const second = await h.connect("mod");
    await sleep(1100);
    const pings = (x: typeof c) => x.records.filter((r) => r.t === "ping").length;
    assert.ok(pings(c) >= 4, `${pings(c)} pings`);
    assert.ok(pings(second) >= 4, `${pings(second)} pings on the second client`);
    assert.deepEqual(c.records.find((r) => r.t === "ping"), { t: "ping" });
    // Pings don't count as patches: seq has no gaps.
    assert.deepEqual(c.seqErrors, []);
    await c.req("send", { text: "still there?" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "assistant"), 5000);
  } finally {
    await h.stop();
  }
});

test("terminal title (OSC 0): Pi, then the first prompt, then the extension title, then the session name", async () => {
  const h = await startHost({
    name: "title",
    speed: 4,
    scenario: { extensionCommands: { title: [{ ui: { method: "setTitle", title: "\u001b[1mpi - ext title\u001b[0m" } }] } },
  });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await h.waitTitle("Pi");
    const first = "Refactor the auth module\nso that tokens refresh before they expire, and add tests for it";
    await c.req("send", { text: first });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "assistant"), 5000);
    await h.waitTitle("Refactor the auth module so that tokens refresh before they…");
    assert.equal(h.titles.at(-1)!.length, 60);
    await c.req("send", { text: "/title" });
    await h.waitTitle("pi - ext title");
    await c.req("set_name", { name: "Auth\u0007work" });
    await h.waitTitle("Auth work");
    assert.deepEqual(h.titles.filter((t, i, a) => t !== a[i - 1]), ["Pi", "Refactor the auth module so that tokens refresh before they…", "pi - ext title", "Auth work"]);
    assert.ok(!h.screen.includes("\u001b]0;Auth\u0007work"), "control characters replaced");
    h.artifact("terminal-title", { titles: h.titles });
  } finally {
    await h.stop();
  }
});
