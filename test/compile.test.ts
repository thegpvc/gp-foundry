import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { loadHarness } from "../src/config/load.js";
import { compile, hasErrors } from "../src/index.js";
import type { GeneratedFile } from "../src/ir/types.js";

const dot = fileURLToPath(new URL("./fixtures/dixie/harness.dot", import.meta.url));
const config = fileURLToPath(new URL("./fixtures/dixie/foundry.config.yaml", import.meta.url));

const { harness } = loadHarness(dot, config);
const { files, diagnostics } = compile(harness);

function wf(name: string): any {
  const f = files.find((x: GeneratedFile) => x.path === `.github/workflows/${name}.yml`);
  if (!f) throw new Error(`no workflow ${name}`);
  return yaml.load(f.contents);
}

describe("compile(dixie) — Tier 1 spec↔output invariants", () => {
  it("produces no error diagnostics", () => {
    expect(diagnostics.filter((d) => d.level === "error")).toEqual([]);
    expect(hasErrors(diagnostics)).toBe(false);
  });

  it("producer (builder) job is contents:write", () => {
    const job = wf("builder").jobs.builder;
    expect(job.permissions.contents).toBe("write");
    expect(job.permissions["pull-requests"]).toBe("write");
  });

  it("pr-review (critic) is read-only on code (contents:read)", () => {
    const job = wf("critic").jobs.critic;
    expect(job.permissions.contents).toBe("read");
    expect(job.permissions["pull-requests"]).toBe("write");
  });

  it("issue-agent (scout) can write issues but not code", () => {
    const job = wf("scout").jobs.scout;
    expect(job.permissions.contents).toBe("read");
    expect(job.permissions.issues).toBe("write");
  });

  it("edge on=E ⟺ trigger E; label guard is applied", () => {
    const builder = wf("builder");
    expect(builder.on.issues.types).toContain("labeled");
    expect(builder.jobs.builder.if).toContain("github.event.label.name == 'agent'");
    const critic = wf("critic");
    expect(critic.on.pull_request.types).toContain("opened");
  });

  it("merge-gate (shipper) is scheduled + manually dispatchable", () => {
    const on = wf("shipper").on;
    expect(on.schedule?.[0]?.cron).toBe("*/30 * * * *");
    expect(on).toHaveProperty("workflow_dispatch");
  });

  it("INJECTION: no generated run: step interpolates github.event.*", () => {
    for (const f of files) {
      if (!f.path.endsWith(".yml")) continue;
      const doc: any = yaml.load(f.contents);
      for (const job of Object.values<any>(doc.jobs ?? {})) {
        for (const step of job.steps ?? []) {
          if (typeof step.run === "string") {
            expect(step.run, `${f.path}`).not.toMatch(/\$\{\{\s*github\.event\./);
          }
        }
      }
    }
  });

  it("runtime-core actions are referenced by pinned full path (never ./actions)", () => {
    for (const f of files) {
      expect(f.contents).not.toMatch(/uses:\s*\.\/actions\//);
    }
    expect(wf("builder").jobs.builder.steps.some((s: any) => /gp-foundry\/actions\/run-agent@/.test(s.uses ?? ""))).toBe(true);
  });

  it("emits HARNESS.md", () => {
    expect(files.some((f) => f.path === ".github/HARNESS.md")).toBe(true);
  });
});
