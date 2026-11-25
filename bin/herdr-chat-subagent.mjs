// herdr-chat-subagent for Windows (bin/herdr-chat-subagent without sh): a chat host as a
// sub-agent, for `hc run`: `node herdr-chat-subagent.mjs --provider claude -- --model <m>`.
process.env.HERDR_CHAT_ENTRY_RUN = "1";
await import(new URL("./herdr-chat-host.mjs", import.meta.url).href);
