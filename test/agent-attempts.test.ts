/**
 * agent_attempts=N sets a lane's transient-retry budget, compiled through to the
 * run-agent step's `max-attempts` input.
 *
 * It exists because retrying re-runs the whole role, which is safe only for a role
 * that reads current state before acting. Most do — that is the same assumption the
 * harness already makes when a cron, agent_refire or the supervisor re-drives a lane
 * — but a role with an unconditional side effect (the Herald posts a Slack digest
 * with no dedup) must be able to opt out, and without a per-node attr the action
 * default applied to every lane or none.
 *
 * The name is NOT max_attempts: that attr is already the pr-fix fix↔review loop
 * bound. The last test here pins that separation, because sharing the name would
 * silently couple two unrelated budgets.
 */
import { describe, it, expect } from "vitest";
import { parseDot } from "../src/parser/parse.js";
import { loadConfig } from "../src/config/load.js";
import { compile } from "../src/index.js";
import { validate } from "../src/validate/validate.js";
import yaml from "js-yaml";
import type { FoundryConfig, Harness } from "../src/ir/types.js";

function harness(dot: string): Harness {
  const g = parseDot(dot);
  const config = loadConfig(undefined) as FoundryConfig;
  return { name: g.name, nodes: g.nodes, edges: g.edges, config, sourcePath: ".github/harness.dot" };
}

/** The `with:` block of the named workflow's Run agent step. */
function runAgentWith(dot: string, workflow: string, job: string): Record<string, string> | undefined {
  const wf: any = yaml.load(
    compile(harness(dot)).files.find((f) => f.path.endsWith(`${workflow}.yml`))!.contents,
  );
  const steps = wf.jobs[job].steps as Array<{ name?: string; with?: Record<string, string> }>;
  return steps.find((s) => s.name === "Run agent")?.with;
}

const producer = (attrs: string) => `digraph t {
  start   [type=start]
  builder [type=producer, role="agents/roles/builder.md"${attrs}]
  start -> builder [on="issues.opened"]
}`;

describe("agent_attempts → run-agent max-attempts", () => {
  it("is omitted when unset, so the action's own default applies", () => {
    expect(runAgentWith(producer(""), "builder", "builder")).not.toHaveProperty("max-attempts");
  });

  it("passes the declared budget through", () => {
    expect(runAgentWith(producer(", agent_attempts=5"), "builder", "builder")?.["max-attempts"]).toBe("5");
  });

  it("passes 1 through as the opt-out", () => {
    // The Herald case: an unconditional Slack post must never be repeated.
    expect(runAgentWith(producer(", agent_attempts=1"), "builder", "builder")?.["max-attempts"]).toBe("1");
  });

  it("applies to a scheduled lane too, not just producers", () => {
    const dot = `digraph t {
      herald [type=scheduled-agent, role="agents/roles/herald.md", schedule="0 16 * * 5", commit="none", agent_attempts=1]
    }`;
    expect(runAgentWith(dot, "herald", "herald")?.["max-attempts"]).toBe("1");
  });
});

describe("agent_attempts validation", () => {
  const diags = (dot: string) => validate(harness(dot));
  const codes = (dot: string) => diags(dot).map((d) => d.code);

  it("accepts a whole number >= 1", () => {
    expect(codes(producer(", agent_attempts=3"))).not.toContain("node.bad-agent-attempts");
  });

  it("rejects 0 — that would mean never invoking the CLI", () => {
    expect(codes(producer(", agent_attempts=0"))).toContain("node.bad-agent-attempts");
  });

  it("rejects a negative budget", () => {
    // Quoted, because the tokenizer only starts a bare identifier on [A-Za-z0-9_]
    // (parse.ts:127) — an UNQUOTED -1 loses its sign and arrives as 1, before
    // coerce() or any validation can see it. That is pre-existing and applies to
    // every numeric attr (timeout=, max_attempts=), so it is not fixed here; the
    // quoted form is what actually reaches this check.
    expect(codes(producer(', agent_attempts="-1"'))).toContain("node.bad-agent-attempts");
  });

  it("rejects a non-numeric value instead of coercing it", () => {
    // parseDot only coerces /^-?\d+$/, so this stays a string and must fail closed
    // rather than reaching the runner as something nobody intended.
    const d = diags(producer(', agent_attempts="lots"'));
    expect(d.map((x) => x.code)).toContain("node.bad-agent-attempts");
    expect(d.find((x) => x.code === "node.bad-agent-attempts")?.level).toBe("error");
  });

  it("warns when set on a node that runs no agent", () => {
    const dot = `digraph t {
      start [type=start, agent_attempts=2]
      builder [type=producer, role="agents/roles/builder.md"]
      start -> builder [on="issues.opened"]
    }`;
    const d = diags(dot);
    expect(d.map((x) => x.code)).toContain("node.agent-attempts-ignored");
    expect(d.find((x) => x.code === "node.agent-attempts-ignored")?.level).toBe("warning");
  });
});

describe("agent_attempts is independent of the pr-fix max_attempts loop bound", () => {
  // Regression guard on a collision that was nearly shipped. `max_attempts=3` is
  // live on the Fixer lane of at least one real harness as its loop bound; if the
  // retry budget read the same attr, dropping that bound to 1 to shorten the
  // fix↔review loop would also silently disable the lane's transient retry.
  const dot = `digraph t {
    start    [type=start]
    fixer    [type=pr-fix, role="agents/roles/fixer.md", max_attempts=2]
    start -> fixer [on="pull_request_review.submitted"]
  }`;

  it("max_attempts alone does not set the retry budget", () => {
    expect(runAgentWith(dot, "fixer", "fixer")).not.toHaveProperty("max-attempts");
  });

  it("still enforces max_attempts as the loop bound", () => {
    const wf: any = yaml.load(
      compile(harness(dot)).files.find((f) => f.path.endsWith("fixer.yml"))!.contents,
    );
    const names = (wf.jobs.fixer.steps as Array<{ name?: string }>).map((s) => s.name ?? "");
    expect(names.some((n) => n.includes("attempt budget") && n.includes("2"))).toBe(true);
  });

  it("carries both independently when both are set", () => {
    const both = `digraph t {
      start [type=start]
      fixer [type=pr-fix, role="agents/roles/fixer.md", max_attempts=2, agent_attempts=1]
      start -> fixer [on="pull_request_review.submitted"]
    }`;
    expect(runAgentWith(both, "fixer", "fixer")?.["max-attempts"]).toBe("1");
    const wf: any = yaml.load(
      compile(harness(both)).files.find((f) => f.path.endsWith("fixer.yml"))!.contents,
    );
    const names = (wf.jobs.fixer.steps as Array<{ name?: string }>).map((s) => s.name ?? "");
    expect(names.some((n) => n.includes("attempt budget") && n.includes("2"))).toBe(true);
  });
});
