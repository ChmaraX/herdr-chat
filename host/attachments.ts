// The composer's images (protocol.md "Attachments"): a pasted or dropped image
// is a file of the chat's own, so the chat can show it before it's sent (the
// app shows only files under its home). They live with the chat, not one host.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { clipboardImage, readImage } from "./clipboard.ts";
import { imageSize, type ImageFile } from "./imagesize.ts";

// A copy's name is `<ms>-<hex>-<name>`: room for the prefix under the usual 255-byte limit.
const MAX_NAME_BYTES = 200;

function shortened(name: string): string {
  const ext = extname(name);
  let stem = [...name.slice(0, name.length - ext.length)];
  while (stem.length && Buffer.byteLength(stem.join("") + ext) > MAX_NAME_BYTES) stem.pop();
  return stem.join("") + ext;
}

export class Attachments {
  readonly dir: string;
  private closed = new Set<string>();

  constructor(dir: string) {
    this.dir = resolve(dir);
  }

  private newPath(name: string): string {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    return join(this.dir, `${Date.now()}-${randomBytes(3).toString("hex")}-${shortened(name)}`);
  }

  /** The clipboard's image; null when it holds none. */
  async fromClipboard(): Promise<ImageFile | null> {
    const path = await clipboardImage(this.newPath("paste.png"));
    return path ? { path, size: imageSize(readFileSync(path)) } : null;
  }

  /** A copy of an image file. Throws with a user-facing message. */
  fromFile(path: string): ImageFile {
    const { bytes } = readImage(path);
    const out = this.newPath(basename(path));
    writeFileSync(out, bytes, { mode: 0o600 });
    return { path: out, size: imageSize(bytes) };
  }

  /** Removes one. Any other path (the person's own file) is left alone. */
  remove(path: string): void {
    if (dirname(resolve(path)) === this.dir) rmSync(path, { force: true });
  }

  clear(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }

  /**
   * Removes the folders of other chats that are closed: no pane (not in `open`, from the app's layout)
   * and no live host, in two sweeps in a row, since a layout read mid-change may miss a pane.
   */
  sweepClosed(open: Set<string>, live: (chat: string) => boolean): string[] {
    const root = dirname(this.dir);
    let names: string[] = [];
    try {
      names = readdirSync(root);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const closed = names.filter((c) => c !== basename(this.dir) && !open.has(c) && !live(c));
    const removed = closed.filter((c) => this.closed.has(c));
    for (const c of removed) rmSync(join(root, c), { recursive: true, force: true });
    this.closed = new Set(closed.filter((c) => !removed.includes(c)));
    return removed;
  }
}
