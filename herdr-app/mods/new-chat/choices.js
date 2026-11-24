/**
 * Choices shown in the new-chat launcher: always includes Terminal, plus every agent
 * not reported as uninstalled (`installed?.[c.id] !== false`).
 * Before `installed` is known (`null`), every choice is offered until the check resolves.
 */
export function visibleChoices(choices, installed) {
  return choices.filter((c) => c.isTerminal || installed?.[c.id] !== false);
}

/**
 * Resolve the highlighted index within `visible`, preferring `preferredId`, then
 * `fallbackId`, and clamping to 0 if neither is visible.
 */
export function resolveSelection(visible, preferredId, fallbackId = null) {
  if (!visible.length) return 0;
  if (preferredId) {
    const i = visible.findIndex((c) => c.id === preferredId);
    if (i >= 0) return i;
  }
  if (fallbackId) {
    const i = visible.findIndex((c) => c.id === fallbackId);
    if (i >= 0) return i;
  }
  return 0;
}
