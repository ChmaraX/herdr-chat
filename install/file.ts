// Replacing a file of Herdr's (keys.json, a layout) whole: a new copy written
// next to it, then renamed over it, so a reader never sees half a file.
//
// The file may be a symlink into the person's dotfiles: the copy is written
// next to the file the link names, and renamed over that one, so the link stays
// a link and the dotfiles copy carries the change. A dangling link is followed
// too: the file is made where it points.
import { lstatSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

/** Where `path`'s content lives: `path`, or the end of its symlink chain (which may not exist yet). */
function linkEnd(path: string): string {
  for (let hops = 0; hops < 40; hops++) {
    let link: string;
    try { link = lstatSync(path).isSymbolicLink() ? readlinkSync(path) : ""; } catch { return path; }
    if (!link) return path;
    // As the kernel does: a relative target from the link's real folder (its parents may be links too).
    path = resolve(realpathSync(dirname(path)), link);
  }
  throw new Error(`${path}: too many levels of symbolic links`);
}

const readOrNull = (f: string): string | null => { try { return readFileSync(f, "utf8"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; } };

/**
 * Reads `path` (null: no file), asks `change` for the new text (null: nothing
 * to change), and replaces the file whole, unless it changed meanwhile (then
 * again). Keeps symlinks; leaves no temporary file behind. Returns whether it wrote.
 */
export function replaceFile(path: string, change: (text: string | null) => string | null): boolean {
  const file = linkEnd(path);
  const tmp = resolve(dirname(file), `.${basename(file)}.herdr-chat.tmp`);
  // A read-only dotfiles folder: name the file and the link to it, not only the temporary file.
  const writing = (step: () => void) => {
    try { step(); } catch (e) { throw new Error(`can't write ${file}${file === path ? "" : ` (${path} links to it)`}: ${e instanceof Error ? e.message : e}`); }
  };
  for (let i = 0; i < 5; i++) {
    const before = readOrNull(file);
    const after = change(before);
    if (after === null) return false;
    try {
      writing(() => writeFileSync(tmp, after));
      if (readOrNull(file) !== before) continue;
      writing(() => renameSync(tmp, file));
      return true;
    } finally {
      rmSync(tmp, { force: true });
    }
  }
  throw new Error(`${path} keeps changing; run the install again`);
}
