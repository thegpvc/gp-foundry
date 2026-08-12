/**
 * The scaffolded immutable-paths guard, run as the shell it compiles to.
 *
 * scope.yaml describes `immutable_paths` as "CI-enforced", but nothing in the
 * generated output enforced them on a PR: agent-fallback strips such edits on the
 * way out and the merge gate can label them, neither of which is a check anyone —
 * a reviewer, or a branch-protection rule — can see. So the guard has to actually
 * fail, not merely exist: this runs its script against a scratch repo.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import yaml from "js-yaml";
import { parseDot } from "../src/parser/parse.js";
import { loadConfig } from "../src/config/load.js";
import { compile } from "../src/index.js";
import type { FoundryConfig, Harness } from "../src/ir/types.js";

const DOT = `digraph t {
  start [type=start]
  scout [type=issue-agent, role="agents/roles/scout.md"]
  start -> scout [on="issues.opened"]
}`;

/** The guard's `run:` script, as compiled. */
function guardScript(): string {
  const g = parseDot(DOT);
  const config = loadConfig(undefined) as FoundryConfig;
  const ir: Harness = { name: g.name, nodes: g.nodes, edges: g.edges, config, sourcePath: "h.dot" };
  const file = compile(ir, {}, { specDir: ".github" }).files.find((f) =>
    f.path.endsWith("immutable-guard.yml"),
  )!;
  const doc = yaml.load(file.contents) as any;
  return doc.jobs["immutable-paths"].steps[1].run as string;
}

let repo: string;
let scratch: string;

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function write(rel: string, contents: string): void {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, contents);
}

/** Run the guard over base..head; returns its exit code and output. */
function runGuard(baseSha: string, headSha: string): { code: number; out: string } {
  const script = join(scratch, "guard.sh");
  writeFileSync(script, guardScript());
  try {
    const out = execFileSync("bash", [script], {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        SCOPE_PATH: ".github/agents/scope.yaml",
        BASE_SHA: baseSha,
        HEAD_SHA: headSha,
      },
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "gp-foundry-guard-"));
  repo = join(scratch, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  write(
    ".github/agents/scope.yaml",
    ["immutable_paths:", "  - .github/workflows/", "  - infra/terraform/", "", "guidance:", "  - be careful", ""].join("\n"),
  );
  write(".github/workflows/reviewer.yml", "name: reviewer\n");
  write("infra/terraform/main.tf", "# base\n");
  write("src/app.ts", "export const version = 1;\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "base"]);
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function commit(message: string): string {
  git(["add", "-A"]);
  git(["commit", "-qm", message]);
  return git(["rev-parse", "HEAD"]);
}

describe("immutable-paths guard", () => {
  it("passes a PR that stays out of the protected paths", () => {
    const base = git(["rev-parse", "HEAD"]);
    write("src/app.ts", "export const version = 2;\n");
    const head = commit("feat: bump");

    const { code, out } = runGuard(base, head);
    expect(code).toBe(0);
    expect(out).toContain("No immutable paths touched.");
  });

  it("fails a PR that edits the harness's own workflows", () => {
    const base = git(["rev-parse", "HEAD"]);
    write(".github/workflows/reviewer.yml", "name: reviewer\n# and a backdoor\n");
    const head = commit("agent: tweak the gate");

    const { code, out } = runGuard(base, head);
    expect(code).toBe(1);
    expect(out).toContain(".github/workflows/reviewer.yml");
    expect(out).toContain("immutable");
  });

  it("fails on an added file under a protected path, and names it", () => {
    const base = git(["rev-parse", "HEAD"]);
    write(".github/workflows/backdoor.yml", "name: backdoor\n");
    const head = commit("agent: new workflow");

    const { code, out } = runGuard(base, head);
    expect(code).toBe(1);
    expect(out).toContain("backdoor.yml");
  });

  it("honors every entry in the list, not just the first", () => {
    const base = git(["rev-parse", "HEAD"]);
    write("infra/terraform/main.tf", "# rewritten\n");
    const head = commit("agent: touch terraform");

    expect(runGuard(base, head).code).toBe(1);
  });

  it("fails a deletion of a protected file", () => {
    const base = git(["rev-parse", "HEAD"]);
    git(["rm", "-q", ".github/workflows/reviewer.yml"]);
    const head = commit("agent: remove the reviewer");

    expect(runGuard(base, head).code).toBe(1);
  });

  it("falls back to .github/workflows/ when the scope file has no list", () => {
    write(".github/agents/scope.yaml", "guidance:\n  - nothing declared\n");
    const base = commit("chore: empty scope");
    write(".github/workflows/reviewer.yml", "name: changed\n");
    const head = commit("agent: edit a workflow anyway");

    expect(runGuard(base, head).code).toBe(1);
  });
});
