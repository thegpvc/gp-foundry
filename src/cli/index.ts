#!/usr/bin/env node
/** B8 — the gp-foundry CLI: init / build / validate / graph / explain. */
import { Command } from "commander";
import pc from "picocolors";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { Diagnostic, RoleSpec } from "../ir/types.js";
import { compile, hasErrors } from "../index.js";
import { loadHarness } from "../config/load.js";
import { parseRoleFrontmatter } from "../roles/role.js";
import { validate } from "../validate/validate.js";
import { modelCheck } from "../modelcheck/check.js";
import { renderDiagram } from "../diagram/render.js";

const program = new Command();
program.name("gp-foundry").description("Compile a DOT harness spec into GitHub Actions.").version("0.0.0");

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

program
  .command("build")
  .description("Compile harness.dot → .github/workflows/*.yml (+ HARNESS.md)")
  .option("--dot <path>", "path to harness.dot")
  .option("--config <path>", "path to foundry.config.yaml")
  .option("--out <dir>", "output repo root (default: dir of harness.dot)")
  .option("--check", "verify generated files are in sync; exit 1 on drift")
  .option("--dry-run", "print what would be written; do not write")
  .option("--force", "write even if there are error diagnostics")
  .action((opts) => {
    const { dot, config, base } = resolvePaths(opts);
    if (!existsSync(dot)) { process.stderr.write(pc.red(`no harness.dot at ${dot}\n`)); process.exit(1); }
    const { harness, parseErrors } = loadHarness(dot, config);
    if (parseErrors.length) {
      for (const e of parseErrors) process.stderr.write(pc.red(`parse: ${e.message}${e.line ? ` (line ${e.line})` : ""}\n`));
      process.exit(1);
    }
    const out = resolve(opts.out ?? base);
    const specDir = relative(out, base).replace(/\\/g, "/");
    const { files, diagnostics } = compile(harness, {}, { specDir });
    printDiagnostics(diagnostics);

    if (opts.check) {
      let drift = false;
      for (const f of files) {
        const p = join(out, f.path);
        const cur = existsSync(p) ? readFileSync(p, "utf8") : null;
        if (cur !== f.contents) { drift = true; process.stderr.write(pc.yellow(`drift: ${f.path}\n`)); }
      }
      if (drift) { process.stderr.write(pc.red("generated files are out of date — run `gp-foundry build`\n")); process.exit(1); }
      process.stdout.write(pc.green("up to date\n"));
      return;
    }

    if (hasErrors(diagnostics) && !opts.force) {
      process.stderr.write(pc.red("errors present — not writing (use --force to override)\n"));
      process.exit(1);
    }

    if (opts.dryRun) {
      for (const f of files) process.stdout.write(pc.cyan(`--- ${f.path}\n`) + f.contents + "\n");
      return;
    }

    for (const f of files) {
      const p = join(out, f.path);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, f.contents);
      process.stdout.write(pc.green(`wrote ${f.path}\n`));
    }
  });

program
  .command("validate")
  .description("Validate the harness (structural + files + role handoffs + topology)")
  .option("--dot <path>", "path to harness.dot")
  .option("--config <path>", "path to foundry.config.yaml")
  .action((opts) => {
    const { dot, config, base } = resolvePaths(opts);
    const { harness, parseErrors } = loadHarness(dot, config);
    for (const e of parseErrors) process.stderr.write(pc.red(`parse: ${e.message}\n`));
    const fileExists = (rel: string) => existsSync(join(base, rel));
    const roles = loadRoles(harness, base);
    const diags = [...validate(harness, { fileExists, roles }), ...modelCheck(harness)];
    printDiagnostics(diags);
    process.exit(diags.some((d: Diagnostic) => d.level === "error") || parseErrors.length ? 1 : 0);
  });

program
  .command("graph")
  .description("Print the harness as a Mermaid diagram")
  .option("--dot <path>", "path to harness.dot")
  .action((opts) => {
    const { dot } = resolvePaths(opts);
    const { harness } = loadHarness(dot);
    process.stdout.write(renderDiagram(harness) + "\n");
  });

program
  .command("explain <node>")
  .description("Show the workflow a single node compiles to")
  .option("--dot <path>", "path to harness.dot")
  .option("--config <path>", "path to foundry.config.yaml")
  .action((node: string, opts) => {
    const { dot, config } = resolvePaths(opts);
    const { harness } = loadHarness(dot, config);
    const { files } = compile(harness);
    const f = files.find((x) => x.path.endsWith(`/${node}.yml`));
    if (!f) { process.stderr.write(pc.red(`no generated workflow for node '${node}'\n`)); process.exit(1); }
    process.stdout.write(f.contents + "\n");
  });

program.parseAsync(process.argv);
