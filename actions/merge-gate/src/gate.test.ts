import { describe, it, expect } from "vitest";
import {
  evaluateMergeGate,
  checkVerdict,
  validateHandoffClauses,
  escalationLabel,
  standingChangeRequests,
  latestAttemptPerCheck,
  globMatch,
  handWrittenAdditions,
  firstProtectedPath,
  parseTimestamp,
  normalizePolicyKeys,
  filterCandidateNumbers,
  isApprovalBody,
  isCountableVerdict,
  parseRequiredCheck,
  describeCheckRunsFailure,
  type CheckRunFact,
  filterCountableVerdicts,
  latestValidApproval,
  parseDependabotBump,
  DEPENDABOT_LOGIN,
  type PullRequestFacts,
  type MergePolicy,
  type VerdictEvent,
  checkConclusion,
  filterEvaluateCandidates,
  isOpenThread,
  latestHeadVerdictIsEscalation,
  awaitingApprover,
  failingClauses,
  type ReviewThreadFact,
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

  it("skips (no label) when no awaitingApproval label is configured", () => {
    // policy has no labels.awaitingApproval — back-compat: a silent skip.
    const d = evaluateMergeGate(readyPr({ approvedAt: null }), policy, NOW);
    expect(d.action).toBe("skip");
    expect(d.label).toBeUndefined();
  });
});

describe("awaiting-approval label (#12559)", () => {
  const labeledPolicy: MergePolicy = {
    ...policy,
    labels: { ...policy.labels, awaitingApproval: "awaiting-approval" },
  };

  it("labels a ready-but-unapproved PR instead of skipping silently", () => {
    const d = evaluateMergeGate(readyPr({ approvedAt: null }), labeledPolicy, NOW);
    expect(d.action).toBe("label");
    expect(d.code).toBe("not-approved");
    expect(d.label).toBe("awaiting-approval");
  });

  it("labels on an unparseable approval timestamp too", () => {
    const d = evaluateMergeGate(readyPr({ approvedAt: "not-a-date" }), labeledPolicy, NOW);
    expect(d.action).toBe("label");
    expect(d.label).toBe("awaiting-approval");
  });

  it("does NOT label once the PR is approved — it proceeds to merge", () => {
    const d = evaluateMergeGate(readyPr(), labeledPolicy, NOW);
    expect(d.action).toBe("merge");
    expect(d.label).toBeUndefined();
  });

  it("a blocking reason still wins over the awaiting-approval label", () => {
    const d = evaluateMergeGate(readyPr({ approvedAt: null, labels: ["needs-human"] }), labeledPolicy, NOW);
    expect(d.code).toBe("blocking-label");
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

  describe("protectedPathExcludeGlobs", () => {
    const tests = ["**/*_test.go", "**/testdata/**"];
    it("a diff only of excluded files under a protected path is not protected", () => {
      const files = [{ path: "pkg/auth/token_test.go", additions: 40 }, { path: "pkg/auth/testdata/a.json", additions: 5 }];
      expect(firstProtectedPath(files, ["pkg/auth/"], tests)).toBeUndefined();
    });
    it("one non-excluded file under the protected path still is", () => {
      const files = [{ path: "pkg/auth/token_test.go", additions: 40 }, { path: "pkg/auth/token.go", additions: 1 }];
      expect(firstProtectedPath(files, ["pkg/auth/"], tests)).toBe("pkg/auth/");
    });
    it("is read from merge.yaml as protected_path_exclude_globs", () => {
      const policy = normalizePolicyKeys({ protected_paths: ["pkg/auth/"], protected_path_exclude_globs: tests }) as MergePolicy;
      expect(policy.protectedPathExcludeGlobs).toEqual(tests);
      expect(firstProtectedPath([{ path: "pkg/auth/x_test.go", additions: 1 }], policy.protectedPaths, policy.protectedPathExcludeGlobs)).toBeUndefined();
    });
    it("a rename counts both paths: out of a protected path, or onto an excluded name, is still protected", () => {
      expect(firstProtectedPath([{ path: "src/init.sql", previousPath: "db/migrations/0001_init.sql", additions: 0 }], ["db/migrations/"])).toBe("db/migrations/");
      expect(firstProtectedPath([{ path: "pkg/auth/x_test.go", previousPath: "pkg/auth/x.go", additions: 0 }], ["pkg/auth/"], tests)).toBe("pkg/auth/");
      // A test file renamed to another test file stays excluded.
      expect(firstProtectedPath([{ path: "pkg/auth/y_test.go", previousPath: "pkg/auth/x_test.go", additions: 0 }], ["pkg/auth/"], tests)).toBeUndefined();
    });
    it("empty or absent: unchanged", () => {
      const files = [{ path: "pkg/auth/token_test.go", additions: 1 }];
      expect(firstProtectedPath(files, ["pkg/auth/"])).toBe("pkg/auth/");
      expect(firstProtectedPath(files, ["pkg/auth/"], [])).toBe("pkg/auth/");
    });
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

// ── the approval is a real gate ────────────────────────────────────────────

describe("required checks (a human gate must be able to BLOCK)", () => {
  const withChecks = (checkRuns: { name: string; status?: string; conclusion?: string }[]) =>
    evaluateMergeGate(
      readyPr({ checkRuns }),
      { ...policy, requiredChecks: ["human-approval"] },
      NOW,
    );

  it("blocks when the required check never reported", () => {
    const d = withChecks([{ name: "ci", status: "completed", conclusion: "success" }]);
    expect(d.action).toBe("skip");
    expect(d.code).toBe("required-check-missing");
    expect(d.detail?.requiredCheck).toBe("human-approval");
  });

  it("blocks while the required check is still pending", () => {
    const d = withChecks([{ name: "human-approval", status: "in_progress" }]);
    expect(d.code).toBe("required-check-missing");
  });

  it("blocks when the required check failed", () => {
    const d = withChecks([{ name: "human-approval", status: "completed", conclusion: "failure" }]);
    expect(d.code).toBe("required-check-missing");
  });

  it("merges once the required check is green", () => {
    const d = withChecks([{ name: "human-approval", status: "completed", conclusion: "success" }]);
    expect(d.action).toBe("merge");
  });

  it("takes the newest report when a check re-ran", () => {
    expect(
      withChecks([
        { name: "human-approval", status: "completed", conclusion: "failure" },
        { name: "human-approval", status: "completed", conclusion: "success" },
      ]).action,
    ).toBe("merge");
  });

  it("is inert when no requiredChecks are configured", () => {
    expect(evaluateMergeGate(readyPr({ checkRuns: [] }), policy, NOW).action).toBe("merge");
  });

  it("is checked after CI and before the size gate", () => {
    const d = evaluateMergeGate(
      readyPr({ ciStatus: "failing", checkRuns: [] }),
      { ...policy, requiredChecks: ["human-approval"] },
      NOW,
    );
    expect(d.code).toBe("ci-not-passing");
    const e = evaluateMergeGate(
      readyPr({ checkRuns: [], files: [{ path: "x", additions: 9999 }] }),
      { ...policy, requiredChecks: ["human-approval"] },
      NOW,
    );
    expect(e.code).toBe("required-check-missing");
  });
});

describe("verdict trust (who is allowed to approve)", () => {
  const approve = (e: Partial<VerdictEvent> = {}): VerdictEvent => ({
    at: "2026-01-01T00:00:00Z",
    kind: "approve",
    sha: "head",
    source: "review",
    ...e,
  });

  it("counts the bot's own review verdict", () => {
    expect(isCountableVerdict(approve({ author: "my-agent[bot]" }), { botLogin: "my-agent[bot]" })).toBe(true);
  });

  it("counts a review from someone with write access", () => {
    expect(isCountableVerdict(approve({ author: "maintainer", authorAssociation: "MEMBER" }), {})).toBe(true);
  });

  it("REJECTS an approval from a drive-by contributor", () => {
    expect(isCountableVerdict(approve({ author: "stranger", authorAssociation: "NONE" }), { botLogin: "bot" })).toBe(false);
    expect(isCountableVerdict(approve({ author: "stranger", authorAssociation: "CONTRIBUTOR" }), {})).toBe(false);
  });

  it("REJECTS a comment approval unless the channel is enabled", () => {
    const c = approve({ author: "maintainer", authorAssociation: "OWNER", source: "comment", sha: null });
    expect(isCountableVerdict(c, {})).toBe(false);
    expect(isCountableVerdict(c, { allowCommentApprovals: true })).toBe(true);
  });

  it("still requires trust on the comment channel when enabled", () => {
    const c = approve({ author: "stranger", authorAssociation: "NONE", source: "comment", sha: null });
    expect(isCountableVerdict(c, { allowCommentApprovals: true })).toBe(false);
  });

  it("counts rejections from anyone (they can only hold a merge back)", () => {
    const r: VerdictEvent = { at: "x", kind: "reject", author: "stranger", authorAssociation: "NONE", source: "review" };
    expect(isCountableVerdict(r, { botLogin: "bot" })).toBe(true);
  });

  it("honors a custom trusted-association set", () => {
    const e = approve({ author: "x", authorAssociation: "COLLABORATOR" });
    expect(isCountableVerdict(e, { trustedAuthorAssociations: ["OWNER"] })).toBe(false);
  });

  it("filterCountableVerdicts keeps order and drops the untrusted ones", () => {
    const events: VerdictEvent[] = [
      approve({ at: "1", author: "bot" }),
      approve({ at: "2", author: "stranger", authorAssociation: "NONE" }),
      { at: "3", kind: "reject", author: "stranger", authorAssociation: "NONE", source: "review" },
    ];
    const kept = filterCountableVerdicts(events, { botLogin: "bot" });
    expect(kept.map((e) => e.at)).toEqual(["1", "3"]);
  });

  it("an attacker's approve comment cannot override the bot's REQUEST_CHANGES", () => {
    // The exact escalation from the report: reviewer rejects, attacker comments
    // the verdict string, poller merges. With the trust filter the attacker's
    // event never reaches the latest-verdict-wins rule.
    const events: VerdictEvent[] = [
      { at: "2026-01-01T00:00:00Z", kind: "reject", sha: "head", author: "bot", source: "review" },
      { at: "2026-01-01T01:00:00Z", kind: "approve", author: "stranger", authorAssociation: "NONE", source: "comment" },
    ];
    const kept = filterCountableVerdicts(events, { botLogin: "bot" });
    expect(latestValidApproval(kept, "head")).toBeNull();
  });
});

describe("required checks are pinned to their author (a name proves nothing)", () => {
  const run = (o: Partial<CheckRunFact> = {}): CheckRunFact => ({
    name: "human-approval",
    status: "completed",
    conclusion: "success",
    appSlug: "github-actions",
    ...o,
  });
  const gate = (checkRuns: CheckRunFact[], required: string[]) =>
    evaluateMergeGate(readyPr({ checkRuns }), { ...policy, requiredChecks: required }, NOW);

  it("parses the name@app form", () => {
    expect(parseRequiredCheck("human-approval@github-actions")).toEqual({
      name: "human-approval",
      appSlug: "github-actions",
    });
    expect(parseRequiredCheck("ci/build")).toEqual({ name: "ci/build" });
    // A leading @ is part of the name, not a pin (scoped npm-style check names).
    expect(parseRequiredCheck("@scope/check")).toEqual({ name: "@scope/check" });
  });

  it("merges when the pinned app published the check", () => {
    expect(gate([run()], ["human-approval@github-actions"]).action).toBe("merge");
  });

  it("REJECTS a green check of the right name from another app", () => {
    // The escalation: an agent lane holding the harness App token publishes its
    // own "human approval" on its own head SHA.
    const d = gate([run({ appSlug: "gp-foundry-agent" })], ["human-approval@github-actions"]);
    expect(d.action).toBe("skip");
    expect(d.code).toBe("required-check-missing");
    expect(d.reason).toContain("wrong app");
  });

  it("REJECTS a check with no recorded author when an author is pinned", () => {
    expect(gate([run({ appSlug: null })], ["human-approval@github-actions"]).action).toBe("skip");
  });

  it("still accepts any author when the entry is an unpinned name", () => {
    expect(gate([run({ appSlug: "circleci" })], ["human-approval"]).action).toBe("merge");
  });

  it("matches the app slug case-insensitively", () => {
    expect(gate([run({ appSlug: "GitHub-Actions" })], ["human-approval@github-actions"]).action).toBe("merge");
  });
});

describe("check-runs permission failure explains the wiring, not a nonexistent scope", () => {
  it("turns GitHub's flat 403 into an actionable cause", () => {
    const msg = describeCheckRunsFailure({
      status: 403,
      message: "Resource not accessible by personal access token",
    });
    // The fix is wiring GITHUB_TOKEN through, NOT granting a PAT permission --
    // fine-grained PATs have no Checks permission to grant.
    expect(msg).toContain("checks-token");
    expect(msg).toContain("gp-foundry build");
    expect(msg).toContain("require_ci: false");
    expect(msg).not.toMatch(/add checks: read to/i);
    // Keep GitHub's own words too -- the operator may be searching for them.
    expect(msg).toContain("Resource not accessible by personal access token");
  });

  it("covers 404, which is what a token without visibility gets", () => {
    expect(describeCheckRunsFailure({ status: 404, message: "Not Found" })).toContain("checks-token");
  });

  it("does not blame permissions for an unrelated failure", () => {
    const msg = describeCheckRunsFailure({ status: 502, message: "Bad gateway" });
    expect(msg).toContain("Bad gateway");
    expect(msg).not.toContain("checks-token");
  });
});

describe("parseDependabotBump", () => {
  it("classifies patch / minor / major", () => {
    expect(parseDependabotBump("Bump lodash from 4.17.20 to 4.17.21")).toBe("patch");
    expect(parseDependabotBump("Bump lodash from 4.17.20 to 4.18.0")).toBe("minor");
    expect(parseDependabotBump("Bump react-router from 6.22.3 to 7.5.2 in /react")).toBe("major");
    expect(parseDependabotBump("Bump axios from 0.28.0 to 1.8.2 in /icebreaker")).toBe("major");
  });
  it("tolerates a v prefix and prerelease/build suffixes", () => {
    expect(parseDependabotBump("Bump pkg from v1.2.3 to v1.2.4")).toBe("patch");
    expect(parseDependabotBump("Bump pkg from 1.2.3-beta.1 to 1.3.0")).toBe("minor");
  });
  it("is unknown for group updates, non-semver, or missing titles", () => {
    expect(parseDependabotBump("Bump the babel group with 5 updates")).toBe("unknown");
    expect(parseDependabotBump("Bump pkg from latest to newest")).toBe("unknown");
    expect(parseDependabotBump(undefined)).toBe("unknown");
  });
});

describe("dependabot lane (#deps)", () => {
  const dependabotPolicy: MergePolicy = {
    ...policy,
    dependabot: { autoMerge: ["patch", "minor"] },
  };
  /** A dependabot PR: verified author, lockfile-only, CI green, no approval. */
  function dependabotPr(overrides: Partial<PullRequestFacts> = {}): PullRequestFacts {
    return {
      number: 900,
      title: "Bump lodash from 4.17.20 to 4.17.21",
      headRefName: "dependabot/npm_and_yarn/lodash-4.17.21",
      authorLogin: DEPENDABOT_LOGIN,
      dependabotUpdateType: "patch",
      labels: [],
      ciStatus: "passing",
      approvedAt: null, // no human approval — the lane doesn't need one
      files: [{ path: "yarn.lock", additions: 40, deletions: 12 }],
      cleanRebase: true,
      ...overrides,
    };
  }

  it("auto-merges a patch bump with green CI and no human approval", () => {
    const d = evaluateMergeGate(dependabotPr(), dependabotPolicy, NOW);
    expect(d.action).toBe("merge");
    expect(d.code).toBe("dependabot-ready");
  });

  it("auto-merges a minor bump", () => {
    const d = evaluateMergeGate(dependabotPr({ dependabotUpdateType: "minor" }), dependabotPolicy, NOW);
    expect(d.action).toBe("merge");
  });

  it("routes a major bump to a human", () => {
    const d = evaluateMergeGate(dependabotPr({ dependabotUpdateType: "major" }), dependabotPolicy, NOW);
    expect(d.action).toBe("label");
    expect(d.code).toBe("dependabot-review");
    expect(d.label).toBe("needs-human");
  });

  it("routes an unknown/group update to a human", () => {
    const d = evaluateMergeGate(dependabotPr({ dependabotUpdateType: "unknown" }), dependabotPolicy, NOW);
    expect(d.code).toBe("dependabot-review");
    expect(d.label).toBe("needs-human");
  });

  it("routes failing CI to a human, but waits on pending CI", () => {
    const failing = evaluateMergeGate(dependabotPr({ ciStatus: "failing" }), dependabotPolicy, NOW);
    expect(failing.action).toBe("label");
    expect(failing.code).toBe("ci-not-passing");
    const pending = evaluateMergeGate(dependabotPr({ ciStatus: "pending" }), dependabotPolicy, NOW);
    expect(pending.action).toBe("skip");
    expect(pending.code).toBe("ci-not-passing");
  });

  it("routes a protected-path touch to a human", () => {
    const d = evaluateMergeGate(
      dependabotPr({ files: [{ path: ".github/workflows/ci.yml", additions: 2, deletions: 0 }] }),
      dependabotPolicy,
      NOW,
    );
    expect(d.code).toBe("protected-path");
    expect(d.label).toBe("needs-human");
  });

  it("does NOT trust the branch name — a non-dependabot author on a dependabot/ branch falls to the agent lane", () => {
    const d = evaluateMergeGate(
      dependabotPr({ authorLogin: "mallory", dependabotUpdateType: undefined }),
      dependabotPolicy,
      NOW,
    );
    expect(d.code).toBe("wrong-branch"); // agent lane rejects the dependabot/ prefix
  });

  it("is a silent skip when the dependabot lane is not configured", () => {
    const d = evaluateMergeGate(dependabotPr(), policy, NOW); // policy has no dependabot block
    expect(d.action).toBe("skip");
    expect(d.code).toBe("dependabot-disabled");
  });

  it("still honors blocking labels ahead of the lane", () => {
    const d = evaluateMergeGate(dependabotPr({ labels: ["needs-human"] }), dependabotPolicy, NOW);
    expect(d.code).toBe("blocking-label");
  });

  it("only auto-merges the configured levels (patch-only policy holds a minor)", () => {
    const patchOnly: MergePolicy = { ...policy, dependabot: { autoMerge: ["patch"] } };
    expect(evaluateMergeGate(dependabotPr(), patchOnly, NOW).action).toBe("merge");
    const minor = evaluateMergeGate(dependabotPr({ dependabotUpdateType: "minor" }), patchOnly, NOW);
    expect(minor.code).toBe("dependabot-review");
  });

  it("includes dependabot/ branches as candidates only when the lane is on", () => {
    const prs = [
      { number: 1, headRefName: "agent/foo" },
      { number: 2, headRefName: "dependabot/npm_and_yarn/lodash" },
      { number: 3, headRefName: "feature/bar" },
    ];
    expect(filterCandidateNumbers(prs, "agent/", true)).toEqual([1, 2]);
    expect(filterCandidateNumbers(prs, "agent/", false)).toEqual([1]);
  });
});

describe("latestAttemptPerCheck (range-labs/mono#12952)", () => {
  const run = (id: number, name: string, conclusion: string, slug = "github-actions") => ({
    id,
    name,
    status: "completed",
    conclusion,
    app: { slug },
  });

  it("drops a superseded failed attempt of the same check, keeping the newer green one", () => {
    // A workflow_dispatch suite (cancelled → failure) alongside the re-driven pull_request suite.
    const out = latestAttemptPerCheck([run(10, "docker_build", "cancelled"), run(42, "docker_build", "success")]);
    expect(out.map((c) => c.conclusion)).toEqual(["success"]);
  });

  it("keeps a newer failure over an older success — a real regression still blocks", () => {
    const out = latestAttemptPerCheck([run(42, "go_unit_tests", "success"), run(50, "go_unit_tests", "failure")]);
    expect(out.map((c) => c.conclusion)).toEqual(["failure"]);
  });

  it("treats the same name from a different app as a different check", () => {
    const out = latestAttemptPerCheck([run(10, "lint", "failure", "other-ci"), run(42, "lint", "success")]);
    expect(out).toHaveLength(2);
  });

  it("leaves distinct checks alone", () => {
    const out = latestAttemptPerCheck([run(1, "a", "success"), run(2, "b", "failure")]);
    expect(out.map((c) => c.name).sort()).toEqual(["a", "b"]);
  });
});

// ── evaluate-mode clauses ────────────────────────────────────────────────────

describe("require_no_open_threads", () => {
  const AUTHOR = "fletch-bot[bot]";
  const threadPolicy: MergePolicy = {
    ...policy,
    requireNoOpenThreads: true,
    botLogins: ["greptile-apps[bot]", "cursor[bot]"],
  };
  const thread = (over: Partial<ReviewThreadFact> = {}): ReviewThreadFact => ({
    isResolved: false,
    path: "src/a.ts",
    line: 3,
    comments: [{ author: "alice", body: "This leaks the handle." }],
    ...over,
  });
  const pr = (threads: ReviewThreadFact[]) => readyPr({ authorLogin: AUTHOR, reviewThreads: threads });

  it("blocks on an unresolved thread a human opened", () => {
    const d = evaluateMergeGate(pr([thread()]), threadPolicy, NOW);
    expect(d.code).toBe("open-threads");
    expect(d.action).toBe("skip");
    expect(d.detail?.openThreads).toBe(1);
  });
  it("ignores a resolved thread", () => {
    expect(evaluateMergeGate(pr([thread({ isResolved: true })]), threadPolicy, NOW).code).toBe("ready-to-merge");
  });
  it("ignores a thread the author replied in (GraphQL login without [bot])", () => {
    const t = thread({ comments: [{ author: "alice", body: "Leak." }, { author: "fletch-bot", body: "Fixed in abc." }] });
    expect(evaluateMergeGate(pr([t]), threadPolicy, NOW).code).toBe("ready-to-merge");
  });
  it("ignores a thread whose first comment the author reacted to", () => {
    const t = thread({ firstCommentReactions: [{ content: "THUMBS_UP", user: "fletch-bot" }] });
    expect(evaluateMergeGate(pr([t]), threadPolicy, NOW).code).toBe("ready-to-merge");
  });
  it("still blocks when only someone else replied or reacted", () => {
    const t = thread({
      comments: [{ author: "alice", body: "Leak." }, { author: "bob", body: "+1" }],
      firstCommentReactions: [{ content: "THUMBS_UP", user: "bob" }],
    });
    expect(isOpenThread(t, AUTHOR, threadPolicy)).toBe(true);
  });
  it("never blocks on a thread the author opened", () => {
    expect(isOpenThread(thread({ comments: [{ author: AUTHOR, body: "note to self" }] }), AUTHOR, threadPolicy)).toBe(false);
  });
  it("ignores a review bot's P2 thread", () => {
    const t = thread({ comments: [{ author: "greptile-apps", body: "**P2** Consider renaming." }] });
    expect(evaluateMergeGate(pr([t]), threadPolicy, NOW).code).toBe("ready-to-merge");
  });
  it("blocks on a review bot's P1 thread", () => {
    const t = thread({ comments: [{ author: "greptile-apps[bot]", body: "**P1** Null deref on the error path." }] });
    expect(evaluateMergeGate(pr([t]), threadPolicy, NOW).code).toBe("open-threads");
  });
  it("blocks on a Cursor High Severity thread, honouring a custom regex", () => {
    const t = thread({ comments: [{ author: "cursor[bot]", body: "### Bug\n**High Severity**" }] });
    expect(isOpenThread(t, AUTHOR, threadPolicy)).toBe(true);
    expect(isOpenThread(t, AUTHOR, { ...threadPolicy, botThreadBlockingRegex: "Critical" })).toBe(false);
  });
  it("is off by default", () => {
    expect(evaluateMergeGate(pr([thread()]), policy, NOW).code).toBe("ready-to-merge");
  });
});

describe("require_no_review_requests", () => {
  it("blocks while a reviewer or team is still requested", () => {
    const d = evaluateMergeGate(readyPr({ requestedReviewers: ["alice", "team:core"] }), { ...policy, requireNoReviewRequests: true }, NOW);
    expect(d.code).toBe("review-requested");
    expect(d.reason).toContain("team:core");
    expect(d.detail?.requestedReviewers).toEqual(["alice", "team:core"]);
  });
  it("passes with no pending requests", () => {
    expect(evaluateMergeGate(readyPr({ requestedReviewers: [] }), { ...policy, requireNoReviewRequests: true }, NOW).code).toBe("ready-to-merge");
  });
  it("is off by default", () => {
    expect(evaluateMergeGate(readyPr({ requestedReviewers: ["alice"] }), policy, NOW).code).toBe("ready-to-merge");
  });
});

describe("evaluate-mode check conclusion", () => {
  const markers = {
    approval: /\*\*Verdict:\*\* APPROVE$/,
    rejection: /\*\*Verdict:\*\* REQUEST_CHANGES$/,
    escalation: /\*\*Verdict:\*\* ESCALATE$/,
  };
  const trust = { botLogin: "fletch-bot[bot]" };
  const review = (at: string, body: string, over: Record<string, unknown> = {}) => ({
    at, sha: "head", author: "fletch-bot[bot]", authorAssociation: "NONE", body, ...over,
  });

  it("maps merge to success and anything else to failure", () => {
    expect(checkConclusion(evaluateMergeGate(readyPr(), policy, NOW), {})).toBe("success");
    expect(checkConclusion(evaluateMergeGate(readyPr({ ciStatus: "failing" }), policy, NOW), {})).toBe("failure");
  });
  it("maps an escalation to action_required, even over a would-merge decision", () => {
    expect(checkConclusion(evaluateMergeGate(readyPr({ approvedAt: null }), policy, NOW), { escalated: true })).toBe("action_required");
    expect(checkConclusion(evaluateMergeGate(readyPr(), policy, NOW), { escalated: true })).toBe("action_required");
  });
  it("reads the bot's latest verdict on the head, trailing newline and all", () => {
    expect(latestHeadVerdictIsEscalation([review("2026-01-01T00:00:00Z", "Needs a human.\n\n**Verdict:** ESCALATE\n")], "head", trust, markers)).toBe(true);
    // A later approval on the same head supersedes the escalation.
    expect(
      latestHeadVerdictIsEscalation(
        [review("2026-01-01T00:00:00Z", "**Verdict:** ESCALATE"), review("2026-01-01T01:00:00Z", "**Verdict:** APPROVE")],
        "head", trust, markers,
      ),
    ).toBe(false);
    // A non-verdict review after the escalation does not hide it.
    expect(
      latestHeadVerdictIsEscalation(
        [review("2026-01-01T00:00:00Z", "**Verdict:** ESCALATE"), review("2026-01-01T01:00:00Z", "a note")],
        "head", trust, markers,
      ),
    ).toBe(true);
  });
  it("ignores escalations on another head, from untrusted authors, or not on the last line", () => {
    expect(latestHeadVerdictIsEscalation([review("2026-01-01T00:00:00Z", "**Verdict:** ESCALATE", { sha: "old" })], "head", trust, markers)).toBe(false);
    expect(latestHeadVerdictIsEscalation([review("2026-01-01T00:00:00Z", "**Verdict:** ESCALATE", { author: "mallory", authorAssociation: "NONE" })], "head", trust, markers)).toBe(false);
    expect(latestHeadVerdictIsEscalation([review("2026-01-01T00:00:00Z", "quoting `**Verdict:** ESCALATE` here\nbut no")], "head", trust, markers)).toBe(false);
  });
});

describe("failingClauses", () => {
  it("is empty when the gate would merge", () => {
    expect(failingClauses(readyPr(), policy, NOW)).toEqual([]);
  });
  it("lists every failing clause in gate order, not just the first", () => {
    const pr = readyPr({
      approvedAt: null,
      ciStatus: "pending",
      requestedReviewers: ["alice"],
      files: [{ path: "src/big.ts", additions: 1400 }],
    });
    const codes = failingClauses(pr, { ...policy, requireNoReviewRequests: true }, NOW).map((d) => d.code);
    expect(codes).toEqual(["not-approved", "ci-not-passing", "review-requested", "too-large"]);
    // evaluateMergeGate still returns only the first.
    expect(evaluateMergeGate(pr, { ...policy, requireNoReviewRequests: true }, NOW).code).toBe("not-approved");
  });
  it("does not report an approval delay for a missing approval", () => {
    expect(failingClauses(readyPr({ approvedAt: null }), policy, NOW).map((d) => d.code)).toEqual(["not-approved"]);
    expect(failingClauses(readyPr({ approvedAt: minsAgo(5) }), policy, NOW).map((d) => d.code)).toEqual(["approval-delay"]);
  });
  it("agrees with evaluateMergeGate on the first failing clause", () => {
    const cases: Partial<PullRequestFacts>[] = [
      { labels: ["needs-human"], approvedAt: null },
      { headRefName: "feature/x", ciStatus: "failing" },
      { approvedAt: "not a date" },
      { ciStatus: "failing", cleanRebase: false },
      { files: [{ path: "db/migrations/1.sql", additions: 1 }], cleanRebase: null },
      { cleanRebase: false },
    ];
    for (const c of cases) {
      const pr = readyPr(c);
      expect(failingClauses(pr, policy, NOW)[0]).toEqual(evaluateMergeGate(pr, policy, NOW));
    }
  });
});

describe("no_verdict_conclusion: neutral", () => {
  const waiting = readyPr({ approvedAt: null });
  const p: MergePolicy = { ...policy, requireNoOpenThreads: true, requireNoReviewRequests: true };
  const neutral = (pr: PullRequestFacts, pol: MergePolicy = p) => {
    const d = evaluateMergeGate(pr, pol, NOW);
    return checkConclusion(d, pr, { awaitingApprover: awaitingApprover(pr, pol, NOW) !== undefined });
  };
  const thread: ReviewThreadFact = { isResolved: false, comments: [{ author: "alice", body: "This leaks." }] };

  it("is neutral with nothing else failing", () => {
    expect(awaitingApprover(waiting, p, NOW)).toEqual([]);
    expect(neutral(waiting)).toBe("neutral");
    // Also with an approval delay: a missing approval is not "approved too recently".
    expect(neutral(waiting, { ...p, approvalDelayMinutes: 600 })).toBe("neutral");
  });
  it("is neutral while CI runs, naming the CI clause", () => {
    const pr = readyPr({ approvedAt: null, ciStatus: "pending" });
    expect(neutral(pr)).toBe("neutral");
    expect(awaitingApprover(pr, p, NOW)?.map((d) => d.code)).toEqual(["ci-not-passing"]);
  });
  it("is neutral with an open thread, carrying the thread count", () => {
    const pr = readyPr({ approvedAt: null, reviewThreads: [thread, thread] });
    expect(neutral(pr)).toBe("neutral");
    expect(awaitingApprover(pr, p, NOW)).toEqual([expect.objectContaining({ code: "open-threads", detail: { openThreads: 2 } })]);
  });
  it("lists every other failing clause", () => {
    const pr = readyPr({
      approvedAt: null,
      ciStatus: "failing",
      reviewThreads: [thread],
      requestedReviewers: ["team:core"],
      files: [{ path: "db/migrations/1.sql", additions: 1400 }],
    });
    expect(neutral(pr)).toBe("neutral");
    expect(awaitingApprover(pr, p, NOW)?.map((d) => d.code)).toEqual([
      "ci-not-passing", "review-requested", "open-threads", "too-large", "protected-path",
    ]);
  });
  it("is failure when the reviewer rejected the head, whatever else holds", () => {
    expect(neutral(readyPr({ approvedAt: null, headVerdict: "reject" }))).toBe("failure");
    expect(awaitingApprover(readyPr({ approvedAt: null, headVerdict: "reject" }), p, NOW)).toBeUndefined();
  });
  it("is failure for an approved head with another clause failing", () => {
    const pr = readyPr({ headVerdict: "approve", ciStatus: "failing" });
    const d = evaluateMergeGate(pr, p, NOW);
    expect(d.code).toBe("ci-not-passing");
    expect(neutral(pr)).toBe("failure");
  });
  it("leaves success and escalation alone", () => {
    expect(neutral(readyPr({ headVerdict: "approve" }))).toBe("success");
    expect(neutral(readyPr({ approvedAt: null, escalated: true, headVerdict: "escalate" }))).toBe("action_required");
    expect(neutral(readyPr({ approvedAt: null, ciStatus: "pending", escalated: true, headVerdict: "escalate" }))).toBe("action_required");
  });
  it("is off unless asked for", () => {
    const d = evaluateMergeGate(waiting, policy, NOW);
    expect(checkConclusion(d, waiting)).toBe("failure");
  });
});

describe("trusted_author_associations: [] — only the bot's verdicts count", () => {
  const trust = { botLogin: "fletch-bot[bot]", trustedAuthorAssociations: [] as string[] };
  const approve = (author: string, authorAssociation: string): VerdictEvent => ({ at: "2026-01-01T00:00:00Z", kind: "approve", sha: "head", author, authorAssociation, source: "review" });
  it("drops an OWNER's approval and keeps the bot's", () => {
    expect(isCountableVerdict(approve("dpup", "OWNER"), trust)).toBe(false);
    expect(isCountableVerdict(approve("Fletch-Bot[bot]", "NONE"), trust)).toBe(true);
    expect(latestValidApproval(filterCountableVerdicts([approve("dpup", "OWNER")], trust), "head")).toBeNull();
    expect(latestValidApproval(filterCountableVerdicts([approve("fletch-bot[bot]", "NONE")], trust), "head")).not.toBeNull();
  });
  it("drops every non-bot approval when no bot login is set either", () => {
    expect(isCountableVerdict(approve("dpup", "OWNER"), { trustedAuthorAssociations: [] })).toBe(false);
  });
  it("still counts rejections from anyone (they can only hold a merge back)", () => {
    expect(isCountableVerdict({ ...approve("dpup", "OWNER"), kind: "reject" }, trust)).toBe(true);
  });
});

describe("filterEvaluateCandidates", () => {
  const pr = (number: number, over: Record<string, unknown> = {}) => ({
    number, headRefName: "agent/x", draft: false, authorLogin: "fletch-bot[bot]", authorType: "Bot", labels: [] as string[], ...over,
  });
  it("keeps open, non-draft PRs on the prefix", () => {
    expect(filterEvaluateCandidates([pr(1), pr(2, { draft: true }), pr(3, { headRefName: "feature/y" })], "agent/", false)).toEqual([1]);
  });
  it("applies authors, the opt-in label, skip labels and bot authors", () => {
    const prs = [pr(1), pr(2, { authorLogin: "Alice", authorType: "User" }), pr(3, { authorLogin: "eve", authorType: "User", labels: ["agent-review"] }), pr(4, { authorLogin: "eve", authorType: "User" })];
    expect(filterEvaluateCandidates(prs, "agent/", false, { authors: ["alice"], optInLabel: "agent-review" })).toEqual([2, 3]);
    expect(filterEvaluateCandidates(prs, "agent/", false, { skipLabels: ["agent-review"] })).toEqual([1, 2, 4]);
    const bots = [pr(1), pr(2, { authorLogin: "renovate[bot]" })];
    expect(filterEvaluateCandidates(bots, "agent/", false, { skipBotAuthors: true, botLogin: "fletch-bot[bot]" })).toEqual([1]);
  });
});

describe("escalation labels: a person decides, verdict or not", () => {
  const p: MergePolicy = { ...policy, escalationLabels: ["needs-human-decision"], noVerdictConclusion: "neutral" };
  const labelled = (over: Partial<PullRequestFacts> = {}) => readyPr({ labels: ["needs-human-decision"], ...over });

  it("never merges a PR that carries one, however ready it is", () => {
    const d = evaluateMergeGate(labelled(), p, NOW);
    expect(d.action).toBe("skip");
    expect(d.code).toBe("escalated");
    expect(d.reason).toContain("needs-human-decision");
    // Without the label the same PR merges.
    expect(evaluateMergeGate(readyPr(), p, NOW).action).toBe("merge");
  });

  it("stops the dependabot lane too", () => {
    const d = evaluateMergeGate(labelled({ authorLogin: DEPENDABOT_LOGIN, dependabotUpdateType: "patch" }), { ...p, dependabot: { enabled: true } } as MergePolicy, NOW);
    expect(d.code).toBe("escalated");
  });

  it("is listed among the failing clauses, in gate order after blocking labels", () => {
    const codes = failingClauses(labelled({ ciStatus: "failing" }), p, NOW).map((d) => d.code);
    expect(codes).toEqual(["escalated", "ci-not-passing"]);
  });

  it("the check is action_required — not neutral, even with no verdict yet", () => {
    // The caller sets `escalated` from the label (see gatherFacts); an unapproved
    // head would otherwise read "awaiting the approver".
    const facts = labelled({ approvedAt: null, escalated: true });
    expect(awaitingApprover(facts, p, NOW)).toBeUndefined();
    const decision = evaluateMergeGate(facts, p, NOW);
    expect(checkConclusion(decision, facts, { awaitingApprover: false })).toBe("action_required");
  });

  it("is distinct from a blocking label, and off unless configured", () => {
    expect(escalationLabel({ labels: ["needs-human"] }, p)).toBeUndefined();
    expect(escalationLabel({ labels: ["needs-human-decision"] }, policy)).toBeUndefined();
    expect(evaluateMergeGate(labelled(), policy, NOW).action).toBe("merge");
  });
});

describe("standing change requests", () => {
  const r = (author: string, state: string, at: string) => ({ author, state, at });

  it("is each reviewer's latest decision, the way GitHub's merge box counts it", () => {
    expect(
      standingChangeRequests([
        r("alice", "CHANGES_REQUESTED", "2026-01-01T00:00:00Z"),
        r("bob", "CHANGES_REQUESTED", "2026-01-01T00:00:00Z"),
        r("bob", "APPROVED", "2026-01-02T00:00:00Z"), // bob came round
        r("carol", "APPROVED", "2026-01-01T00:00:00Z"),
        r("carol", "CHANGES_REQUESTED", "2026-01-03T00:00:00Z"), // carol changed her mind
      ]),
    ).toEqual(["alice", "carol"]);
  });

  it("a later comment does not clear a block; a dismissal does", () => {
    const blocked = [r("alice", "CHANGES_REQUESTED", "2026-01-01T00:00:00Z"), r("alice", "COMMENTED", "2026-01-02T00:00:00Z")];
    expect(standingChangeRequests(blocked)).toEqual(["alice"]);
    expect(standingChangeRequests([...blocked, r("alice", "DISMISSED", "2026-01-03T00:00:00Z")])).toEqual([]);
  });

  it("leaves the harness bot out: its request is a verdict, cleared by a later verdict", () => {
    const reviews = [r("Agent-Bot[bot]", "CHANGES_REQUESTED", "2026-01-01T00:00:00Z"), r("alice", "CHANGES_REQUESTED", "2026-01-01T00:00:00Z")];
    expect(standingChangeRequests(reviews, "agent-bot[bot]")).toEqual(["alice"]);
    expect(standingChangeRequests(reviews)).toEqual(["Agent-Bot[bot]", "alice"]);
  });

  it("holds the gate only when the policy asks for it", () => {
    const facts = readyPr({ changesRequestedBy: ["alice"] });
    expect(evaluateMergeGate(facts, policy, NOW).action).toBe("merge"); // today's behaviour: latest verdict wins
    const d = evaluateMergeGate(facts, { ...policy, requireNoHumanChangesRequested: true }, NOW);
    expect(d.action).toBe("skip");
    expect(d.code).toBe("changes-requested");
    expect(d.reason).toContain("`alice`");
    expect(evaluateMergeGate(readyPr({ changesRequestedBy: [] }), { ...policy, requireNoHumanChangesRequested: true }, NOW).action).toBe("merge");
  });
});

describe("checkVerdict: policy handoffs", () => {
  const p: MergePolicy = { ...policy, handoffClauses: ["protected-path", "too-large"] };
  const touching = (over: Partial<PullRequestFacts> = {}) =>
    readyPr({ files: [{ path: "db/migrations/1.sql", additions: 3, deletions: 0 }], ...over });
  const signoff = { reviewer: "bob", sha: "abc1234def" };

  it("without handoff_clauses it is exactly the original rule", () => {
    const v = checkVerdict(touching(), policy, NOW);
    expect(v.conclusion).toBe("failure");
    expect(v.decision.code).toBe("protected-path");
    expect(v.outstanding).toEqual([]);
    expect(checkVerdict(readyPr(), policy, NOW).conclusion).toBe("success");
  });

  it("an outstanding handoff on its own is action_required", () => {
    const v = checkVerdict(touching(), p, NOW);
    expect(v.conclusion).toBe("action_required");
    expect(v.outstanding.map((d) => d.code)).toEqual(["protected-path"]);
  });

  it("a sign-off clears only the handoff clauses", () => {
    const v = checkVerdict(touching({ signoff }), p, NOW);
    expect(v.conclusion).toBe("success");
    expect(v.signedOff.map((d) => d.code)).toEqual(["protected-path"]);
    const red = checkVerdict(touching({ signoff, ciStatus: "failing" }), p, NOW);
    expect(red.conclusion).toBe("failure");
    expect(red.decision.code).toBe("ci-not-passing");
  });

  it("covers both handoff clauses at once", () => {
    const big = touching({ files: [{ path: "db/migrations/1.sql", additions: 5000, deletions: 0 }] });
    expect(checkVerdict(big, p, NOW).outstanding.map((d) => d.code)).toEqual(["too-large", "protected-path"]);
    expect(checkVerdict({ ...big, signoff }, p, NOW).conclusion).toBe("success");
  });

  it("never clears an escalation", () => {
    expect(checkVerdict(touching({ signoff, escalated: true }), p, NOW).conclusion).toBe("action_required");
  });

  it("an outstanding handoff with another failure is a failure", () => {
    expect(checkVerdict(touching({ ciStatus: "failing" }), p, NOW).conclusion).toBe("failure");
  });

  it("does not change the merge decision", () => {
    expect(evaluateMergeGate(touching({ signoff }), p, NOW).action).not.toBe("merge");
  });

  it("validates the clause list", () => {
    expect(validateHandoffClauses(undefined)).toBeUndefined();
    expect(validateHandoffClauses(["too-large"])).toEqual(["too-large"]);
    expect(() => validateHandoffClauses(["not-approved"])).toThrow(/cannot be a handoff/);
    expect(() => validateHandoffClauses("protected-path")).toThrow(/must be a list/);
  });
});
