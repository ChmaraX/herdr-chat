// The OS the host acts for: process.platform, or HERDR_CHAT_PLATFORM when set
// (protocol.md "Host env"). The tests set it to run the Linux clipboard and
// ImageMagick paths on any machine, with stand-in tools on PATH.
export const OS = (process.env.HERDR_CHAT_PLATFORM || process.platform) as NodeJS.Platform;
export const IS_MAC = OS === "darwin";
