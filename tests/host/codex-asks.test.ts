// Codex asks through the real host: approval cards (allow / always / deny), questions, permission grants, MCP elicitations.
import { test } from "node:test";
import assert from "node:assert/strict";
import { idle } from "./harness.ts";
import { codexHost } from "../fake-codex/host.ts";

const answered = (text: RegExp) => (x: any) => idle(x) && x.items.some((i: any) => i.kind === "assistant" && text.test(i.text) && !i.streaming);
const dialog = (method: string, title?: string) => (x: any) => x.state.dialog?.method === method && (!title || x.state.dialog.title === title);

test("codex: three command approvals answered allow, always and deny; the denied one is declined", async () => {
  const h = await codexHost({
    name: "cx-approve",
    scenario: {
      approvalPolicy: "untrusted",
      prompts: [{
        match: "clean up",
        steps: [
          { command: "ls build", output: "a.o\n", approval: {} },
          { command: "rm -rf build", approval: { availableDecisions: ["accept", "acceptForSession", "decline", "cancel"], reason: "Deletes the build folder" } },
          { command: "git push --force", approval: { availableDecisions: ["accept", "decline"] }, onDecline: [{ text: "Skipped the push, as you asked." }] },
        ],
      }],
    },
  });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    assert.equal(c.state.permissionMode, "untrusted");
    await c.req("send", { text: "clean up the build" });

    await c.waitFor(dialog("permission"), 5000, "first approval");
    let d = c.state.dialog;
    assert.equal(d.title, "Run this command?");
    assert.equal(d.tool.title, "$ ls build");
    assert.deepEqual(d.tool.detail, { type: "bash", command: "ls build" });
    // Only what Codex offers, plus a plain deny when it offers just "cancel".
    assert.deepEqual(d.choices.map((x: any) => [x.id, x.label, x.kind]), [
      ["accept", "Allow once", "allow"],
      ["amend1", "Always allow `ls build`", "allow_always"],
      ["decline", "Deny", "deny"],
      ["cancel", "Deny and stop", "deny"],
    ]);
    await h.waitStatus(/^blocked\(Run this command\?\)$/);
    const running = c.items.find((i) => i.kind === "tool");
    assert.equal(running.status, "running", "the card behind the ask is shown already");
    await assert.rejects(c.req("dialog_answer", { dialog: d.id, choice: "maybe" }), /choice/);
    await c.req("dialog_answer", { dialog: d.id, choice: "accept" });

    await c.waitFor((x) => dialog("permission")(x) && x.state.dialog.id !== d.id, 5000, "second approval");
    d = c.state.dialog;
    assert.equal(d.message, "Deletes the build folder");
    assert.deepEqual(d.choices.map((x: any) => x.id), ["accept", "acceptForSession", "decline", "cancel"]);
    await c.req("dialog_answer", { dialog: d.id, choice: "acceptForSession" });

    await c.waitFor((x) => dialog("permission")(x) && x.state.dialog.tool.title === "$ git push --force", 5000, "third approval");
    d = c.state.dialog;
    assert.deepEqual(d.choices.map((x: any) => x.id), ["accept", "decline"]);
    await c.req("dialog_answer", { dialog: d.id, choice: "decline" });

    await c.waitFor(answered(/Skipped the push/), 5000);
    const tools = c.items.filter((i) => i.kind === "tool");
    assert.deepEqual(tools.map((t) => [t.title, t.status]), [["$ ls build", "done"], ["$ rm -rf build", "done"], ["$ git push --force", "declined"]]);
    assert.equal(c.state.dialog, null);
    assert.deepEqual(h.answers().map((a) => a.result.decision), ["accept", "acceptForSession", "decline"]);
    // Codex's own tool-router error for the rejection is not a user-facing notice.
    assert.ok(!c.items.some((i) => i.kind === "notice" && /tool error/.test(i.text)));
    await h.waitStatus(/^done/);
    await h.waitTranscript(/^· \$ git push --force ✗$/m);
    h.artifact("codex-approvals");
  } finally {
    await h.stop();
  }
});

test("codex: a file change approval shows the diff; deny with a reason steers it to the model; Esc cancels an open ask; Codex withdrawing one closes the card", async () => {
  const h = await codexHost({
    name: "cx-approve-file",
    scenario: {
      prompts: [
        {
          match: "edit",
          steps: [
            { fileChange: [{ path: "notes.txt", kind: "update", diff: "@@ -1 +1 @@\n-two\n+three\n" }], approval: { grantRoot: "/tmp/elsewhere" } },
            { waitFor: "steer", timeout: 3000 },
          ],
        },
        { match: "not that file", steps: [{ text: "Understood, leaving notes.txt alone." }] },
        { match: "slow", steps: [{ command: "make deploy", approval: {} }] },
        {
          // Another client of the thread answers first: Codex resolves the request itself.
          match: "elsewhere",
          steps: [
            { emit: { id: 99, method: "item/commandExecution/requestApproval", params: { kind: "command", threadId: "{thread}", turnId: "{turn}", itemId: "x1", command: "make release", availableDecisions: ["accept", "decline"] } } },
            { wait: 400 },
            { emit: { method: "serverRequest/resolved", params: { threadId: "{thread}", requestId: 99 } } },
            { text: "Answered elsewhere." },
          ],
        },
      ],
    },
  });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "edit the notes" });
    await c.waitFor(dialog("permission", "Apply this change?"), 5000);
    const d = c.state.dialog;
    assert.equal(d.tool.title, "Edit notes.txt");
    assert.match(d.tool.detail.diff, /^-two\n\+three$/m);
    assert.match(d.message, /write under \/tmp\/elsewhere/);
    assert.deepEqual(d.choices.map((x: any) => x.kind), ["allow", "allow_always", "deny", "deny"]);
    await c.req("dialog_answer", { dialog: d.id, choice: "decline", message: "not that file, please" });
    await c.waitFor(answered(/leaving notes\.txt alone/), 5000);
    assert.equal(c.items.find((i) => i.kind === "tool").status, "declined");
    assert.ok(h.requests("turn/steer").some((r) => r.params.input[0].text === "not that file, please"), "the reason went to Codex");

    // Esc during an ask: Codex resolves the ask itself and the card goes.
    await c.req("send", { text: "slow deploy" });
    await c.waitFor(dialog("permission"), 5000);
    await c.req("abort");
    await c.waitFor((x) => idle(x) && x.state.dialog === null, 5000, "card closed, turn over");
    // The abort answers the open ask with "cancel": Codex declines the command and ends the turn.
    assert.equal(c.items.filter((i) => i.kind === "tool").at(-1).status, "declined");
    assert.equal(h.answers().at(-1).result.decision, "cancel");
    await h.waitStatus(/^idle$/);

    await c.req("send", { text: "answered elsewhere" });
    await c.waitFor((x) => x.state.dialog?.tool?.title === "$ make release", 5000, "ask shown");
    await c.waitFor((x) => x.state.dialog === null, 5000, "withdrawn by Codex");
    await c.waitFor(answered(/Answered elsewhere/), 5000);
    assert.ok(!h.answers().some((a) => a.id === 99), "nothing answered for a withdrawn ask");
    h.artifact("codex-file-approval");
  } finally {
    await h.stop();
  }
});

test("codex: questions, a permission grant and MCP elicitations (form and URL)", async () => {
  const h = await codexHost({
    name: "cx-questions",
    scenario: {
      prompts: [{
        match: "script",
        steps: [
          {
            question: {
              questions: [
                { id: "word", header: "Greeting", question: "Which greeting word?", isOther: true, isSecret: false, options: [{ label: "Hello", description: "Classic" }, { label: "Hi", description: "Short" }] },
                { id: "name", header: "Name", question: "Who to greet?", isOther: false, isSecret: false, options: null },
              ],
            },
            then: { "*": [{ text: "Using {answer}." }] },
          },
          { permissions: { reason: "Needs the network", permissions: { network: { enabled: true }, fileSystem: null } }, then: { session: [{ text: "Network granted for the session." }], "*": [{ text: "No network." }] } },
          {
            elicitation: { serverName: "figma", mode: "form", _meta: null, message: "Pick a file", requestedSchema: { type: "object", properties: { file: { type: "string", enum: ["a.fig", "b.fig"], title: "File" }, open: { type: "boolean", title: "Open it" } } } },
            then: { accept: [{ text: "Figma got {content}." }] },
          },
          { elicitation: { serverName: "github", mode: "url", _meta: null, message: "Sign in", url: "https://github.com/login/device", elicitationId: "e1" }, then: { accept: [{ text: "Signed in." }], decline: [{ text: "Not signed in." }] } },
        ],
      }],
    },
  });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "write a greeting script" });
    await c.waitFor(dialog("questions"), 5000);
    const q = c.state.dialog;
    assert.equal(q.title, "Codex has some questions");
    assert.deepEqual(q.questions.map((x: any) => [x.id, x.header, x.options.length, x.multiSelect, x.allowOther]), [["word", "Greeting", 2, false, true], ["name", "Name", 0, false, true]]);
    await h.waitStatus(/^blocked\(Codex has some questions\)$/);
    await c.req("dialog_answer", { dialog: q.id, answers: { word: "Hi", name: "Ada" } });
    await c.waitFor((x) => x.items.some((i) => i.kind === "assistant" && i.text === "Using Hi."), 5000);
    assert.deepEqual(h.answers()[0].result, { answers: { word: { answers: ["Hi"] }, name: { answers: ["Ada"] } } });

    await c.waitFor(dialog("permission", "Grant Codex more permissions?"), 5000);
    assert.match(c.state.dialog.message, /Needs the network\nNetwork access/);
    await c.req("dialog_answer", { dialog: c.state.dialog.id, choice: "session" });
    await c.waitFor((x) => x.items.some((i) => i.kind === "assistant" && i.text === "Network granted for the session."), 5000);
    assert.deepEqual(h.answers()[1].result, { permissions: { network: { enabled: true } }, scope: "session" });

    await c.waitFor(dialog("questions", "figma: Pick a file"), 5000);
    const f = c.state.dialog;
    assert.deepEqual(f.questions.map((x: any) => [x.id, x.options.map((o: any) => o.label)]), [["file", ["a.fig", "b.fig"]], ["open", ["Yes", "No"]]]);
    await c.req("dialog_answer", { dialog: f.id, answers: { file: "b.fig", open: "Yes" } });
    await c.waitFor((x) => x.items.some((i) => i.kind === "assistant" && /Figma got/.test(i.text)), 5000);
    assert.deepEqual(h.answers()[2].result, { action: "accept", content: { file: "b.fig", open: true }, _meta: null });

    await c.waitFor(dialog("confirm"), 5000);
    assert.equal(c.state.dialog.title, "github: Sign in");
    assert.match(c.state.dialog.message, /https:\/\/github\.com\/login\/device/);
    await c.req("dialog_answer", { dialog: c.state.dialog.id, confirmed: false });
    await c.waitFor(answered(/Not signed in\./), 5000);
    h.artifact("codex-questions");
  } finally {
    await h.stop();
  }
});

test("codex fixture plan-mode: a real question, answered, then the proposed plan", async () => {
  const h = await codexHost({ name: "cx-fx-plan", replay: "plan-mode.jsonl", speed: 8 });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "I want a tiny shell script that greets someone. Before planning, ask me exactly one multiple-choice question (with your request_user_input tool) about which greeting word to use. Then propose a short plan." });
    await c.waitFor(dialog("questions"), 10_000);
    const q = c.state.dialog;
    assert.equal(q.title, "Greeting word");
    assert.deepEqual(q.questions[0].options.map((o: any) => o.label), ["Hello (Recommended)", "Hi", "Howdy"]);
    assert.equal(q.questions[0].allowOther, true);
    await c.req("dialog_answer", { dialog: q.id, answers: { greeting_word: "Hello (Recommended)" } });
    await c.waitFor(answered(/^# Tiny Greeting Script/), 10_000);
    assert.equal(c.state.dialog, null);
    h.artifact("codex-fixture-plan-mode");
  } finally {
    await h.stop();
  }
});
