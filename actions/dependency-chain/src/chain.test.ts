import { describe, it, expect } from "vitest";
import {
  computeChainOps,
  extractClosedIssues,
  type ChainConfig,
  type ChainInput,
  type IssueSnapshot,
} from "./chain.js";

// A config mirroring the original gp-dixie behavior but with generic names.
const CFG: ChainConfig = {
  blockedLabel: "blocked",
  readyLabel: "ready",
  dependsOnMarker: "<!-- depends-on: #{n} -->",
  parentMarker: "<!-- parent: #{n} -->",
  parentCloseComment: "All phases complete. Closing tracking issue #{n}.",
};

function issue(
  number: number,
  body: string,
  labels: string[] = [],
): IssueSnapshot {
  return { number, body, labels };
}

// ────────────────────────────────────────────────────────────────────────────
// extractClosedIssues
// ────────────────────────────────────────────────────────────────────────────

describe("extractClosedIssues", () => {
  it("returns [] for empty / null / undefined bodies", () => {
    expect(extractClosedIssues("")).toEqual([]);
    expect(extractClosedIssues(null)).toEqual([]);
    expect(extractClosedIssues(undefined)).toEqual([]);
  });

  it("matches the canonical `Closes #N`", () => {
    expect(extractClosedIssues("Closes #260")).toEqual([260]);
  });

  it("is case-insensitive across all default keywords", () => {
    expect(extractClosedIssues("FIXES #1")).toEqual([1]);
    expect(extractClosedIssues("resolved #2")).toEqual([2]);
    expect(extractClosedIssues("Fixed #3")).toEqual([3]);
    expect(extractClosedIssues("CLOSE #4")).toEqual([4]);
  });

  it("tolerates a colon and varied whitespace", () => {
    expect(extractClosedIssues("Closes:   #7")).toEqual([7]);
    expect(extractClosedIssues("fixes:\t#8")).toEqual([8]);
  });

  it("extracts multiple, de-duplicated, first-seen order", () => {
    const body = "Fixes #5\n\nAlso closes #9 and resolves #5 again.";
    expect(extractClosedIssues(body)).toEqual([5, 9]);
  });

  it("handles cross-repo owner/repo#N form (repo ignored)", () => {
    expect(extractClosedIssues("Closes octo/repo#42")).toEqual([42]);
  });

  it("does NOT match a bare `#N` without a keyword", () => {
    expect(extractClosedIssues("See #99 for context")).toEqual([]);
  });

  it("does NOT match keyword-substrings like `discloses`", () => {
    expect(extractClosedIssues("This discloses #5")).toEqual([]);
    expect(extractClosedIssues("prefixes #6")).toEqual([]);
  });

  it("honors a custom keyword set", () => {
    expect(extractClosedIssues("Closes #1", ["done"])).toEqual([]);
    expect(extractClosedIssues("done #1", ["done"])).toEqual([1]);
  });

  it("ignores an empty custom keyword set", () => {
    expect(extractClosedIssues("Closes #1", [])).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// computeChainOps — no-op paths
// ────────────────────────────────────────────────────────────────────────────

describe("computeChainOps: no-op paths", () => {
  it("returns no ops when the PR body references no issue", () => {
    const input: ChainInput = { prBody: "just a refactor", openIssues: [] };
    const r = computeChainOps(input, CFG);
    expect(r.closedIssues).toEqual([]);
    expect(r.ops).toEqual([]);
  });

  it("returns no ops when there are no blocked/dependent issues", () => {
    const input: ChainInput = {
      prBody: "Closes #10",
      openIssues: [issue(20, "unrelated", [])],
    };
    expect(computeChainOps(input, CFG).ops).toEqual([]);
  });

  it("reports closedIssues even when there are no ops", () => {
    const input: ChainInput = { prBody: "Closes #10", openIssues: [] };
    expect(computeChainOps(input, CFG).closedIssues).toEqual([10]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// computeChainOps — unblocking dependents
// ────────────────────────────────────────────────────────────────────────────

describe("computeChainOps: unblock dependents", () => {
  it("unblocks a blocked dependent whose only blocker just closed", () => {
    const input: ChainInput = {
      prBody: "Closes #100",
      openIssues: [issue(200, "next phase\n<!-- depends-on: #100 -->", ["blocked"])],
    };
    const r = computeChainOps(input, CFG);
    expect(r.ops).toEqual([
      {
        kind: "unblock",
        issue: 200,
        removeLabels: ["blocked"],
        addLabels: ["ready"],
        unblockedBy: [100],
      },
    ]);
  });

  it("skips issues that lack the blocked label (when configured)", () => {
    const input: ChainInput = {
      prBody: "Closes #100",
      openIssues: [issue(200, "<!-- depends-on: #100 -->", [])],
    };
    expect(computeChainOps(input, CFG).ops).toEqual([]);
  });

  it("considers all open issues candidates when no blockedLabel is set", () => {
    const cfg: ChainConfig = { readyLabel: "ready" };
    const input: ChainInput = {
      prBody: "Closes #100",
      openIssues: [issue(200, "<!-- depends-on: #100 -->", [])],
    };
    const r = computeChainOps(input, cfg);
    expect(r.ops).toEqual([
      {
        kind: "unblock",
        issue: 200,
        removeLabels: [],
        addLabels: ["ready"],
        unblockedBy: [100],
      },
    ]);
  });

  it("does NOT unblock when another declared dependency is still open", () => {
    const input: ChainInput = {
      prBody: "Closes #100",
      openIssues: [
        issue(200, "<!-- depends-on: #100 -->\n<!-- depends-on: #101 -->", ["blocked"]),
        issue(101, "still open blocker", []), // #101 remains open
      ],
    };
    // #200 depends on #100 (closed) AND #101 (still open) → stays blocked.
    expect(computeChainOps(input, CFG).ops).toEqual([]);
  });

  it("unblocks when the last of several dependencies closes (others already gone)", () => {
    const input: ChainInput = {
      prBody: "Closes #100",
      openIssues: [
        // #101 is NOT in openIssues → already closed. Only #100 was open-ish.
        issue(200, "<!-- depends-on: #100 -->\n<!-- depends-on: #101 -->", ["blocked"]),
      ],
    };
    const r = computeChainOps(input, CFG);
    expect(r.ops).toHaveLength(1);
    expect(r.ops[0]).toMatchObject({ kind: "unblock", issue: 200, unblockedBy: [100] });
  });

  it("does not unblock a dependent whose depends-on points elsewhere", () => {
    const input: ChainInput = {
      prBody: "Closes #100",
      openIssues: [issue(200, "<!-- depends-on: #999 -->", ["blocked"])],
    };
    expect(computeChainOps(input, CFG).ops).toEqual([]);
  });

  it("unblocks multiple dependents of one closed issue", () => {
    const input: ChainInput = {
      prBody: "Closes #1",
      openIssues: [
        issue(2, "<!-- depends-on: #1 -->", ["blocked"]),
        issue(3, "<!-- depends-on: #1 -->", ["blocked"]),
      ],
    };
    const nums = computeChainOps(input, CFG).ops.map((o) => o.issue);
    expect(nums.sort()).toEqual([2, 3]);
  });

  it("handles a PR closing multiple issues at once", () => {
    const input: ChainInput = {
      prBody: "Closes #1\nFixes #2",
      openIssues: [
        issue(10, "<!-- depends-on: #1 -->", ["blocked"]),
        issue(11, "<!-- depends-on: #2 -->", ["blocked"]),
      ],
    };
    const r = computeChainOps(input, CFG);
    expect(r.closedIssues).toEqual([1, 2]);
    expect(r.ops.map((o) => o.issue).sort()).toEqual([10, 11]);
  });

  it("does not match #10 when the closed issue is #1 (digit boundary)", () => {
    const input: ChainInput = {
      prBody: "Closes #1",
      openIssues: [issue(200, "<!-- depends-on: #10 -->", ["blocked"])],
    };
    expect(computeChainOps(input, CFG).ops).toEqual([]);
  });

  it("does not match #1 when body has #100 for closed #1 (reverse boundary)", () => {
    const input: ChainInput = {
      prBody: "Closes #1",
      openIssues: [issue(200, "<!-- depends-on: #100 -->", ["blocked"])],
    };
    expect(computeChainOps(input, CFG).ops).toEqual([]);
  });

  it("tolerates whitespace variance inside the marker", () => {
    const bodies = [
      "<!--depends-on:#100-->",
      "<!--   depends-on:   #100   -->",
      "<!-- depends-on:\t#100 -->",
    ];
    for (const b of bodies) {
      const input: ChainInput = {
        prBody: "Closes #100",
        openIssues: [issue(200, b, ["blocked"])],
      };
      expect(computeChainOps(input, CFG).ops, b).toHaveLength(1);
    }
  });

  it("does not unblock the closed issue itself if it appears in openIssues", () => {
    // Snapshot taken before GitHub flips state: #100 still appears open.
    const input: ChainInput = {
      prBody: "Closes #100",
      openIssues: [issue(100, "<!-- depends-on: #100 -->", ["blocked"])],
    };
    expect(computeChainOps(input, CFG).ops).toEqual([]);
  });

  it("tolerates null/empty issue bodies", () => {
    const input: ChainInput = {
      prBody: "Closes #100",
      openIssues: [
        { number: 5, body: null, labels: ["blocked"] },
        { number: 6, body: undefined, labels: ["blocked"] },
      ],
    };
    expect(computeChainOps(input, CFG).ops).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// computeChainOps — closing parents
// ────────────────────────────────────────────────────────────────────────────

describe("computeChainOps: close parents", () => {
  it("closes a parent when its last sub-issue closes", () => {
    const input: ChainInput = {
      prBody: "Closes #50",
      openIssues: [
        // The closed sub-issue #50 still visible in the snapshot, pointing to parent #3.
        issue(50, "<!-- parent: #3 -->", ["blocked"]),
        // No OTHER open issue points at #3.
        issue(3, "tracking parent", []),
      ],
    };
    const r = computeChainOps(input, CFG);
    expect(r.ops).toEqual([
      {
        kind: "close-parent",
        issue: 3,
        comment: "All phases complete. Closing tracking issue #3.",
      },
    ]);
  });

  it("does NOT close a parent while sibling sub-issues remain open", () => {
    const input: ChainInput = {
      prBody: "Closes #50",
      openIssues: [
        issue(50, "<!-- parent: #3 -->", []),
        issue(51, "<!-- parent: #3 -->", []), // sibling still open
        issue(3, "tracking parent", []),
      ],
    };
    const ops = computeChainOps(input, CFG).ops;
    expect(ops.some((o) => o.kind === "close-parent")).toBe(false);
  });

  it("emits no comment when parentCloseComment is not configured", () => {
    const cfg: ChainConfig = { ...CFG, parentCloseComment: undefined };
    const input: ChainInput = {
      prBody: "Closes #50",
      openIssues: [issue(50, "<!-- parent: #3 -->", [])],
    };
    const op = computeChainOps(input, cfg).ops.find((o) => o.kind === "close-parent");
    expect(op).toMatchObject({ kind: "close-parent", issue: 3 });
    expect((op as { comment?: string }).comment).toBeUndefined();
  });

  it("de-duplicates a parent referenced by multiple just-closed sub-issues", () => {
    const input: ChainInput = {
      prBody: "Closes #50\nCloses #51",
      openIssues: [
        issue(50, "<!-- parent: #3 -->", []),
        issue(51, "<!-- parent: #3 -->", []),
      ],
    };
    const parentOps = computeChainOps(input, CFG).ops.filter(
      (o) => o.kind === "close-parent",
    );
    expect(parentOps).toHaveLength(1);
    expect(parentOps[0]!.issue).toBe(3);
  });

  it("does not close a parent that is itself being closed by the PR", () => {
    const input: ChainInput = {
      prBody: "Closes #50\nCloses #3",
      openIssues: [issue(50, "<!-- parent: #3 -->", [])],
    };
    const parentOps = computeChainOps(input, CFG).ops.filter(
      (o) => o.kind === "close-parent",
    );
    expect(parentOps).toEqual([]);
  });

  it("closed sub-issue with no parent marker produces no close-parent op", () => {
    const input: ChainInput = {
      prBody: "Closes #50",
      openIssues: [issue(50, "no parent here", [])],
    };
    expect(
      computeChainOps(input, CFG).ops.some((o) => o.kind === "close-parent"),
    ).toBe(false);
  });

  it("uses a custom parent marker template", () => {
    const cfg: ChainConfig = {
      ...CFG,
      parentMarker: "[parent:{n}]",
    };
    const input: ChainInput = {
      prBody: "Closes #50",
      openIssues: [issue(50, "epic [parent:3]", [])],
    };
    const op = computeChainOps(input, cfg).ops.find((o) => o.kind === "close-parent");
    expect(op?.issue).toBe(3);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Combined end-to-end scenario mirroring the original workflow
// ────────────────────────────────────────────────────────────────────────────

describe("computeChainOps: combined scenario", () => {
  it("unblocks a dependent AND closes the parent in one pass", () => {
    // PR closes sub-issue #260 (phase 1). #261 (phase 2) depends on it and is
    // blocked. #260 is the last sub-issue of parent #100.
    const input: ChainInput = {
      prBody: "Implements phase 1.\n\nCloses #260",
      openIssues: [
        issue(260, "Phase 1\n<!-- parent: #100 -->", ["blocked"]),
        issue(261, "Phase 2\n<!-- depends-on: #260 -->\n<!-- parent: #100 -->", ["blocked"]),
        issue(100, "Tracking epic", []),
      ],
    };
    const r = computeChainOps(input, CFG);

    const unblock = r.ops.find((o) => o.kind === "unblock");
    expect(unblock).toMatchObject({ issue: 261, removeLabels: ["blocked"], addLabels: ["ready"] });

    // #261 (still open) points at parent #100, so the parent must NOT close yet.
    expect(r.ops.some((o) => o.kind === "close-parent")).toBe(false);
  });

  it("closes the parent once the final phase (with no open siblings) merges", () => {
    const input: ChainInput = {
      prBody: "Closes #261",
      openIssues: [
        // #260 already closed/removed from snapshot. #261 is the last child.
        issue(261, "Phase 2\n<!-- parent: #100 -->", ["blocked"]),
        issue(100, "Tracking epic", []),
      ],
    };
    const r = computeChainOps(input, CFG);
    const parentOp = r.ops.find((o) => o.kind === "close-parent");
    expect(parentOp?.issue).toBe(100);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Marker template validation
// ────────────────────────────────────────────────────────────────────────────

describe("marker template validation", () => {
  it("throws if dependsOnMarker lacks the {n} token", () => {
    const cfg: ChainConfig = { ...CFG, dependsOnMarker: "<!-- depends-on -->" };
    const input: ChainInput = {
      prBody: "Closes #1",
      openIssues: [issue(2, "<!-- depends-on -->", ["blocked"])],
    };
    expect(() => computeChainOps(input, cfg)).toThrow(/token/);
  });

  it("throws if parentMarker lacks the {n} token", () => {
    const cfg: ChainConfig = { ...CFG, parentMarker: "<!-- parent -->" };
    const input: ChainInput = {
      prBody: "Closes #1",
      openIssues: [issue(1, "<!-- parent -->", [])],
    };
    expect(() => computeChainOps(input, cfg)).toThrow(/token/);
  });
});
