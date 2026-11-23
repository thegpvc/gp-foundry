import { describe, expect, it } from "vitest";
import { decide, listInScope } from "./index.js";

const BOT = "agent-bot[bot]";

function octokit(pr: Record<string, unknown> | Error, commits: (string | null)[] | Error = [BOT]) {
  const calls: string[] = [];
  const o = {
    calls,
    paginate: async (fn: (p: unknown) => Promise<{ data: unknown }>, params: unknown) => (await fn(params)).data,
    rest: {
      pulls: {
        get: async () => {
          calls.push("pulls.get");
          if (pr instanceof Error) throw pr;
          return { data: { draft: false, labels: [], user: { login: BOT, type: "Bot" }, ...pr } };
        },
        listCommits: async () => {
          calls.push("pulls.listCommits");
          if (commits instanceof Error) throw commits;
          return { data: commits.map((login) => ({ author: login ? { login } : null })) };
        },
      },
    },
  };
  return o as unknown as Parameters<typeof decide>[0] & { calls: string[] };
}
const base = { owner: "o", repo: "r", number: 7, botLogin: BOT };
const by = (login: string, type = "User", over: Record<string, unknown> = {}) => ({ user: { login, type }, ...over });

describe("pr-scope: a reading lane", () => {
  const read = (pr: Record<string, unknown> | Error, rollout?: object) =>
    decide(octokit(pr), { ...base, rollout, requireAgentWritten: false });

  it("runs on a PR in scope and says why", async () => {
    const r = await read(by("alice"), { authors: ["alice"] });
    expect(r).toMatchObject({ inScope: true, run: true });
    expect(r.reason).toContain("alice");
    expect(r.agentWritten).toBeUndefined();
  });

  it("does not run on one that is out, for each reason the rule has", async () => {
    const rollout = { authors: ["alice"], optInLabel: "agent-review", skipLabel: "no-agent-review" };
    expect((await read(by("bob"), rollout)).run).toBe(false);
    expect((await read(by("alice", "User", { draft: true }), rollout)).run).toBe(false);
    expect((await read(by("alice", "User", { labels: [{ name: "no-agent-review" }] }), rollout)).run).toBe(false);
    expect((await read(by("renovate[bot]", "Bot"), rollout)).run).toBe(false);
    expect((await read(by("bob", "User", { labels: [{ name: "agent-review" }] }), rollout)).run).toBe(true);
  });

  it("runs on the pipeline's own PR whatever the dial says, without reading commits", async () => {
    const o = octokit({});
    const r = await decide(o, { ...base, rollout: { authors: [] }, requireAgentWritten: false });
    expect(r.run).toBe(true);
    expect(o.calls).toEqual(["pulls.get"]);
  });

  it("with no rollout, runs on every person's PR", async () => {
    expect((await read(by("anyone"))).run).toBe(true);
  });

  it("fails closed on a PR it cannot read", async () => {
    const r = await read(new Error("503"));
    expect(r).toMatchObject({ inScope: false, run: false });
    expect(r.reason).toContain("could not read PR #7");
  });
});

describe("pr-scope: a writing lane", () => {
  const write = (pr: Record<string, unknown>, commits: (string | null)[] | Error = [BOT], rollout?: object) =>
    decide(octokit(pr, commits), { ...base, rollout, requireAgentWritten: true });

  it("runs on a PR the pipeline wrote", async () => {
    expect(await write({})).toMatchObject({ inScope: true, agentWritten: true, run: true });
  });

  it("does not run on a person's PR, in scope or not — and never reads its commits", async () => {
    const o = octokit(by("alice"));
    const r = await decide(o, { ...base, rollout: { authors: ["alice"] }, requireAgentWritten: true });
    expect(r).toMatchObject({ inScope: true, agentWritten: false, run: false });
    expect(r.reason).toContain("only acts on PRs the pipeline wrote");
    expect(o.calls).toEqual(["pulls.get"]);
  });

  it("does not run once anyone else has committed to the pipeline's PR", async () => {
    const r = await write({}, [BOT, "alice"]);
    expect(r).toMatchObject({ agentWritten: false, run: false });
    expect(r.reason).toContain("alice");
  });

  it("does not run when a commit cannot be attributed, or the commits cannot be read", async () => {
    expect((await write({}, [BOT, null])).run).toBe(false);
    expect((await write({}, new Error("502"))).run).toBe(false);
  });

  it("is still subject to scope: the skip label stops it on the pipeline's own PR", async () => {
    const r = await write({ labels: [{ name: "no-agent-review" }] }, [BOT], { skipLabel: "no-agent-review" });
    expect(r).toMatchObject({ inScope: false, run: false });
  });

  it("never runs without a bot login to attribute PRs to", async () => {
    const r = await decide(octokit(by("alice")), { owner: "o", repo: "r", number: 7, requireAgentWritten: true });
    expect(r.run).toBe(false);
  });
});

describe("pr-scope: listing for a sweep", () => {
  const NOW = Date.parse("2026-01-01T01:00:00Z");
  const open = (number: number, login: string, over: Record<string, unknown> = {}) => ({
    number,
    draft: false,
    labels: [],
    user: { login, type: login.endsWith("[bot]") ? "Bot" : "User" },
    head: { sha: `sha${number}` },
    base: { ref: "main" },
    requested_reviewers: [],
    requested_teams: [],
    updated_at: "2026-01-01T00:59:00Z",
    ...over,
  });
  function lister(pages: (unknown[] | Error)[]) {
    let call = 0;
    const seen: unknown[] = [];
    const o = {
      seen,
      paginate: async (fn: (p: unknown) => Promise<{ data: unknown }>, params: unknown) => (await fn(params)).data,
      rest: {
        pulls: {
          list: async (params: unknown) => {
            seen.push(params);
            const page = pages[Math.min(call++, pages.length - 1)]!;
            if (page instanceof Error) throw page;
            return { data: page };
          },
        },
      },
    };
    return o as unknown as Parameters<typeof listInScope>[0] & { seen: any[] };
  }
  const opts = { owner: "o", repo: "r", baseBranch: "main", botLogin: BOT, nowMs: NOW, retryDelayMs: 0 };

  it("returns the in-scope PRs, oldest first, with what the selector needs", async () => {
    const o = lister([
      [
        open(1, "alice", { requested_reviewers: [{ login: "x" }], requested_teams: [{ slug: "t" }] }),
        open(2, "bob"),
        open(3, BOT, { base: { ref: "release" } }),
        open(4, "alice", { draft: true }),
        open(5, "renovate[bot]"),
      ],
    ]);
    const prs = await listInScope(o, { ...opts, rollout: { authors: ["alice"] } });
    expect(prs).toEqual([
      { number: 1, sha: "sha1", base: "main", requested: 2, quiet: 60 },
      { number: 3, sha: "sha3", base: "release", requested: 0, quiet: 60 },
    ]);
    expect(o.seen[0]).toMatchObject({ state: "open", base: "main", sort: "created", direction: "asc" });
  });

  it("retries a failed listing once", async () => {
    const o = lister([new Error("unexpected end of JSON input"), [open(1, "alice")]]);
    expect(await listInScope(o, opts)).toHaveLength(1);
    expect(o.seen).toHaveLength(2);
  });

  it("gives up quietly after the retry: undefined, not a throw", async () => {
    const o = lister([new Error("502"), new Error("502")]);
    expect(await listInScope(o, opts)).toBeUndefined();
    expect(o.seen).toHaveLength(2);
  });

  describe("only: one PR, read directly (#51)", () => {
    const getter = (pr: unknown) => {
      const o = lister([[]]) as any;
      o.rest.pulls.get = async (params: unknown) => {
        o.seen.push(params);
        if (pr instanceof Error) throw pr;
        return { data: pr };
      };
      o.graphql = async () => {
        throw new Error("the search must not be used");
      };
      return o as Parameters<typeof listInScope>[0] & { seen: any[] };
    };
    it("lists that PR alone, without the search, even with reviewed-by", async () => {
      const o = getter({ ...open(7, "alice", { requested_reviewers: [{ login: "x" }] }), state: "open" });
      expect(await listInScope(o, { ...opts, reviewedBy: BOT, only: 7 })).toEqual([{ number: 7, sha: "sha7", base: "main", requested: 1, quiet: 60 }]);
      expect(o.seen).toEqual([{ owner: "o", repo: "r", pull_number: 7 }]);
    });
    it("is empty for a closed PR, another base, or one out of scope", async () => {
      expect(await listInScope(getter({ ...open(7, "alice"), state: "closed" }), { ...opts, only: 7 })).toEqual([]);
      expect(await listInScope(getter({ ...open(7, "alice", { base: { ref: "release" } }), state: "open" }), { ...opts, only: 7 })).toEqual([]);
      expect(await listInScope(getter({ ...open(7, "mallory"), state: "open" }), { ...opts, rollout: { authors: ["alice"] }, only: 7 })).toEqual([]);
    });
    it("an unreadable PR is a quiet tick", async () => {
      expect(await listInScope(getter(new Error("502")), { ...opts, only: 7 })).toBeUndefined();
    });
  });
});

describe("pr-scope: the wrong-bot-login hint", () => {
  const onAgentBranch = { user: { login: "dan", type: "User" }, head: { ref: "agent/12-fix" } };
  const opts = { ...base, branchPrefix: "agent/" };

  it("explains an agent-named branch turned away because someone else opened it", async () => {
    const r = await decide(octokit(onAgentBranch), { ...opts, rollout: { authors: [] }, requireAgentWritten: false });
    expect(r.run).toBe(false);
    expect(r.reason).toContain("identity.bot_login should be 'dan'");
    const w = await decide(octokit(onAgentBranch), { ...opts, requireAgentWritten: true });
    expect(w.run).toBe(false);
    expect(w.reason).toContain("identity.bot_login should be 'dan'");
  });

  it("says nothing for an ordinary branch, the bot's own PR, a draft or a skip label", async () => {
    const quiet = async (pr: Record<string, unknown>, rollout: object = { authors: [] }) =>
      (await decide(octokit(pr), { ...opts, rollout, requireAgentWritten: false })).reason;
    expect(await quiet({ user: { login: "dan", type: "User" }, head: { ref: "dan/feature" } })).not.toContain("bot_login");
    expect(await quiet({ head: { ref: "agent/12-fix" } })).not.toContain("bot_login");
    expect(await quiet({ ...onAgentBranch, draft: true })).not.toContain("bot_login");
    expect(await quiet({ ...onAgentBranch, labels: [{ name: "no" }] }, { authors: [], skipLabel: "no" })).not.toContain("bot_login");
  });
});

describe("pr-scope: listing only PRs the bot has reviewed", () => {
  const NOW = Date.parse("2026-01-01T01:00:00Z");
  const node = (n: number, login: string, updated: string, over: Record<string, unknown> = {}) => ({
    number: n, headRefOid: `sha${n}`, baseRefName: "main", isDraft: false, updatedAt: updated,
    author: { __typename: login.endsWith("[bot]") ? "Bot" : "User", login }, labels: { nodes: [] }, reviewRequests: { totalCount: 0 }, ...over,
  });
  function searcher(results: (unknown[] | Error)[]) {
    const queries: string[] = [];
    let i = 0;
    const o = {
      queries,
      graphql: async (_q: string, v: any) => {
        queries.push(v.q);
        const r = results[Math.min(i++, results.length - 1)]!;
        if (r instanceof Error) throw r;
        return { search: { issueCount: r.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes: r } };
      },
      paginate: async () => {
        throw new Error("must not list every open PR");
      },
      rest: { pulls: { list: async () => { throw new Error("must not list every open PR"); } } },
    };
    return o as unknown as Parameters<typeof listInScope>[0] & { queries: string[] };
  }
  const opts = { owner: "o", repo: "r", baseBranch: "main", botLogin: BOT, nowMs: NOW, retryDelayMs: 0, reviewedBy: BOT };

  it("searches once for open PRs the bot reviewed, and round-robins them by author", async () => {
    const flood = Array.from({ length: 5 }, (_, i) => node(100 + i, "prolific", `2026-01-01T00:0${i}:00Z`));
    const o = searcher([[...flood, node(1, "alice", "2025-12-31T00:00:00Z"), node(2, "dependabot[bot]", "2026-01-01T00:00:00Z"), node(3, "bob", "2026-01-01T00:30:00Z", { isDraft: true })]]);
    const prs = await listInScope(o, opts);
    expect(o.queries).toEqual([`repo:o/r is:pr is:open base:main reviewed-by:${BOT}`]);
    // alice waited longest; then prolific, oldest first; dependabot (another bot) and the draft are out.
    expect(prs!.map((p) => p.number)).toEqual([1, 100, 101, 102, 103, 104]);
    expect(prs![0]).toEqual({ number: 1, sha: "sha1", base: "main", requested: 0, quiet: 90000 });
  });

  it("leaves the skip label out of the search, and still drops skipped PRs it returns", async () => {
    const skip = { labels: { nodes: [{ name: "fletch:skip" }] } };
    const o = searcher([[node(1, "alice", "2026-01-01T00:00:00Z", skip), node(2, "alice", "2026-01-01T00:10:00Z"), node(3, "bob", "2026-01-01T00:20:00Z")]]);
    const prs = await listInScope(o, { ...opts, rollout: { skipLabel: "fletch:skip" } });
    expect(o.queries).toEqual([`repo:o/r is:pr is:open base:main reviewed-by:${BOT} -label:"fletch:skip"`]);
    expect(prs!.map((p) => p.number)).toEqual([2, 3]);
  });

  // The selector takes the first LIMIT of this list: a skipped PR must not hold a
  // place in an author's turn, or one author's skipped backlog starves the rest.
  it("round-robins only PRs in scope: 90 skipped of 100 leave 10, each author still taking turns", async () => {
    const skip = { labels: { nodes: [{ name: "fletch:skip" }] } };
    const nodes = Array.from({ length: 100 }, (_, i) =>
      node(i + 1, i < 90 ? "prolific" : i % 2 ? "alice" : "bob", `2026-01-01T00:${String(i % 60).padStart(2, "0")}:00Z`, i < 90 ? skip : {}),
    );
    const prs = await listInScope(searcher([nodes]), { ...opts, rollout: { skipLabel: "fletch:skip" } });
    expect(prs).toHaveLength(10);
    expect(prs!.every((p) => p.number > 90)).toBe(true);
    // Strict alternation between the two in-scope authors.
    const authorOf = (n: number) => ((n - 1) % 2 ? "alice" : "bob");
    const order = prs!.map((p) => authorOf(p.number));
    for (let i = 1; i < order.length; i++) expect(order[i]).not.toBe(order[i - 1]);
  });

  it("retries a failed search once, then reports the tick as not listed", async () => {
    expect(await listInScope(searcher([new Error("rate limit"), [node(1, "alice", "2026-01-01T00:00:00Z")]]), opts)).toHaveLength(1);
    expect(await listInScope(searcher([new Error("rate limit"), new Error("rate limit")]), opts)).toBeUndefined();
  });
});

// rollout.bot_authors (#55): a named bot's PRs beside every person's.
describe("pr-scope: rollout.bot_authors", () => {
  const DEP = "dependabot[bot]";
  const rollout = { skipLabel: "no-agent-review", botAuthors: [DEP] };

  it("a guard hands a listed bot's PR to the scheduled bot pass: in scope, not run, the reason given", async () => {
    const o = octokit(by(DEP, "Bot"));
    const r = await decide(o, { ...base, rollout, requireAgentWritten: false });
    expect(r).toMatchObject({ inScope: true, run: false });
    expect(r.reason).toContain("rollout.bot_authors");
    expect(r.reason).toContain("bot pass");
    // No commit read: the event's read-only token is all a Dependabot run has.
    expect(o.calls).toEqual(["pulls.get"]);
  });

  it("people's PRs still run; another bot stays out", async () => {
    expect((await decide(octokit(by("alice")), { ...base, rollout, requireAgentWritten: false })).run).toBe(true);
    const other = await decide(octokit(by("renovate[bot]", "Bot")), { ...base, rollout, requireAgentWritten: false });
    expect(other).toMatchObject({ inScope: false, run: false });
    expect(other.reason).toContain("bot_authors");
  });

  it("a writing lane never runs on it", async () => {
    const r = await decide(octokit(by(DEP, "Bot"), [DEP]), { ...base, rollout, requireAgentWritten: true });
    expect(r.run).toBe(false);
  });

  describe("listing", () => {
    const NOW = Date.parse("2026-01-01T01:00:00Z");
    const open = (number: number, login: string, over: Record<string, unknown> = {}) => ({
      number,
      draft: false,
      labels: [],
      title: `PR ${number}`,
      user: { login, type: login.endsWith("[bot]") ? "Bot" : "User" },
      head: { sha: `sha${number}` },
      base: { ref: "main" },
      requested_reviewers: [],
      requested_teams: [],
      updated_at: "2026-01-01T00:59:00Z",
      ...over,
    });
    const GROUPED_MAJOR = ["Bump the npm group with 2 updates", "", "---", "updated-dependencies:", "- dependency-name: a", "  update-type: version-update:semver-patch", "- dependency-name: b", "  update-type: version-update:semver-major", "...", ""].join("\n");
    type C = { login: string | null; message?: string; signed?: boolean; sha?: string };
    function lister(prs: unknown[], commits: Record<number, C[] | Error>, checkRuns: Record<string, unknown[] | Error> = {}) {
      const reads: number[] = [];
      const o = {
        reads,
        paginate: async (fn: (p: unknown) => Promise<{ data: unknown }>, params: unknown) => (await fn(params)).data,
        rest: {
          checks: {
            listForRef: async ({ ref }: { ref: string }) => {
              const c = checkRuns[ref] ?? [];
              if (c instanceof Error) throw c;
              return { data: c };
            },
          },
          pulls: {
            list: async () => ({ data: prs }),
            listCommits: async ({ pull_number }: { pull_number: number }) => {
              reads.push(pull_number);
              const c = commits[pull_number] ?? [];
              if (c instanceof Error) throw c;
              // Signed by GitHub unless said otherwise; the last commit is the listed head.
              return {
                data: c.map(({ login, message, signed = true, sha }, i) => ({
                  sha: sha ?? (i === c.length - 1 ? `sha${pull_number}` : `c${i}`),
                  author: login ? { login } : null,
                  committer: { login: signed ? "web-flow" : (login ?? "x") },
                  commit: { message: message ?? "", verification: { verified: signed } },
                })),
              };
            },
          },
        },
      };
      return o as unknown as Parameters<typeof listInScope>[0] & { reads: number[] };
    }
    const opts = { owner: "o", repo: "r", baseBranch: "main", botLogin: BOT, nowMs: NOW, retryDelayMs: 0, rollout };
    const prs = [
      open(1, "alice"),
      open(2, DEP, { title: "Bump the npm group with 2 updates" }),
      open(3, DEP),
      open(4, DEP),
      open(5, "renovate[bot]"),
      open(6, DEP, { labels: [{ name: "no-agent-review" }] }),
      open(7, DEP, { draft: true }),
    ];
    const commits = {
      2: [{ login: DEP, message: GROUPED_MAJOR }],
      3: [{ login: DEP }, { login: "mallory" }],
      4: new Error("HTTP 502"),
    };

    it("keeps the bot's own PRs with the update level; drops one a person pushed to, or whose commits cannot be read", async () => {
      const o = lister(prs, commits);
      const got = await listInScope(o, opts);
      expect(got?.map((p) => p.number)).toEqual([1, 2]);
      expect(got?.[0]).not.toHaveProperty("bump");
      expect(got?.[1]).toMatchObject({ number: 2, bump: "major" });
      // Commits are read only for the bot's PRs in scope.
      expect(o.reads.sort()).toEqual([2, 3, 4]);
    });

    describe("reviewed-check: a head the bot pass has recorded", () => {
      const pass = { ...opts, botAuthorsOnly: true, reviewedCheck: "gp-foundry/swept (reviewer)", rereviewLabel: "re-review" };
      const mark = (slug = "github-actions") => [{ name: "gp-foundry/swept (reviewer)", app: { slug } }];

      it("is left out before its commits are read", async () => {
        const o = lister([open(2, DEP)], { 2: [{ login: DEP }] }, { sha2: mark() });
        expect(await listInScope(o, pass)).toEqual([]);
        expect(o.reads).toEqual([]);
      });

      it("only on the mark job's own check: another App's of that name changes nothing", async () => {
        const o = lister([open(2, DEP)], { 2: [{ login: DEP }] }, { sha2: mark("some-app") });
        expect((await listInScope(o, pass))?.map((p) => p.number)).toEqual([2]);
        expect(o.reads).toEqual([2]);
      });

      it("checks that cannot be read: the commits are read, as without it", async () => {
        const o = lister([open(2, DEP)], { 2: [{ login: DEP }] }, { sha2: new Error("HTTP 502") });
        expect((await listInScope(o, pass))?.map((p) => p.number)).toEqual([2]);
      });

      it("not while a re-review is requested: the select job says which records still count", async () => {
        const o = lister([open(2, DEP, { labels: [{ name: "re-review" }] })], { 2: [{ login: DEP }] }, { sha2: mark() });
        await listInScope(o, pass).catch(() => undefined);
        expect(o.reads).toEqual([2]);
      });
    });

    it("a security update (no update-type in its commit): the level and versions from the commit body (#57)", async () => {
      const SECURITY = ["Bump x from 1.4.1 to 1.4.6", "", "Bumps [x](https://github.com/o/x) from 1.4.1 to 1.4.6.", "", "---", "updated-dependencies:", "- dependency-name: x", "  dependency-version: 1.4.6", "  dependency-type: direct:production", "...", ""].join("\n");
      const o = lister([open(2, DEP, { title: "Bump x from 1.4.1 to 1.4.6" })], { 2: [{ login: DEP, message: SECURITY }] });
      expect(await listInScope(o, opts)).toMatchObject([{ number: 2, bump: "patch", updates: "x>1.4.1>1.4.6" }]);
    });

    it("bot-authors-only lists just the bot's own PRs, for the bot pass", async () => {
      const got = await listInScope(lister(prs, commits), { ...opts, botAuthorsOnly: true });
      expect(got?.map((p) => p.number)).toEqual([2]);
    });

    it("drops a bot's PR with a commit in its name GitHub did not make, at the commit cap, or whose head moved", async () => {
      const one = [open(2, DEP)];
      const forged = await listInScope(lister(one, { 2: [{ login: DEP }, { login: DEP, signed: false }] }), opts);
      expect(forged).toEqual([]);
      const capped = await listInScope(lister(one, { 2: Array.from({ length: 250 }, () => ({ login: DEP })) }), opts);
      expect(capped).toEqual([]);
      const moved = await listInScope(lister(one, { 2: [{ login: DEP, sha: "newer" }] }), opts);
      expect(moved).toEqual([]);
      const fine = await listInScope(lister(one, { 2: [{ login: DEP }] }), opts);
      expect(fine?.map((p) => p.number)).toEqual([2]);
    });

    it("a person's PR gets no level, whatever its title claims: only the bot's is taken at its word", async () => {
      const o = lister([open(1, "alice", { title: "Bump x from 1.2.3 to 1.3.0" })], {});
      const got = await listInScope(o, opts);
      expect(got?.map((p) => p.number)).toEqual([1]);
      expect(got?.[0]).not.toHaveProperty("bump");
      expect(o.reads).toEqual([]);
    });

    it("without bot_authors in the rollout, the bot's PRs are another bot's: out", async () => {
      const o = lister(prs, commits);
      const got = await listInScope(o, { ...opts, rollout: { skipLabel: "no-agent-review" } });
      expect(got?.map((p) => p.number)).toEqual([1]);
      expect(o.reads).toEqual([]);
    });
  });
});
