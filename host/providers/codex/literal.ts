// Reads a JavaScript literal (objects, arrays, strings, numbers, true, false,
// null) out of source text without running it: Codex's code mode writes a
// tool's arguments as JS, such as `tools.update_plan({plan: [...]})`.

const NOT_LITERAL = Symbol("not a literal");

const ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", 0: "\0" };

class Reader {
  private src: string;
  private i: number;

  constructor(src: string, at: number) {
    this.src = src;
    this.i = at;
  }

  value(): unknown {
    this.space();
    const c = this.src[this.i];
    if (c === "{") return this.object();
    if (c === "[") return this.array();
    if (c === '"' || c === "'" || c === "`") return this.string(c);
    const word = /^(?:true|false|null|-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(?![\w$])/.exec(this.src.slice(this.i, this.i + 64));
    if (!word) throw NOT_LITERAL;
    this.i += word[0].length;
    return JSON.parse(word[0]);
  }

  private object(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    this.i++;
    for (;;) {
      this.space();
      if (this.eat("}")) return out;
      const c = this.src[this.i];
      let key: string;
      if (c === '"' || c === "'") key = this.string(c);
      else {
        const m = /^[A-Za-z_$][\w$]*/.exec(this.src.slice(this.i, this.i + 256));
        if (!m) throw NOT_LITERAL;
        key = m[0];
        this.i += key.length;
      }
      this.space();
      if (!this.eat(":")) throw NOT_LITERAL;
      out[key] = this.value();
      this.space();
      if (this.eat("}")) return out;
      if (!this.eat(",")) throw NOT_LITERAL;
    }
  }

  private array(): unknown[] {
    const out: unknown[] = [];
    this.i++;
    for (;;) {
      this.space();
      if (this.eat("]")) return out;
      out.push(this.value());
      this.space();
      if (this.eat("]")) return out;
      if (!this.eat(",")) throw NOT_LITERAL;
    }
  }

  private string(quote: string): string {
    let out = "";
    for (this.i++; this.i < this.src.length; this.i++) {
      const c = this.src[this.i]!;
      if (c === quote) {
        this.i++;
        return out;
      }
      if (quote === "`" && c === "$" && this.src[this.i + 1] === "{") throw NOT_LITERAL;
      if (c !== "\\") {
        out += c;
        continue;
      }
      const e = this.src[++this.i] ?? "";
      if (e === "\n") continue;
      if (e === "x" || e === "u") {
        const m = e === "x" ? /^[0-9a-fA-F]{2}/.exec(this.src.slice(this.i + 1, this.i + 3)) : /^(?:[0-9a-fA-F]{4}|\{[0-9a-fA-F]+\})/.exec(this.src.slice(this.i + 1, this.i + 12));
        const code = m ? parseInt(m[0].replace(/[{}]/g, ""), 16) : NaN;
        if (!m || !(code <= 0x10ffff)) throw NOT_LITERAL;
        out += String.fromCodePoint(code);
        this.i += m[0].length;
        continue;
      }
      out += ESCAPES[e] ?? e;
    }
    throw NOT_LITERAL;
  }

  private space(): void {
    for (;;) {
      const m = /^(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)/.exec(this.src.slice(this.i, this.i + 4096));
      if (!m) return;
      this.i += m[0].length;
    }
  }

  private eat(c: string): boolean {
    if (this.src[this.i] !== c) return false;
    this.i++;
    return true;
  }
}

/** The literal argument of each call `<callee>(…)` in `src`, in source order. A call whose argument is anything else is left out. */
export function literalArgs(src: string, callee: string): unknown[] {
  const out: unknown[] = [];
  const open = `${callee}(`;
  for (let at = src.indexOf(open); at >= 0; at = src.indexOf(open, at + open.length)) {
    try {
      out.push(new Reader(src, at + open.length).value());
    } catch (e) {
      if (e !== NOT_LITERAL) throw e;
    }
  }
  return out;
}
