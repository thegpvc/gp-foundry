import { describe, it, expect } from "vitest";
import { formatContext, type ContextData } from "./formatters.js";

// --- Fixtures ---

const issueData: ContextData = {
  issue: {
    title: "Test issue",
    body: "Issue body text",
    labels: [{ name: "bug" }, { name: "agent" }],
  },
  comments: [
    { user: { login: "dpup" }, created_at: "2026-03-23T10:00:00Z", body: "A comment" },
  ],
};

const prData: ContextData = {
  pr: {
    title: "Fix the thing",
    body: "PR body",
    changed_files: 3,
    additions: 50,
    deletions: 10,
  },
  comments: [
    { user: { login: "dpup" }, created_at: "2026-03-23T10:00:00Z", body: "Looks good" },
  ],
  reviews: [
    { user: { login: "bot" }, state: "COMMENTED", submitted_at: "2026-03-23T05:17:09Z", body: "Review body" },
  ],
  inlineComments: [
    { user: { login: "dpup" }, path: "src/main.ts", line: 42, body: "Fix this" },
  ],
  diff: "diff --git a/src/main.ts b/src/main.ts\n--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1 +1 @@\n-old\n+new",
};

// --- Tests ---

describe("formatContext - issue", () => {
  it("produces an issue header with number, title, labels, and body", () => {
    const result = formatContext(issueData, { type: "issue", number: 44 });
    expect(result).toContain("=== ISSUE #44 ===");
    expect(result).toContain("Title: Test issue");
    expect(result).toContain("Labels: bug, agent");
    expect(result).toContain("Body:");
    expect(result).toContain("Issue body text");
  });

  it("produces a comments section with count and comment entries", () => {
    const result = formatContext(issueData, { type: "issue", number: 44 });
    expect(result).toContain("=== COMMENTS (1) ===");
    expect(result).toContain("[dpup] 2026-03-23T10:00:00Z");
    expect(result).toContain("A comment");
  });

  it("omits comments section when there are no comments", () => {
    const data: ContextData = { ...issueData, comments: [] };
    const result = formatContext(data, { type: "issue", number: 44 });
    expect(result).not.toContain("=== COMMENTS");
  });

  it("omits labels line when issue has no labels", () => {
    const data: ContextData = {
      ...issueData,
      issue: { ...issueData.issue!, labels: [] },
    };
    const result = formatContext(data, { type: "issue", number: 44 });
    expect(result).not.toContain("Labels:");
  });

  it("supports string labels as well as objects", () => {
    const data: ContextData = {
      ...issueData,
      issue: { ...issueData.issue!, labels: ["bug", "agent"] },
    };
    const result = formatContext(data, { type: "issue", number: 44 });
    expect(result).toContain("Labels: bug, agent");
  });
});

describe("formatContext - pr-review", () => {
  it("produces a PR header with number, title, body, and file stats", () => {
    const result = formatContext(prData, { type: "pr-review", number: 10 });
    expect(result).toContain("=== PR #10 ===");
    expect(result).toContain("Title: Fix the thing");
    expect(result).toContain("PR body");
    expect(result).toContain("Files: 3 changed");
    expect(result).toContain("+50");
    expect(result).toContain("-10");
  });

  it("includes comments, reviews, inline comments, and diff sections", () => {
    const result = formatContext(prData, { type: "pr-review", number: 10 });
    expect(result).toContain("=== COMMENTS (1) ===");
    expect(result).toContain("[dpup] 2026-03-23T10:00:00Z");
    expect(result).toContain("Looks good");

    expect(result).toContain("=== REVIEWS (1) ===");
    expect(result).toContain("[bot] COMMENTED 2026-03-23T05:17:09Z");
    expect(result).toContain("Review body");

    expect(result).toContain("=== INLINE REVIEW COMMENTS (1) ===");
    expect(result).toContain("[dpup] src/main.ts:42");
    expect(result).toContain("Fix this");

    expect(result).toContain("=== DIFF ===");
    expect(result).toContain("diff --git");
  });
});

describe("formatContext - pr-full", () => {
  it("behaves the same as pr-review (includes all sections)", () => {
    const result = formatContext(prData, { type: "pr-full", number: 10 });
    expect(result).toContain("=== PR #10 ===");
    expect(result).toContain("=== COMMENTS (1) ===");
    expect(result).toContain("=== REVIEWS (1) ===");
    expect(result).toContain("=== INLINE REVIEW COMMENTS (1) ===");
    expect(result).toContain("=== DIFF ===");
  });
});

describe("formatContext - pr-diff", () => {
  it("produces PR header and diff only — no comments, reviews, or inline", () => {
    const result = formatContext(prData, { type: "pr-diff", number: 10 });
    expect(result).toContain("=== PR #10 ===");
    expect(result).toContain("=== DIFF ===");
    expect(result).not.toContain("=== COMMENTS");
    expect(result).not.toContain("=== REVIEWS");
    expect(result).not.toContain("=== INLINE REVIEW COMMENTS");
  });
});

describe("formatContext - empty sections omitted", () => {
  it("omits reviews section when empty", () => {
    const data: ContextData = { ...prData, reviews: [] };
    const result = formatContext(data, { type: "pr-review", number: 10 });
    expect(result).not.toContain("=== REVIEWS");
  });

  it("omits inline comments section when empty", () => {
    const data: ContextData = { ...prData, inlineComments: [] };
    const result = formatContext(data, { type: "pr-review", number: 10 });
    expect(result).not.toContain("=== INLINE REVIEW COMMENTS");
  });

  it("omits diff section when diff is empty or missing", () => {
    const data: ContextData = { ...prData, diff: "" };
    const result = formatContext(data, { type: "pr-review", number: 10 });
    expect(result).not.toContain("=== DIFF ===");
  });

  it("shows (no body) for reviews with no body", () => {
    const data: ContextData = {
      ...prData,
      reviews: [
        { user: { login: "dpup" }, state: "CHANGES_REQUESTED", submitted_at: "2026-03-23T16:51:56Z", body: "" },
      ],
    };
    const result = formatContext(data, { type: "pr-review", number: 10 });
    expect(result).toContain("(no body)");
  });
});

describe("formatContext - triggering comment", () => {
  it("adds a TRIGGERING COMMENT section at the end when provided", () => {
    const result = formatContext(issueData, {
      type: "issue",
      number: 44,
      triggeringComment: "@my-agent please fix the review feedback",
    });
    expect(result).toContain("=== TRIGGERING COMMENT ===");
    expect(result).toContain("@my-agent please fix the review feedback");
    const trigIdx = result.indexOf("=== TRIGGERING COMMENT ===");
    const issueIdx = result.indexOf("=== ISSUE #44 ===");
    expect(trigIdx).toBeGreaterThan(issueIdx);
  });

  it("does not add triggering comment section when not provided", () => {
    const result = formatContext(issueData, { type: "issue", number: 44 });
    expect(result).not.toContain("=== TRIGGERING COMMENT ===");
  });

  it("does not add triggering comment section when empty string", () => {
    const result = formatContext(issueData, {
      type: "issue",
      number: 44,
      triggeringComment: "",
    });
    expect(result).not.toContain("=== TRIGGERING COMMENT ===");
  });
});

describe("formatContext - diff truncation", () => {
  it("truncates diffs over 100KB with a warning", () => {
    const bigDiff = "x".repeat(100001);
    const data: ContextData = { ...prData, diff: bigDiff };
    const result = formatContext(data, { type: "pr-diff", number: 10 });
    expect(result).toContain("[Diff truncated at 100KB. Use Read tool to examine full files.]");
    expect(result).not.toContain(bigDiff);
  });

  it("does not truncate diffs at exactly 100KB", () => {
    const exactDiff = "x".repeat(100000);
    const data: ContextData = { ...prData, diff: exactDiff };
    const result = formatContext(data, { type: "pr-diff", number: 10 });
    expect(result).not.toContain("[Diff truncated at 100KB");
  });
});
