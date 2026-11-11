// The branch of the chat's folder (ChatState.git), shown under the composer.
// Read when the agent starts, when a run settles (a repo it made), and when
// the repo's HEAD changes (a switch from the agent's bash or another
// terminal). A folder that isn't a repo is looked at again on each ask.
import { execFile } from "node:child_process";
import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";

export type GitState = {
  /** null: detached HEAD. */
  branch: string | null;
  /** The short commit when detached; null on a branch. */
  head: string | null;
};

const TIMEOUT_MS = 5_000;
const DEBOUNCE_MS = 100;

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
    if (branch) return this.onChange({ branch, head: null });
    const head = await git(this.cwd, ["rev-parse", "--short", "HEAD"]);
    this.onChange(head ? { branch: null, head } : null);
  }

  // The git dir's HEAD (a linked worktree has its own). Not recursive.
  private watch(gitDir: string | null): void {
    this.watcher?.close();
    this.watcher = null;
    this.gitDir = gitDir;
    if (!gitDir) return;
    try {
      this.watcher = watch(gitDir, { persistent: false }, (_ev, name) => {
        if (name && String(name) !== "HEAD") return;
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => {
          this.debounce = null;
          this.refresh();
        }, DEBOUNCE_MS);
      });
      this.watcher.on("error", (e) => {
        this.log(`git watch: ${e}`);
        this.watcher?.close();
        this.watcher = null;
        this.gitDir = null; // the next refresh looks again
      });
    } catch (e) {
      this.log(`git watch: ${e}`);
    }
  }
}
