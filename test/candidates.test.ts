import { describe, it, expect } from "vitest";
import { roundRobinByAuthor, rotatingWindow, searchCandidates, reviewedByQualifier, type Candidate } from "../src/shared/candidates.js";

const c = (number: number, author: string, updatedAt: number): Candidate => ({
  number, sha: `s${number}`, base: "main", author, authorType: "User", draft: false, labels: [], requested: 0, updatedAt,
});

describe("roundRobinByAuthor", () => {
  it("gives one author with many PRs one place per round", () => {
    const flood = Array.from({ length: 6 }, (_, i) => c(100 + i, "prolific", 1000 + i));
    const order = roundRobinByAuthor([...flood, c(1, "alice", 500), c(2, "bob", 600)]).map((x) => x.number);
    // Round 1: one each (longest-waiting author first), then the flood drains.
    expect(order.slice(0, 3).sort()).toEqual([1, 105, 2].sort());
    expect(order.slice(3)).toEqual([104, 103, 102, 101, 100]);
  });

  it("takes each author's newest PR first; authors who have waited longest lead each round", () => {
    const order = roundRobinByAuthor([c(1, "a", 10), c(2, "a", 30), c(3, "b", 5), c(4, "b", 20)]).map((x) => x.number);
    expect(order).toEqual([4, 2, 3, 1]); // b waited longest (5 < 10); newest of each first
  });

  it("treats logins case-insensitively and is deterministic", () => {
    const xs = [c(1, "Alice", 1), c(2, "alice", 2), c(3, "bob", 3)];
    expect(roundRobinByAuthor(xs).map((x) => x.number)).toEqual([2, 3, 1]);
    expect(roundRobinByAuthor([...xs].reverse())).toEqual(roundRobinByAuthor(xs));
  });

  it("with a slot limit, a flood cannot take every slot", () => {
    const xs = [...Array.from({ length: 300 }, (_, i) => c(1000 + i, "flood", 100 + i)), c(1, "a", 50), c(2, "b", 60), c(3, "c", 70)];
    const first10 = roundRobinByAuthor(xs).slice(0, 10).map((x) => x.author);
    expect(first10.filter((a) => a === "flood").length).toBeLessThanOrEqual(8);
    expect(new Set(first10)).toEqual(new Set(["flood", "a", "b", "c"]));
  });
});

describe("rotatingWindow", () => {
  it("covers every item within ⌈length ÷ count⌉ consecutive runs, from any starting run", () => {
    const items = Array.from({ length: 83 }, (_, i) => i);
    for (const start of [0, 1, 7, 999]) {
      const seen = new Set<number>();
      for (let r = start; r < start + Math.ceil(83 / 20); r++) rotatingWindow(items, 20, r).forEach((x) => seen.add(x));
      expect(seen.size, `from run ${start}`).toBe(83);
    }
  });

  it("returns everything when it fits", () => {
    expect(rotatingWindow([1, 2, 3], 20, 5)).toEqual([1, 2, 3]);
  });
});

describe("searchCandidates", () => {
  const node = (n: number) => ({
    number: n, headRefOid: `sha${n}`, baseRefName: "main", isDraft: false, updatedAt: "2026-11-16T00:00:00Z",
    author: { __typename: "User", login: "dev" }, labels: { nodes: [{ name: "x" }] }, reviewRequests: { totalCount: 2 },
  });
  function gql(total: number) {
    const queries: { q: string; cursor: string | null }[] = [];
    const fn = async (_q: string, v: any) => {
      queries.push({ q: v.q, cursor: v.cursor });
      const start = v.cursor ? Number(v.cursor) : 0;
      const ids = Array.from({ length: Math.max(0, Math.min(100, total - start)) }, (_, i) => start + i + 1);
      return { search: { issueCount: total, pageInfo: { hasNextPage: start + 100 < total, endCursor: String(start + 100) }, nodes: ids.map(node) } } as any;
    };
    return { fn, queries };
  }

  it("builds one query per qualifier, scoped to open PRs into the base, and pages through", async () => {
    const g = gql(150);
    const got = await searchCandidates(g.fn, { owner: "o", repo: "r", base: "main", qualifiers: [reviewedByQualifier("fletch[bot]")] });
    expect(got).toHaveLength(150);
    expect(g.queries.map((q) => q.q)).toEqual(["repo:o/r is:pr is:open base:main reviewed-by:fletch[bot]", "repo:o/r is:pr is:open base:main reviewed-by:fletch[bot]"]);
    expect(got[0]).toMatchObject({ number: 1, sha: "sha1", author: "dev", authorType: "User", labels: ["x"], requested: 2 });
  });

  it("merges qualifiers without duplicates", async () => {
    const g = gql(3);
    expect(await searchCandidates(g.fn, { owner: "o", repo: "r", qualifiers: ["reviewed-by:b", "author:app/dependabot"] })).toHaveLength(3);
  });

  it("refuses a result set GitHub would truncate", async () => {
    await expect(searchCandidates(gql(1500).fn, { owner: "o", repo: "r", qualifiers: ["reviewed-by:b"] })).rejects.toThrow(/more than GitHub returns/);
  });
});
