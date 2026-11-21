// A message with several skills, for Claude Code. Its terminal prompt runs
// `/a /b rest` as stacked skills, but `claude -p` (stream-json, what the chat
// drives) loads only the first and passes `/b rest` to it as arguments
// (code.claude.com/docs/en/skills, "Stack several skills in one message").
// So such a message goes as text that names each skill as a separate word,
// with the request to run them: the model loads each with the Skill tool, as
// Claude Code would (a name the person wrote is their permission, so a skill
// with `disable-model-invocation` runs too). One skill stays a real `/name`.
// The transcript keeps that text; `typedSkills` reads it back as typed.
import { typedText } from "../../skill.ts";
import type { Prompt } from "../types.ts";

const LEAD = "Before anything else, run these skills with the Skill tool, one call each, in this order:";

/** `/a /b rest` (skill names, the rest) → what Claude Code gets. */
export function stackedSkills(names: string[], rest: string): string {
  return `${LEAD} ${names.map((n) => `/${n}`).join(" ")}${rest ? `\n\n${rest}` : ""}`;
}

/** A message as Claude Code gets it: its skills (split by the core) said so they all run. */
export function asSent(p: Prompt): string {
  if (!p.lead) return p.text;
  const { skills, rest } = p.lead;
  return skills.length > 1 ? stackedSkills(skills.map((s) => s.command), rest) : typedText(rest, skills);
}

/** A message `stackedSkills` wrote, back as typed (`/a /b rest`); any other text as it is. */
export function typedSkills(text: string): string {
  if (!text.startsWith(LEAD)) return text;
  const m = /^ ((?:\/\S+ ?)+)(?:\n\n([\s\S]*))?$/.exec(text.slice(LEAD.length));
  return m ? `${m[1]!.trim()}${m[2] ? ` ${m[2]}` : ""}` : text;
}
