// The words in a permission card's reason field (dialogs.js): what the typed
// text goes with. A plan's "Tell Claude what to change" takes what should
// change, a "No, and tell Codex what to do differently" what to do instead,
// any other deny a reason. Named after the choice it's sent with, as the card
// shows it, never a "Deny" the card has no button for.

/** @param {{ kind?: string, label?: string }[] | undefined} choices */
export function reasonPlaceholder(choices) {
  const deny = (choices ?? []).find((x) => x?.kind === "deny");
  const label = String(deny?.label ?? "").trim();
  const short = label.split(/,|\s+\(/)[0].trim() || "Deny";
  if (/\bwhat to change\b/i.test(label)) return `What should change? (sent with ${short})`;
  if (/\bdifferently\b/i.test(label)) return `What to do instead? (optional, sent with ${short})`;
  return `Why not? (optional, sent with ${short})`;
}
