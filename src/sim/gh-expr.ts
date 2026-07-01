/**
 * A tiny evaluator for the SUBSET of GitHub `if:` expressions the wiring compiler
 * emits: `a.b.c == 'x'`, `!=`, `contains(a.b, 'x')`, joined by `||` / `&&`.
 * Used by the plumbing simulator to decide whether a compiled guard fires.
 */
export type Ctx = Record<string, unknown>;

export function resolvePath(ctx: Ctx, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o == null ? undefined : (o as any)[k]), ctx);
}

function evalCmp(s: string, ctx: Ctx): boolean {
  const t = s.trim();
  const eq = /^(.+?)\s*(==|!=)\s*'([^']*)'$/.exec(t);
  if (eq) {
    const lhs = resolvePath(ctx, eq[1]!.trim());
    return eq[2] === "==" ? String(lhs) === eq[3] : String(lhs) !== eq[3];
  }
  const con = /^contains\((.+?),\s*'([^']*)'\)$/.exec(t);
  if (con) {
    const v = resolvePath(ctx, con[1]!.trim());
    return Array.isArray(v) ? v.includes(con[2]) : String(v).includes(con[2]!);
  }
  if (t === "true") return true;
  if (t === "false") return false;
  return false;
}

export function evalGuard(expr: string | undefined, ctx: Ctx): boolean {
  if (!expr) return true;
  return expr.split("||").some((or) => or.split("&&").every((and) => evalCmp(and, ctx)));
}
