// The platform's key conventions. macOS has Cmd for the app's own keys;
// on Linux (and Windows) Ctrl does that work, Super belongs to the desktop,
// and Ctrl+C is a text field's copy.

import os from "os";

export const MAC = /^(darwin|macos)$/.test(os.platform());
