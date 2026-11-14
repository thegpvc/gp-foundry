/** Shared CLI helpers (kept out of index.ts so ops.ts can use them without cycles). */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pc from "picocolors";
import type { Diagnostic, GeneratedFile } from "../ir/types.js";
import { GENERATED_MARKER } from "../assemble/assemble.js";

/**
 * Generated workflows on disk that the current graph no longer produces — a
 * lane that was removed, a guard that no longer applies. Left in place they keep
 * RUNNING: GitHub executes whatever is in .github/workflows/, not what the spec
 * says. Only files carrying the generated header are ever returned, so a
 * hand-written workflow is never touched. Paths are repo-relative.
 */
export function staleGeneratedWorkflows(root: string, files: GeneratedFile[]): string[] {
  const dir = join(root, ".github", "workflows");
  if (!existsSync(dir)) return [];
  const current = new Set(files.map((f) => f.path));
  return readdirSync(dir)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => `.github/workflows/${name}`)
    .filter((rel) => !current.has(rel))
    .filter((rel) => readFileSync(join(root, rel), "utf8").startsWith(GENERATED_MARKER))
    .sort();
}

/** Resolve a path inside the installed package (works in dev via tsx and when bundled/published). */
export function pkgFile(rel: string): string {
  return fileURLToPath(new URL(`../../${rel}`, import.meta.url));
}

export function emitJson(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

export function printDiagnostics(diags: Diagnostic[]): void {
  for (const d of diags) {
    const tag =
      d.level === "error" ? pc.red("error") : d.level === "warning" ? pc.yellow("warn") : pc.blue("info");
    const where = d.where?.node ? pc.dim(` [${d.where.node}]`) : "";
    process.stderr.write(`${tag} ${pc.dim(d.code)}${where}  ${d.message}\n`);
    if (d.hint) process.stderr.write(`      ${pc.dim("hint: " + d.hint)}\n`);
  }
}

export interface ResolvedPaths {
  dot: string;
  config?: string;
  /** dir containing harness.dot (usually .github/) — spec-relative paths resolve from here */
  base: string;
  /** the repo root — where generated ".github/..." paths land */
  root: string;
}

export function resolvePaths(opts: { dot?: string; config?: string }): ResolvedPaths {
  const dot = resolve(opts.dot ?? ".github/harness.dot");
  const base = dirname(dot);
  let config = opts.config ? resolve(opts.config) : undefined;
  if (!config) {
    for (const c of [join(base, "foundry.config.yaml"), join(base, "agents/foundry.config.yaml")]) {
      if (existsSync(c)) { config = c; break; }
    }
  }
  // Generated file paths start with ".github/", so the default output root is the
  // REPO root: when harness.dot lives under .github/, that's .github's parent.
  // (Emitting relative to `base` would write .github/.github/workflows/ — dead files.)
  const root = base.endsWith(".github") ? dirname(base) : base;
  return { dot, config, base, root };
}
