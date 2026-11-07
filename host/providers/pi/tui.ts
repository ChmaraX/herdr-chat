// A Pi TUI's session: the herdr-chat-lock extension labels its terminal with
// it (herdr-chat.session), and Pi records the TUI's model and thinking choices
// in the session file.
import { readFileSync } from "node:fs";
import type { TuiQuery, TuiSession } from "../tui.ts";

export function piTuiSession(q: TuiQuery): TuiSession {
  if (!q.label) throw new Error("this Pi doesn't say which session it has open: restart it to load the herdr-chat-lock extension");
  let model: string | null = null, thinking: string | null = null;
  try {
    for (const line of readFileSync(q.label, "utf8").split("\n")) {
      if (!line.includes("model_change") && !line.includes("thinking_level_change")) continue;
      try {
        const e = JSON.parse(line);
        if (e.type === "model_change" && e.provider && e.modelId) model = `${e.provider}/${e.modelId}`;
        if (e.type === "thinking_level_change" && e.thinkingLevel) thinking = e.thinkingLevel;
      } catch {}
    }
  } catch {
    throw new Error(`can't read the session file ${q.label}`);
  }
  return { session: q.label, model, thinking, args: [...(model ? ["--model", model] : []), ...(thinking ? ["--thinking", thinking] : [])] };
}
