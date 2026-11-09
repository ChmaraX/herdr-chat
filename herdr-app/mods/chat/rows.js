// Timeline items → the rows the timeline draws (visual-v2.md §5, §6):
// - consecutive tool and thinking items of one response fold into a work
//   group (`g-<first id>`); a lone one stays a row of its own;
// - assistant messages that only carried tool calls (no text) are hidden,
//   and so are info notifies (the toast says it);
// - the last assistant row of a finished run carries the run's footer
//   (model · time · tokens · cost), or a footer row follows the run;
// - while Pi works (or waits on a dialog), an activity row comes last;
// - an extension's notify repeated word for word (after a resume) shows once.
// Pure: the view calls it on every render (O(items)).

export function visible(it) {
  if (it.kind === "assistant") {
    if (it.text?.trim() || it.error) return true; // streaming with no text yet: the activity row says so
    return it.stopReason === "aborted" || it.stopReason === "length" || it.stopReason === "error";
  }
  if (it.kind === "notice" && it.source === "notify" && it.level === "info") return false;
  return true;
}

const WORK = new Set(["tool", "thinking"]);

// Items a subagent's run produced (`parent`, protocol v3), by parent id, in
// order. They're drawn inside the parent's agent card, never as rows.
export function childrenOf(items) {
  const kids = new Map();
  for (const it of items) if (it.parent) (kids.get(it.parent) ?? kids.set(it.parent, []).get(it.parent)).push(it);
  return kids;
}

// state: ChatState. Returns rows: {id, kind: "item"|"group"|"footer"|"activity", ...},
// with `rows.children` (childrenOf) for the agent cards.
export function buildRows(items, state) {
  const rows = [];
  rows.children = childrenOf(items);
  let group = null;
  const notified = new Set();
  const flush = () => {
    if (!group) return;
    if (group.length === 1) rows.push({ id: group[0].id, kind: "item", item: group[0] });
    else rows.push({ id: `g-${group[0].id}`, kind: "group", items: group });
    group = null;
  };
  // Runs: from one user message to the next. The footer goes on the run's last row.
  let run = null;
  const endRun = (done) => {
    if (!run) return;
    const r = run;
    run = null;
    if (!done || !r.assistants.length) return;
    const foot = footerOf(r.assistants);
    if (!foot) return;
    const last = rows[rows.length - 1];
    if (last?.kind === "item" && last.item.kind === "assistant") last.footer = foot;
    else rows.push({ id: `f-${r.assistants[r.assistants.length - 1].id}`, kind: "footer", footer: foot });
  };
  for (const it of items) {
    if (it.kind === "user") {
      flush();
      endRun(true);
      run = { assistants: [] };
    }
    if (it.parent) continue; // nested under its agent card
    // An extension's notify that repeats an earlier one word for word (a startup
    // warning again after a resume): the first one says it.
    if (it.kind === "notice" && it.source === "notify") {
      const key = `${it.level}:${it.text ?? (it.spans ?? []).map((x) => x.text).join("")}`;
      if (notified.has(key)) continue;
      notified.add(key);
    }
    if (it.kind === "assistant") (run ??= { assistants: [] }).assistants.push(it);
    if (!visible(it)) continue;
    if (WORK.has(it.kind)) {
      (group ??= []).push(it);
      continue;
    }
    flush();
    rows.push({ id: it.id, kind: "item", item: it });
  }
  flush();
  const working = state.phase === "working" || state.phase === "compacting";
  endRun(!working);
  if (working || state.dialog) rows.push({ id: "activity", kind: "activity" });
  return rows;
}

// The run's footer: its assistant messages' model, time, tokens and cost.
function footerOf(list) {
  let ms = 0, out = 0, inp = 0, cache = 0, cost = null, model = null, any = false;
  for (const a of list) {
    if (a.streaming) return null;
    if (a.model) model = a.model;
    if (a.durationMs != null) { ms += a.durationMs; any = true; }
    if (a.usage) {
      any = true;
      out += a.usage.output ?? 0;
      inp += a.usage.input ?? 0;
      cache += (a.usage.cacheRead ?? 0) + (a.usage.cacheWrite ?? 0);
      if (a.usage.cost != null) cost = (cost ?? 0) + a.usage.cost;
    }
  }
  if (!any && !model) return null;
  return { model, ms: any ? ms : null, output: out, input: inp, cache, cost };
}

const VERB = {
  bash: ["Ran", "command"], read: ["read", "file"], edit: ["edited", "file"], write: ["wrote", "file"],
  search: ["searched", "time"], web: ["made", "web lookup"], agent: ["ran", "agent"], generic: ["called", "tool"],
};

// A work group's summary: "Ran 3 commands · read 2 files · edited 1 file", its
// span of time, and its worst status.
export function groupSummary(items) {
  const n = {};
  const paths = { edit: new Set(), write: new Set(), read: new Set() };
  let thinking = 0, failed = false, declined = false, running = false, start = Infinity, end = 0;
  for (const it of items) {
    start = Math.min(start, it.ts ?? Infinity);
    end = Math.max(end, (it.ts ?? 0) + (it.durationMs ?? 0));
    if (it.kind === "thinking") {
      thinking++;
      if (it.streaming) running = true;
      continue;
    }
    const type = it.detail?.type ?? "generic";
    const k = VERB[type] ? type : "generic";
    if (paths[k] && it.detail?.path) paths[k].add(it.detail.path);
    n[k] = (n[k] ?? 0) + 1;
    if (it.status === "error") failed = true;
    if (it.status === "declined") declined = true;
    if (it.status === "running" || it.status === "pending") running = true;
  }
  const parts = [];
  for (const k of Object.keys(VERB)) {
    if (!n[k]) continue;
    const c = paths[k]?.size || n[k];
    const [verb, noun] = VERB[k];
    parts.push(`${verb} ${c} ${noun}${c === 1 ? "" : "s"}`);
  }
  if (!parts.length && thinking) parts.push("Thought");
  let text = parts.join(" · ");
  text = text.charAt(0).toUpperCase() + text.slice(1);
  return { text, failed, declined, running, ms: end > start && start !== Infinity ? end - start : null };
}
