import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync, crc32 } from "node:zlib";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startHost, idle, Host } from "./harness.ts";

/** A w×h grayscale PNG, no dependencies. */
function makePng(w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  const rows = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rows[y * (w + 1) + 1 + x] = (x * 7 + y * 3) & 0xff;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

function pngSize(b: Buffer): { w: number; h: number } {
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

const SHOT = makePng(64, 32);

const scenario = {
  prompts: [
    {
      match: "png",
      steps: [
        { assistant: { text: "Reading it.", tools: [{ id: "call_img", name: "read", args: { path: "shot.png" } }] } },
        // Pi's read of an image returns a note plus the image block.
        { tool: { id: "call_img", content: [{ type: "text", text: "Read image file [image/png]" }, { type: "image", data: SHOT.toString("base64"), mimeType: "image/png" }] } },
        { assistant: { text: "It's a gradient." } },
      ],
    },
  ],
};

test("images: prompts downscaled to 2000 px, tool-result and user images saved as files, again on resume", async () => {
  const h = await startHost({ name: "image-files", speed: 4, scenario });
  let toolImage: string;
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    // A 3000×40 screenshot attached to the prompt.
    const wide = join(h.dir, "wide.png");
    writeFileSync(wide, makePng(3000, 40));
    await c.req("send", { text: "what is in this png", images: [wide] });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "assistant" && i.text === "It's a gradient."), 10_000);

    const sent = Buffer.from(h.piCommands().find((x) => x.type === "prompt").images[0].data, "base64");
    if (process.platform === "darwin") {
      const { w, h: ht } = pngSize(sent);
      assert.ok(w === 2000 && (ht === 26 || ht === 27), `longest edge 2000 px, aspect kept: ${w}×${ht}`);
    }
    else assert.deepEqual(pngSize(sent), { w: 3000, h: 40 });

    const user = c.items.find((i) => i.kind === "user");
    assert.equal(user.images, 1);
    assert.equal(user.imagePaths.length, 1);
    const userImage = user.imagePaths[0];
    assert.equal(userImage, join(h.stateDir, "images", "c-test", `${user.id}-1.png`));
    assert.deepEqual(readFileSync(userImage), sent, "the user item shows what Pi got");

    const tool = c.items.find((i) => i.kind === "tool");
    assert.equal(tool.title, "Read shot.png");
    assert.match(tool.output, /Read image file \[image\/png\]\n\[image\]/);
    assert.equal(tool.images.length, 1);
    toolImage = tool.images[0];
    assert.equal(toolImage, join(h.stateDir, "images", "c-test", `${tool.id}-1.png`));
    assert.deepEqual(readFileSync(toolImage), SHOT);
    assert.ok(!JSON.stringify(c.records).includes(SHOT.toString("base64").slice(0, 200)), "no base64 on the wire");
    h.artifact("image-files");
  } finally {
    await h.stop();
  }

  // Resume: the same images come back from history, under the new item ids; old files are gone.
  const again = await new Host({ name: "image-files-again", speed: 4, scenario, dir: h.dir }).start();
  try {
    const c = again.client;
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "tool"), 10_000, "history");
    const tool = c.items.find((i) => i.kind === "tool");
    const user = c.items.find((i) => i.kind === "user");
    assert.equal(tool.images.length, 1);
    assert.deepEqual(readFileSync(tool.images[0]), SHOT);
    assert.equal(user.imagePaths.length, 1);
    assert.ok(existsSync(user.imagePaths[0]));
    assert.ok(!existsSync(toolImage!) || toolImage === tool.images[0], "stale files from the last run are removed");
    const files = readdirSync(join(again.stateDir, "images", "c-test")).sort();
    assert.deepEqual(files, [`${tool.id}-1.png`, `${user.id}-1.png`].sort());
    again.artifact("image-files-resumed");
  } finally {
    await again.stop();
  }
});

test("at most 8 images per tool item", async () => {
  const many = Array.from({ length: 11 }, () => ({ type: "image", data: SHOT.toString("base64"), mimeType: "image/png" }));
  const h = await startHost({
    name: "image-cap",
    speed: 4,
    scenario: { prompts: [{ match: ".", steps: [
      { assistant: { text: "Screens.", tools: [{ id: "call_s", name: "mcp__figma__get_screenshots", args: {} }] } },
      { tool: { id: "call_s", content: many } },
      { assistant: { text: "ok" } },
    ] }] },
  });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "screens" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "assistant" && i.text === "ok"), 10_000);
    const tool = c.items.find((i) => i.kind === "tool");
    assert.equal(tool.images.length, 8);
    assert.ok(tool.images.every((p: string, n: number) => p.endsWith(`${tool.id}-${n + 1}.png`) && existsSync(p)));
    h.artifact("image-cap");
  } finally {
    await h.stop();
  }
});
