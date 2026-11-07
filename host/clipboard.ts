// The clipboard image → a temp PNG, and image files → ImageContent (base64 + MIME type).
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, statSync, existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join, extname } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

export function clipboardImage(dir = join(tmpdir(), "herdr-chat-images")): Promise<string | null> {
  if (process.platform !== "darwin") return Promise.resolve(null);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `paste-${Date.now()}-${randomBytes(3).toString("hex")}.png`);
  const script = [
    "set png to (the clipboard as «class PNGf»)",
    `set f to open for access (POSIX file ${JSON.stringify(path)}) with write permission`,
    "set eof f to 0",
    "write png to f",
    "close access f",
  ];
  return new Promise((resolve) => {
    execFile("osascript", script.flatMap((l) => ["-e", l]), { timeout: 10_000 }, (err) => {
      if (err || !existsSync(path) || statSync(path).size === 0) {
        try {
          unlinkSync(path);
        } catch {}
        resolve(null);
      } else resolve(path);
    });
  });
}

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
export const IMAGE_LIMITS = { bytes: 5 * 1024 * 1024, count: 20, total: 20 * 1024 * 1024 };

function sniff(b: Buffer): string | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (b.length >= 12 && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

export type ImageContent = { type: "image"; data: string; mimeType: string };

export const MAX_EDGE = 2000;

function run(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 20_000 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

/** Pixel size via sips (macOS). */
async function dimensions(path: string): Promise<{ w: number; h: number } | null> {
  const out = await run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path]);
  const w = Number(/pixelWidth:\s*(\d+)/.exec(out ?? "")?.[1]);
  const h = Number(/pixelHeight:\s*(\d+)/.exec(out ?? "")?.[1]);
  return w > 0 && h > 0 ? { w, h } : null;
}

/**
 * Downscales to a MAX_EDGE longest edge with `sips -Z` (macOS only, no
 * dependencies). Returns the original bytes when smaller, not macOS, or sips fails.
 */
export async function downscale(path: string, bytes: Buffer, mime: string): Promise<Buffer> {
  if (process.platform !== "darwin") return bytes;
  const dim = await dimensions(path);
  if (!dim || Math.max(dim.w, dim.h) <= MAX_EDGE) return bytes;
  const dir = join(tmpdir(), "herdr-chat-images");
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `scaled-${Date.now()}-${randomBytes(3).toString("hex")}${extname(path) || ".png"}`);
  try {
    writeFileSync(tmp, bytes);
    if ((await run("sips", ["-Z", String(MAX_EDGE), tmp])) === null) return bytes;
    const out = readFileSync(tmp);
    return out.length && sniff(out) === mime ? out : bytes;
  } catch {
    return bytes;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }
}

const MAX_SOURCE_BYTES = 64 * 1024 * 1024;

/**
 * Reads and checks image files (Orca's checks), downscaling large ones first.
 * The caps apply to what is sent. Throws with a user-facing message.
 */
export async function loadImages(paths: string[]): Promise<ImageContent[]> {
  if (paths.length > IMAGE_LIMITS.count) throw new Error(`Too many images (at most ${IMAGE_LIMITS.count})`);
  let total = 0;
  const out: ImageContent[] = [];
  for (const p of paths) {
    if (/^[a-z]+:\/\//i.test(p)) throw new Error("Image URLs aren't supported: save the image and attach the file");
    const mime = MIME[extname(p).toLowerCase()];
    if (!mime) throw new Error(`Unsupported image type: ${p}`);
    let bytes: Buffer;
    try {
      if (statSync(p).size > MAX_SOURCE_BYTES) throw new Error("too big");
      bytes = readFileSync(p);
    } catch {
      throw new Error(`Could not read image (or larger than 64 MiB): ${p}`);
    }
    if (!bytes.length) throw new Error(`Image is empty: ${p}`);
    if (sniff(bytes) !== mime) throw new Error(`Not a valid ${mime.slice(6).toUpperCase()} file: ${p}`);
    bytes = await downscale(p, bytes, mime);
    if (bytes.length > IMAGE_LIMITS.bytes) throw new Error(`Image is larger than 5 MiB: ${p}`);
    total += bytes.length;
    if (total > IMAGE_LIMITS.total) throw new Error("Images are larger than 20 MiB in total");
    out.push({ type: "image", data: bytes.toString("base64"), mimeType: mime });
  }
  return out;
}
