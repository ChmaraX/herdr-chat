// A chat whose host is older than the install (protocol.md "v3.5: updates").
// A host keeps the code it started with; the mods reload at once. So after an
// install each chat compares its host's build (the welcome) with the
// install's (config.json) and, once the person asks (this chat's bar, /reload,
// or new-chat's popup for every chat), restarts its host on the same session
// as soon as the chat is quiet. A sub-agent's host is its parent's: never.

import { shared } from "herdr";

/** The build the person asked every chat to restart on (new-chat's popup sets it). */
export const RESTART_ALL = "herdr-chat.update.restart";

/** The host runs other code than the install's. A host from before builds existed has none: older. */
export function outdated(welcome, cfg) {
  return Boolean(cfg?.build && welcome) && welcome.host?.build !== cfg.build;
}

/** Every chat was asked to restart on this install. */
export function restartAll(cfg) {
  return Boolean(cfg?.build) && shared(RESTART_ALL) === cfg.build;
}

/**
 * Nothing a restart would lose: no run, no open question, nothing queued (the
 * host holds the follow-ups in memory), no hand-off or conflict. An agent
 * that exited or failed is quiet too: the restart starts it again.
 */
export function quiet(s) {
  if (!["idle", "exited", "error"].includes(s.phase)) return false;
  if (s.dialog || s.dialogsPending) return false;
  return !(s.queue?.steering?.length || s.queue?.followUp?.length);
}
