// The timeline's spacing, on one scale (4, 6, 8, 12, 16, 20, 28): the gaps
// between rows (turns, prose, work) and inside an answer (blocks, headings).
// cards.js and rich.js read these; nothing else spells them out.

export const SPACE = {
  first: 8, // above the timeline's first row
  turn: 28, // above a user message (from an answer, a notice, a footer, anything)
  reply: 16, // a user message → what follows it
  block: 12, // an answer's paragraphs, lists, code, tables, diagrams
  headingAbove: 20, // above a heading that isn't first
  headingBelow: 6,
  work: 8, // tool rows, work groups and notices ↔ the prose around them
  card: 6, // between the cards of a group
  slot: 20, // the row under a turn's answer: hover actions and the run's footer
  slotGap: 4, // the answer → that row
  lineH: 22, // prose line height at 14 px
  bubble: { x: 16, y: 10, r: 16 }, // the user's bubble
};

// What a row's own bottom holds below its content: the slot (actions and
// footer) is part of the gap after it, not on top of it.
const trail = (r) => (r?.slot ? SPACE.slotGap + SPACE.slot : 0);

const kindOf = (r) => (r.kind === "item" ? r.item.kind : r.kind);
const isUser = (r) => kindOf(r) === "user";
const PROSE = new Set(["assistant"]);

// rows (rows.js) → each row's `gap` (px above it) and `slot` (an answer that
// ends its turn carries the actions/footer row in flow; one mid-run shows
// them over its last line instead, so the 8 px to the work after it holds).
export function space(rows) {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i], next = rows[i + 1];
    const k = kindOf(r);
    if (k === "footer") r.slot = true;
    else if (k === "assistant") r.slot = !r.item.streaming && (Boolean(r.footer) || !next || isUser(next));
    else r.slot = false;
  }
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i], prev = rows[i - 1];
    if (!prev) { r.gap = SPACE.first; continue; }
    const k = kindOf(r), pk = kindOf(prev);
    if (k === "footer") { r.gap = SPACE.slotGap; continue; } // the slot itself
    let want;
    if (isUser(r)) want = SPACE.turn;
    else if (pk === "user") want = SPACE.reply;
    else if (PROSE.has(k) && PROSE.has(pk)) want = SPACE.block;
    else want = SPACE.work;
    r.gap = Math.max(0, want - trail(prev));
  }
  return rows;
}
