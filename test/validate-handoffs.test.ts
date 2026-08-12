/**
 * The "handoffs == out-edges" invariant, specifically for escape edges into an
 * `exit` node. The default graph declares `fixer -> needs_human
 * [when="attempts>=3"]` while the shipped fixer role listed only the reviewer
 * handoff — and validate stayed silent, because every edge into an exit node was
 * exempt from the parity check.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseDot } from "../src/parser/parse.js";
import { loadConfig } from "../src/config/load.js";
import { validate } from "../src/validate/validate.js";
import { parseRoleFrontmatter } from "../src/roles/role.js";
import type { FoundryConfig, Harness, RoleSpec } from "../src/ir/types.js";

function mkHarness(dotSrc: string): Harness {
  const g = parseDot(dotSrc);
  const config = loadConfig(undefined) as FoundryConfig;
  return { name: g.name, nodes: g.nodes, edges: g.edges, config, sourcePath: "test.dot" };
}

const dot = (escapeEdge: string) => `digraph t {
  start [type=start]
  reviewer [type=pr-review, role="agents/roles/reviewer.md"]
  fixer [type=pr-fix, role="agents/roles/fixer.md", max_attempts=3]
  needs_human [type=exit]
  start -> reviewer [on="pull_request.opened"]
  reviewer -> fixer [when="verdict=request_changes"]
  fixer -> reviewer [on="push"]
  ${escapeEdge}
}`;

/** A fixer role spec whose handoffs list is supplied by the test. */
function fixerRole(handoffs: { to: string; when?: string }[]): Map<string, RoleSpec> {
  return new Map([["fixer", { role: "Fixer", handoffs } as RoleSpec]]);
}

const escapeWarnings = (ir: Harness, roles: Map<string, RoleSpec>) =>
  validate(ir, { roles }).filter(
    (d) => d.code === "role.edge-no-handoff" && d.message.includes("needs_human"),
  );

describe("exit-edge handoff parity", () => {
  it("flags a CONDITIONAL escape edge the role does not declare", () => {
    const ir = mkHarness(dot(`fixer -> needs_human [when="attempts>=3"]`));
    const warns = escapeWarnings(ir, fixerRole([{ to: "reviewer", when: "push" }]));
    expect(warns).toHaveLength(1);
    expect(warns[0]!.level).toBe("warning");
  });

  it("is silent once the role declares the escape handoff", () => {
    const ir = mkHarness(dot(`fixer -> needs_human [when="attempts>=3"]`));
    const roles = fixerRole([
      { to: "reviewer", when: "push" },
      { to: "needs_human", when: "attempts>=3" },
    ]);
    expect(escapeWarnings(ir, roles)).toEqual([]);
  });

  it("still exempts a bare, unconditional edge into an exit (a lane terminus, not a handoff)", () => {
    const ir = mkHarness(dot(`fixer -> needs_human`));
    expect(escapeWarnings(ir, fixerRole([{ to: "reviewer", when: "push" }]))).toEqual([]);
  });
});

describe("shipped software fixer role matches the template graph", () => {
  it("declares the needs_human escape the default harness.dot compiles", () => {
    const roleSrc = readFileSync(fileURLToPath(new URL("../roles/software/fixer.md", import.meta.url)), "utf8");
    const spec = parseRoleFrontmatter(roleSrc)!;
    const targets = (spec.handoffs ?? []).map((h) => String(h.to).toLowerCase());
    expect(targets).toContain("reviewer");
    expect(targets).toContain("needs_human");

    const dotSrc = readFileSync(fileURLToPath(new URL("../skill/templates/harness.dot", import.meta.url)), "utf8");
    const ir = mkHarness(dotSrc);
    const roles = new Map([["fixer", spec]]);
    expect(validate(ir, { roles }).filter((d) => d.code === "role.edge-no-handoff")).toEqual([]);
  });
});
