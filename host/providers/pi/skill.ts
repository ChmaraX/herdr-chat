// Skills for Pi, and what Pi expands turned back into what the person typed.
// Pi runs one skill per message: `/skill:name rest` is echoed as
// `<skill name=… location=…>\nbody\n</skill>\n\nrest`. A message with more
// skills (`/skill:a /skill:b rest`) leaves the first to Pi and gets the others'
// blocks from the adapter (`piSkillBlock`, `expandSkills`), in the same format,
// so the echo is a run of blocks, then the rest: `parsePiSkills` turns that
// back into the skills (drawn as pills) and the text after them.
// A file given as `pi @brief.md` arrives inline: `<file name="/abs/brief.md">…</file>`.
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SkillRef } from "../types.ts";

const BODY_MAX = 64 * 1024;

// Pi's own block (agent-session.js `_expandSkillCommand`, `parseSkillBlock`), tolerant of a missing location.
const BLOCK = /^<skill name="([^"]+)"(?: location="([^"]*)")?>\n?([\s\S]*?)\n?<\/skill>(?:\n\n|\s*$)/;

/** Pi's expanded skill blocks → the skills and the person's message after them; null when `text` starts with none. */
export function parsePiSkills(text: string): { skills: SkillRef[]; text: string } | null {
  const skills: SkillRef[] = [];
  let rest = text;
  for (let m; (m = BLOCK.exec(rest)); rest = rest.slice(m[0].length)) {
    const body = m[3]!.replace(/^References are relative to [^\n]*\n\n?/, "");
    skills.push({ name: m[1]!, command: `skill:${m[1]}`, ...(m[2] ? { path: m[2] } : {}), ...(body ? { body: body.length > BODY_MAX ? body.slice(0, BODY_MAX) + "\n\n… [truncated]" : body } : {}) });
  }
  return skills.length ? { skills, text: rest.trim() } : null;
}

/** A user message's text and skills, as the person typed it: `{text, skills?}`. */
export function userText(text: string): { text: string; skills?: SkillRef[] } {
  return parsePiSkills(text) ?? { text };
}

/**
 * A skill as Pi expands it: its block (agent-session.js `_expandSkillCommand`),
 * the one format a message's blocks are written and read in. `path`: its
 * SKILL.md; throws when it can't be read.
 */
export function piSkillBlock(name: string, path: string): string {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`Can't read the skill ${name} (${path}): ${(e as Error).message}`);
  }
  return `<skill name="${name}" location="${path}">\nReferences are relative to ${dirname(path)}.\n\n${stripFrontmatter(content)}\n</skill>`;
}

/**
 * The message Pi gets for several skills: the first as its `/skill:` (Pi
 * expands that one), the others' blocks after it, then the rest. Pi passes
 * everything after the first command to it, so the model reads a run of
 * blocks, then the message.
 */
export function expandSkills(first: SkillRef, blocks: string[], rest: string): string {
  const args = [...blocks, rest].filter(Boolean).join("\n\n");
  return `/${first.command}${args ? ` ${args}` : ""}`;
}

/**
 * Each skill command's SKILL.md, from Pi's `get_commands` (`sourceInfo.path`).
 * Asks Pi again when a skill isn't known yet (a reload added it), so a stale
 * list can't refuse a message.
 */
export class PiSkillFiles {
  private paths = new Map<string, string>();
  private readonly getCommands: () => Promise<Record<string, any>>;
  constructor(getCommands: () => Promise<Record<string, any>>) {
    this.getCommands = getCommands;
  }

  async path(command: string): Promise<string> {
    if (!this.paths.has(command)) await this.load();
    const path = this.paths.get(command);
    if (!path) throw new Error(`Pi didn't say where the skill ${command.replace(/^skill:/, "")} is`);
    return path;
  }

  private async load(): Promise<void> {
    const d = await this.getCommands();
    const list: Record<string, any>[] = Array.isArray(d?.commands) ? d.commands : [];
    this.paths = new Map(list.filter((c) => c?.source === "skill" && typeof c.name === "string" && typeof c.sourceInfo?.path === "string").map((c) => [c.name, c.sourceInfo.path]));
  }
}

// Pi's `stripFrontmatter` (utils/frontmatter.js): the body after a leading `---` block, trimmed.
function stripFrontmatter(content: string): string {
  const text = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!text.startsWith("---")) return text.trim();
  const end = text.indexOf("\n---", 3);
  return end === -1 ? text.trim() : text.slice(end + 4).trim();
}

/** `pi @brief.md go`'s inlined files back as `@/abs/brief.md go` (a session list's one line). */
export function fileArgsAsTyped(text: string): string {
  return text.replace(/<file name="([^"]*)">[\s\S]*?(?:<\/file>|$)\n?/g, "@$1 ").trim();
}
