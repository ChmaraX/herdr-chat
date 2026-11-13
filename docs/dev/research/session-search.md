# Session search for /resume

How /resume should list and search sessions: every session, not the newest
100; search through what was said, not only the first message; fast in a
chat whose host is one of many. Measured on one real machine (Nov 2026):
Pi 2,599 sessions in 4.13 GB, Claude Code 63 in 18 MB, Codex 1,092 rollouts
in 1.7 GB.

**Decision (built):** no index. As Codex's and Claude Code's own pickers,
/resume searches the name, first message and folder, the same for every
agent; full text is left out. `host/sessions.ts`: the host lists every
session, reading files in the background and remembering each until its
size or mtime changes; the client sends the query and asks again while
`loading`. Pi's files are scanned by their first bytes per line (`eachLine`,
`host/jsonl.ts`),
parsing only the header, the name and the first user message. Measured on
the store below: all folders 3.0 s cold (Pi's own `listAll`: 12.7 s), 196 MB
peak RSS, the longest stall 64 ms; a refresh 28 ms; a query ~2 ms. The
design below (C) stays the way to add full text if it's wanted.

## What we have (0.2.x)

- The host lists the 100 newest session files (by mtime) and reads each in
  full to get the first user message, the name and a message count. Pi: 350
  ms for one folder, 750 ms for every folder.
- The mod filters those 100 rows on each keystroke with `rank()` (prefix, word
  prefix, substring, then letters in order) over the row text, the file path
  and the meta. The letters-in-order match on long paths lets almost
  anything through, and sorting by score loses the recency order.
- Nothing past the 100 newest exists; nothing past the first message is
  searchable.

## How Pi does it (pi-coding-agent, `core/session-manager.js`, `session-selector-search.js`)

- **No index, no cache.** `SessionManager.list(cwd)` / `listAll()` read every
  `.jsonl` file in full (readline, JSON.parse per line, 10 files at a time),
  keeping per session `{id, cwd, name, firstMessage, messageCount, modified,
  allMessagesText}`: all user and assistant text joined.
- The picker loads progressively (publishes partial lists, "Loading n/m")
  and can be aborted. Tab switches Current Folder / All.
- Search (`matchSession`): tokens are ANDed; `"quoted phrase"`; `re:<regex>`.
  Tiers, best first: name contains the token → id, message text or cwd
  contains it (literal only: "scattered matches in them are noise") →
  fuzzy on name or cwd. Ties: newest first. A "Recent" sort keeps recency and
  only filters. Lowercased text is cached per session in a WeakMap.
- Cost here: `listAll()` takes **12.7 s, 2,599 sessions, 84 MB of text, 353
  MB RSS**. `list(~/projects/novu)` 754 ms for 206 sessions. Fine for a TUI
  that does it once per `/resume`; a host per chat that does it, and holds
  84 MB of text, is not.

## What the stores hold

- Pi: of 4.13 GB, user text is 29.7 MB and assistant text 53.9 MB (83.7 MB);
  the rest is tool output, images, thinking. Files are append-only JSONL
  (a session header first, then entries); `session_info` (the name) can be
  anywhere. Statting all 2,599 files: 21 ms.
- Claude Code: append-only transcripts under
  `<config>/projects/<encoded cwd>/`; small here.
- Codex: the app-server's `thread/list` takes `cwd` (exact), `searchTerm`
  (substring of the title only), `cursor`/`limit`, `sortKey`. Rollout files
  are an internal format (new record types appear between versions:
  `world_state`, `ordinal`); the supported interface is the app-server.

## Options

| | Approach | Full text | Cost measured here | Verdict |
|---|---|---|---|---|
| A | Pi's: read everything on each open | yes | 12.7 s and ~350 MB RSS per host for All | no: per chat, per open |
| B | In-memory index in each host, JSON cache on disk | yes | substring scan 30 ms/query, but **430 MB RSS** with the text resident; DIY persistence and locking between hosts | no |
| C | **One SQLite FTS5 index** (`node:sqlite`) in the state dir, shared by every host, filled incrementally | yes | build 12.5 s once (reading 4.1 GB); queries **0.1–0.8 ms**; DB 115 MB (unicode61, text stored) | **yes** |
| D | fff (`@ff-labs/fff-node`) or ripgrep over the raw JSONL per query | noisy | rg: 1.3–1.6 s per query warm | no |
| E | Metadata-only index (no message text), JSON | no | small, Node 20 | a fallback only |

### Why not fff (D)

fff is a Rust library (loaded with `ffi-rs`, one dylib per platform) for
fuzzy **file path** search and live grep in a **code tree**: frecency, git
status, gitignore, a watcher. Here:

- The text is inside JSON lines (escaped `\n`, `\"`, `\u…`) next to tool
  output, base64 images and signatures. A line hit says nothing until the
  line is parsed; "render" matched 3,053 files with rg, mostly tool output.
- It scans per query (no content index), so it's ripgrep speed: about a
  second and a half over 4 GB, too slow per keystroke.
- It adds a native dependency to a host that ships as plain JS.
- Its strengths (path fuzzy, frecency, git status) don't apply to sessions.

### C in detail (measured with a throwaway script over the real Pi store)

| tokenizer | text stored | build | DB | "subscription lookup" | `render*` |
|---|---|---|---|---|---|
| unicode61 | yes | 12.5 s | 115 MB | 0.2 ms | 0.8 ms |
| trigram | no (contentless) | 18.1 s | 180 MB | 2.8 ms | 2.2 ms |

unicode61 matches words and word prefixes (`subscr*`), which is how people
search a history; trigram adds substrings inside words but is bigger,
slower to build, and can't match fewer than 3 characters. Storing the text
lets FTS5 return a snippet (where it matched) for the row.

## If full text is wanted: C

**One index, owned by the host core, fed by the adapters.**

- `host/sessions/index.ts`: `SessionIndex` over `<stateDir>/sessions.db`
  (WAL, `busy_timeout`), shared by every host of this install.
  - `sessions(id, provider, path UNIQUE, cwd, name, first, count, modified,
    size, mtime, offset)` and `text USING fts5(body, tokenize='unicode61
    remove_diacritics 2')`, rowid = session id.
  - `refresh(provider)`: stat the provider's files (21 ms for 2,599); a file
    that grew is read **from its stored offset** (the stores are
    append-only); one that shrank or whose header changed is read again.
    Newest first, in batches of transactions, yielding between files. One
    host refreshes at a time (a lease row: pid + heartbeat); the others
    query what's there.
  - `query({provider, scope, cwd, q, offset, limit})` → `{rows, total,
    indexing: {done, total} | null}`. No query: newest first. A query:
    tokens ANDed (the last one as a prefix while typing, `"phrases"`), tiers
    as Pi (name or first message → folder → message text → fuzzy on name and
    folder), newest first within a tier, a snippet for text hits.
- Adapters keep the format knowledge. Pi and Claude provide a file source:
  `files(scope)` and `extract(path, fromOffset) → {cwd?, name?, first?,
  count, text, offset}` (Pi's and Claude's current `describeSession` logic,
  made incremental). Codex has no file source: `thread/list` with
  `searchTerm`, `cwd` and `cursor`, so titles only, unless we choose to read
  its rollouts.
- Protocol: `sessions {scope, query?, offset?, limit?}` → `{sessions, total,
  indexing}`. The mod queries the host as you type (debounced ~100 ms,
  stale replies dropped by sequence), pages on scroll, shows "Indexing
  n/m…" while the first build runs, and a match snippet as the row detail.
- When to build: on the first /resume, not at host start. The first build
  is ~12 s of disk reading here; results fill in newest first meanwhile.

## Costs and open questions

1. **Node.** `node:sqlite` needs Node 22.13+ (unflagged there; it still
   prints an ExperimentalWarning on 22, which the host would silence). The
   release targets Node 20 today, which reached end of life in April 2026;
   Pi itself needs 22.19. Claude Code and Codex are native binaries, so a
   person using only those may still have Node 20. Bump `NODE_MIN` to 22.13,
   or fall back to E without full text when `node:sqlite` is missing.
2. **Disk.** ~115 MB for 4.1 GB of Pi sessions (2.8%). Capping each
   message's text (briefs and skill bodies arrive inline in user messages)
   or a contentless index (no snippets) would shrink it; not measured yet.
3. **Codex full text.** Titles via the app-server only, or also read the
   rollouts (an internal format, already read in `providers/codex/tui.ts`
   for the hand-off)?
4. **Deleted sessions.** A file that's gone drops out on the next refresh.
