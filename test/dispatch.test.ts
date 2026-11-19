/**
 * dispatch= (#49): wake other workflows the moment a node has delivered — a
 * sweep after its upstream lane posts, a consumer's workflow after the gate
 * publishes — instead of leaving them to their cron. (The post step's runtime
 * behaviour is in post-review.test.ts.)
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { parseDot } from "../src/parser/parse.js";
import { loadConfig } from "../src/config/load.js";
import { compile } from "../src/index.js";
import { validate } from "../src/validate/validate.js";
import type { FoundryConfig, Harness } from "../src/ir/types.js";

const graph = (reviewer = 'dispatch="approver, formal-approval.yml"', gate = "") => `digraph t {
  start    [type=start]
  reviewer [type=pr-review, role="agents/roles/reviewer.md", context="pr-diff", post="review"${reviewer ? ", " + reviewer : ""}]
  approver [type=pr-review, role="agents/roles/approver.md", context="pr-review", select="sweep", schedule="*/5 * * * *", requires_review=true, post="review"]
  gate     [type=merge-gate, policy="agents/policy/merge.yaml", schedule="*/10 * * * *", merge="off"${gate ? ", " + gate : ""}]
  builder  [type=producer, role="agents/roles/builder.md", context=issue]
  start -> reviewer [on="pull_request.opened, pull_request.synchronize"]
  start -> builder  [on="issues.labeled", when="label=build"]
}`;
function harness(d: string): Harness {
  const g = parseDot(d);
  expect(g.errors).toEqual([]);
  const config = { ...loadConfig(undefined), identity: { bot_login: "agent-bot[bot]" }, rollout: {} } as FoundryConfig;
  return { name: g.name, nodes: g.nodes, edges: g.edges, config, sourcePath: "t.dot" };
}
const wf = (d: string, name: string): any => yaml.load(compile(harness(d)).files.find((f) => f.path.endsWith(`/${name}.yml`))!.contents);
const errors = (d: string) => validate(harness(d)).filter((x) => x.level === "error").map((x) => x.code);

describe("dispatch= on a posting lane", () => {
  it("the post step wakes each target after it posts, with the job's own token", () => {
    const job = wf(graph(), "reviewer").jobs.reviewer;
    const post = job.steps.find((s: any) => s.name === "Post the review");
    // A sweep makes its own pass (no inputs); a workflow file gets the PR.
    expect(post.env.DISPATCH_TARGETS).toBe("approver.yml -\nformal-approval.yml pr");
    expect(post.env.DISPATCH_TOKEN).toBe("${{ github.token }}");
    expect(post.run).toContain('dispatch_to "$DISPATCH_TARGETS"');
    expect(job.permissions.actions).toBe("write");
  });

  it("off: the post step and the job are as they were", () => {
    const job = wf(graph(""), "reviewer").jobs.reviewer;
    const post = job.steps.find((s: any) => s.name === "Post the review");
    expect(post.env.DISPATCH_TARGETS).toBeUndefined();
    expect(post.run).not.toContain("dispatch_to");
    expect(job.permissions.actions).toBeUndefined();
  });

  it("a single gate named as a target takes the PR as its `pr` dispatch input", () => {
    const d = graph('dispatch="gate"');
    expect(wf(d, "reviewer").jobs.reviewer.steps.find((s: any) => s.name === "Post the review").env.DISPATCH_TARGETS).toBe("gate.yml pr");
    const gate = wf(d, "gate");
    expect(gate.on.workflow_dispatch.inputs.pr.type).toBe("string");
    expect(gate.jobs.gate.steps.find((s: any) => String(s.uses ?? "").includes("merge-gate")).with["pr-number"]).toBe("${{ github.event.pull_request.number || inputs.pr }}");
  });
});

describe("dispatch= on the gate", () => {
  const d = graph("", 'dispatch="formal-approval.yml, approver"');

  it("wakes each target after it publishes, once per PR whose result changed", () => {
    const job = wf(d, "gate").jobs.gate;
    const gateStep = job.steps.find((s: any) => String(s.uses ?? "").includes("merge-gate"));
    expect(gateStep.id).toBe("gate");
    const wake = job.steps.find((s: any) => s.name === "Wake downstream workflows");
    expect(wake.if).toBe("${{ !cancelled() && steps.gate.outputs.published-prs != '' }}");
    expect(wake.env).toMatchObject({ PRS: "${{ steps.gate.outputs.published-prs }}", DISPATCH_TARGETS: "formal-approval.yml pr\napprover.yml -", BASE_BRANCH: "main" });
    expect(job.permissions.actions).toBe("write");
  });

  it("the step: per PR for a `pr` target, once for a pass; a failure only warns", () => {
    const wake = wf(d, "gate").jobs.gate.steps.find((s: any) => s.name === "Wake downstream workflows");
    const dir = mkdtempSync(join(tmpdir(), "gpf-wake-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "gh"),
      `#!/usr/bin/env bash
echo "$*" >> "$LOG"
[[ "$*" == *approver.yml* ]] && { echo "HTTP 403" >&2; exit 1; }
exit 0
`,
    );
    chmodSync(join(bin, "gh"), 0o755);
    const log = join(dir, "log");
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(wake.env as Record<string, string>)) if (!String(v).includes("${{")) env[k] = String(v);
    const out = execFileSync("bash", ["-eo", "pipefail", "-c", wake.run], {
      env: { PATH: `${bin}:${process.env.PATH}`, GITHUB_REPOSITORY: "o/r", LOG: log, ...env, PRS: "3,5" },
      encoding: "utf8",
    });
    const calls = readFileSync(log, "utf8").trim().split("\n");
    expect(calls).toEqual([
      "api --method POST repos/o/r/actions/workflows/formal-approval.yml/dispatches -f ref=main -f inputs[pr]=3",
      "api --method POST repos/o/r/actions/workflows/formal-approval.yml/dispatches -f ref=main -f inputs[pr]=5",
      "api --method POST repos/o/r/actions/workflows/approver.yml/dispatches -f ref=main",
    ]);
    expect(out).toContain("::warning::could not start approver.yml");
    expect(existsSync(join(process.cwd(), "err.txt"))).toBe(false);
  });

  it("off: no dispatch step, actions only read", () => {
    const job = wf(graph(""), "gate").jobs.gate;
    expect(job.steps.find((s: any) => s.name === "Wake downstream workflows")).toBeUndefined();
    expect(job.permissions.actions).toBe("read");
  });
});

describe("validation", () => {
  it("accepts sweeps, scheduled nodes, single gates and workflow files", () => {
    expect(errors(graph('dispatch="approver, gate, formal-approval.yml"'))).toEqual([]);
    expect(errors(graph("", 'dispatch="formal-approval.yaml"'))).toEqual([]);
  });
  it("only a posting lane or a single gate dispatches", () => {
    expect(errors(graph("").replace('context=issue]', 'context=issue, dispatch="approver"]'))).toContain("node.dispatch-unsupported");
  });
  it("rejects a target that is no node, cannot be dispatched, or is itself", () => {
    expect(errors(graph('dispatch="nope"'))).toContain("node.bad-dispatch");
    expect(errors(graph('dispatch="builder"'))).toContain("node.bad-dispatch");
    expect(errors(graph('dispatch="reviewer"'))).toContain("node.bad-dispatch");
    expect(errors(graph('dispatch="../x.yml"'))).toContain("node.bad-dispatch");
  });
});
