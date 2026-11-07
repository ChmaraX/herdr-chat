// A user message that invokes a skill → the skill (drawn as a pill) and what
// the person typed after it. Each agent sends a skill its own way:
//   Pi:          `/skill:name rest`, echoed as `<skill name=… location=…>\nbody\n</skill>\n\nrest`
//   Claude Code: `/name rest`, echoed as typed
//   Codex:       `/name rest`, sent and echoed as `$name rest` (the adapter names the skill)
import type { SkillRef } from "./providers/types.ts";

export type { SkillRef };

const BODY_MAX = 64 * 1024;

// Pi's own format (agent-session.js `parseSkillBlock`), tolerant of a missing location.
const PI_BLOCK = /^<skill name="([^"]+)"(?: location="([^"]*)")?>\n?([\s\S]*?)\n?<\/skill>(?:\n\n([\s\S]*))?$/;

/** Pi's expanded skill block → the skill and the person's message after it; null when `text` isn't one. */
export function parsePiSkill(text: string): { skill: SkillRef; text: string } | null {
  const m = PI_BLOCK.exec(text);
  if (!m) return null;
  const body = m[3]!.replace(/^References are relative to [^\n]*\n\n?/, "");
  const skill: SkillRef = { name: m[1]!, command: `skill:${m[1]}`, ...(m[2] ? { path: m[2] } : {}), ...(body ? { body: body.length > BODY_MAX ? body.slice(0, BODY_MAX) + "\n\n… [truncated]" : body } : {}) };
  return { skill, text: (m[4] ?? "").trim() };
}

/**
 * The skill a message starts with, by the chat's skill commands: `/command rest`
 * (as typed), or Pi's expanded block. `skills`: the names of the chat's commands
 * whose source is "skill".
 */
export function splitSkill(text: string, skills: Iterable<string>): { skill: SkillRef; text: string } | null {
  const pi = parsePiSkill(text);
  if (pi) return pi;
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  for (const command of skills) {
    if (command !== m[1]) continue;
    return { skill: { name: command.replace(/^skill:/, ""), command }, text: (m[2] ?? "").trim() };
  }
  return null;
}

/** The message as the person would type it again: `/command rest`. */
export function typedText(text: string, skill: SkillRef | undefined): string {
  return skill ? `/${skill.command}${text ? ` ${text}` : ""}` : text;
}
