// A user message that invokes skills → the skills (drawn as pills) and what
// the person typed after them. As typed, a message runs its skills from the
// front: `/a /b rest`. The core splits it once, by the chat's skill commands,
// and hands that split to the adapter, which says the skills its agent's way.
// Read back, an agent that echoes skills its own way is named by its adapter
// (`user_message.skills`: Pi's expanded blocks, Codex's skill inputs);
// otherwise the message is as typed, and this split runs again.
import type { SkillLead, SkillRef } from "./providers/types.ts";

export type { SkillLead, SkillRef };

/** A skill command → its ref: Pi's `skill:name` is named `name`. */
export function skillRef(command: string): SkillRef {
  return { name: command.replace(/^skill:/, ""), command };
}

/**
 * The skills a message starts with, by the chat's skill commands: `/a /b rest`.
 * `skills`: the names of the chat's commands whose source is "skill". A skill
 * named twice runs once.
 */
export function splitSkills(text: string, skills: Iterable<string>): SkillLead | null {
  const known = new Set(skills);
  const out: SkillRef[] = [];
  let rest = text.trim();
  for (let m; (m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(rest)) && known.has(m[1]!); rest = (m[2] ?? "").trim()) {
    if (!out.some((s) => s.command === m![1])) out.push(skillRef(m[1]!));
  }
  return out.length ? { skills: out, rest } : null;
}

/** The message as the person would type it again: `/a /b rest`. */
export function typedText(text: string, skills: readonly SkillRef[] | undefined): string {
  const lead = (skills ?? []).map((s) => `/${s.command}`).join(" ");
  return lead ? `${lead}${text ? ` ${text}` : ""}` : text;
}
