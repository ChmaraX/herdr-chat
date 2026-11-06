// Syntax highlighting: highlight.js HTML → Span[][] with `syn:<token>` colors (protocol.md "Span").
import hljs from "highlight.js";
import type { Span } from "./ansi.ts";

export const MAX_LINES = 2000;
const AUTO_MAX_BYTES = 2048;
/** Auto-detection only tries these: faster, and fewer wrong guesses than all ~190 grammars (makefile and ini claim any `x = 1`). */
const AUTO_SUBSET = [
  "typescript", "javascript", "python", "bash", "shell", "json", "yaml", "rust", "go", "java", "c", "cpp", "csharp",
  "ruby", "php", "swift", "kotlin", "sql", "xml", "css", "scss", "markdown", "diff", "lua",
].filter((l) => hljs.getLanguage(l));

const TOKENS = new Set([
  "keyword", "string", "number", "literal", "function", "title", "type", "class", "comment", "variable", "attr", "property",
  "meta", "tag", "punctuation", "operator", "regexp", "symbol", "built_in", "params", "section", "bullet", "link",
  "emphasis", "strong", "addition", "deletion",
]);

/** hljs scopes outside the token list → the nearest token. null = plain (resets the outer scope, e.g. `${…}`). */
const ALIASES: Record<string, string | null> = {
  subst: null, doctag: "keyword", name: "tag", attribute: "attr", quote: "comment", code: "string", formula: "string",
  char: "string", "template-variable": "variable", "template-tag": "tag", "selector-tag": "tag", "selector-id": "class",
  "selector-class": "class", "selector-attr": "attr", "selector-pseudo": "keyword", "meta-keyword": "keyword",
  "meta-string": "string",
};

/** Scope classes of one `<span class="…">` → its token. undefined = inherit the outer one. */
function tokenOf(cls: string): string | null | undefined {
  const parts = cls.split(/\s+/);
  const main = parts.find((p) => p.startsWith("hljs-"))?.slice(5);
  // `title.function` is emitted as "hljs-title function_": the sub-scope is more specific.
  for (const p of parts) {
    const sub = /^([a-z_]+)_$/.exec(p)?.[1];
    if (sub && TOKENS.has(sub)) return sub;
    if (sub === "language") return "built_in";
  }
  if (!main) return undefined;
  if (TOKENS.has(main)) return main;
  if (main in ALIASES) return ALIASES[main];
  return undefined;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#x27": "'", "#39": "'" };
function unescape(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#x27|#39);/g, (_, e: string) => ENTITIES[e]!);
}

/** Parses hljs HTML output into lines of spans; the innermost scope wins. */
export function htmlToLines(html: string): Span[][] {
  const lines: Span[][] = [[]];
  const stack: (string | null)[] = [];
  const push = (text: string) => {
    let tok: string | null = null;
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i] !== undefined) {
        tok = stack[i]!;
        break;
      }
    }
    const parts = text.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (!part) return;
      const line = lines[lines.length - 1]!;
      const last = line[line.length - 1];
      const fg = tok ? `syn:${tok}` : undefined;
      if (last && last.fg === fg) last.text += part;
      else line.push(fg ? { text: part, fg } : { text: part });
    });
  };
  const re = /<span class="([^"]*)">|<\/span>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[1] !== undefined) stack.push(tokenOf(m[1]) as string | null);
    else if (m[0] === "</span>") stack.pop();
    else push(unescape(m[2]!));
  }
  return lines;
}

/** The hljs language for an info string or a file extension/name, or null. */
export function resolveLang(name: string | null | undefined): string | null {
  if (!name) return null;
  const n = name.trim().toLowerCase().replace(/^\{?\.?/, "").replace(/[}\s].*$/, "");
  if (!n) return null;
  return hljs.getLanguage(n) ? n : null; // getLanguage knows the aliases (ts, sh, py, …)
}

const EXT_LANG: Record<string, string> = { mjs: "javascript", cjs: "javascript", mts: "typescript", cts: "typescript", jsonl: "json", h: "c", hpp: "cpp", zsh: "bash", fish: "bash", toml: "ini", lock: "json" };
const NAME_LANG: Record<string, string> = { dockerfile: "dockerfile", makefile: "makefile", "cmakelists.txt": "cmake", gemfile: "ruby", rakefile: "ruby" };

/** The language for a file path, by extension (or a well-known file name). */
export function langForPath(path: string): string | null {
  const base = path.split("/").pop()?.toLowerCase() ?? "";
  if (NAME_LANG[base]) return NAME_LANG[base]!;
  const ext = /\.([a-z0-9+_-]+)$/.exec(base)?.[1];
  if (!ext) return null;
  return resolveLang(EXT_LANG[ext] ?? ext);
}

/** Plain lines, no colors. */
export function plainLines(code: string): Span[][] {
  return code.split("\n").map((l) => (l ? [{ text: l }] : []));
}

/**
 * Highlights `code` (at most MAX_LINES lines are returned). With no known
 * language, auto-detects when `auto` and the code is under 2 KB; else plain.
 */
export function highlight(code: string, lang: string | null, auto = true): { lines: Span[][]; lang: string | null } {
  const all = code.split("\n");
  const src = all.length > MAX_LINES ? all.slice(0, MAX_LINES).join("\n") : code;
  const language = resolveLang(lang);
  try {
    if (language) return { lines: htmlToLines(hljs.highlight(src, { language, ignoreIllegals: true }).value), lang: language };
    if (auto && Buffer.byteLength(src) < AUTO_MAX_BYTES && src.trim()) {
      const r = hljs.highlightAuto(src, AUTO_SUBSET);
      if (r.language && r.relevance >= 3) return { lines: htmlToLines(r.value), lang: r.language };
    }
  } catch {
    // fall through to plain
  }
  return { lines: plainLines(src), lang: null };
}
