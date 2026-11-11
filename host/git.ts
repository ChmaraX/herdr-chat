// The branch of the chat's folder (ChatState.git), shown under the composer.
// Read when the agent starts, when a run settles (a repo it made), and when
// the repo's HEAD changes (a switch from the agent's bash or another
// terminal). A folder that isn't a repo is looked at again on each ask.
import { execFile } from "node:child_process";
import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";

export type GitState = {
  /** The branch, or the short commit when detached. */
  name: string;
  detached: boolean;
};

const TIMEOUT_MS = 5_000;
const DEBOUNCE_MS = 100;
/** A watch that fails is tried again at most this often. */
const RETRY_MS = 1_000;

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((done) => {
    execFile("git", args, { cwd, timeout: TIMEOUT_MS }, (err, stdout) => done(err ? null : stdout.trim()));
  });
}

export class GitWatch {
  private cwd: string;
  private onChange: (s: GitState | null) => void;
  private log: (msg: string) => void;
  private gitDir: string | null = null;
  private watcher: FSWatcher | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private lastRetry = 0;
  private busy = false;
  private again = false;

  constructor(cwd: string, onChange: (s: GitState | null) => void, log: (msg: string) => void) {
    this.cwd = cwd;
    this.onChange = onChange;
    this.log = log;
  }

  /** Looks again now. Calls while one runs coalesce into one more. */
  refresh(): void {
    if (this.busy) {
      this.again = true;
      return;
    }
    this.busy = true;
    void this.read().finally(() => {
      this.busy = false;
      if (this.again) {
        this.again = false;
        this.refresh();
      }
    });
  }

  private async read(): Promise<void> {
    const gitDir = await git(this.cwd, ["rev-parse", "--absolute-git-dir"]);
    if (gitDir !== this.gitDir) this.watch(gitDir);
    if (!gitDir) return this.onChange(null);
    // A branch, born or not; else detached: the commit.
    const branch = await git(this.cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
    if (branch) return this.onChange({ name: branch, detached: false });
    const head = await git(this.cwd, ["rev-parse", "--short", "HEAD"]);
    this.onChange(head ? { name: head, detached: true } : null);
  }

  // The git dir's HEAD (a linked worktree has its own). Not recursive.
  // Installed only once fs.watch succeeds; a failure clears it and looks again.
  private watch(gitDir: string | null): void {
    this.unwatch();
    if (!gitDir) {
      this.gitDir = null;
      return;
    }
    try {
      const watcher = watch(gitDir, { persistent: false }, (_ev, name) => {
        if (name && String(name) !== "HEAD") return;
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => {
          this.debounce = null;
          this.refresh();
        }, DEBOUNCE_MS);
      });
      watcher.on("error", (e) => {
        if (this.watcher !== watcher) return;
        this.failed(e);
      });
      this.watcher = watcher;
      this.gitDir = gitDir;
    } catch (e) {
      this.failed(e);
    }
  }

  private unwatch(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  // Not watched: the next read sets it up again, at most once a second.
  private failed(e: unknown): void {
    this.log(`git watch: ${e}`);
    this.unwatch();
    this.gitDir = null;
    const now = Date.now();
    if (now - this.lastRetry < RETRY_MS) return;
    this.lastRetry = now;
    this.refresh();
  }
}
