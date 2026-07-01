#!/usr/bin/env node
/** B8 — the gp-foundry CLI: init / build / validate / graph / explain. */
import { Command } from "commander";
import pc from "picocolors";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Diagnostic, RoleSpec } from "../ir/types.js";
import { compile, hasErrors } from "../index.js";
import { loadHarness } from "../config/load.js";
import { parseDot } from "../parser/parse.js";
import { parseRoleFrontmatter } from "../roles/role.js";
import { validate } from "../validate/validate.js";
import { modelCheck } from "../modelcheck/check.js";
import { renderDiagram } from "../diagram/render.js";

const program = new Command();
program.name("gp-foundry").description("Compile a DOT harness spec into GitHub Actions.").version("0.1.0");

/** Resolve a path inside the installed package (works in dev via tsx and when bundled/published). */
function pkgFile(rel: string): string {
  return fileURLToPath(new URL(`../../${rel}`, import.meta.url));
}

function emitJson(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

function printDiagnostics(diags: Diagnostic[]): void {
  for (const d of diags) {
    const tag =
      d.level === "error" ? pc.red("error") : d.level === "warning" ? pc.yellow("warn") : pc.blue("info");
    const where = d.where?.node ? pc.dim(` [${d.where.node}]`) : "";
    process.stderr.write(`${tag} ${pc.dim(d.code)}${where}  ${d.message}\n`);
    if (d.hint) process.stderr.write(`      ${pc.dim("hint: " + d.hint)}\n`);
  }
}

function resolvePaths(opts: { dot?: string; config?: string }): { dot: string; config?: string; base: string } {
  const dot = resolve(opts.dot ?? ".github/harness.dot");
  const base = dirname(dot);
  let config = opts.config ? resolve(opts.config) : undefined;
  if (!config) {
    for (const c of [join(base, "foundry.config.yaml"), join(base, "agents/foundry.config.yaml")]) {
      if (existsSync(c)) { config = c; break; }
    }
  }
  return { dot, config, base };
}

function loadRoles(ir: ReturnType<typeof loadHarness>["harness"], base: string): Map<string, RoleSpec> {
  const roles = new Map<string, RoleSpec>();
  for (const n of ir.nodes) {
    if (!n.files.role) continue;
    const p = join(base, n.files.role);
    if (existsSync(p)) {
      const spec = parseRoleFrontmatter(readFileSync(p, "utf8"));
      if (spec) roles.set(n.id, spec);
    }
  }
  return roles;
}

// The starter files init scaffolds, from the packaged templates. Role files are
// derived from the harness graph (one per referenced role) so init is self-consistent.
const INIT_FILES: [tpl: string, dest: string][] = [
  ["skill/templates/harness.dot", ".github/harness.dot"],
  ["skill/templates/foundry.config.yaml", ".github/agents/foundry.config.yaml"],
  ["skill/templates/scope.yaml", ".github/agents/scope.yaml"],
  ["skill/templates/policy-merge.yaml", ".github/agents/policy/merge.yaml"],
  ["skill/templates/communication.md", ".github/agents/communication.md"],
];

program
  .command("init")
  .description("Scaffold a starter harness (harness.dot + config + roles + scope + policy) into a repo")
  .option("--dir <path>", "target repo root", ".")
  .option("--force", "overwrite existing files")
  .option("--json", "machine-readable output")
  .action((opts) => {
    const root = resolve(opts.dir);
    const written: string[] = [];
    const skipped: string[] = [];
    const write = (dest: string, content: string) => {
      const d = join(root, dest);
      if (existsSync(d) && !opts.force) { skipped.push(dest); return; }
      mkdirSync(dirname(d), { recursive: true });
      writeFileSync(d, content);
      written.push(dest);
    };
    for (const [tpl, dest] of INIT_FILES) write(dest, readFileSync(pkgFile(tpl), "utf8"));
    // Scaffold one starter role file per role the harness references (paths are
    // relative to the harness.dot dir, i.e. .github/).
    const dotPath = join(root, ".github/harness.dot");
    if (existsSync(dotPath)) {
      const roleTpl = readFileSync(pkgFile("skill/templates/role.md"), "utf8");
      for (const n of parseDot(readFileSync(dotPath, "utf8")).nodes) {
        if (n.files.role) write(join(".github", n.files.role), roleTpl);
      }
    }
    if (opts.json) return emitJson({ written, skipped });
    for (const w of written) process.stdout.write(pc.green(`created ${w}\n`));
    for (const s of skipped) process.stderr.write(pc.yellow(`skipped ${s} (exists; --force to overwrite)\n`));
    process.stdout.write(
      pc.dim("\nNext: fill in .github/harness.dot + .github/agents/{foundry.config.yaml,roles/}, then run `gp-foundry build`.\n"),
    );
  });

program
  .command("build")
  .description("Compile harness.dot → .github/workflows/*.yml (+ HARNESS.md)")
  .option("--dot <path>", "path to harness.dot")
  .option("--config <path>", "path to foundry.config.yaml")
  .option("--out <dir>", "output repo root (default: dir of harness.dot)")
  .option("--check", "verify generated files are in sync; exit 1 on drift")
  .option("--dry-run", "print what would be written; do not write")
  .option("--force", "write even if there are error diagnostics")
  .option("--json", "machine-readable output")
  .action((opts) => {
    const { dot, config, base } = resolvePaths(opts);
    if (!existsSync(dot)) {
      if (opts.json) emitJson({ error: `no harness.dot at ${dot}` });
      else process.stderr.write(pc.red(`no harness.dot at ${dot}\n`));
      process.exit(1);
    }
    const { harness, parseErrors } = loadHarness(dot, config);
    if (parseErrors.length) {
      if (opts.json) emitJson({ parseErrors });
      else for (const e of parseErrors) process.stderr.write(pc.red(`parse: ${e.message}${e.line ? ` (line ${e.line})` : ""}\n`));
      process.exit(1);
    }
    const out = resolve(opts.out ?? base);
    const specDir = relative(out, base).replace(/\\/g, "/");
    const { files, diagnostics } = compile(harness, {}, { specDir });
    if (!opts.json) printDiagnostics(diagnostics);

    if (opts.check) {
      const drift = files.filter((f) => {
        const p = join(out, f.path);
        return (existsSync(p) ? readFileSync(p, "utf8") : null) !== f.contents;
      });
      if (opts.json) emitJson({ upToDate: drift.length === 0, drift: drift.map((f) => f.path), diagnostics });
      else if (drift.length) {
        for (const f of drift) process.stderr.write(pc.yellow(`drift: ${f.path}\n`));
        process.stderr.write(pc.red("generated files are out of date — run `gp-foundry build`\n"));
      } else process.stdout.write(pc.green("up to date\n"));
      process.exit(drift.length ? 1 : 0);
    }

    if (hasErrors(diagnostics) && !opts.force) {
      if (opts.json) emitJson({ ok: false, diagnostics, wrote: [] });
      else process.stderr.write(pc.red("errors present — not writing (use --force to override)\n"));
      process.exit(1);
    }

    if (opts.dryRun) {
      if (opts.json) emitJson({ diagnostics, files });
      else for (const f of files) process.stdout.write(pc.cyan(`--- ${f.path}\n`) + f.contents + "\n");
      return;
    }

    for (const f of files) {
      const p = join(out, f.path);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, f.contents);
      if (!opts.json) process.stdout.write(pc.green(`wrote ${f.path}\n`));
    }
    if (opts.json) emitJson({ ok: !hasErrors(diagnostics), diagnostics, wrote: files.map((f) => f.path) });
  });

program
  .command("validate")
  .description("Validate the harness (structural + files + role handoffs + topology)")
  .option("--dot <path>", "path to harness.dot")
  .option("--config <path>", "path to foundry.config.yaml")
  .option("--json", "machine-readable output")
  .action((opts) => {
    const { dot, config, base } = resolvePaths(opts);
    const { harness, parseErrors } = loadHarness(dot, config);
    const fileExists = (rel: string) => existsSync(join(base, rel));
    const roles = loadRoles(harness, base);
    const diagnostics = [...validate(harness, { fileExists, roles }), ...modelCheck(harness)];
    const failed = diagnostics.some((d) => d.level === "error") || parseErrors.length > 0;
    if (opts.json) emitJson({ ok: !failed, parseErrors, diagnostics });
    else {
      for (const e of parseErrors) process.stderr.write(pc.red(`parse: ${e.message}\n`));
      printDiagnostics(diagnostics);
    }
    process.exit(failed ? 1 : 0);
  });

program
  .command("graph")
  .description("Print the harness topology (Mermaid, or --json for the IR)")
  .option("--dot <path>", "path to harness.dot")
  .option("--json", "output the parsed nodes/edges as JSON")
  .action((opts) => {
    const { dot } = resolvePaths(opts);
    const { harness } = loadHarness(dot);
    if (opts.json) emitJson({ name: harness.name, nodes: harness.nodes, edges: harness.edges });
    else process.stdout.write(renderDiagram(harness) + "\n");
  });

program
  .command("explain <node>")
  .description("Show the workflow a single node compiles to")
  .option("--dot <path>", "path to harness.dot")
  .option("--config <path>", "path to foundry.config.yaml")
  .option("--json", "machine-readable output")
  .action((node: string, opts) => {
    const { dot, config } = resolvePaths(opts);
    const { harness } = loadHarness(dot, config);
    const { files } = compile(harness);
    const f = files.find((x) => x.path.endsWith(`/${node}.yml`));
    if (!f) {
      if (opts.json) emitJson({ error: `no generated workflow for node '${node}'` });
      else process.stderr.write(pc.red(`no generated workflow for node '${node}'\n`));
      process.exit(1);
    }
    if (opts.json) emitJson({ node, path: f.path, contents: f.contents });
    else process.stdout.write(f.contents + "\n");
  });

program.parseAsync(process.argv);
