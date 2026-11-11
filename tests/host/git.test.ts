// The branch under the composer (ChatState.git): a real repo, changed the way
// an agent's bash or another terminal changes it, with and without a run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHost, idle, sleep } from "./harness.ts";
import type { ChatClient } from "../../host/client.ts";

const ID = ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"];
const git = (cwd: string, ...args: string[]) => execFileSync("git", [...ID, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "pich-git-")));

function repo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "first");
  return dir;
}

const branchIs = (b: string | null) => (c: ChatClient) => c.state.git?.branch === b;

async function turn(c: ChatClient, text: string): Promise<void> {
  const answers = c.items.filter((i: any) => i.kind === "assistant").length;
  await c.req("send", { text });
  await c.waitFor((x) => idle(x) && x.items.filter((i: any) => i.kind === "assistant").length > answers, 5000, `answer to ${text}`);
}

test("the branch follows switches made outside the chat: new, renamed, detached", async () => {
  const dir = tmp();
  const cwd = repo(join(dir, "cwd"));
  const h = await startHost({ name: "git-follow", cwd, dir });
  try {
    const c = h.client;
    await c.waitFor((x) => idle(x) && branchIs("main")(x), 10_000, "main at start");
    assert.deepEqual(c.state.git, { branch: "main", head: null });
    // No run: the watcher sees HEAD change.
    git(cwd, "checkout", "-qb", "feature/login");
    await c.waitFor(branchIs("feature/login"), 3000, "a new branch");
    git(cwd, "branch", "-m", "feature/sign-in");
    await c.waitFor(branchIs("feature/sign-in"), 3000, "a renamed branch");
    git(cwd, "checkout", "-q", "--detach");
    await c.waitFor(branchIs(null), 3000, "detached");
    assert.equal(c.state.git.head, git(cwd, "rev-parse", "--short", "HEAD"));
    git(cwd, "checkout", "-q", "main");
    await c.waitFor(branchIs("main"), 3000, "back on main");
    assert.ok(!c.items.some((i: any) => i.kind === "notice" && i.level === "error"), "no error notices");
    h.artifact("git-follow");
  } finally {
    await h.stop();
  }
});

test("not a repo, then one; a linked worktree from a subfolder", async () => {
  const dir = tmp();
  const cwd = join(dir, "cwd");
  mkdirSync(cwd, { recursive: true });
  const h = await startHost({ name: "git-norepo", cwd, dir });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await turn(c, "hello");
    assert.equal(c.state.git, null);
    // The agent runs `git init`: the next settle finds the repo, its branch unborn.
    git(cwd, "init", "-q");
    await turn(c, "init the repo");
    await c.waitFor(branchIs("main"), 3000, "a repo made during the chat");
    // From then on it's watched: a switch with no run.
    git(cwd, "checkout", "-qb", "next");
    await c.waitFor(branchIs("next"), 3000, "watched after git init");
    h.artifact("git-norepo");
  } finally {
    await h.stop();
  }

  // A linked worktree has its own HEAD under .git/worktrees/<name>; the chat runs in a subfolder.
  const main = repo(join(dir, "main"));
  const wt = join(dir, "wt");
  git(main, "worktree", "add", "-qb", "wt-branch", wt);
  mkdirSync(join(wt, "src"));
  const w = await startHost({ name: "git-worktree", cwd: join(wt, "src"), dir: tmp() });
  try {
    const c = w.client;
    await c.waitFor(branchIs("wt-branch"), 10_000, "the worktree's branch");
    git(wt, "checkout", "-qb", "wt-next");
    await c.waitFor(branchIs("wt-next"), 3000, "a switch inside the worktree");
    git(main, "checkout", "-qb", "main-next");
    await sleep(500);
    assert.equal(c.state.git.branch, "wt-next", "the main checkout's switch isn't the worktree's");
    w.artifact("git-worktree");
  } finally {
    await w.stop();
  }
});
