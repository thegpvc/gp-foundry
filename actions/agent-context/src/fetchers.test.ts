import { describe, it, expect, vi } from "vitest";
import { fetchContext, type Octokit } from "./fetchers.js";

// --- Mock Octokit factory ---

function createMockOctokit(overrides: Record<string, unknown> = {}): Octokit {
  const defaults = {
    issues: {
      get: vi.fn().mockResolvedValue({
        data: { title: "Test issue", body: "Body", labels: [{ name: "bug" }] },
      }),
      listComments: vi.fn().mockResolvedValue([
        { user: { login: "user1" }, created_at: "2026-01-01T00:00:00Z", body: "comment" },
      ]),
    },
    pulls: {
      get: vi.fn().mockResolvedValue({
        data: { title: "Test PR", body: "PR body", changed_files: 2, additions: 10, deletions: 5 },
      }),
      listReviews: vi.fn().mockResolvedValue([
        { user: { login: "reviewer" }, state: "APPROVED", submitted_at: "2026-01-01T00:00:00Z", body: "LGTM" },
      ]),
      listReviewComments: vi.fn().mockResolvedValue([
        { user: { login: "reviewer" }, path: "src/index.ts", line: 10, body: "Fix this" },
      ]),
    },
  };

  const rest = { ...defaults, ...overrides };

  return {
    rest,
    paginate: vi.fn().mockImplementation((method: (p: unknown) => unknown, params: unknown) => method(params)),
  } as unknown as Octokit;
}

// --- Tests ---

describe("fetchContext - issue type", () => {
  it("calls issues.get and issues.listComments, returns { issue, comments }", async () => {
    const octokit = createMockOctokit();
    const result = await fetchContext(octokit, {
      owner: "myorg",
      repo: "myrepo",
      number: 42,
      type: "issue",
      includeDiff: false,
    });

    expect(octokit.rest.issues.get).toHaveBeenCalledWith({
      owner: "myorg",
      repo: "myrepo",
      issue_number: 42,
    });
    expect(octokit.paginate).toHaveBeenCalledWith(octokit.rest.issues.listComments, {
      owner: "myorg",
      repo: "myrepo",
      issue_number: 42,
    });
    expect(result).toHaveProperty("issue");
    expect(result).toHaveProperty("comments");
    expect(result.issue?.title).toBe("Test issue");
  });

  it("does not call pulls APIs for issue type", async () => {
    const octokit = createMockOctokit();
    await fetchContext(octokit, {
      owner: "myorg",
      repo: "myrepo",
      number: 42,
      type: "issue",
      includeDiff: false,
    });

    expect(octokit.rest.pulls.get).not.toHaveBeenCalled();
    expect(octokit.rest.pulls.listReviews).not.toHaveBeenCalled();
  });
});

describe("fetchContext - pr-review type", () => {
  it("calls pulls.get, listReviews, listReviewComments, and issues.listComments", async () => {
    const octokit = createMockOctokit();
    const result = await fetchContext(octokit, {
      owner: "myorg",
      repo: "myrepo",
      number: 10,
      type: "pr-review",
      includeDiff: false,
    });

    expect(octokit.rest.pulls.get).toHaveBeenCalledWith({
      owner: "myorg",
      repo: "myrepo",
      pull_number: 10,
    });
    expect(octokit.paginate).toHaveBeenCalledWith(octokit.rest.pulls.listReviews, {
      owner: "myorg",
      repo: "myrepo",
      pull_number: 10,
    });
    expect(octokit.paginate).toHaveBeenCalledWith(octokit.rest.pulls.listReviewComments, {
      owner: "myorg",
      repo: "myrepo",
      pull_number: 10,
    });
    expect(octokit.paginate).toHaveBeenCalledWith(octokit.rest.issues.listComments, {
      owner: "myorg",
      repo: "myrepo",
      issue_number: 10,
    });

    expect(result).toHaveProperty("pr");
    expect(result).toHaveProperty("reviews");
    expect(result).toHaveProperty("inlineComments");
    expect(result).toHaveProperty("comments");
    expect(result).toHaveProperty("diff");
  });

  it("fetches diff when includeDiff is true (two pulls.get calls)", async () => {
    const octokit = createMockOctokit();
    await fetchContext(octokit, {
      owner: "myorg",
      repo: "myrepo",
      number: 10,
      type: "pr-review",
      includeDiff: true,
    });

    expect(octokit.rest.pulls.get).toHaveBeenCalledTimes(2);
    expect(octokit.rest.pulls.get).toHaveBeenCalledWith({
      owner: "myorg",
      repo: "myrepo",
      pull_number: 10,
      mediaType: { format: "diff" },
    });
  });

  it("does not fetch diff when includeDiff is false (one pulls.get call)", async () => {
    const octokit = createMockOctokit();
    const result = await fetchContext(octokit, {
      owner: "myorg",
      repo: "myrepo",
      number: 10,
      type: "pr-review",
      includeDiff: false,
    });

    expect(octokit.rest.pulls.get).toHaveBeenCalledTimes(1);
    expect(result.diff).toBeNull();
  });
});

describe("fetchContext - pr-diff type", () => {
  it("calls pulls.get for metadata, does NOT call reviews or comments APIs", async () => {
    const octokit = createMockOctokit();
    const result = await fetchContext(octokit, {
      owner: "myorg",
      repo: "myrepo",
      number: 10,
      type: "pr-diff",
      includeDiff: false,
    });

    expect(octokit.rest.pulls.get).toHaveBeenCalledTimes(1);
    expect(octokit.rest.pulls.listReviews).not.toHaveBeenCalled();
    expect(octokit.rest.pulls.listReviewComments).not.toHaveBeenCalled();
    expect(octokit.rest.issues.listComments).not.toHaveBeenCalled();

    expect(result).toHaveProperty("pr");
    expect(result).toHaveProperty("diff");
  });

  it("fetches diff when includeDiff is true (two pulls.get calls)", async () => {
    const octokit = createMockOctokit();
    await fetchContext(octokit, {
      owner: "myorg",
      repo: "myrepo",
      number: 10,
      type: "pr-diff",
      includeDiff: true,
    });

    expect(octokit.rest.pulls.get).toHaveBeenCalledTimes(2);
    expect(octokit.rest.pulls.get).toHaveBeenCalledWith({
      owner: "myorg",
      repo: "myrepo",
      pull_number: 10,
      mediaType: { format: "diff" },
    });
  });
});

describe("fetchContext - pr-full type", () => {
  it("behaves the same as pr-review, fetching all sections", async () => {
    const octokit = createMockOctokit();
    const result = await fetchContext(octokit, {
      owner: "myorg",
      repo: "myrepo",
      number: 10,
      type: "pr-full",
      includeDiff: false,
    });

    expect(result).toHaveProperty("pr");
    expect(result).toHaveProperty("reviews");
    expect(result).toHaveProperty("inlineComments");
    expect(result).toHaveProperty("comments");
    expect(result).toHaveProperty("diff");
    expect(octokit.paginate).toHaveBeenCalledWith(
      octokit.rest.pulls.listReviews,
      expect.any(Object)
    );
  });
});

describe("fetchContext - includeDiff: false", () => {
  it("does not fetch diff for pr-full when includeDiff is false", async () => {
    const octokit = createMockOctokit();
    const result = await fetchContext(octokit, {
      owner: "myorg",
      repo: "myrepo",
      number: 10,
      type: "pr-full",
      includeDiff: false,
    });

    expect(octokit.rest.pulls.get).toHaveBeenCalledTimes(1);
    expect(result.diff).toBeNull();
  });
});

describe("fetchContext - unknown type", () => {
  it("throws an error for unknown type", async () => {
    const octokit = createMockOctokit();
    await expect(
      fetchContext(octokit, {
        owner: "myorg",
        repo: "myrepo",
        number: 1,
        // deliberately invalid to exercise the default branch
        type: "unknown-type" as never,
        includeDiff: false,
      })
    ).rejects.toThrow("Unknown context type: unknown-type");
  });
});
