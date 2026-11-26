// Continue as chat for Antigravity: not supported in v1.
import type { TuiQuery, TuiSession } from "../tui.ts";

export function agyTuiSession(_q: TuiQuery): TuiSession {
  throw new Error("Continue as chat is not supported for Antigravity yet. Use /resume inside a new Antigravity chat.");
}
