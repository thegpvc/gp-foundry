/**
 * The fixer's attempt budget (#4): the marker comment and the exhaustion label
 * are the visible record, not the control flow. A failure to write them must not
 * turn "run the attempt" into a red run with the agent skipped.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { parseDot } from "../src/parser/parse.js";
import { loadConfig } from "../src/config/load.js";
import { compile } from "../src/index.js";
import type { FoundryConfig } from "../src/ir/types.js";

const DOT = `digraph t {
  start [type=start]
  fixer [type=pr-fix, role="agents/roles/fixer.md", max_attempts=2]
  start -> fixer [on="pull_request_review.submitted"]
}`;

function budgetStep(): any {
  const g = parseDot(DOT);
  expect(g.errors).toEqual([]);
  const config = { ...loadConfig(undefined), identity: { bot_login: "agent-bot[bot]" } } as FoundryConfig;
  const { files } = compile({ name: g.name, nodes: g.nodes, edges: g.edges, config, sourcePath: "t.dot" });
  const wf = yaml.load(files.find((f) => f.path.endsWith("/fixer.yml"))!.contents) as any;
  return wf.jobs.fixer.steps.find((s: any) => s.id === "attempts");
}

/** A gh whose reviews read returns `changes` request-changes reviews, and whose writes all fail. */
function run(changes: number) {
  const dir = mkdtempSync(join(tmpdir(), "gpf-budget-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env bash
if [ "$1" = "api" ] && [[ "$*" != *"--method"* ]]; then echo ${changes}; exit 0; fi
echo "GraphQL: Resource not accessible by personal access token (addComment)" >&2
exit 1
`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  const out = join(dir, "out");
  writeFileSync(out, "");
  const step = budgetStep();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(step.env as Record<string, string>)) if (!String(v).includes("${{")) env[k] = String(v);
  let status = 0;
  let stdout = "";
  try {
    stdout = execFileSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", step.run], {
      env: { PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: out, GITHUB_REPOSITORY: "o/r", PR: "3", ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e: any) {
    status = e.status ?? 1;
    stdout = (e.stdout ?? "") + (e.stderr ?? "");
  }
  return { status, stdout, output: readFileSync(out, "utf8") };
}

describe("the fixer's attempt budget survives a failed marker comment (#4)", () => {
  it("under budget: the attempt still runs, with a warning", () => {
    const r = run(1);
    expect(r.status).toBe(0);
    expect(r.output).toContain("exhausted=false");
    expect(r.stdout).toContain("::warning::could not post the attempt marker");
  });

  it("over budget: still stops, even when neither the label nor the notice can be written", () => {
    const r = run(3);
    expect(r.status).toBe(0);
    expect(r.output).toContain("exhausted=true");
    expect(r.stdout).toContain("could not label #3");
    expect(r.stdout).toContain("could not post the exhaustion notice");
  });
});

describe("the Fixer drops an untracked scratch draft instead of committing it (#3)", () => {
  it("removes root drafts, keeps real work and a matching name below the root", () => {
    const g = parseDot(DOT);
    const config = { ...loadConfig(undefined), identity: { bot_login: "agent-bot[bot]" } } as FoundryConfig;
    const { files } = compile({ name: g.name, nodes: g.nodes, edges: g.edges, config, sourcePath: "t.dot" });
    const wf = yaml.load(files.find((f) => f.path.endsWith("/fixer.yml"))!.contents) as any;
    const step = wf.jobs.fixer.steps.find((s: any) => s.name === "Commit and push fixes");

    const dir = mkdtempSync(join(tmpdir(), "gpf-fixer-scratch-"));
    const origin = join(dir, "origin.git");
    const repo = join(dir, "work");
    const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
    execFileSync("git", ["init", "-q", "--bare", "-b", "fix-branch", origin]);
    execFileSync("git", ["clone", "-q", origin, repo], { stdio: "ignore" });
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");
    writeFileSync(join(repo, "app.ts"), "1\n");
    git("add", "-A");
    git("commit", "-qm", "base");
    git("push", "-q", "origin", "HEAD:fix-branch");

    writeFileSync(join(repo, "app.ts"), "2\n");
    writeFileSync(join(repo, ".review-body.md"), "reply\n");
    writeFileSync(join(repo, "pr-body.md"), "body\n");
    mkdirSync(join(repo, "docs"));
    writeFileSync(join(repo, "docs", "pr-body.md"), "real doc\n");

    const out = execFileSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", step.run], {
      cwd: repo,
      env: { PATH: process.env.PATH, HOME: process.env.HOME ?? dir, BRANCH: "fix-branch" },
      encoding: "utf8",
    });
    expect(out).toContain("'pr-body.md' looks like an agent's scratch file");
    expect(git("show", "--name-only", "--format=", "HEAD").split("\n").sort()).toEqual(["app.ts", "docs/pr-body.md"]);
    expect(git("status", "--porcelain")).toBe("");
  });
});
