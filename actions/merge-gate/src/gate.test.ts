import { describe, it, expect } from "vitest";
import {
  evaluateMergeGate,
  globMatch,
  handWrittenAdditions,
  firstProtectedPath,
  parseTimestamp,
  normalizePolicyKeys,
  filterCandidateNumbers,
  isApprovalBody,
  type PullRequestFacts,
  type MergePolicy,
} from "./gate.js";

describe("normalizePolicyKeys (snake_case policy support)", () => {
  it("converts snake_case keys to camelCase recursively", () => {
    const out = normalizePolicyKeys({
      branch_prefix: "agent/",
      approval_delay_minutes: 30,
      exclude_globs: ["**/dist/**"],
      max_additions: 600,
    }) as Record<string, unknown>;
    expect(out.branchPrefix).toBe("agent/");
    expect(out.approvalDelayMinutes).toBe(30);
    expect(out.maxAdditions).toBe(600);
    expect(out.excludeGlobs).toEqual(["**/dist/**"]); // values (globs) untouched
  });
  it("leaves already-camelCase keys unchanged", () => {
    const out = normalizePolicyKeys({ branchPrefix: "x", approvalBodyRegex: "Verdict.*APPROVE" }) as Record<string, unknown>;
    expect(out.branchPrefix).toBe("x");
    expect(out.approvalBodyRegex).toBe("Verdict.*APPROVE");
  });
});

describe("filterCandidateNumbers", () => {
  const prs = [
    { number: 1, headRefName: "agent/1-a" },
    { number: 2, headRefName: "feature/x" },
    { number: 3, headRefName: "agent/3-c" },
  ];
  it("filters by branch prefix, preserving order", () => {
    expect(filterCandidateNumbers(prs, "agent/")).toEqual([1, 3]);
  });
  it("returns all when no prefix", () => {
    expect(filterCandidateNumbers(prs)).toEqual([1, 2, 3]);
  });
});

describe("isApprovalBody", () => {
  it("matches a comment/review verdict body", () => {
    expect(isApprovalBody("## Critic\n\n**Verdict:** APPROVE", "Verdict.*APPROVE")).toBe(true);
    expect(isApprovalBody("**Verdict:** REQUEST_CHANGES", "Verdict.*APPROVE")).toBe(false);
  });
  it("is false for empty body or no regex", () => {
    expect(isApprovalBody("", "Verdict.*APPROVE")).toBe(false);
    expect(isApprovalBody("**Verdict:** APPROVE", undefined)).toBe(false);
  });
});

// A fixed "now" for deterministic delay math.
const NOW = Date.parse("2026-07-01T12:00:00Z");
const minsAgo = (m: number) => new Date(NOW - m * 60000).toISOString();

/** A fully-passing PR; individual tests override one field to fail a gate. */
function readyPr(overrides: Partial<PullRequestFacts> = {}): PullRequestFacts {
  return {
    number: 42,
    title: "Add widget",
    headRefName: "agent/add-widget",
    labels: [],
    ciStatus: "passing",
    approvedAt: minsAgo(60),
    files: [{ path: "src/widget.ts", additions: 100, deletions: 3 }],
    cleanRebase: true,
    ...overrides,
  };
}

/** A representative policy mirroring the dixie Shipper, but parameterized. */
const policy: MergePolicy = {
  branchPrefix: "agent/",
  approvalDelayMinutes: 30,
  maxAdditions: 1200,
  excludeGlobs: ["gen/**"],
  protectedPaths: [
    "db/migrations/",
    ".github/workflows/",
    "terraform/",
    "CLAUDE.md",
    "scope.yaml",
  ],
  blockingLabels: ["needs-human", "rebase-needed"],
  requireCi: true,
  requireCleanRebase: true,
  labels: { needsHuman: "needs-human", rebaseNeeded: "rebase-needed" },
};

describe("evaluateMergeGate — happy path", () => {
  it("merges a fully-qualifying PR", () => {
    const d = evaluateMergeGate(readyPr(), policy, NOW);
    expect(d.action).toBe("merge");
    expect(d.code).toBe("ready-to-merge");
    expect(d.detail?.handAdditions).toBe(100);
    expect(d.detail?.minutesSinceApproval).toBe(60);
  });
});

describe("blocking labels", () => {
  it("skips a PR with a blocking label", () => {
    const d = evaluateMergeGate(readyPr({ labels: ["needs-human"] }), policy, NOW);
    expect(d.action).toBe("skip");
    expect(d.code).toBe("blocking-label");
    expect(d.reason).toContain("needs-human");
  });

  it("skips on rebase-needed label too", () => {
    const d = evaluateMergeGate(readyPr({ labels: ["rebase-needed"] }), policy, NOW);
    expect(d.code).toBe("blocking-label");
  });

  it("ignores unrelated labels", () => {
    const d = evaluateMergeGate(readyPr({ labels: ["enhancement", "audit-log"] }), policy, NOW);
    expect(d.action).toBe("merge");
  });

  it("blocking label wins even when other gates would also fail", () => {
    const d = evaluateMergeGate(
      readyPr({ labels: ["needs-human"], ciStatus: "failing", approvedAt: null }),
      policy,
      NOW,
    );
    expect(d.code).toBe("blocking-label");
  });
});

describe("branch prefix", () => {
  it("skips a PR on a non-agent branch", () => {
    const d = evaluateMergeGate(readyPr({ headRefName: "feature/x" }), policy, NOW);
    expect(d.action).toBe("skip");
    expect(d.code).toBe("wrong-branch");
  });

  it("accepts any branch when no prefix is configured", () => {
    const { branchPrefix, ...noPrefix } = policy;
    const d = evaluateMergeGate(readyPr({ headRefName: "feature/x" }), noPrefix, NOW);
    expect(d.action).toBe("merge");
  });
});

describe("bot-approval present", () => {
  it("skips when approvedAt is null", () => {
    const d = evaluateMergeGate(readyPr({ approvedAt: null }), policy, NOW);
    expect(d.code).toBe("not-approved");
  });

  it("skips when approvedAt is undefined", () => {
    const d = evaluateMergeGate(readyPr({ approvedAt: undefined }), policy, NOW);
    expect(d.code).toBe("not-approved");
  });

  it("skips when approvedAt is an empty string", () => {
    const d = evaluateMergeGate(readyPr({ approvedAt: "" }), policy, NOW);
    expect(d.code).toBe("not-approved");
  });

  it("skips when approvedAt is unparseable", () => {
    const d = evaluateMergeGate(readyPr({ approvedAt: "not-a-date" }), policy, NOW);
    expect(d.code).toBe("not-approved");
    expect(d.reason).toContain("unparseable");
  });
});

describe("approval delay", () => {
  it("skips when approval is too recent", () => {
    const d = evaluateMergeGate(readyPr({ approvedAt: minsAgo(10) }), policy, NOW);
    expect(d.action).toBe("skip");
    expect(d.code).toBe("approval-delay");
    expect(d.detail?.minutesSinceApproval).toBe(10);
    expect(d.reason).toContain("need 30m");
  });

  it("merges exactly at the delay boundary", () => {
    const d = evaluateMergeGate(readyPr({ approvedAt: minsAgo(30) }), policy, NOW);
    expect(d.action).toBe("merge");
  });

  it("accepts an epoch-ms number approvedAt", () => {
    const d = evaluateMergeGate(readyPr({ approvedAt: NOW - 45 * 60000 }), policy, NOW);
    expect(d.action).toBe("merge");
    expect(d.detail?.minutesSinceApproval).toBe(45);
  });

  it("default policy has zero delay", () => {
    const d = evaluateMergeGate(
      readyPr({ approvedAt: minsAgo(0), headRefName: "x" }),
      { requireCleanRebase: false },
      NOW,
    );
    expect(d.action).toBe("merge");
  });
});

describe("CI status", () => {
  it.each(["failing", "pending", "unknown"] as const)("skips when CI is %s", (ci) => {
    const d = evaluateMergeGate(readyPr({ ciStatus: ci }), policy, NOW);
    expect(d.action).toBe("skip");
    expect(d.code).toBe("ci-not-passing");
  });

  it("ignores CI when requireCi is false", () => {
    const d = evaluateMergeGate(readyPr({ ciStatus: "failing" }), { ...policy, requireCi: false }, NOW);
    expect(d.action).toBe("merge");
  });
});

describe("hand-written additions gate", () => {
  it("labels needs-human when too large", () => {
    const d = evaluateMergeGate(
      readyPr({ files: [{ path: "src/big.ts", additions: 1500 }] }),
      policy,
      NOW,
    );
    expect(d.action).toBe("label");
    expect(d.code).toBe("too-large");
    expect(d.label).toBe("needs-human");
    expect(d.detail?.handAdditions).toBe(1500);
  });

  it("excludes generated files from the count", () => {
    const d = evaluateMergeGate(
      readyPr({
        files: [
          { path: "src/small.ts", additions: 200 },
          { path: "gen/proto/foo.pb.ts", additions: 5000 },
        ],
      }),
      policy,
      NOW,
    );
    expect(d.action).toBe("merge");
    expect(d.detail?.handAdditions).toBe(200);
  });

  it("boundary: exactly at limit is allowed", () => {
    const d = evaluateMergeGate(
      readyPr({ files: [{ path: "src/x.ts", additions: 1200 }] }),
      policy,
      NOW,
    );
    expect(d.action).toBe("merge");
  });

  it("one over the limit is blocked", () => {
    const d = evaluateMergeGate(
      readyPr({ files: [{ path: "src/x.ts", additions: 1201 }] }),
      policy,
      NOW,
    );
    expect(d.code).toBe("too-large");
  });

  it("skips (no label) when no needsHuman label configured", () => {
    const { labels, ...noLabels } = policy;
    const d = evaluateMergeGate(
      readyPr({ files: [{ path: "src/x.ts", additions: 5000 }] }),
      noLabels,
      NOW,
    );
    expect(d.action).toBe("skip");
    expect(d.code).toBe("too-large");
    expect(d.label).toBeUndefined();
  });

  it("no size limit means never too-large", () => {
    const d = evaluateMergeGate(
      readyPr({ files: [{ path: "src/x.ts", additions: 999999 }] }),
      { ...policy, maxAdditions: undefined },
      NOW,
    );
    expect(d.action).toBe("merge");
  });
});

describe("protected paths gate", () => {
  it("labels needs-human on a protected dir prefix", () => {
    const d = evaluateMergeGate(
      readyPr({ files: [{ path: "db/migrations/001_init.sql", additions: 10 }] }),
      policy,
      NOW,
    );
    expect(d.action).toBe("label");
    expect(d.code).toBe("protected-path");
    expect(d.label).toBe("needs-human");
    expect(d.detail?.protectedPath).toBe("db/migrations/");
  });

  it("matches an exact protected file", () => {
    const d = evaluateMergeGate(
      readyPr({ files: [{ path: "CLAUDE.md", additions: 4 }] }),
      policy,
      NOW,
    );
    expect(d.code).toBe("protected-path");
    expect(d.detail?.protectedPath).toBe("CLAUDE.md");
  });

  it("does not match a merely similar path", () => {
    const d = evaluateMergeGate(
      readyPr({ files: [{ path: "docs/db/migrations-guide.md", additions: 4 }] }),
      policy,
      NOW,
    );
    expect(d.action).toBe("merge");
  });

  it("size gate is evaluated before protected paths", () => {
    const d = evaluateMergeGate(
      readyPr({ files: [{ path: "db/migrations/x.sql", additions: 5000 }] }),
      policy,
      NOW,
    );
    expect(d.code).toBe("too-large");
  });
});

describe("clean rebase gate", () => {
  it("labels rebase-needed on conflicts", () => {
    const d = evaluateMergeGate(readyPr({ cleanRebase: false }), policy, NOW);
    expect(d.action).toBe("label");
    expect(d.code).toBe("rebase-needed");
    expect(d.label).toBe("rebase-needed");
    expect(d.reason).toContain("conflicts");
  });

  it("labels rebase-needed when rebase not yet verified", () => {
    const d = evaluateMergeGate(readyPr({ cleanRebase: undefined }), policy, NOW);
    expect(d.code).toBe("rebase-needed");
    expect(d.reason).toContain("not yet verified");
  });

  it("skips (no label) when no rebaseNeeded label configured", () => {
    const { labels, ...noLabels } = policy;
    const d = evaluateMergeGate(readyPr({ cleanRebase: false }), noLabels, NOW);
    expect(d.action).toBe("skip");
    expect(d.code).toBe("rebase-needed");
    expect(d.label).toBeUndefined();
  });

  it("ignores rebase when requireCleanRebase is false", () => {
    const d = evaluateMergeGate(
      readyPr({ cleanRebase: undefined }),
      { ...policy, requireCleanRebase: false },
      NOW,
    );
    expect(d.action).toBe("merge");
  });
});

describe("gate ordering", () => {
  it("checks approval before CI", () => {
    const d = evaluateMergeGate(readyPr({ approvedAt: null, ciStatus: "failing" }), policy, NOW);
    expect(d.code).toBe("not-approved");
  });

  it("checks CI before size", () => {
    const d = evaluateMergeGate(
      readyPr({ ciStatus: "failing", files: [{ path: "x", additions: 9999 }] }),
      policy,
      NOW,
    );
    expect(d.code).toBe("ci-not-passing");
  });

  it("checks protected path before rebase", () => {
    const d = evaluateMergeGate(
      readyPr({ files: [{ path: "terraform/main.tf", additions: 5 }], cleanRebase: false }),
      policy,
      NOW,
    );
    expect(d.code).toBe("protected-path");
  });
});

describe("empty policy defaults", () => {
  it("merges an approved+clean PR with a bare policy", () => {
    const d = evaluateMergeGate(readyPr(), {}, NOW);
    expect(d.action).toBe("merge");
  });

  it("still requires CI and rebase by default", () => {
    expect(evaluateMergeGate(readyPr({ ciStatus: "failing" }), {}, NOW).code).toBe("ci-not-passing");
    expect(evaluateMergeGate(readyPr({ cleanRebase: false }), {}, NOW).code).toBe("rebase-needed");
  });
});

// ── unit tests for the pure helpers ────────────────────────────────────────

describe("globMatch", () => {
  it("dir prefix matches files underneath", () => {
    expect(globMatch("gen/", "gen/proto/foo.ts")).toBe(true);
    expect(globMatch("gen/", "gen")).toBe(true);
    expect(globMatch("gen/", "generated/x")).toBe(false);
  });

  it("** matches across segments", () => {
    expect(globMatch("gen/**", "gen/a/b/c.ts")).toBe(true);
    expect(globMatch("gen/**", "gen")).toBe(false);
    expect(globMatch("**/*.pb.go", "a/b/foo.pb.go")).toBe(true);
    expect(globMatch("**/*.pb.go", "foo.pb.go")).toBe(true);
  });

  it("* stays within a segment", () => {
    expect(globMatch("src/*.ts", "src/a.ts")).toBe(true);
    expect(globMatch("src/*.ts", "src/sub/a.ts")).toBe(false);
  });

  it("? matches a single non-slash char", () => {
    expect(globMatch("a?c", "abc")).toBe(true);
    expect(globMatch("a?c", "a/c")).toBe(false);
  });

  it("literal (no metachar) is a prefix match", () => {
    expect(globMatch("scope.yaml", "scope.yaml")).toBe(true);
    expect(globMatch("scope.yaml", "scope.yaml.bak")).toBe(true);
    expect(globMatch("scope.yaml", "other.yaml")).toBe(false);
  });

  it("escapes regex metacharacters in literals", () => {
    expect(globMatch("a.b/", "a.b/x")).toBe(true);
    expect(globMatch("a.b/", "axb/x")).toBe(false);
  });
});

describe("handWrittenAdditions", () => {
  it("sums non-excluded additions", () => {
    expect(
      handWrittenAdditions(
        [
          { path: "src/a.ts", additions: 10 },
          { path: "gen/b.ts", additions: 100 },
          { path: "src/c.ts", additions: 5 },
        ],
        ["gen/**"],
      ),
    ).toBe(15);
  });

  it("counts everything when no excludes", () => {
    expect(handWrittenAdditions([{ path: "gen/x", additions: 7 }])).toBe(7);
  });
});

describe("firstProtectedPath", () => {
  it("returns the first matching pattern in policy order", () => {
    expect(
      firstProtectedPath(
        [{ path: "terraform/main.tf", additions: 1 }],
        ["db/migrations/", "terraform/"],
      ),
    ).toBe("terraform/");
  });

  it("returns undefined when nothing is protected", () => {
    expect(firstProtectedPath([{ path: "src/x.ts", additions: 1 }], ["terraform/"])).toBeUndefined();
  });
});

describe("parseTimestamp", () => {
  it("passes numbers through", () => {
    expect(parseTimestamp(1234)).toBe(1234);
  });
  it("parses ISO strings", () => {
    expect(parseTimestamp("2026-07-01T12:00:00Z")).toBe(Date.parse("2026-07-01T12:00:00Z"));
  });
  it("treats a numeric string as epoch ms", () => {
    expect(parseTimestamp("1700000000000")).toBe(1700000000000);
  });
  it("returns NaN for garbage", () => {
    expect(Number.isNaN(parseTimestamp("nope"))).toBe(true);
  });
});
