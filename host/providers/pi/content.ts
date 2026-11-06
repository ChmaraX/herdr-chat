// Pi's content blocks ({type:"text",text} | {type:"image",data,mimeType}) → text and images.
import type { ImageBlock } from "../types.ts";

type Rec = Record<string, any>;

/** Text blocks joined by newlines; images become "[image]". */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (b && typeof b === "object") {
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
      else if (b.type === "image") parts.push("[image]");
    }
  }
  return parts.join("\n");
}

/** Only the text blocks (a live user echo). */
export function echoText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b: Rec) => b?.type === "text").map((b: Rec) => b.text).join("\n");
}

export function countImages(content: unknown): number {
  return Array.isArray(content) ? content.filter((b) => b && b.type === "image").length : 0;
}

export function imageBlocks(content: unknown): ImageBlock[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((b) => b && b.type === "image" && typeof b.data === "string" && b.data.length > 0)
    .map((b) => ({ data: b.data, mimeType: typeof b.mimeType === "string" ? b.mimeType : "image/png" }));
}

/** A tool result's text: `{content}` blocks, a string, or JSON. */
export function resultText(result: unknown): string {
  if (result === undefined || result === null) return "";
  if (typeof result === "string") return result;
  if (typeof result === "object" && "content" in (result as Rec)) return contentText((result as Rec).content);
  try {
    return JSON.stringify(result);
  } catch {
    return "";
  }
}

export function resultImages(result: unknown): ImageBlock[] {
  return result && typeof result === "object" ? imageBlocks((result as Rec).content) : [];
}
