/**
 * Ops-layer CLI commands — the "dark factory" bring-up and day-2 surface:
 *
 *   vendor — copy the packaged runtime actions into .github/actions/ (self-contained repo)
 *   up     — labels + vendor + build + doctor: one command from init to runnable factory
 *   doctor — preflight: everything that must be true before the factory can run
 *   status — the operator dashboard: what's in flight, what's stuck, what failed
 *
 * Everything gh-dependent degrades to a "skip" with a hint when gh is missing or
 * unauthenticated — the local (offline) checks still run.
 */
import type { Command } from "commander";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import pc from "picocolors";
import { compile, hasErrors } from "../index.js";
import { loadHarness } from "../config/load.js";
import { emitJson, pkgFile, resolvePaths } from "./common.js";
import { relative } from "node:path";

// ── small helpers ─────────────────────────────────────────────────────────────

function gh(args: string[], opts: { cwd?: string } = {}): { ok: boolean; out: string } {
  try {
    const out = execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], cwd: opts.cwd });
    return { ok: true, out: out.trim() };
  } catch (e) {
    return { ok: false, out: (e as { stderr?: string; message?: string }).stderr?.toString().trim() ?? String((e as Error).message) };
  }
}

function ghJson<T>(args: string[], cwd?: string): T | null {
  const r = gh(args, { cwd });
  if (!r.ok) return null;
  try { return JSON.parse(r.out) as T; } catch { return null; }
}

/** The runtime actions a harness may reference (everything the package ships). */
function packagedActions(): string[] {
  const dir = pkgFile("actions");
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "action.yml")))
    .map((d) => d.name);
}

/** Labels the factory needs: semantic lane labels (resolved) + gate/ops labels. */
function requiredLabels(configPath: string | undefined, dotDir: string): { name: string; description: string; color: string }[] {
  const { harness } = loadHarness(join(dotDir, "harness.dot"), configPath);
  const semantic = new Map<string, string>([
    ["build", "ready to implement"],
    ["plan", "needs design first"],
  ]);
  const labels: { name: string; description: string; color: string }[] = [];
  for (const [key, desc] of semantic) {
    labels.push({ name: harness.config.labels?.[key] ?? key, description: desc, color: key === "build" ? "0e8a16" : "5319e7" });
  }
  labels.push({ name: "needs-human", description: "agents are blocked; a human should take over", color: "b60205" });
  labels.push({ name: "needs-rebase", description: "PR conflicts with base; the janitor sweep rebases it", color: "d93f0b" });
  return labels;
}

interface Check {
  name: string;
  status: "ok" | "warn" | "fail" | "skip";
  detail: string;
  hint?: string;
}

function printChecks(checks: Check[]): void {
  const icon = { ok: pc.green("✓"), warn: pc.yellow("!"), fail: pc.red("✗"), skip: pc.dim("-") };
  for (const c of checks) {
    process.stdout.write(`${icon[c.status]} ${c.name.padEnd(28)} ${c.detail}\n`);
    if (c.hint && c.status !== "ok") process.stdout.write(`  ${pc.dim("hint: " + c.hint)}\n`);
  }
}

// ── vendor ────────────────────────────────────────────────────────────────────

export function vendorInto(root: string): string[] {
  const written: string[] = [];
  for (const name of packagedActions()) {
    const src = pkgFile(`actions/${name}`);
    const dest = join(root, ".github/actions", name);
    mkdirSync(dest, { recursive: true });
    cpSync(join(src, "action.yml"), join(dest, "action.yml"));
    if (existsSync(join(src, "dist"))) cpSync(join(src, "dist"), join(dest, "dist"), { recursive: true });
    written.push(`.github/actions/${name}/`);
  }
  // The consumer-owned toolchain shim every agent job runs. Scaffold if absent (never overwrite).
  const shim = join(root, ".github/agent-setup/action.yml");
  if (!existsSync(shim)) {
    mkdirSync(dirname(shim), { recursive: true });
    writeFileSync(shim, readFileSync(pkgFile("skill/templates/agent-setup.yml"), "utf8"));
    written.push(".github/agent-setup/action.yml");
  }
  return written;
}

// ── doctor ────────────────────────────────────────────────────────────────────

export function runDoctor(opts: { dot?: string; config?: string }): { checks: Check[]; failed: boolean } {
  const checks: Check[] = [];
  const { dot, config, base, root } = resolvePaths(opts);

  // 1. harness + validate (includes placeholder + vendored-action checks)
  if (!existsSync(dot)) {
    checks.push({ name: "harness", status: "fail", detail: `no harness.dot at ${dot}`, hint: "run `gp-foundry init`" });
    return { checks, failed: true };
  }
  const { harness, parseErrors } = loadHarness(dot, config);
  const fileExists = (rel: string) => existsSync(join(base, rel));
  const specDir = relative(root, base).replace(/\\/g, "/");
  const { files, diagnostics } = compile(harness, { fileExists }, { specDir });
  const errs = diagnostics.filter((d) => d.level === "error").length + parseErrors.length;
  const warns = diagnostics.filter((d) => d.level === "warning");
  checks.push(
    errs
      ? { name: "validate", status: "fail", detail: `${errs} error(s)`, hint: "run `gp-foundry validate` for details" }
      : { name: "validate", status: warns.length ? "warn" : "ok", detail: warns.length ? `${warns.length} warning(s): ${warns.map((w) => w.code).join(", ")}` : "no diagnostics" },
  );

  // 2. drift: generated files on disk match a fresh compile
  const drift = files.filter((f) => {
    const p = join(root, f.path);
    return (existsSync(p) ? readFileSync(p, "utf8") : null) !== f.contents;
  });
  checks.push(
    drift.length
      ? { name: "workflows in sync", status: "fail", detail: `${drift.length} file(s) drifted: ${drift.slice(0, 3).map((f) => f.path).join(", ")}${drift.length > 3 ? ", …" : ""}`, hint: "run `gp-foundry build`" }
      : { name: "workflows in sync", status: "ok", detail: `${files.length} generated files match` },
  );

  // 3. vendored runtime present (validate already warns; make it a first-class check)
  if ((harness.config.runtime?.mode ?? "pinned") === "vendored") {
    const missing = packagedActions().filter((n) => !existsSync(join(root, ".github/actions", n, "action.yml")));
    checks.push(
      missing.length
        ? { name: "vendored actions", status: "fail", detail: `missing: ${missing.join(", ")}`, hint: "run `gp-foundry vendor`" }
        : { name: "vendored actions", status: "ok", detail: "all runtime actions vendored" },
    );
  }
  checks.push(
    existsSync(join(root, ".github/agent-setup/action.yml"))
      ? { name: "agent-setup shim", status: "ok", detail: ".github/agent-setup/action.yml present" }
      : { name: "agent-setup shim", status: "fail", detail: "missing — every agent job needs it", hint: "run `gp-foundry vendor` (or `init`)" },
  );

  // 4. gh + repo-side checks (best-effort; skip cleanly when gh is unavailable)
  const auth = gh(["auth", "status"]);
  if (!auth.ok) {
    checks.push({ name: "gh cli", status: "skip", detail: "gh missing or unauthenticated — skipping repo checks", hint: "install GitHub CLI and `gh auth login`" });
    return { checks, failed: checks.some((c) => c.status === "fail") };
  }
  checks.push({ name: "gh cli", status: "ok", detail: "authenticated" });

  const repo = ghJson<{ nameWithOwner: string }>(["repo", "view", "--json", "nameWithOwner"], root);
  if (!repo) {
    checks.push({ name: "github repo", status: "skip", detail: "not a GitHub repo (or no remote) — skipping labels/secrets checks", hint: "create it with `gh repo create`" });
    return { checks, failed: checks.some((c) => c.status === "fail") };
  }
  checks.push({ name: "github repo", status: "ok", detail: repo.nameWithOwner });

  const have = new Set((ghJson<{ name: string }[]>(["label", "list", "--json", "name", "--limit", "100"], root) ?? []).map((l) => l.name));
  const need = requiredLabels(config, base).map((l) => l.name);
  const missingLabels = need.filter((n) => !have.has(n));
  checks.push(
    missingLabels.length
      ? { name: "labels", status: "fail", detail: `missing: ${missingLabels.join(", ")}`, hint: "run `gp-foundry up` to create them" }
      : { name: "labels", status: "ok", detail: need.join(", ") },
  );

  const secretNames = new Set((ghJson<{ name: string }[]>(["secret", "list", "--json", "name"], root) ?? []).map((s) => s.name));
  const needSecrets = [harness.config.agent.oauth_token_secret ?? "CLAUDE_CODE_OAUTH_TOKEN"];
  const authCfg = harness.config.auth;
  if (authCfg?.mode === "pat" && authCfg.token_secret) needSecrets.push(authCfg.token_secret);
  if (authCfg?.mode === "app") needSecrets.push(authCfg.app_id_secret ?? "APP_ID", authCfg.app_key_secret ?? "APP_PRIVATE_KEY");
  const missingSecrets = needSecrets.filter((s) => !secretNames.has(s));
  checks.push(
    missingSecrets.length
      ? { name: "secrets", status: "fail", detail: `missing: ${missingSecrets.join(", ")}`, hint: `gh secret set ${missingSecrets[0]}` }
      : { name: "secrets", status: "ok", detail: needSecrets.join(", ") },
  );

  // 5. workflows committed? (uncommitted generated files never run on GitHub)
  const porcelain = gh(["--version"]); // gh exists; use git directly for this one
  void porcelain;
  try {
    const untracked = execFileSync("git", ["status", "--porcelain", ".github"], { cwd: root, encoding: "utf8" }).trim();
    checks.push(
      untracked
        ? { name: "committed", status: "warn", detail: ".github/ has uncommitted changes", hint: "commit + push so GitHub picks them up" }
        : { name: "committed", status: "ok", detail: ".github/ clean" },
    );
  } catch {
    checks.push({ name: "committed", status: "skip", detail: "not a git repo" });
  }

  return { checks, failed: checks.some((c) => c.status === "fail") };
}

// ── status ────────────────────────────────────────────────────────────────────

interface StatusReport {
  repo?: string;
  lanes: Record<string, { number: number; title: string; ageHours: number }[]>;
  prs: { number: number; title: string; labels: string[]; mergeable?: string; headRefName: string }[];
  stalled: { kind: string; number: number; title: string; detail: string }[];
  recentFailures: { workflow: string; url: string; ageHours: number }[];
}

export function runStatus(opts: { dot?: string; config?: string }): StatusReport | { error: string } {
  const { config, base, root } = resolvePaths(opts);
  if (!gh(["auth", "status"]).ok) return { error: "gh missing or unauthenticated — status needs the GitHub CLI" };
  const repo = ghJson<{ nameWithOwner: string }>(["repo", "view", "--json", "nameWithOwner"], root);
  if (!repo) return { error: "not a GitHub repo (or no remote)" };

  const { harness } = loadHarness(join(base, "harness.dot"), config);
  const prefix = harness.config.repo.branch_prefix;
  const now = Date.now();
  const hoursAgo = (iso: string) => Math.round((now - Date.parse(iso)) / 36e5);

  const lanes: StatusReport["lanes"] = {};
  for (const key of ["plan", "build", "needs-human"]) {
    const label = key === "needs-human" ? "needs-human" : (harness.config.labels?.[key] ?? key);
    const issues = ghJson<{ number: number; title: string; createdAt: string }[]>(
      ["issue", "list", "--label", label, "--state", "open", "--json", "number,title,createdAt", "--limit", "50"], root) ?? [];
    lanes[label] = issues.map((i) => ({ number: i.number, title: i.title, ageHours: hoursAgo(i.createdAt) }));
  }

  const allPrs = ghJson<{ number: number; title: string; labels: { name: string }[]; mergeable: string; headRefName: string; body: string; updatedAt: string }[]>(
    ["pr", "list", "--state", "open", "--json", "number,title,labels,mergeable,headRefName,body,updatedAt", "--limit", "50"], root) ?? [];
  const agentPrs = allPrs.filter((p) => p.headRefName.startsWith(prefix));

  // stalled heuristics
  const stalled: StatusReport["stalled"] = [];
  const closedBy = new Set<number>();
  for (const p of agentPrs) for (const m of p.body?.matchAll(/[Cc]loses #(\d+)/g) ?? []) closedBy.add(Number(m[1]));
  const buildLabel = harness.config.labels?.build ?? "build";
  for (const i of lanes[buildLabel] ?? []) {
    if (!closedBy.has(i.number) && i.ageHours >= 2) {
      stalled.push({ kind: "issue-no-pr", number: i.number, title: i.title, detail: `labeled ${buildLabel} ${i.ageHours}h ago, no open PR closes it` });
    }
  }
  for (const p of agentPrs) {
    if (p.updatedAt && hoursAgo(p.updatedAt) >= 4) {
      stalled.push({ kind: "pr-idle", number: p.number, title: p.title, detail: `no activity for ${hoursAgo(p.updatedAt)}h` });
    }
  }

  const failures = (ghJson<{ name: string; url: string; createdAt: string; conclusion: string }[]>(
    ["run", "list", "--status", "failure", "--limit", "15", "--json", "name,url,createdAt,conclusion"], root) ?? [])
    .filter((r) => hoursAgo(r.createdAt) <= 24)
    .map((r) => ({ workflow: r.name, url: r.url, ageHours: hoursAgo(r.createdAt) }));

  return {
    repo: repo.nameWithOwner,
    lanes,
    prs: agentPrs.map((p) => ({ number: p.number, title: p.title, labels: p.labels.map((l) => l.name), mergeable: p.mergeable, headRefName: p.headRefName })),
    stalled,
    recentFailures: failures,
  };
}

// ── command registration ──────────────────────────────────────────────────────

export function registerOpsCommands(program: Command): void {
  program
    .command("vendor")
    .description("Copy the runtime-core actions into .github/actions/ (self-contained repo)")
    .option("--dir <path>", "target repo root", ".")
    .option("--json", "machine-readable output")
    .action((opts) => {
      const written = vendorInto(opts.dir);
      if (opts.json) return emitJson({ written });
      for (const w of written) process.stdout.write(pc.green(`vendored ${w}\n`));
      process.stdout.write(pc.dim("commit .github/actions/ — the generated workflows reference these local paths\n"));
    });

  program
    .command("doctor")
    .description("Preflight the factory: config, drift, vendored actions, gh auth, labels, secrets")
    .option("--dot <path>", "path to harness.dot")
    .option("--config <path>", "path to foundry.config.yaml")
    .option("--json", "machine-readable output")
    .action((opts) => {
      const { checks, failed } = runDoctor(opts);
      if (opts.json) emitJson({ ok: !failed, checks });
      else {
        printChecks(checks);
        process.stdout.write(failed ? pc.red("\nnot ready — fix the ✗ items above\n") : pc.green("\nfactory is ready\n"));
      }
      process.exit(failed ? 1 : 0);
    });

  program
    .command("status")
    .description("Factory dashboard: work in flight, stalled items, recent failures")
    .option("--dot <path>", "path to harness.dot")
    .option("--config <path>", "path to foundry.config.yaml")
    .option("--json", "machine-readable output")
    .action((opts) => {
      const report = runStatus(opts);
      if ("error" in report) {
        if (opts.json) emitJson(report);
        else process.stderr.write(pc.red(report.error + "\n"));
        process.exit(1);
      }
      if (opts.json) return emitJson(report);
      process.stdout.write(pc.bold(`\n${report.repo} — factory status\n\n`));
      for (const [label, items] of Object.entries(report.lanes)) {
        process.stdout.write(pc.cyan(`${label} (${items.length})\n`));
        for (const i of items.slice(0, 10)) process.stdout.write(`  #${i.number} ${i.title} ${pc.dim(`(${i.ageHours}h)`)}\n`);
      }
      process.stdout.write(pc.cyan(`\nagent PRs (${report.prs.length})\n`));
      for (const p of report.prs) process.stdout.write(`  #${p.number} ${p.title} ${pc.dim(p.mergeable ?? "")} ${p.labels.length ? pc.yellow(p.labels.join(",")) : ""}\n`);
      if (report.stalled.length) {
        process.stdout.write(pc.red(`\nstalled (${report.stalled.length})\n`));
        for (const s of report.stalled) process.stdout.write(`  #${s.number} ${s.title} — ${s.detail}\n`);
      }
      if (report.recentFailures.length) {
        process.stdout.write(pc.red(`\nfailed runs, last 24h (${report.recentFailures.length})\n`));
        for (const f of report.recentFailures.slice(0, 10)) process.stdout.write(`  ${f.workflow} ${pc.dim(`${f.ageHours}h ago`)} ${f.url}\n`);
      }
      if (!report.stalled.length && !report.recentFailures.length) process.stdout.write(pc.green("\nno stalled work, no recent failures\n"));
    });

  program
    .command("up")
    .description("Bring the factory up: create labels, vendor actions, build workflows, run doctor")
    .option("--dot <path>", "path to harness.dot")
    .option("--config <path>", "path to foundry.config.yaml")
    .option("--json", "machine-readable output")
    .action((opts) => {
      const { dot, config, base, root } = resolvePaths(opts);
      const result: Record<string, unknown> = {};

      // 1. labels (best-effort; skipped cleanly without gh)
      if (gh(["auth", "status"]).ok && ghJson(["repo", "view", "--json", "nameWithOwner"], root)) {
        const created: string[] = [];
        for (const l of requiredLabels(config, base)) {
          if (gh(["label", "create", l.name, "--color", l.color, "--description", l.description], { cwd: root }).ok) created.push(l.name);
        }
        result.labels = created;
        if (!opts.json) process.stdout.write(pc.green(`labels ensured (created: ${created.length ? created.join(", ") : "none — already present"})\n`));
      } else {
        result.labels = "skipped (gh unavailable or no GitHub repo)";
        if (!opts.json) process.stdout.write(pc.yellow("skipped label creation (gh unavailable or no GitHub repo yet)\n"));
      }

      // 2. vendor (only in vendored mode)
      const { harness } = loadHarness(dot, config);
      if ((harness.config.runtime?.mode ?? "pinned") === "vendored") {
        result.vendored = vendorInto(root);
        if (!opts.json) process.stdout.write(pc.green(`vendored ${(result.vendored as string[]).length} runtime action(s)\n`));
      }

      // 3. build
      const fileExists = (rel: string) => existsSync(join(base, rel));
      const specDir = relative(root, base).replace(/\\/g, "/");
      const { files, diagnostics } = compile(harness, { fileExists }, { specDir });
      if (hasErrors(diagnostics)) {
        if (opts.json) emitJson({ ok: false, diagnostics });
        else process.stderr.write(pc.red("build errors — run `gp-foundry validate` for details\n"));
        process.exit(1);
      }
      for (const f of files) {
        const p = join(root, f.path);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, f.contents);
      }
      result.wrote = files.map((f) => f.path);
      if (!opts.json) process.stdout.write(pc.green(`built ${files.length} workflow file(s)\n`));

      // 4. doctor
      const { checks, failed } = runDoctor(opts);
      result.checks = checks;
      result.ok = !failed;
      if (opts.json) return emitJson(result);
      process.stdout.write("\n");
      printChecks(checks);
      process.stdout.write(
        failed
          ? pc.yellow("\nalmost there — fix the ✗ items above, commit .github/, push, then file an issue\n")
          : pc.green("\nfactory is up — commit .github/, push, then file an issue to watch it run\n"),
      );
    });
}
