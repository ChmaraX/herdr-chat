import { test } from "node:test";
import assert from "node:assert/strict";
import { startHost, idle } from "./harness.ts";

test("a select and a confirm with a timeout, then an input: cards, answers, OSC blocked", async () => {
  // Real speed for the 5 s confirm timeout would be slow; speed 2 makes it 2.5 s.
  const h = await startHost({ name: "dialogs", scenario: "dialogs.json", speed: 2 });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "Delete the build folder" });
    await c.waitFor((x) => x.state.dialog?.method === "select", 5000, "select");
    const sel = c.state.dialog;
    assert.equal(sel.title, "Allow dangerous command?");
    assert.equal(sel.message, "rm -rf build");
    assert.deepEqual(sel.options, ["Allow", "Block"]);
    assert.ok(sel.timeoutAt > Date.now() && sel.timeoutAt <= Date.now() + 5_000, `timeoutAt ${sel.timeoutAt - Date.now()} ms away`);
    assert.equal(c.state.dialogsPending, 1);
    await assert.rejects(c.req("dialog_answer", { dialog: sel.id, value: "Maybe" }), /Not one of the options/);
    await c.req("dialog_answer", { dialog: sel.id, value: "Allow" });

    // The confirm: let it time out. Pi resolves it; the card goes away.
    await c.waitFor((x) => x.state.dialog?.method === "confirm", 5000, "confirm");
    const conf = c.state.dialog;
    assert.ok(conf.timeoutAt - Date.now() > 1000);
    await c.waitFor((x) => x.state.dialog?.method !== "confirm", 6000, "confirm timed out");
    await c.waitFor((x) => x.items.some((i) => i.kind === "notice" && i.text === "Cache kept (timeout)"), 3000, "timeout outcome");

    await c.waitFor((x) => x.state.dialog?.method === "input", 5000, "input");
    assert.equal(c.state.dialog.placeholder, "backup-name");
    await c.req("dialog_answer", { dialog: c.state.dialog.id, value: "nightly" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "assistant" && i.text === "Backup saved as nightly."), 5000, "answer");
    assert.equal(c.state.dialog, null);
    assert.equal(c.state.dialogsPending, 0);
    const tool = c.items.find((i) => i.kind === "tool");
    assert.equal(tool.status, "done");
    await assert.rejects(c.req("dialog_answer", { dialog: sel.id, value: "Allow" }), /no longer open/);
    const answers = h.piCommands().filter((x) => x.type === "extension_ui_response");
    assert.deepEqual(answers.map((a) => a.value ?? a.confirmed ?? a.cancelled), ["Allow", "nightly"]);
    const blocked = h.statuses.filter((s, i, a) => s !== a[i - 1] && s.startsWith("blocked"));
    assert.deepEqual(blocked, ["blocked(Allow dangerous command?)", "blocked(Also clear the cache?)", "blocked(Name for the backup?)"]);
    await h.waitStatus(/^done$/);
    h.artifact("select-confirm-timeout-input");
  } finally {
    await h.stop();
  }
});

test("an extension command's dialog outside a run: handled, blocked status, answered after the reply race", async () => {
  const h = await startHost({ name: "cmd-dialog", scenario: "dialogs.json", speed: 1 });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    const t0 = Date.now();
    const r = await c.req("send", { text: "/rpc-input" });
    // Pi replies to an extension command only after its dialog is answered.
    assert.equal(r.disposition, "pending");
    assert.ok(Date.now() - t0 >= 1400);
    await c.waitFor((x) => x.state.dialog?.title === "What is your name?", 2000, "input dialog");
    await h.waitStatus(/^blocked\(What\ is\ your\ name\?\)$/);
    await c.req("dialog_answer", { dialog: c.state.dialog.id, value: "Ada" });
    await c.waitFor((x) => x.items.some((i) => i.kind === "notice" && i.text === "You entered: Ada"), 3000, "notify");
    await c.waitFor(idle, 3000, "back to idle");
    assert.ok(!c.items.some((i) => i.kind === "user"), "a handled command adds no user item");
    await h.waitStatus(/^idle$/);
    h.artifact("extension-command-dialog");
  } finally {
    await h.stop();
  }
});

test("startup dialog: Pi can't read stdin until session_start ends, the host explains it and shows the dialog", async () => {
  const h = await startHost({ name: "startup-dialog", scenario: "startup-dialog.json", speed: 1 });
  try {
    const c = h.client;
    await c.waitFor((x) => x.state.dialog !== null, 3000, "dialog shown");
    assert.equal(c.state.phase, "starting");
    assert.equal(c.state.dialog.title, "Trust this project's extensions?");
    await c.waitFor((x) => typeof x.state.error === "string" && x.state.error.includes("waiting for input during startup"), 13_000, "explained");
    assert.match(c.state.error, /"Trust this project's extensions\?"/);
    assert.ok(c.items.some((i) => i.kind === "notice" && i.level === "warning" && i.text.includes("Pi RPC can't deliver")));
    h.artifact("startup-dialog-hang");
  } finally {
    await h.stop();
  }
});

test("startup dialog with a timeout: Pi resolves it itself, then the chat works", async () => {
  const h = await startHost({ name: "startup-dialog-t", scenario: "startup-dialog-timeout.json", speed: 1 });
  try {
    const c = h.client;
    await c.waitFor((x) => x.state.dialog !== null, 3000, "dialog shown");
    await c.waitFor((x) => x.state.error !== null, 12_000, "explained");
    assert.match(c.state.error, /resolve it itself/);
    await c.waitFor(idle, 8000, "Pi started after the timeout");
    assert.equal(c.state.error, null);
    assert.equal(c.state.dialog, null);
    await c.req("send", { text: "hello" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "assistant"), 5000);
    h.artifact("startup-dialog-timeout");
  } finally {
    await h.stop();
  }
});
