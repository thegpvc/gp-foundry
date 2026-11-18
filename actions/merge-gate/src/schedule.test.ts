/**
 * The single gate's scheduling: a bounded scheduled pass, least recently
 * evaluated first, and targeted runs for one PR — against a synthetic backlog
 * larger than one tick, on a fake GitHub that keeps its check runs between
 * ticks.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@actions/core", () => ({
  getInput: () => "",
  setOutput: () => {},
  setFailed: () => {},
  info: () => {},
  warning: () => {},
  notice: () => {},
}));
vi.mock("@actions/github", () => ({ getOctokit: () => ({}), context: { repo: { owner: "o", repo: "r" } } }));

const { runHybridGate, GATE_TICK_LIMIT } = await import("./index.js");

const BOT = "gate-bot[bot]";
const CHECK = "acme/approval";
const APP = "gate-app";
const sha = (n: number, v = 1) => `${String(n).padStart(4, "0")}${"0".repeat(32)}v${v}`.slice(0, 40);

interface FakePr {
  number: number;
  head: number; // version of the head commit
  labels: string[];
  /** The bot has reviewed this PR (at some head): it is a search result. */
  reviewed: boolean;
  /** The approver's verdict on the CURRENT head, if any. */
  verdict?: "APPROVE" | "REQUEST_CHANGES";
  user?: string;
  state?: string;
  ci?: "success" | "in_progress";
  /** pulls.get throws this many more times. */
  failReads?: number;
}

/** A fake GitHub: PRs, CI and the gate's own check runs, kept between ticks. */
class World {
  prs = new Map<number, FakePr>();
  checks: { id: number; sha: string; name: string; app: string; status: string; conclusion: string | null; output: { title: string; summary: string; text?: string } }[] = [];
  merged: { pr: number; sha: string }[] = [];
  calls: Record<string, number> = {};
  failSearch = false;
  clock = Date.parse("2026-11-17T00:00:00Z");
  /** Fake time each full evaluation takes (charged when the PR is read). */
  evalMs = 2000;
  private nextId = 1;

  add(pr: Partial<FakePr> & { number: number }) {
    this.prs.set(pr.number, { head: 1, labels: [], reviewed: false, ci: "success", ...pr });
  }
  total() {
    return Object.values(this.calls).reduce((a, b) => a + b, 0);
  }
  headSha(n: number) {
    return sha(n, this.prs.get(n)!.head);
  }
  /** The gate's current result on a PR's current head, if any. */
  result(n: number) {
    const s = this.headSha(n);
    return this.checks.filter((c) => c.sha === s && c.name === CHECK && c.app === APP).sort((a, b) => b.id - a.id)[0];
  }
  private count(k: string) {
    this.calls[k] = (this.calls[k] ?? 0) + 1;
  }
  private prJson(p: FakePr) {
    return {
      number: p.number,
      state: p.state ?? "open",
      draft: false,
      title: `PR ${p.number}`,
      user: { login: p.user ?? BOT, type: (p.user ?? BOT).endsWith("[bot]") ? "Bot" : "User" },
      labels: p.labels.map((name) => ({ name })),
      head: { sha: sha(p.number, p.head), ref: `agent/${p.number}`, repo: { full_name: "o/r" } },
      base: { ref: "main" },
      mergeable: true,
      mergeable_state: "clean",
      requested_reviewers: [],
      requested_teams: [],
      updated_at: "2026-11-16T00:00:00Z",
    };
  }
  octokit(): any {
    const w = this;
    const call = <T>(k: string, fn: (p: any) => T) => async (p: any) => {
      w.count(k);
      return { data: fn(p) };
    };
    return {
      paginate: async (fn: (p: any) => Promise<{ data: any }>, params: any) => {
        const { data } = await fn(params);
        return Array.isArray(data) ? data : data.check_runs ?? data;
      },
      graphql: async (query: string, vars: any) => {
        if (query.includes("search(")) {
          w.count("graphql.search");
          if (w.failSearch) throw new Error("secondary rate limit");
          const q: string = vars.q;
          const open = [...w.prs.values()].filter((p) => (p.state ?? "open") === "open");
          const hits = q.includes("reviewed-by:") ? open.filter((p) => p.reviewed) : q.includes("author:app/dependabot") ? open.filter((p) => p.user === "dependabot[bot]") : open;
          const start = vars.cursor ? Number(vars.cursor) : 0;
          const page = hits.slice(start, start + 100);
          return {
            search: {
              issueCount: hits.length,
              pageInfo: { hasNextPage: start + 100 < hits.length, endCursor: String(start + 100) },
              nodes: page.map((p) => ({
                number: p.number,
                headRefOid: sha(p.number, p.head),
                baseRefName: "main",
                isDraft: false,
                updatedAt: "2026-11-16T00:00:00Z",
                author: { __typename: (p.user ?? BOT).endsWith("[bot]") ? "Bot" : "User", login: p.user ?? BOT },
                labels: { nodes: p.labels.map((name) => ({ name })) },
                reviewRequests: { totalCount: 0 },
              })),
            },
          };
        }
        w.count("graphql.other");
        return { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] }, reviewDecision: null } } };
      },
      rest: {
        pulls: {
          list: call("pulls.list", () => [...w.prs.values()].filter((p) => (p.state ?? "open") === "open").sort((a, b) => a.number - b.number).map((p) => w.prJson(p))),
          get: async ({ pull_number }: any) => {
            w.count("pulls.get");
            const p = w.prs.get(pull_number)!;
            w.clock += w.evalMs;
            if (p.failReads) {
              p.failReads--;
              throw new Error("HTTP 502");
            }
            return { data: w.prJson(p) };
          },
          listReviews: call("pulls.listReviews", ({ pull_number }: any) => {
            const p = w.prs.get(pull_number)!;
            const h = sha(p.number, p.head);
            return [
              ...(p.reviewed ? [{ submitted_at: "2026-11-15T00:00:00Z", state: "COMMENTED", commit_id: sha(p.number, 1), user: { login: BOT }, author_association: "NONE", body: "Two findings." }] : []),
              ...(p.verdict ? [{ submitted_at: "2026-11-16T00:00:00Z", state: "COMMENTED", commit_id: h, user: { login: BOT }, author_association: "NONE", body: `ok\n\n**Verdict:** ${p.verdict}` }] : []),
            ];
          }),
          listFiles: call("pulls.listFiles", () => [{ filename: "src/a.ts", additions: 10, deletions: 0 }]),
          listCommits: call("pulls.listCommits", () => [{ author: { login: BOT } }]),
          merge: call("pulls.merge", ({ pull_number, sha: s }: any) => {
            w.merged.push({ pr: pull_number, sha: s });
            return {};
          }),
        },
        issues: {
          listComments: call("issues.listComments", () => []),
          addLabels: call("issues.addLabels", () => ({})),
          removeLabel: call("issues.removeLabel", () => ({})),
          createComment: call("issues.createComment", () => ({})),
        },
        repos: { getCommit: call("repos.getCommit", () => ({ commit: { committer: { date: "2026-11-15T00:00:00Z" } } })) },
        git: { deleteRef: call("git.deleteRef", () => ({})) },
        checks: {
          listForRef: call("checks.listForRef", ({ ref, check_name }: any) => {
            const pr = [...w.prs.values()].find((p) => sha(p.number, p.head) === ref);
            const ci = { id: 0, name: "ci", status: pr?.ci === "in_progress" ? "in_progress" : "completed", conclusion: pr?.ci === "in_progress" ? null : "success", app: { slug: "github-actions" }, output: {} };
            const gate = w.checks
              .filter((c) => c.sha === ref)
              .map((c) => ({ id: c.id, name: c.name, status: c.status, conclusion: c.conclusion, app: { slug: c.app }, output: c.output }));
            const all = [ci, ...gate];
            return { check_runs: check_name ? all.filter((c) => c.name === check_name) : all };
          }),
          create: call("checks.create", ({ head_sha, name, conclusion, output }: any) => {
            w.checks.push({ id: w.nextId++, sha: head_sha, name, app: APP, status: "completed", conclusion, output });
            return {};
          }),
          update: call("checks.update", ({ check_run_id, status, conclusion, output }: any) => {
            const c = w.checks.find((x) => x.id === check_run_id)!;
            c.status = status;
            c.conclusion = status === "completed" ? conclusion : null;
            c.output = output;
            return {};
          }),
        },
      },
    };
  }
}

const POLICY = {
  botLogin: BOT,
  approvalBodyRegex: "(?:^|\\n)[ \\t]*\\*\\*Verdict:\\*\\* APPROVE[ \\t]*$",
  blockingLabels: ["hold"],
  requireCi: true,
};

let run = 0;
function tick(w: World, opts: { prNumber?: number; budgetSeconds?: number; merge?: "off" | "agent-only"; rotation?: number } = {}) {
  const o = w.octokit();
  const before = w.total();
  return runHybridGate({
    octokit: o,
    checksOctokit: o,
    owner: "o",
    repo: "r",
    policy: { ...POLICY },
    checkName: CHECK,
    checkApp: APP,
    baseBranch: "main",
    merge: opts.merge ?? "off",
    rollout: undefined,
    prNumber: opts.prNumber,
    dryRun: false,
    timeBudgetSeconds: opts.budgetSeconds,
    rotation: opts.rotation ?? run++,
    now: () => w.clock,
  }).then((r) => ({ ...r, calls: w.total() - before }));
}

const current = (w: World, n: number, conclusion: string) => w.result(n)?.status === "completed" && w.result(n)?.conclusion === conclusion;

/** A repo shaped like a busy one: 800 open PRs, 78 reviewed by the bot, 24 with a verdict on the head. */
function busyRepo(): World {
  const w = new World();
  for (let n = 1; n <= 800; n++) w.add({ number: n, user: `dev${n % 40}`, reviewed: n % 10 === 0 || n <= 3, verdict: n % 30 === 0 ? "APPROVE" : undefined });
  return w;
}

describe("candidates: only PRs the bot has reviewed", () => {
  it("one search finds them; the other ~720 open PRs are never read", async () => {
    run = 0;
    const w = busyRepo();
    const reviewed = [...w.prs.values()].filter((p) => p.reviewed).length;
    expect(reviewed).toBe(83);
    const t = await tick(w);
    expect(w.calls["graphql.search"]).toBe(1); // 83 results fit one page
    expect(w.calls["pulls.list"]).toBeUndefined();
    expect(t.evaluated).toBe(GATE_TICK_LIMIT);
    expect(w.calls["pulls.get"]).toBe(GATE_TICK_LIMIT);
  });

  it("a head with no verdict gets no result: a missing required check blocks, a neutral one would pass", async () => {
    const w = new World();
    w.add({ number: 1, reviewed: true }); // reviewed, no verdict
    w.add({ number: 2, reviewed: true, verdict: "APPROVE" });
    await tick(w);
    expect(w.result(1)).toBeUndefined();
    expect(current(w, 2, "success")).toBe(true);
    expect(w.checks.every((c) => c.conclusion !== "neutral")).toBe(true);
  });

  it("a result whose verdict is dismissed is withdrawn to in progress, not left passing", async () => {
    const w = new World();
    w.add({ number: 1, reviewed: true, verdict: "APPROVE" });
    await tick(w, { prNumber: 1 });
    expect(current(w, 1, "success")).toBe(true);
    w.prs.get(1)!.verdict = undefined; // dismissed
    await tick(w, { prNumber: 1 });
    expect(w.result(1)!.status).toBe("in_progress");
    expect(w.result(1)!.conclusion).toBeNull();
    expect(w.result(1)!.output.title).toBe("Awaiting the approver");
  });

  it("a failed search is a quiet tick — no fallback to walking every open PR", async () => {
    const w = busyRepo();
    w.failSearch = true;
    const t = await tick(w);
    expect(t.evaluated).toBe(0);
    expect(w.calls["pulls.list"]).toBeUndefined();
    expect(w.calls["pulls.get"]).toBeUndefined();
  });

  it("dependabot's PRs are searched too when the policy runs its lane", async () => {
    const w = new World();
    w.add({ number: 1, user: "dependabot[bot]" });
    const o = w.octokit();
    await runHybridGate({
      octokit: o, checksOctokit: o, owner: "o", repo: "r", checkName: CHECK, checkApp: APP, baseBranch: "main", merge: "off", rollout: undefined, dryRun: false,
      policy: { ...POLICY, dependabot: { autoMerge: ["patch"] } } as any,
    });
    expect(w.calls["graphql.search"]).toBe(2);
    expect(w.calls["pulls.get"]).toBe(1);
  });
});

describe("the scheduled pass", () => {
  it("a rotating window reaches every candidate within ⌈candidates ÷ 20⌉ ticks, without stored state", async () => {
    const w = busyRepo();
    const seen = new Set<number>();
    const ticks = Math.ceil(83 / GATE_TICK_LIMIT);
    for (let t = 0; t < ticks; t++) {
      const o = w.octokit();
      const getSpy = o.rest.pulls.get;
      o.rest.pulls.get = async (p: any) => {
        seen.add(p.pull_number);
        return getSpy(p);
      };
      await runHybridGate({ octokit: o, checksOctokit: o, owner: "o", repo: "r", policy: { ...POLICY }, checkName: CHECK, checkApp: APP, baseBranch: "main", merge: "off", rollout: undefined, dryRun: false, rotation: 100 + t });
    }
    expect(seen.size).toBe(83);
  });

  it("a verdicted head gets its check at once from the review event; CI finishing later is picked up by the pass", async () => {
    run = 0;
    const w = busyRepo();
    w.add({ number: 801, reviewed: true, verdict: "APPROVE", ci: "in_progress" });
    // The approver posts its verdict: the event runs the gate for that PR alone.
    const t = await tick(w, { prNumber: 801 });
    expect(t.calls).toBeLessThanOrEqual(8);
    expect(current(w, 801, "failure")).toBe(true); // CI still running
    // CI finishes — no event. The pass reaches it within ⌈84 ÷ 20⌉ ticks.
    w.prs.get(801)!.ci = "success";
    let ticks = 0;
    while (!current(w, 801, "success") && ticks < 10) {
      await tick(w);
      ticks++;
    }
    expect(current(w, 801, "success")).toBe(true);
    expect(ticks).toBeLessThanOrEqual(Math.ceil(84 / GATE_TICK_LIMIT));
  });

  it("an interrupted tick loses nothing: the window moves on regardless", async () => {
    run = 0;
    const w = busyRepo();
    w.evalMs = 10_000;
    const t1 = await tick(w, { budgetSeconds: 40 });
    expect(t1.evaluated).toBeLessThan(GATE_TICK_LIMIT);
    w.evalMs = 2000;
    for (let t = 0; t < Math.ceil(83 / GATE_TICK_LIMIT); t++) await tick(w);
    // Every verdicted, reviewed head has a result.
    const verdicted = [...w.prs.values()].filter((p) => p.reviewed && p.verdict);
    for (const p of verdicted) expect(w.result(p.number), `#${p.number}`).toBeDefined();
  });

  it("a failed read is retried on a later tick", async () => {
    const w = new World();
    w.add({ number: 1, reviewed: true, verdict: "APPROVE", failReads: 1 });
    await tick(w);
    expect(w.result(1)).toBeUndefined();
    await tick(w);
    expect(current(w, 1, "success")).toBe(true);
  });

  it("a targeted run on a closed PR does nothing", async () => {
    const w = new World();
    w.add({ number: 1, state: "closed", reviewed: true, verdict: "APPROVE" });
    const r = await tick(w, { prNumber: 1 });
    expect(r.evaluated).toBe(0);
    expect(w.checks).toEqual([]);
  });

  it("a new commit carries no earlier result, and a merge pins the SHA it evaluated", async () => {
    const w = new World();
    w.add({ number: 1, reviewed: true, verdict: "APPROVE" });
    await tick(w, { prNumber: 1 });
    w.prs.get(1)!.head = 2;
    w.prs.get(1)!.verdict = undefined;
    expect(w.result(1)).toBeUndefined();
    await tick(w, { prNumber: 1, merge: "agent-only" });
    expect(w.result(1)).toBeUndefined();
    expect(w.merged).toEqual([]);
  });
});

describe("API calls", () => {
  it("per tick and per targeted run, on the busy repo", async () => {
    run = 0;
    const w = busyRepo();
    const full = await tick(w);
    const targeted = await tick(w, { prNumber: 30 });
    // One search page + about 6 calls per evaluated PR (20 per tick).
    expect(full.calls).toBeLessThanOrEqual(1 + 7 * GATE_TICK_LIMIT);
    expect(targeted.calls).toBeLessThanOrEqual(8);
  });
});

