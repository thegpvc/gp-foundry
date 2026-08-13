/**
 * A scheduled-agent's `commit=` attr controls how it persists output:
 *   direct (default) — commit straight to the base branch (back-compat).
 *   pr               — commit to a fresh agent branch and open a PR (reviewed + gated).
 *   none             — no commit/push at all (read-only lane; gh/API side effects only).
 */
import { describe, it, expect } from "vitest";
import { parseDot } from "../src/parser/parse.js";
import { loadConfig } from "../src/config/load.js";
import { compile } from "../src/index.js";
import yaml from "js-yaml";
import type { FoundryConfig, Harness } from "../src/ir/types.js";

function laneJob(commitAttr: string): any {
  const attr = commitAttr ? `, ${commitAttr}` : "";
  const g = parseDot(`digraph t {
    start [type=start]
    lane  [type=scheduled-agent, role="agents/roles/lane.md", schedule="0 8 * * *"${attr}]
  }`);
  const ir: Harness = {
    name: g.name,
    nodes: g.nodes,
    edges: g.edges,
    config: loadConfig(undefined) as FoundryConfig,
    sourcePath: ".github/harness.dot",
  };
  const wf: any = yaml.load(compile(ir).files.find((f) => f.path.endsWith("lane.yml"))!.contents);
  return wf.jobs.lane;
}
const names = (job: any): string[] => (job.steps as Array<{ name?: string }>).map((s) => s.name ?? "");
const step = (job: any, name: string): any => (job.steps as Array<{ name?: string }>).find((s) => s.name === name);

describe("scheduled-agent commit= attribute", () => {
  it("default is direct: commits straight to the base branch, no PR", () => {
    const job = laneJob("");
    const fb = step(job, "Strip protected paths, commit, push");
    expect(fb).toBeTruthy();
    expect(fb.with.branch).toBe(fb.with["base-branch"]); // branch == base → direct commit
    expect(fb.with["pr-title"]).toBeUndefined();
  });

  it("commit=none emits no commit/push epilogue at all", () => {
    const n = names(laneJob('commit="none"'));
    expect(n).not.toContain("Strip protected paths, commit, push");
    expect(n).not.toContain("Commit, push branch, open PR");
    expect(n).not.toContain("Create branch");
  });

  it("commit=pr branches and opens a PR, never touching base directly", () => {
    const job = laneJob('commit="pr"');
    expect(names(job)).toContain("Create branch");
    const fb = step(job, "Commit, push branch, open PR");
    expect(fb).toBeTruthy();
    expect(fb.with.branch).not.toBe(fb.with["base-branch"]); // branch != base → PR
    expect(fb.with["pr-title"]).toBeTruthy();
    expect(step(job, "Strip protected paths, commit, push")).toBeUndefined();
  });
});
