#!/usr/bin/env node
/** B8 — the gp-foundry CLI: init / build / validate / graph / explain. */
import { Command } from "commander";
import pc from "picocolors";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { RoleSpec } from "../ir/types.js";
import { compile, hasErrors } from "../index.js";
import { loadHarness } from "../config/load.js";
import { parseDot } from "../parser/parse.js";
import { parseRoleFrontmatter } from "../roles/role.js";
import { validate } from "../validate/validate.js";
import { modelCheck } from "../modelcheck/check.js";
import { renderDiagram } from "../diagram/render.js";
import { emitJson, pkgFile, printDiagnostics, resolvePaths } from "./common.js";
import { registerOpsCommands } from "./ops.js";

const program = new Command();
program.name("gp-foundry").description("Compile a DOT harness spec into GitHub Actions.").version("0.1.0");

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
  // Every agent job runs `uses: ./.github/agent-setup` — the consumer-owned
  // toolchain shim. Scaffolding it is what makes a fresh init runnable.
  ["skill/templates/agent-setup.yml", ".github/agent-setup/action.yml"],
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
    // A factory that targets a branch the repo doesn't have (main vs master/trunk)
    // fails only at runtime — detect the actual branch and scaffold with it.
    let baseBranch = "main";
    try {
      const b = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
      if (b) baseBranch = b;
    } catch { /* not a git repo yet — keep main */ }
    for (const [tpl, dest] of INIT_FILES) {
      let content = readFileSync(pkgFile(tpl), "utf8");
      if (dest.endsWith("foundry.config.yaml") && baseBranch !== "main") {
        content = content.replace(/^(\s*base_branch:\s*)main\b/m, `$1${baseBranch}`);
      }
      write(dest, content);
    }
    // Scaffold one starter role file per role the harness references (paths are
    // relative to the harness.dot dir, i.e. .github/).
    const dotPath = join(root, ".github/harness.dot");
    if (existsSync(dotPath)) {
      for (const n of parseDot(readFileSync(dotPath, "utf8")).nodes) {
        if (!n.files.role) continue;
        // Prefer a ready-made software-pack role of the same name; else the generic template.
        const roleName = n.files.role.replace(/^.*\//, "").replace(/\.md$/, "");
        const packPath = pkgFile(`roles/software/${roleName}.md`);
        const src = existsSync(packPath) ? packPath : pkgFile("skill/templates/role.md");
        write(join(".github", n.files.role), readFileSync(src, "utf8"));
      }
    }
    if (opts.json) return emitJson({ written, skipped });
    for (const w of written) process.stdout.write(pc.green(`created ${w}\n`));
    for (const s of skipped) process.stderr.write(pc.yellow(`skipped ${s} (exists; --force to overwrite)\n`));
    process.stdout.write(
      [
        "",
        pc.bold("Next steps — dark factory in 4 moves:"),
        `  1. ${pc.cyan("gp-foundry up")}          vendor actions, create labels, build workflows, run checks`,
        `  2. set two secrets:       ${pc.cyan("gh secret set CLAUDE_CODE_OAUTH_TOKEN")} (agent auth)`,
        `                            ${pc.cyan("gh secret set AGENT_PAT")} (fine-grained PAT: contents/PRs/issues RW)`,
        `  3. commit + push ${pc.cyan(".github/")}`,
        `  4. file an issue → the 🕵️ scout triages it and the factory takes it from there`,
        "",
        pc.dim("Tune later: .github/harness.dot (topology) · agents/roles/*.md (behavior) · agents/policy/merge.yaml (merge rules)"),
        "",
      ].join("\n"),
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
    const { dot, config, base, root } = resolvePaths(opts);
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
    const out = resolve(opts.out ?? root);
    const specDir = relative(out, base).replace(/\\/g, "/");
    const fileExists = (rel: string) => existsSync(join(base, rel));
    const { files, diagnostics } = compile(harness, { fileExists }, { specDir });
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
    if (!existsSync(dot)) {
      if (opts.json) emitJson({ ok: false, error: `no harness.dot at ${dot}` });
      else process.stderr.write(pc.red(`no harness.dot at ${dot} — run \`gp-foundry init\` first\n`));
      process.exit(1);
    }
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
    if (!existsSync(dot)) {
      // A clean, machine-readable "no harness" signal — orientation probes rely on it.
      if (opts.json) emitJson({ error: `no harness.dot at ${dot}` });
      else process.stderr.write(pc.red(`no harness.dot at ${dot} — run \`gp-foundry init\` first\n`));
      process.exit(1);
    }
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
    if (!existsSync(dot)) {
      if (opts.json) emitJson({ error: `no harness.dot at ${dot}` });
      else process.stderr.write(pc.red(`no harness.dot at ${dot} — run \`gp-foundry init\` first\n`));
      process.exit(1);
    }
    const { harness } = loadHarness(dot, config);
    const { files } = compile(harness);
    // Diamond legs ride inside their fan_in's workflow — fall back to the file
    // whose jobs: block contains this node id.
    const f =
      files.find((x) => x.path.endsWith(`/${node}.yml`)) ??
      files.find((x) => x.path.startsWith(".github/workflows/") && new RegExp(`^  ${node}:`, "m").test(x.contents));
    if (!f) {
      if (opts.json) emitJson({ error: `no generated workflow for node '${node}'` });
      else process.stderr.write(pc.red(`no generated workflow for node '${node}'\n`));
      process.exit(1);
    }
    if (opts.json) emitJson({ node, path: f.path, contents: f.contents });
    else process.stdout.write(f.contents + "\n");
  });

registerOpsCommands(program);

program.parseAsync(process.argv);
