import { describe, it, expect, vi } from "vitest";
import { fetchContext, quietVerdictReviews, type Octokit } from "./fetchers.js";

// --- Mock Octokit factory ---

const HEAD_SHA = "1111111111111111111111111111111111111111";

/** One page of the reviewThreads GraphQL connection. */
function threadsPage(nodes: unknown[], endCursor: string | null = null) {
  return {
    repository: {
      pullRequest: {
        reviewThreads: { pageInfo: { hasNextPage: endCursor !== null, endCursor }, nodes },
      },
    },
  };
}

function threadNode(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    isResolved: false,
    isOutdated: false,
    path: "src/index.ts",
    line: 10,
    originalLine: 10,
    firstComment: { nodes: [{ reactions: { nodes: [] } }] },
    comments: { totalCount: 1, nodes: [{ author: { __typename: "User", login: "reviewer" }, body: "Fix this" }] },
    ...extra,
  };
}

/** An error shaped like Octokit's RequestError. */
function httpError(status: number, message: string, data: unknown = {}): Error {
  return Object.assign(new Error(message), { status, response: { data } });
}

function createMockOctokit(
  overrides: Record<string, unknown> = {},
  graphql: unknown = vi.fn().mockResolvedValue(threadsPage([])),
): Octokit {
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
        data: {
          title: "Test PR",
          body: "PR body",
          changed_files: 2,
          additions: 10,
          deletions: 5,
          head: { sha: HEAD_SHA },
        },
      }),
      listFiles: vi.fn().mockResolvedValue([
        { filename: "src/index.ts", status: "modified", additions: 10, deletions: 5, patch: "@@ -1 +1 @@\n-a\n+b" },
      ]),
      listReviews: vi.fn().mockResolvedValue([
        { user: { login: "reviewer" }, state: "APPROVED", submitted_at: "2026-01-01T00:00:00Z", body: "LGTM" },
      ]),
      listReviewComments: vi.fn().mockResolvedValue([
        { user: { login: "reviewer" }, path: "src/index.ts", line: 10, body: "Fix this" },
      ]),
    },
    checks: {
      listForRef: vi.fn().mockResolvedValue([
        { id: 1, name: "test", status: "completed", conclusion: "success", started_at: "2026-01-01T00:00:00Z" },
      ]),
    },
  };

  const rest = { ...defaults, ...overrides };

  return {
    rest,
    graphql,
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
  it("calls pulls.get, listReviews, the threads query, and issues.listComments", async () => {
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
    expect(octokit.graphql).toHaveBeenCalledWith(
      expect.stringContaining("reviewThreads"),
      { owner: "myorg", repo: "myrepo", number: 10, cursor: null },
    );
    // The flat REST comments are the fallback only — threads carry the same text.
    expect(octokit.rest.pulls.listReviewComments).not.toHaveBeenCalled();
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

// --- Richer PR payload ---

const prOpts = { owner: "myorg", repo: "myrepo", number: 10, includeDiff: false } as const;

describe("fetchContext - changed files", () => {
  it.each(["pr-diff", "pr-review", "pr-full"] as const)("lists files with pagination for %s", async (type) => {
    const octokit = createMockOctokit();
    const result = await fetchContext(octokit, { ...prOpts, type });

    expect(octokit.paginate).toHaveBeenCalledWith(octokit.rest.pulls.listFiles, {
      owner: "myorg",
      repo: "myrepo",
      pull_number: 10,
      per_page: 100,
    });
    expect(result.files).toHaveLength(1);
    expect(result.pr?.head?.sha).toBe(HEAD_SHA);
  });
});

describe("fetchContext - review threads", () => {
  it("follows the cursor across pages and maps threads, comments, and reactions", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(
        threadsPage(
          [
            threadNode("PRRT_one", {
              isResolved: true,
              firstComment: {
                nodes: [{ reactions: { nodes: [{ content: "THUMBS_UP", user: { login: "dpup" } }] } }],
              },
            }),
          ],
          "cursor-1",
        ),
      )
      .mockResolvedValueOnce(
        threadsPage([threadNode("PRRT_two", { isOutdated: true, line: null, originalLine: 7 })]),
      );
    const octokit = createMockOctokit({}, graphql);
    const result = await fetchContext(octokit, { ...prOpts, type: "pr-review" });

    expect(graphql).toHaveBeenCalledTimes(2);
    expect(graphql.mock.calls[1]?.[1]).toMatchObject({ cursor: "cursor-1" });
    expect(result.reviewThreads).toEqual([
      {
        id: "PRRT_one",
        isResolved: true,
        isOutdated: false,
        path: "src/index.ts",
        line: 10,
        comments: [{ user: { login: "reviewer" }, body: "Fix this" }],
        totalComments: 1,
        reactions: [{ content: "THUMBS_UP", user: { login: "dpup" } }],
      },
      expect.objectContaining({ id: "PRRT_two", isOutdated: true, line: 7 }),
    ]);
    expect(result.reviewThreadsUnavailable).toBeUndefined();
    expect(result.inlineComments).toEqual([]);
  });

  it("gives a GitHub App author its REST login, so trusted-authors still matches", async () => {
    const graphql = vi.fn().mockResolvedValue(
      threadsPage([
        threadNode("PRRT_bot", {
          comments: { totalCount: 1, nodes: [{ author: { __typename: "Bot", login: "my-app" }, body: "x" }] },
        }),
      ]),
    );
    const result = await fetchContext(createMockOctokit({}, graphql), { ...prOpts, type: "pr-review" });
    expect(result.reviewThreads?.[0]?.comments[0]?.user?.login).toBe("my-app[bot]");
  });

  it("falls back to the flat REST comments when GraphQL fails, without throwing", async () => {
    const graphql = vi.fn().mockRejectedValue(new Error("Resource not accessible by personal access token"));
    const octokit = createMockOctokit({}, graphql);
    const result = await fetchContext(octokit, { ...prOpts, type: "pr-review" });

    expect(result.reviewThreads).toBeUndefined();
    expect(result.reviewThreadsUnavailable).toBe(true);
    expect(octokit.paginate).toHaveBeenCalledWith(octokit.rest.pulls.listReviewComments, {
      owner: "myorg",
      repo: "myrepo",
      pull_number: 10,
    });
    expect(result.inlineComments).toHaveLength(1);
    expect(result.fetchWarnings?.join("\n")).toContain("Resource not accessible");
  });

  it("does not query threads for pr-diff", async () => {
    const octokit = createMockOctokit();
    await fetchContext(octokit, { ...prOpts, type: "pr-diff" });
    expect(octokit.graphql).not.toHaveBeenCalled();
  });
});

describe("fetchContext - check runs", () => {
  it("skips checks entirely when no checks client is given", async () => {
    const octokit = createMockOctokit();
    const result = await fetchContext(octokit, { ...prOpts, type: "pr-review" });
    expect(octokit.rest.checks.listForRef).not.toHaveBeenCalled();
    expect(result.checkRuns).toBeUndefined();
    expect(result.checksUnavailable).toBeUndefined();
  });

  it("reads check runs on the head SHA with the SEPARATE client", async () => {
    const octokit = createMockOctokit();
    const checksOctokit = createMockOctokit();
    const result = await fetchContext(octokit, { ...prOpts, type: "pr-diff", checksOctokit });

    expect(checksOctokit.paginate).toHaveBeenCalledWith(checksOctokit.rest.checks.listForRef, {
      owner: "myorg",
      repo: "myrepo",
      ref: HEAD_SHA,
      per_page: 100,
    });
    expect(octokit.rest.checks.listForRef).not.toHaveBeenCalled();
    // The checks client is for checks only: nothing else goes through it.
    expect(checksOctokit.rest.pulls.get).not.toHaveBeenCalled();
    expect(result.checkRuns).toHaveLength(1);
  });

  it("marks checks unavailable when the fetch fails, without throwing", async () => {
    const checksOctokit = createMockOctokit({
      checks: { listForRef: vi.fn().mockRejectedValue(httpError(403, "Resource not accessible by integration")) },
    });
    const result = await fetchContext(createMockOctokit(), { ...prOpts, type: "pr-review", checksOctokit });

    expect(result.checkRuns).toBeUndefined();
    expect(result.checksUnavailable).toBe(true);
    expect(result.fetchWarnings?.join("\n")).toContain("Resource not accessible by integration");
    // The rest of the context is intact.
    expect(result.reviews).toHaveLength(1);
  });
});

describe("fetchContext - oversized diff", () => {
  /** pulls.get that serves metadata but fails the diff media type with `error`. */
  function pullsFailingDiff(error: Error) {
    const base = createMockOctokit().rest.pulls;
    return {
      ...base,
      get: vi.fn().mockImplementation((params: { mediaType?: unknown }) =>
        params.mediaType
          ? Promise.reject(error)
          : Promise.resolve({ data: { title: "Big PR", body: "", changed_files: 1, additions: 1, deletions: 1, head: { sha: HEAD_SHA } } }),
      ),
    };
  }

  it("on HTTP 406, flags the diff too large and keeps the per-file patches", async () => {
    const octokit = createMockOctokit({
      pulls: pullsFailingDiff(httpError(406, "Sorry, the diff exceeded the maximum number of lines (20000)")),
    });
    const result = await fetchContext(octokit, { ...prOpts, type: "pr-diff", includeDiff: true });

    expect(result.diffTooLarge).toBe(true);
    expect(result.diff).toBeNull();
    expect(result.files?.[0]?.patch).toContain("@@ -1 +1 @@");
  });

  it("treats a 422 too_large the same way", async () => {
    const octokit = createMockOctokit({
      pulls: pullsFailingDiff(httpError(422, "Validation Failed", { errors: [{ code: "too_large" }] })),
    });
    const result = await fetchContext(octokit, { ...prOpts, type: "pr-review", includeDiff: true });
    expect(result.diffTooLarge).toBe(true);
  });

  it.each([
    ["a 500", httpError(500, "Server Error")],
    ["a 404", httpError(404, "Not Found")],
    ["an unrelated 422", httpError(422, "Validation Failed", { errors: [{ code: "invalid" }] })],
  ])("still throws on %s", async (_label, error) => {
    const octokit = createMockOctokit({ pulls: pullsFailingDiff(error) });
    await expect(
      fetchContext(octokit, { ...prOpts, type: "pr-diff", includeDiff: true }),
    ).rejects.toThrow(error.message);
  });
});

describe("quiet_verdicts: verdict check runs listed with the reviews", () => {
  const CHECK = "gp-foundry/verdict (approver)";
  const VC = { checks: [CHECK], app: "agent-app" };
  const run = (over: object = {}) => ({
    id: 1, name: CHECK, status: "completed", conclusion: "success", completed_at: "2026-11-18T10:00:00Z", head_sha: HEAD_SHA,
    app: { slug: "agent-app" }, output: { title: "Verdict: APPROVE", summary: "Looks right." }, ...over,
  });

  it("the App's completed verdict check becomes a review record ending in the verdict line", () => {
    const [r, ...rest] = quietVerdictReviews([run()], VC, HEAD_SHA);
    expect(rest).toEqual([]);
    expect(r).toMatchObject({ user: { login: "agent-app[bot]" }, submitted_at: "2026-11-18T10:00:00Z", commit_id: HEAD_SHA });
    expect(r!.state).toContain(CHECK);
    expect(r!.body).toBe("Looks right.\n\n**Verdict:** APPROVE");
  });

  it("ignores another App's run of the same name, an unfinished run, other checks, and an untitled one", () => {
    expect(
      quietVerdictReviews(
        [run({ app: { slug: "someone-else" } }), run({ status: "in_progress" }), run({ name: "ci" }), run({ output: { title: "Done" } })],
        VC,
        HEAD_SHA,
      ),
    ).toEqual([]);
  });

  it("off: nothing", () => {
    expect(quietVerdictReviews([run()], undefined, HEAD_SHA)).toEqual([]);
  });
});
