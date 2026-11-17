// What Pi expands, turned back into what the person typed. A skill typed as
// `/skill:name rest` is echoed as `<skill name=… location=…>\nbody\n</skill>\n\nrest`:
// the adapter turns that back into the skill (drawn as a pill) and the text after it.
// A file given as `pi @brief.md` arrives inline: `<file name="/abs/brief.md">…</file>`.
import type { SkillRef } from "../types.ts";

const BODY_MAX = 64 * 1024;

// Pi's own format (agent-session.js `parseSkillBlock`), tolerant of a missing location.
const BLOCK = /^<skill name="([^"]+)"(?: location="([^"]*)")?>\n?([\s\S]*?)\n?<\/skill>(?:\n\n([\s\S]*))?$/;

/** Pi's expanded skill block → the skill and the person's message after it; null when `text` isn't one. */
export function parsePiSkill(text: string): { skill: SkillRef; text: string } | null {
  const m = BLOCK.exec(text);
  if (!m) return null;
  const body = m[3]!.replace(/^References are relative to [^\n]*\n\n?/, "");
  const skill: SkillRef = { name: m[1]!, command: `skill:${m[1]}`, ...(m[2] ? { path: m[2] } : {}), ...(body ? { body: body.length > BODY_MAX ? body.slice(0, BODY_MAX) + "\n\n… [truncated]" : body } : {}) };
  return { skill, text: (m[4] ?? "").trim() };
}

/** A user message's text and skill, as the person typed it: `{text, skill?}`. */
export function userText(text: string): { text: string; skill?: SkillRef } {
  return parsePiSkill(text) ?? { text };
}

/** `pi @brief.md go`'s inlined files back as `@/abs/brief.md go` (a session list's one line). */
export function fileArgsAsTyped(text: string): string {
  return text.replace(/<file name="([^"]*)">[\s\S]*?(?:<\/file>|$)\n?/g, "@$1 ").trim();
}
