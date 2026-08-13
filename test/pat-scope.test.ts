/**
 * Reading check-runs takes the Checks permission, and a fine-grained PAT cannot
 * be granted it: GitHub's fine-grained permission list has no Checks entry — it
 * is a GitHub App permission. So the merge gate cannot do that read with the
 * harness PAT no matter how it is scoped, and the fix is not a scope at all: the
 * generated job passes the built-in GITHUB_TOKEN (an App installation token) for
 * that one call and declares `checks: read`.
 *
 * With `require_ci: true` (the shipped default, and the action's default when the
 * key is absent) the gate makes that call for every candidate, so before this
 * wiring a by-the-book setup merged nothing and said so only in the Actions tab.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseDot } from "../src/parser/parse.js";
import { loadConfig } from "../src/config/load.js";
import { needsChecksPermission } from "../src/cli/ops.js";
import { compile } from "../src/index.js";
import yaml from "js-yaml";
import type { FoundryConfig, Harness } from "../src/ir/types.js";

const compileHarness = (ir: Harness): any =>
  yaml.load(compile(ir).files.find((f) => f.path.endsWith("merge_gate.yml"))!.contents);

const repoFile = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");

function harnessWith(policyRef: string): Harness {
  const g = parseDot(`digraph t {
    start [type=start]
    merge_gate [type=merge-gate${policyRef}, schedule="*/30 * * * *"]
  }`);
  return {
    name: g.name,
    nodes: g.nodes,
    edges: g.edges,
    config: loadConfig(undefined) as FoundryConfig,
    sourcePath: ".github/harness.dot",
  };
}

/** A scratch repo root holding one policy file at .github/agents/policy/merge.yaml. */
function rootWithPolicy(contents: string): string {
  const root = mkdtempSync(join(tmpdir(), "gp-foundry-pat-"));
  const p = join(root, ".github/agents/policy/merge.yaml");
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, contents);
  return root;
}

describe("needsChecksPermission", () => {
  const POLICY = `, policy="agents/policy/merge.yaml"`;
  let roots: string[] = [];
  const scratch = (contents: string) => {
    const r = rootWithPolicy(contents);
    roots.push(r);
    return r;
  };
  const cleanup = () => {
    roots.forEach((r) => rmSync(r, { recursive: true, force: true }));
    roots = [];
  };

  it("is true when the policy requires CI", () => {
    expect(needsChecksPermission(harnessWith(POLICY), scratch("require_ci: true\n"))).toBe(true);
    cleanup();
  });

  it("is true when the policy omits require_ci -- the action defaults it on", () => {
    expect(needsChecksPermission(harnessWith(POLICY), scratch("branch_prefix: agent/\n"))).toBe(true);
    cleanup();
  });

  it("is false only when the policy explicitly opts out", () => {
    expect(needsChecksPermission(harnessWith(POLICY), scratch("require_ci: false\n"))).toBe(false);
    expect(needsChecksPermission(harnessWith(POLICY), scratch("requireCi: false\n"))).toBe(false);
    cleanup();
  });

  it("assumes yes when the policy file is missing or unreadable", () => {
    const root = mkdtempSync(join(tmpdir(), "gp-foundry-pat-"));
    expect(needsChecksPermission(harnessWith(POLICY), root)).toBe(true);
    rmSync(root, { recursive: true, force: true });
    expect(needsChecksPermission(harnessWith(""), scratch("require_ci: false\n"))).toBe(true);
    cleanup();
  });

  it("is false for a harness with no merge gate at all", () => {
    const g = parseDot(`digraph t {
      start [type=start]
      scout [type=issue-agent, role="agents/roles/scout.md"]
      start -> scout [on="issues.opened"]
    }`);
    const ir: Harness = {
      name: g.name,
      nodes: g.nodes,
      edges: g.edges,
      config: loadConfig(undefined) as FoundryConfig,
      sourcePath: ".github/harness.dot",
    };
    expect(needsChecksPermission(ir, scratch("require_ci: true\n"))).toBe(false);
    cleanup();
  });
});

describe("no doc tells a user to grant a permission that does not exist", () => {
  // The first attempt at this fix documented "Checks: read" on the PAT. There is
  // no such toggle in GitHub's fine-grained permission list, so that advice sent
  // people looking for a setting they could never find.
  for (const rel of [
    "AGENTS.md",
    "README.md",
    "src/cli/index.ts",
    "skill/templates/foundry.config.yaml",
    "examples/starter/.github/agents/foundry.config.yaml",
  ]) {
    it(`${rel} does not ask for Checks on the PAT`, () => {
      const text = repoFile(rel);
      expect(text).not.toMatch(/checks[:\s]+(read|write)/i);
      expect(text).not.toMatch(/\+ *checks\b/i);
    });
  }

  it("the config template explains why the PAT needs nothing for CI", () => {
    const tpl = repoFile("skill/templates/foundry.config.yaml");
    expect(tpl).toMatch(/GITHUB_TOKEN/);
    expect(tpl).toMatch(/cannot be granted/i);
  });

  it("the shipped policy template still requires CI, which is what makes the read happen", () => {
    expect(repoFile("skill/templates/policy-merge.yaml")).toMatch(/^require_ci:\s*true/m);
  });
});

describe("the generated merge gate reads CI with GITHUB_TOKEN", () => {
  it("passes checks-token and declares checks: read", () => {
    const g = parseDot(`digraph t {
      merge_gate [type=merge-gate, policy="agents/policy/merge.yaml", schedule="*/30 * * * *"]
    }`);
    // pat mode: the case the whole issue is about, and the one where the two
    // tokens must genuinely differ.
    const ir: Harness = {
      name: g.name,
      nodes: g.nodes,
      edges: g.edges,
      config: { ...loadConfig(undefined), auth: { mode: "pat", token_secret: "AGENT_PAT" } } as FoundryConfig,
      sourcePath: ".github/harness.dot",
    };
    const doc = compileHarness(ir);
    const job = doc.jobs.merge_gate;
    expect(job.permissions.checks).toBe("read");
    const step = job.steps.find((s: any) => s.name === "Evaluate merge gate");
    expect(step.with["checks-token"]).toBe("${{ github.token }}");
    // The merge itself must stay on the harness token, or merges stop cascading.
    expect(step.with.token).toBe("${{ secrets.AGENT_PAT }}");
  });

  it("the shipped starter example carries that wiring", () => {
    const wf = repoFile("examples/starter/.github/workflows/merge_gate.yml");
    expect(wf).toContain("checks-token: ${{ github.token }}");
    expect(wf).toMatch(/checks:\s*read/);
  });
});
