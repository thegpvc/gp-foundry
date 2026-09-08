/**
 * A job-level timeout CANCELS the job, and cancellation skips the `!cancelled()`
 * salvage that commits/pushes/opens a PR for the work the agent already did
 * (#12545). So the agent step carries its own timeout, below the job's, letting
 * it fail the STEP (job stays un-cancelled) with the fallback margin to spare.
 */
import { describe, it, expect } from "vitest";
import { parseDot } from "../src/parser/parse.js";
import { loadConfig } from "../src/config/load.js";
import { compile } from "../src/index.js";
import yaml from "js-yaml";
import type { FoundryConfig, Harness } from "../src/ir/types.js";

function jobOf(dot: string, jobId: string): any {
  const g = parseDot(dot);
  const config = loadConfig(undefined) as FoundryConfig;
  const ir: Harness = { name: g.name, nodes: g.nodes, edges: g.edges, config, sourcePath: ".github/harness.dot" };
  const wf: any = yaml.load(compile(ir).files.find((f) => f.path.endsWith(`${jobId}.yml`))!.contents);
  return wf.jobs[jobId];
}

const DOT = `digraph t {
  start    [type=start]
  builder  [type=producer, role="agents/roles/builder.md"]
  reviewer [type=pr-review, role="agents/roles/reviewer.md", context="pr-diff"]
  fixer    [type=pr-fix, role="agents/roles/fixer.md"]
  sweeper  [type=scheduled-agent, role="agents/roles/sweeper.md", schedule="0 8 * * *", commit=pr]
  start    -> builder  [on="issues.opened"]
  builder  -> reviewer [on="pull_request.opened"]
  reviewer -> fixer    [when="verdict=request_changes"]
  fixer    -> reviewer [on="push"]
}`;

describe("agent step timeout (#12545)", () => {
  it("gives the producer's Run agent step a timeout below the job's", () => {
    const job = jobOf(DOT, "builder");
    const runAgent = job.steps.find((s: any) => s.name === "Run agent");
    expect(job["timeout-minutes"]).toBe(35);
    expect(runAgent["timeout-minutes"]).toBe(25); // 35 - 10 margin — step cap unchanged, setup headroom now 10
    expect(runAgent["timeout-minutes"]).toBeLessThan(job["timeout-minutes"]);
  });

  it("scales the step budget to a custom job timeout=", () => {
    const dot = DOT.replace('role="agents/roles/builder.md"', 'role="agents/roles/builder.md", timeout=12');
    const job = jobOf(dot, "builder");
    const runAgent = job.steps.find((s: any) => s.name === "Run agent");
    expect(job["timeout-minutes"]).toBe(12);
    expect(runAgent["timeout-minutes"]).toBe(2); // 12 - 10 margin
  });

  it("never drops the step budget below 1 minute", () => {
    const dot = DOT.replace('role="agents/roles/builder.md"', 'role="agents/roles/builder.md", timeout=3');
    const runAgent = jobOf(dot, "builder").steps.find((s: any) => s.name === "Run agent");
    expect(runAgent["timeout-minutes"]).toBe(1);
  });

  it("also budgets the scheduled-agent's Run agent step", () => {
    const job = jobOf(DOT, "sweeper");
    const runAgent = job.steps.find((s: any) => s.name === "Run agent");
    expect(job["timeout-minutes"]).toBe(20);
    expect(runAgent["timeout-minutes"]).toBe(10); // 20 - 10 margin
  });

  it("budgets the Fixer's Run agent step too — it also has a push epilogue", () => {
    const job = jobOf(DOT, "fixer");
    const runAgent = job.steps.find((s: any) => s.name === "Run agent");
    expect(job["timeout-minutes"]).toBe(35);
    expect(runAgent["timeout-minutes"]).toBe(25); // 35 - 10 margin
  });

  it("leaves a 10-min margin (cold-setup headroom) between the job and step caps", () => {
    // The margin must exceed a cold-cache `Setup agent toolchain` step (~7 min), so the
    // agent reaches its OWN step cap before the JOB cap fires — otherwise the job is
    // cancelled mid-agent and the `!cancelled()` salvage is skipped (#12611).
    for (const id of ["builder", "fixer", "sweeper"]) {
      const job = jobOf(DOT, id);
      const runAgent = job.steps.find((s: any) => s.name === "Run agent");
      expect(job["timeout-minutes"] - runAgent["timeout-minutes"]).toBe(10);
    }
  });
});
