// A user message that invokes a skill → the skill (drawn as a pill) and what
// the person typed after it. An adapter whose agent echoes a skill its own way
// names it itself (`user_message.skill`: Pi's expanded block, Codex's `$name`);
// otherwise the message is as typed, `/command rest` (Claude Code), and the
// chat's skill commands tell a skill from any other command.
import type { SkillRef } from "./providers/types.ts";

export type { SkillRef };

/**
 * The skill a message starts with, by the chat's skill commands: `/command rest`.
 * `skills`: the names of the chat's commands whose source is "skill".
 */
export function splitSkill(text: string, skills: Iterable<string>): { skill: SkillRef; text: string } | null {
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
