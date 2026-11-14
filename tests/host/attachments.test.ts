// The composer's images (protocol.md "Attachments"): a pasted or dropped image
// becomes a file of the chat's own under the state dir, so the chat can show it
// before it's sent. Its life: ✕ removes it unless a held or queued message
// lists it, sending keeps it, a restart keeps it, closing the chat removes all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Host, idle, startHost } from "./harness.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

const SCENARIO = {
  prompts: [
    {
      match: "^long",
      once: false,
      steps: [
        { assistant: { text: "Running the long build.", tools: [{ name: "bash", args: { command: "make build" } }] } },
        { tool: { name: "bash", until: "abort", every: 100, tick: "compiling unit {n}\n" } },
        { assistant: { text: "unreachable" } },
      ],
    },
  ],
};

const running = (x: any) => x.items.some((i: any) => i.kind === "tool" && i.status === "running");
const answered = (text: string) => (x: any) => idle(x) && x.items.some((i: any) => i.kind === "assistant" && i.text === text && !i.streaming);

test("composer images: copied under the state dir, kept while a message needs them, removed with the chat", async () => {
  const h = await startHost({ name: "attachments", scenario: SCENARIO, speed: 1 });
  const dir = join(h.stateDir, "attachments", h.chat);
  const own = join(h.dir, "shot.png");
  writeFileSync(own, PNG);
  let sent: string;
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);

    const { path: dropped } = await c.req("attach_image", { path: own });
    assert.equal(dirname(dropped), dir, "a dropped file is copied into the chat's attachments");
    assert.match(basename(dropped), /shot\.png$/);
    assert.deepEqual(readFileSync(dropped), PNG);
    writeFileSync(join(h.dir, "notes.txt"), "x");
    await assert.rejects(c.req("attach_image", { path: join(h.dir, "notes.txt") }), /Unsupported image type/);
    writeFileSync(join(h.dir, "fake.png"), "not a png");
    await assert.rejects(c.req("attach_image", { path: join(h.dir, "fake.png") }), /Not a valid PNG file/);
    await assert.rejects(c.req("attach_image", { path: join(h.dir, "missing.png") }), /Could not read image/);
    const clip = await c.req("clipboard_image");
    assert.ok(clip.path === null || dirname(clip.path) === dir, `a pasted image is an attachment too: ${clip.path}`);

    await c.req("detach_image", { path: dropped });
    assert.ok(!existsSync(dropped), "✕ on its chip removes the copy");
    await c.req("detach_image", { path: own });
    assert.ok(existsSync(own), "a file that isn't an attachment is never removed");

    const { path: held } = await c.req("attach_image", { path: own });
    const { path: steer } = await c.req("attach_image", { path: own });
    await c.req("send", { text: "long build" });
    await c.waitFor(running, 5000, "tool running");
    assert.equal((await c.req("send", { text: "look at this", images: [held], mode: "followUp" })).disposition, "queued");
    await c.req("send", { text: "and this", images: [steer], mode: "steer" });
    await c.waitFor((x) => x.state.queue.steering.length === 1 && x.state.queue.followUp.length === 1, 3000, "both lanes");
    await c.req("detach_image", { path: held });
    await c.req("detach_image", { path: steer });
    assert.ok(existsSync(held), "a held follow-up keeps its image");
    assert.ok(existsSync(steer), "a queued steer keeps its image");

    const back = await c.req("queue_edit", { message: c.state.queue.followUpIds[0] });
    assert.deepEqual(back.images, [held], "edit puts the attachment back in the composer");
    assert.ok(existsSync(held));
    await c.req("detach_image", { path: held });
    assert.ok(!existsSync(held), "out of the queue, ✕ removes it");
    await c.req("abort");
    await c.waitFor(idle, 5000, "aborted");

    ({ path: sent } = await c.req("attach_image", { path: own }));
    await c.req("send", { text: "what is this", images: [sent] });
    await c.waitFor(answered("ok: what is this"), 10_000, "answered");
    assert.ok(existsSync(sent), "a sent image stays: a queued edit and an agent without image input read it later");

    await c.req("shutdown", { restart: true });
    await h.exited;
    assert.ok(existsSync(sent), "a restart keeps the attachments: the composer outlives its host");
  } finally {
    await h.stop();
  }

  const again = await new Host({ name: "attachments-again", scenario: SCENARIO, speed: 1, dir: h.dir }).start();
  try {
    await again.client.waitFor(idle, 10_000);
    assert.ok(existsSync(sent!), "the next host keeps them");
    again.artifact("attachments");
  } finally {
    await again.stop();
  }
  assert.ok(!existsSync(dir), "closing the chat removes its attachments");
});
