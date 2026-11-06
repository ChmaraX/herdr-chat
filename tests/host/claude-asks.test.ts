// Claude Code asks: permission prompts (allow once / always / deny), questions,
// plan approval, and an ask the CLI withdraws.
import { test } from "node:test";
import assert from "node:assert/strict";
import { idle } from "./harness.ts";
import { startClaude } from "../fake-claude/host.ts";

const bash = (command: string, out = "ok") => ({ tool: "Bash", input: { command, description: `Run ${command}` }, result: { content: out } });

test("claude: permission card shows the tool; allow once, always (no second ask), deny (declined card)", async () => {
  const h = await startClaude({
    name: "claude-permissions", speed: 4,
    scenario: {
      turns: [
        { match: "once", steps: [bash("touch a.txt"), { text: "Made a.txt." }] },
        { match: "always", steps: [bash("npm test", "12 passing"), bash("npm test", "12 passing"), { text: "Tests pass twice." }] },
        { match: "deny", steps: [bash("rm -rf build"), { text: "Not removed: {prompt}" }] },
      ],
    },
  });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    const dialog = async () => {
      await c.waitFor((x) => x.state.dialog?.method === "permission", 5000, "permission card");
      return c.state.dialog;
    };

    await c.req("send", { text: "Do it once" });
    let d = await dialog();
    assert.equal(d.title, "Allow Bash?");
    assert.equal(d.message, "Run touch a.txt");
    assert.deepEqual({ name: d.tool.name, title: d.tool.title, detail: d.tool.detail }, { name: "Bash", title: "$ touch a.txt", detail: { type: "bash", command: "touch a.txt" } });
    assert.deepEqual(d.choices.map((x: any) => [x.id, x.kind]), [["allow", "allow"], ["always", "allow_always"], ["deny", "deny"]]);
    assert.equal(d.choices[1].description, "Bash(touch a.txt)");
    await h.waitStatus(/^blocked\(Allow Bash\?\)$/);
    await c.req("dialog_answer", { dialog: d.id, choice: "allow" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.text === "Made a.txt."), 5000);
    assert.equal(c.items.find((i) => i.kind === "tool").status, "done");

    await c.req("send", { text: "Run the tests, always" });
    d = await dialog();
    await c.req("dialog_answer", { dialog: d.id, choice: "always" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.text === "Tests pass twice."), 5000, "second run without an ask");
    const answers = h.inputs().filter((r) => r.type === "control_response");
    assert.equal(answers.length, 2, "the second npm test was not asked again");
    assert.deepEqual(answers[1].response.response.updatedPermissions?.map((p: any) => p.rules?.[0]), [{ toolName: "Bash", ruleContent: "npm test" }]);
    assert.equal(answers[1].response.response.behavior, "allow");

    await c.req("send", { text: "Please deny" });
    d = await dialog();
    await c.req("dialog_answer", { dialog: d.id, choice: "deny", message: "Not the build folder" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => /^Not removed/.test(i.text ?? "")), 5000);
    const denied = c.items.filter((i) => i.kind === "tool").at(-1);
    assert.equal(denied.title, "$ rm -rf build");
    assert.equal(denied.status, "declined");
    assert.equal(denied.output, "Not the build folder", "the deny reason reached the model");
    const last = h.inputs().filter((r) => r.type === "control_response").at(-1).response.response;
    assert.deepEqual(last, { behavior: "deny", message: "Not the build folder", toolUseID: last.toolUseID });
    assert.equal(c.state.dialog, null);
    h.artifact("claude-permissions");
  } finally {
    await h.stop();
  }
});

test("claude: questions (AskUserQuestion), plan approval (ExitPlanMode), and an ask the CLI withdraws", async () => {
  const h = await startClaude({
    name: "claude-questions", speed: 4,
    scenario: {
      turns: [
        {
          match: "drink",
          steps: [
            { question: { questions: [
              { question: "Tea or coffee?", header: "Drink", options: [{ label: "Tea", description: "Hot leaves" }, { label: "Coffee", description: "Beans" }], multiSelect: false },
              { question: "Which snacks?", header: "Snacks", options: [{ label: "Biscuits" }, { label: "Fruit" }, { label: "Nuts" }], multiSelect: true },
            ] } },
            { text: "Noted." },
          ],
        },
        { match: "plan", steps: [{ plan: "# Plan\n\n1. Create hello.txt\n2. Say hi" }, { text: "Plan handled in {mode} mode." }] },
        { match: "withdraw", steps: [{ ...bash("sleep 1"), withdrawAfterMs: 600 }, { text: "Went another way." }] },
      ],
    },
  });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "Ask me about a drink" });
    await c.waitFor((x) => x.state.dialog?.method === "questions", 5000);
    const q = c.state.dialog;
    assert.equal(q.title, "Claude Code has some questions");
    assert.deepEqual(q.questions.map((x: any) => [x.id, x.header, x.question, x.options.map((o: any) => o.label), x.multiSelect, x.allowOther]), [
      ["q0", "Drink", "Tea or coffee?", ["Tea", "Coffee"], false, true],
      ["q1", "Snacks", "Which snacks?", ["Biscuits", "Fruit", "Nuts"], true, true],
    ]);
    assert.equal(q.questions[0].options[0].description, "Hot leaves");
    await assert.rejects(c.req("dialog_answer", { dialog: q.id, answers: { q0: 3 } }), /must be a string/);
    await c.req("dialog_answer", { dialog: q.id, answers: { q0: "Tea", q1: ["Biscuits", "Nuts"] } });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.text === "Noted."), 5000);
    const sent = h.inputs().filter((r) => r.type === "control_response").at(-1).response.response;
    assert.equal(sent.behavior, "allow");
    assert.deepEqual(sent.updatedInput.answers, { "Tea or coffee?": "Tea", "Which snacks?": "Biscuits, Nuts" });
    assert.match(c.items.find((i) => i.kind === "tool" && i.name === "AskUserQuestion").output, /"Tea or coffee\?"="Tea"/);

    await c.req("send", { text: "Make a plan" });
    await c.waitFor((x) => x.state.dialog?.method === "permission", 5000);
    const p = c.state.dialog;
    assert.equal(p.title, "Claude Code's plan is ready");
    assert.match(p.message, /1\. Create hello\.txt/);
    assert.deepEqual(p.choices.map((x: any) => x.id), ["approve", "approve_edits", "keep"]);
    await c.req("dialog_answer", { dialog: p.id, choice: "approve_edits" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => /^Plan handled/.test(i.text ?? "")), 5000);
    assert.ok(c.items.some((i) => i.text === "Plan handled in acceptEdits mode."));
    await c.waitFor((x) => x.state.permissionMode === "acceptEdits", 2000, "the mode chip follows");

    await c.req("send", { text: "Then withdraw it" });
    await c.waitFor((x) => x.state.dialog?.method === "permission", 5000);
    await c.waitFor((x) => x.state.dialog === null, 3000, "the CLI withdrew the ask: the card closes");
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.text === "Went another way."), 5000);
    h.artifact("claude-questions-plan");
  } finally {
    await h.stop();
  }
});
