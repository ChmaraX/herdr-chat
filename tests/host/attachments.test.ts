// The composer's images (protocol.md "Attachments"): a pasted or dropped image
// becomes a file of the chat's own under the state dir, so the chat can show it
// before it's sent. Its life: ✕ removes it unless a held or queued message
// lists it, sending keeps it, and every end of a host keeps it (a take-over, a
// restart's kill): only the chat's pane closing removes it (E2E `thumb`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Host, idle, sleep, startHost } from "./harness.ts";

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

test("composer images: copied under the state dir, kept while a message or the chat's composer needs them", async () => {
  const h = await startHost({ name: "attachments", scenario: SCENARIO, speed: 1 });
  const dir = join(h.stateDir, "attachments", h.chat);
  const own = join(h.dir, "shot.png");
  writeFileSync(own, PNG);
  let sent: string;
  let composed: string;
  let b: Host | null = null;
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
    const long = join(h.dir, `${"a".repeat(250)}.png`);
    writeFileSync(long, PNG);
    const { path: longCopy } = await c.req("attach_image", { path: long });
    assert.ok(basename(longCopy).length <= 255 && longCopy.endsWith("a.png"), `a name too long for the copy is shortened, its extension kept: ${basename(longCopy)}`);

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
    ({ path: composed } = await c.req("attach_image", { path: own }));
    h.artifact("attachments");

    b = await new Host({ name: "attachments-b", dir: h.dir, chat: "c-b", session: c.state.sessionFile!, scenario: SCENARIO, speed: 1 }).start();
    await b.client.waitFor((x) => x.state.phase === "conflict", 10_000, "conflict");
    await b.client.req("take_over");
    assert.equal(await Promise.race([h.exited, sleep(5000).then(() => "timeout")]), 0, "the take-over shut chat A's host down");
    assert.ok(existsSync(composed), "a take-over keeps chat A's attachments: its pane and composer are still open");
    assert.ok(existsSync(sent));
    b.artifact("attachments-take-over");
  } finally {
    await b?.stop();
    await h.stop();
  }

  const again = await new Host({ name: "attachments-again", scenario: SCENARIO, speed: 1, dir: h.dir }).start();
  try {
    await again.client.waitFor(idle, 10_000);
    assert.ok(existsSync(composed!) && existsSync(sent!), "chat A's next host has them");
    again.artifact("attachments-again");
  } finally {
    await again.stop();
  }
  assert.equal(again.exitCode, 0, "SIGTERM ends the host as a restart's kill does");
  assert.ok(existsSync(composed!), "a killed host keeps the attachments: a restart that falls back to a kill starts a new host for the composer");
});
