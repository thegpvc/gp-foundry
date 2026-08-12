/**
 * A tiny evaluator for the SUBSET of GitHub `if:` expressions the wiring compiler
 * emits: `a.b.c == 'x'`, `!=`, `contains(a.b, 'x')`, `startsWith(a.b, 'x')`,
 * `!expr`, grouping with `()`, joined by `||` / `&&`.
 * Used by the plumbing simulator to decide whether a compiled guard fires.
 *
 * Grouping is not a nicety: the branch-prefix guard wraps an OR of edge guards
 * (`(a || b) && startsWith(...)`), and a splitter that ignored parentheses would
 * read that as `a || (b && startsWith(...))` — passing a simulation that the
 * real workflow would fail.
 */
export type Ctx = Record<string, unknown>;

export function resolvePath(ctx: Ctx, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o == null ? undefined : (o as any)[k]), ctx);
}

// ── tokenizer ───────────────────────────────────────────────────────────────

type Token = { kind: "op" | "punct" | "str" | "ident"; value: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end === -1) throw new Error(`unterminated string in expression: ${src}`);
      tokens.push({ kind: "str", value: src.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === "&&" || two === "||" || two === "==" || two === "!=") {
      tokens.push({ kind: "op", value: two });
      i += 2;
      continue;
    }
    if (c === "(" || c === ")" || c === "," || c === "!") {
      tokens.push({ kind: "punct", value: c });
      i++;
      continue;
    }
    const ident = /^[A-Za-z0-9_.[\]*-]+/.exec(src.slice(i));
    if (ident) {
      tokens.push({ kind: "ident", value: ident[0] });
      i += ident[0].length;
      continue;
    }
    throw new Error(`unexpected character '${c}' in expression: ${src}`);
  }
  return tokens;
}

// ── parser / evaluator (recursive descent, evaluates as it parses) ──────────

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[], private readonly ctx: Ctx) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private eat(value: string): boolean {
    if (this.peek()?.value === value) {
      this.pos++;
      return true;
    }
    return false;
  }

  private expect(value: string): void {
    if (!this.eat(value)) throw new Error(`expected '${value}' in expression`);
  }

  /** expr := and ('||' and)* */
  parseExpr(): unknown {
    let left = this.parseAnd();
    while (this.eat("||")) {
      const right = this.parseAnd();
      left = truthy(left) || truthy(right);
    }
    return left;
  }

  /** and := cmp ('&&' cmp)* */
  private parseAnd(): unknown {
    let left = this.parseCmp();
    while (this.eat("&&")) {
      const right = this.parseCmp();
      left = truthy(left) && truthy(right);
    }
    return left;
  }

  /** cmp := unary (('=='|'!=') unary)? */
  private parseCmp(): unknown {
    const left = this.parseUnary();
    const op = this.peek();
    if (op?.kind === "op" && (op.value === "==" || op.value === "!=")) {
      this.pos++;
      const right = this.parseUnary();
      const equal = String(left ?? "") === String(right ?? "");
      return op.value === "==" ? equal : !equal;
    }
    return left;
  }

  /** unary := '!' unary | primary */
  private parseUnary(): unknown {
    if (this.eat("!")) return !truthy(this.parseUnary());
    return this.parsePrimary();
  }

  /** primary := '(' expr ')' | call | literal | path */
  private parsePrimary(): unknown {
    if (this.eat("(")) {
      const value = this.parseExpr();
      this.expect(")");
      return value;
    }
    const token = this.peek();
    if (!token) throw new Error("unexpected end of expression");
    this.pos++;
    if (token.kind === "str") return token.value;
    if (token.value === "true") return true;
    if (token.value === "false") return false;

    // A function call — `name()`, `name(arg)`, `name(arg, arg)`. The zero-arg
    // form is the one the step-level guards use (`always()`, `!cancelled()`).
    if (this.peek()?.value === "(") {
      this.pos++;
      const args: unknown[] = [];
      if (this.peek()?.value !== ")") {
        args.push(this.parseExpr());
        while (this.eat(",")) args.push(this.parseExpr());
      }
      this.expect(")");
      return applyFunction(token.value, args);
    }
    return resolvePath(this.ctx, token.value);
  }
}

function truthy(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v !== "";
  if (typeof v === "number") return v !== 0;
  return true;
}

function applyFunction(name: string, args: unknown[]): unknown {
  const [a, b] = args;
  switch (name) {
    case "contains":
      return Array.isArray(a) ? a.map(String).includes(String(b)) : String(a ?? "").includes(String(b ?? ""));
    case "startsWith":
      return String(a ?? "").startsWith(String(b ?? ""));
    case "endsWith":
      return String(a ?? "").endsWith(String(b ?? ""));
    case "always":
      return true;
    case "cancelled":
    case "failure":
      return false;
    case "success":
      return true;
    default:
      throw new Error(`unsupported function '${name}' in expression`);
  }
}

export function evalGuard(expr: string | undefined, ctx: Ctx): boolean {
  if (!expr) return true;
  return truthy(new Parser(tokenize(expr), ctx).parseExpr());
}
