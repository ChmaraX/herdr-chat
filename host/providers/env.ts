// The environment an agent CLI runs in under the chat host.

/**
 * Marked as run by the host (PI_CHAT_HOST), without Herdr's hook variables: the
 * agent's own Herdr hook would report this host's pane status beside our OSC 7501.
 */
export function agentEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PI_CHAT_HOST: "1", ...extra };
  delete env.HERDR_PANE_ID;
  delete env.HERDR_SOCKET_PATH;
  delete env.HERDR_ENV;
  return env;
}
