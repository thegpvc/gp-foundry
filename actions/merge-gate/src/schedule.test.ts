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

const { runHybridGate, publishCheck, readAtOf, GATE_TICK_LIMIT } = await import("./index.js");

const BOT = "gate-bot[bot]";
const CHECK = "acme/approval";
const APP = "gate-app";
const sha = (n: number, v = 1) => `${String(n).padStart(4, "0")}${"0".repeat(32)}v${v}`.slice(0, 40);

interface FakePr {
  number: number;
  head: number; // version of the head commit
  labels: string[];
  approved: boolean;
  user?: string;
  state?: string;
  /** pulls.get throws this many more times. */
  failReads?: number;
}

/** A fake GitHub: PRs, CI and the gate's own check runs, kept between ticks. */
class World {
  prs = new Map<number, FakePr>();
  checks: { id: number; sha: string; name: string; app: string; conclusion: string; output: { title: string; summary: string; text: string } }[] = [];
  merged: { pr: number; sha: string }[] = [];
  calls = 0;
  clock = Date.parse("2026-11-17T00:00:00Z");
  /** Fake time each full evaluation takes (charged when the PR is read). */
  evalMs = 5000;
  private nextId = 1;

  add(pr: Partial<FakePr> & { number: number }) {
    this.prs.set(pr.number, { head: 1, labels: [], approved: true, ...pr });
  }
  headSha(n: number) {
    return sha(n, this.prs.get(n)!.head);
  }
  /** The gate's current result on a PR's current head, if any. */
  result(n: number) {
    const s = this.headSha(n);
    return this.checks.filter((c) => c.sha === s && c.name === CHECK && c.app === APP).sort((a, b) => b.id - a.id)[0];
  }
  private prJson(p: FakePr) {
    return {
      number: p.number,
      state: p.state ?? "open",
      draft: false,
      title: `PR ${p.number}`,
      user: { login: p.user ?? BOT, type: "Bot" },
      labels: p.labels.map((name) => ({ name })),
      head: { sha: sha(p.number, p.head), ref: `agent/${p.number}`, repo: { full_name: "o/r" } },
      base: { ref: "main" },
      mergeable: true,
      mergeable_state: "clean",
      requested_reviewers: [],
      requested_teams: [],
    };
  }
  octokit(): any {
    const w = this;
    const call = <T>(fn: (p: any) => T) => async (p: any) => {
      w.calls++;
      return { data: fn(p) };
    };
    return {
      paginate: async (fn: (p: any) => Promise<{ data: any }>, params: any) => {
        const { data } = await fn(params);
        return Array.isArray(data) ? data : data.check_runs ?? data;
      },
      graphql: async () => {
        w.calls++;
        return { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] }, reviewDecision: null } } };
      },
      rest: {
        pulls: {
          list: call(() => [...w.prs.values()].filter((p) => (p.state ?? "open") === "open").sort((a, b) => a.number - b.number).map((p) => w.prJson(p))),
          get: async ({ pull_number }: any) => {
            w.calls++;
            const p = w.prs.get(pull_number)!;
            w.clock += w.evalMs;
            if (p.failReads) {
              p.failReads--;
              throw new Error("HTTP 502");
            }
            return { data: w.prJson(p) };
          },
          listReviews: call(({ pull_number }: any) => {
            const p = w.prs.get(pull_number)!;
            return p.approved
              ? [{ submitted_at: "2026-11-16T00:00:00Z", state: "COMMENTED", commit_id: sha(p.number, p.head), user: { login: BOT }, author_association: "NONE", body: "ok\n\n**Verdict:** APPROVE" }]
              : [];
          }),
          listFiles: call(() => [{ filename: "src/a.ts", additions: 10, deletions: 0 }]),
          listCommits: call(() => [{ author: { login: BOT } }]),
          merge: call(({ pull_number, sha: s }: any) => {
            w.merged.push({ pr: pull_number, sha: s });
            return {};
          }),
        },
        issues: {
          listComments: call(() => []),
          addLabels: call(() => ({})),
          removeLabel: call(() => ({})),
          createComment: call(() => ({})),
        },
        repos: { getCommit: call(() => ({ commit: { committer: { date: "2026-11-15T00:00:00Z" } } })) },
        git: { deleteRef: call(() => ({})) },
        checks: {
          listForRef: call(({ ref, check_name }: any) => {
            const ci = { id: 0, name: "ci", status: "completed", conclusion: "success", app: { slug: "github-actions" }, output: { text: "" } };
            const gate = w.checks
              .filter((c) => c.sha === ref)
              .map((c) => ({ id: c.id, name: c.name, status: "completed", conclusion: c.conclusion, app: { slug: c.app }, output: c.output, completed_at: null }));
            const all = [ci, ...gate];
            return { check_runs: check_name ? all.filter((c) => c.name === check_name) : all };
          }),
          create: call(({ head_sha, name, conclusion, output }: any) => {
            w.checks.push({ id: w.nextId++, sha: head_sha, name, app: APP, conclusion, output });
            return {};
          }),
          update: call(({ check_run_id, conclusion, output }: any) => {
            const c = w.checks.find((x) => x.id === check_run_id)!;
            c.conclusion = conclusion;
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

function tick(w: World, opts: { prNumber?: number; budgetSeconds?: number; merge?: "off" | "agent-only"; now?: () => number } = {}) {
  const o = w.octokit();
  const before = w.calls;
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
    now: opts.now ?? (() => w.clock),
  }).then((r) => ({ ...r, calls: w.calls - before }));
}

const current = (w: World, n: number, conclusion: string) => w.result(n)?.conclusion === conclusion;

describe("the scheduled pass on a backlog larger than one tick", () => {
  let w: World;
  beforeEach(() => {
    w = new World();
    for (let n = 1; n <= 50; n++) w.add({ number: n });
    w.add({ number: 3, labels: ["hold"] }); // an older head held by a label
  });

  it("evaluates at most the per-tick limit, never-evaluated heads first", async () => {
    const t1 = await tick(w);
    expect(t1.evaluated).toBe(GATE_TICK_LIMIT);
    expect([...w.prs.keys()].filter((n) => w.result(n)).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    const t2 = await tick(w);
    expect(t2.evaluated).toBe(GATE_TICK_LIMIT);
    // The second tick continues where the first stopped, not from the oldest PR.
    expect(w.result(21)).toBeDefined();
    expect(w.result(40)).toBeDefined();
  });

  it("an interrupted pass loses nothing; a new head and a cleared hold get current results within a bounded number of ticks", async () => {
    // Tick 1 is cut short by its time budget: 8 evaluations of 5s fit in 40s.
    const t1 = await tick(w, { budgetSeconds: 40 });
    expect(t1.evaluated).toBeLessThan(GATE_TICK_LIMIT);
    expect(current(w, 3, "failure")).toBe(true); // #3 was reached, and is held

    // Meanwhile: a ready head near the tail, and the hold on #3 cleared without a push.
    w.add({ number: 51 });
    w.prs.get(3)!.labels = [];

    const bound = Math.ceil(w.prs.size / GATE_TICK_LIMIT) + 1;
    let ticks = 0;
    const perTick: number[] = [];
    while (!(current(w, 51, "success") && current(w, 3, "success")) && ticks < bound + 2) {
      perTick.push((await tick(w)).calls);
      ticks++;
    }
    expect(current(w, 51, "success")).toBe(true);
    expect(current(w, 3, "success")).toBe(true);
    expect(ticks).toBeLessThanOrEqual(bound);
    // API calls per tick: one listing, one check read per PR in scope, about six per evaluation.
    for (const c of perTick) expect(c).toBeLessThanOrEqual(1 + w.prs.size + 7 * GATE_TICK_LIMIT);
  });

  it("a targeted run gives the PR an event was about a current result at once", async () => {
    await tick(w);
    w.prs.get(3)!.labels = [];
    const r = await tick(w, { prNumber: 3 });
    expect(r.evaluated).toBe(1);
    expect(current(w, 3, "success")).toBe(true);
    expect(r.calls).toBeLessThanOrEqual(8);
  });

  it("a failed read is retried: the head stays first in line", async () => {
    w.prs.get(2)!.failReads = 1;
    await tick(w);
    expect(w.result(2)).toBeUndefined();
    await tick(w);
    expect(current(w, 2, "success")).toBe(true);
  });
});

describe("no stale result", () => {
  it("a result read earlier never replaces one read later (duplicate or slow runs)", async () => {
    const w = new World();
    w.add({ number: 1 });
    await tick(w, { prNumber: 1 }); // published, read at t0+5s
    const fresh = w.result(1)!;
    w.prs.get(1)!.labels = ["hold"]; // the state changes…
    // …and a run that read BEFORE the published one finishes last.
    const r = await tick(w, { prNumber: 1, now: () => Date.parse("2026-11-16T00:00:00Z") });
    expect(r.written).toBe(0);
    expect(w.result(1)!.conclusion).toBe(fresh.conclusion);
    expect(w.result(1)!.output.text).toBe(fresh.output.text);
  });

  it("…and a run that is stale does not merge on its result either", async () => {
    const w = new World();
    w.add({ number: 1 });
    await tick(w, { prNumber: 1 });
    const r = await tick(w, { prNumber: 1, merge: "agent-only", now: () => Date.parse("2026-11-16T00:00:00Z") });
    expect(r.mergedPr).toBe("");
    expect(w.merged).toEqual([]);
  });

  it("an unchanged result is re-stamped, so the check records the latest read", async () => {
    const w = new World();
    w.add({ number: 1 });
    await tick(w, { prNumber: 1 });
    const first = readAtOf(w.result(1)!.output.text)!;
    await tick(w, { prNumber: 1 });
    expect(readAtOf(w.result(1)!.output.text)!).toBeGreaterThan(first);
    expect(w.checks).toHaveLength(1); // updated in place
  });

  it("a superseded head never carries an approval: results are per commit, and a merge pins the SHA", async () => {
    const w = new World();
    w.add({ number: 1 });
    await tick(w, { prNumber: 1 });
    expect(current(w, 1, "success")).toBe(true);
    w.prs.get(1)!.head = 2; // a new commit
    w.prs.get(1)!.approved = false; // the approval was for the old head
    expect(w.result(1)).toBeUndefined(); // nothing on the new head yet
    await tick(w, { prNumber: 1, merge: "agent-only" });
    expect(current(w, 1, "failure")).toBe(true);
    expect(w.merged).toEqual([]);
  });

  it("a targeted run on a closed PR does nothing", async () => {
    const w = new World();
    w.add({ number: 1, state: "closed" });
    const r = await tick(w, { prNumber: 1 });
    expect(r.evaluated).toBe(0);
    expect(w.checks).toEqual([]);
  });
});

describe("publishCheck with a read time", () => {
  it("returns superseded, and writes nothing, when the published result was read later", async () => {
    const w = new World();
    w.add({ number: 1 });
    await tick(w, { prNumber: 1 });
    const o = w.octokit();
    const r = await publishCheck(o, "o", "r", w.headSha(1), CHECK, { conclusion: "failure", title: "x", summary: "x", text: "" }, APP, "2020-01-01T00:00:00.000Z");
    expect(r).toBe("superseded");
    expect(w.result(1)!.conclusion).toBe("success");
  });
});

