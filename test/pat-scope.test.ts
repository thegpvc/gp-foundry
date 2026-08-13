/**
 * The Checks permission a `pat`-mode harness needs, and the places that have to
 * say so.
 *
 * A fine-grained PAT scoped exactly as the setup docs described it (Contents,
 * Pull requests, Issues, Actions) cannot read `commits/{sha}/check-runs` — that
 * is the separate Checks permission. With `require_ci: true` (the shipped
 * default, and the action's default when the key is absent) the merge gate reads
 * that endpoint for every candidate, so a by-the-book setup merged nothing and
 * said so only in the Actions tab.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseDot } from "../src/parser/parse.js";
import { loadConfig } from "../src/config/load.js";
import { needsChecksPermission } from "../src/cli/ops.js";
import type { FoundryConfig, Harness } from "../src/ir/types.js";

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

describe("every place that documents the PAT scope names Checks", () => {
  // The bug was a documentation gap as much as a code one: four surfaces state
  // this scope, and a consumer who follows any one of them must end up with a
  // working gate.
  for (const rel of [
    "AGENTS.md",
    "README.md",
    "src/cli/index.ts",
    "skill/templates/foundry.config.yaml",
    "examples/starter/.github/agents/foundry.config.yaml",
  ]) {
    it(`${rel} mentions the Checks permission`, () => {
      expect(repoFile(rel)).toMatch(/checks/i);
    });
  }

  it("the shipped policy template still requires CI, which is what makes it necessary", () => {
    expect(repoFile("skill/templates/policy-merge.yaml")).toMatch(/^require_ci:\s*true/m);
  });
});
