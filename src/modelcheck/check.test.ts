import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseDot } from "../parser/parse.js";
import { modelCheck } from "./check.js";
import { validate } from "../validate/validate.js";
import type { Harness, FoundryConfig } from "../ir/types.js";

const cfg: FoundryConfig = {
  name: "t",
  identity: {},
  agent: { cli: "claude", model: "m" },
  repo: { base_branch: "main", branch_prefix: "agent/" },
  labels: {},
};

function harness(dot: string): Harness {
  const g = parseDot(dot);
  return { name: g.name, nodes: g.nodes, edges: g.edges, config: cfg };
}

const dixie = harness(
  readFileSync(fileURLToPath(new URL("../../examples/dixie/harness.dot", import.meta.url)), "utf8"),
);

describe("modelCheck", () => {
  it("dixie harness has no errors", () => {
    const errs = modelCheck(dixie).filter((d) => d.level === "error");
    expect(errs).toEqual([]);
  });

  it("flags an unbounded loop (livelock)", () => {
    const h = harness(`digraph l {
      start [type=start]
      a [type=producer, role="a.md"]
      b [type=pr-fix, role="b.md"]
      start -> a [on="issues.opened"]
      a -> b [on="push"]
      b -> a [on="push"]
    }`);
    const errs = modelCheck(h);
    expect(errs.some((d) => d.code === "graph.unbounded-loop")).toBe(true);
  });

  it("accepts a bounded loop with an escape", () => {
    const errs = modelCheck(dixie);
    // fixer -> critic -> fixer is a cycle, but fixer -> needs_human [attempts>=3] escapes it
    expect(errs.some((d) => d.code === "graph.unbounded-loop")).toBe(false);
  });

  it("flags an unreachable node", () => {
    const h = harness(`digraph u {
      start [type=start]
      a [type=producer, role="a.md"]
      orphan [type=producer, role="o.md"]
      start -> a [on="issues.opened"]
    }`);
    expect(modelCheck(h).some((d) => d.code === "graph.unreachable" && d.where?.node === "orphan")).toBe(true);
  });
});

describe("validate", () => {
  it("dixie harness has no validation errors (without file/role deps)", () => {
    const errs = validate(dixie).filter((d) => d.level === "error");
    expect(errs).toEqual([]);
  });

  it("errors on an agent node missing a role", () => {
    const h = harness(`digraph m { start [type=start]  a [type=producer]  start -> a [on="issues.opened"] }`);
    expect(validate(h).some((d) => d.code === "node.missing-role")).toBe(true);
  });

  it("errors on a human-gate without environment", () => {
    const h = harness(`digraph hg { start [type=start]  g [type=human-gate]  start -> g [on="issues.opened"] }`);
    expect(validate(h).some((d) => d.code === "node.human-gate-no-environment")).toBe(true);
  });
});
