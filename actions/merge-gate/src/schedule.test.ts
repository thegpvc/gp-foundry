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
/** quiet_verdicts=: the approver's verdict check, and the harness App that owns it. */
const QUIET_CHECK = "gp-foundry/verdict (approver)";
const QUIET_APP = "agent-app";
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
  /** More check runs on the current head (other workflows' jobs, the gate's own job). */
  extra?: { name: string; status: string; conclusion: string | null; details_url?: string; app?: string; completed_at?: string; head_sha?: string; output?: { title?: string; summary?: string } }[];
  draft?: boolean;
  /** When the re-review label was added, if it is on the PR. */
  rereviewAt?: string;
  /** The label history read fails. */
  eventsFail?: boolean;
  /** The label is on, but its history has no labeled event for it. */
  undated?: boolean;
  /** When the verdict was posted (default before any re-review request). */
  verdictAt?: string;
}

/** A fake GitHub: PRs, CI and the gate's own check runs, kept between ticks. */
class World {
  prs = new Map<number, FakePr>();
  checks: { id: number; sha: string; name: string; app: string; status: string; conclusion: string | null; output: { title: string; summary: string; text?: string } }[] = [];
  merged: { pr: number; sha: string }[] = [];
  calls: Record<string, number> = {};
  /** Every call, in order. */
  order: string[] = [];
  failSearch = false;
  /** The search honours `-label:"…"` (real GitHub does); off, only the gate's own scope test filters. */
  honourLabelExclusion = true;
  queries: string[] = [];
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
    this.order.push(k);
  }
  private prJson(p: FakePr) {
    return {
      number: p.number,
      state: p.state ?? "open",
      draft: !!p.draft,
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
          w.queries.push(q);
          const open = [...w.prs.values()].filter((p) => (p.state ?? "open") === "open");
          const excluded = w.honourLabelExclusion ? [...q.matchAll(/-label:"([^"]+)"/g)].map((m) => m[1]!) : [];
          const hits = (q.includes("reviewed-by:") ? open.filter((p) => p.reviewed) : q.includes("author:app/dependabot") ? open.filter((p) => p.user === "dependabot[bot]") : open).filter(
            (p) => !p.labels.some((l) => excluded.includes(l)),
          );
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
                isDraft: !!p.draft,
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
              ...(p.verdict ? [{ submitted_at: p.verdictAt ?? "2026-11-16T00:00:00Z", state: "COMMENTED", commit_id: h, user: { login: BOT }, author_association: "NONE", body: `ok\n\n**Verdict:** ${p.verdict}` }] : []),
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
          listEvents: call("issues.listEvents", ({ issue_number }: any) => {
            const p = w.prs.get(issue_number)!;
            if (p.eventsFail) throw new Error("HTTP 502");
            return p.rereviewAt && !p.undated ? [{ event: "labeled", label: { name: "re-review" }, created_at: p.rereviewAt }] : [];
          }),
          listComments: call("issues.listComments", () => []),
          addLabels: call("issues.addLabels", () => ({})),
          removeLabel: call("issues.removeLabel", ({ issue_number, name }: any) => {
            const p = w.prs.get(issue_number)!;
            p.labels = p.labels.filter((l) => l !== name);
            p.rereviewAt = undefined;
            return {};
          }),
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
            const extra = (pr?.extra ?? []).map((c, i) => ({ id: 1000 + i, ...c, app: { slug: c.app ?? "github-actions" }, output: c.output ?? {} }));
            const all = [ci, ...extra, ...gate];
            return { check_runs: check_name ? all.filter((c) => c.name === check_name) : all };
          }),
          create: call("checks.create", ({ head_sha, name, status, conclusion, output }: any) => {
            const st = status ?? "completed";
            w.checks.push({ id: w.nextId++, sha: head_sha, name, app: APP, status: st, conclusion: st === "completed" ? conclusion : null, output });
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

/** The gate's own run, as the action reads it from the runner and the compiler. */
const SELF = { runId: "7001", jobCheckName: "gate" };
const runUrl = (id: string | number) => `https://github.com/o/r/actions/runs/${id}/job/${Number(id) + 1}`;

const POLICY = {
  botLogin: BOT,
  approvalBodyRegex: "(?:^|\\n)[ \\t]*\\*\\*Verdict:\\*\\* APPROVE[ \\t]*$",
  blockingLabels: ["hold"],
  requireCi: true,
};

let run = 0;
function tick(
  w: World,
  opts: { prNumber?: number; budgetSeconds?: number; merge?: "off" | "agent-only"; rotation?: number; rollout?: { skipLabel?: string; authors?: string[] }; rereview?: boolean; quiet?: boolean; self?: { runId?: string; jobCheckName?: string } } = {},
) {
  const o = w.octokit();
  const before = w.total();
  return runHybridGate({
    octokit: o,
    checksOctokit: o,
    owner: "o",
    repo: "r",
    policy: { ...POLICY, ...(opts.rereview ? { rereviewLabel: "re-review" } : {}), ...(opts.quiet ? { verdictChecks: [QUIET_CHECK], verdictApp: QUIET_APP } : {}) },
    checkName: CHECK,
    checkApp: APP,
    baseBranch: "main",
    merge: opts.merge ?? "off",
    rollout: opts.rollout,
    ...(opts.rereview ? { rereviewLabel: "re-review" } : {}),
    prNumber: opts.prNumber,
    dryRun: false,
    timeBudgetSeconds: opts.budgetSeconds,
    self: opts.self ?? SELF,
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
    // Superseded by a new run, not reopened: the old run keeps its conclusion but is no longer the newest.
    expect(w.checks).toHaveLength(2);
    // A new verdict completes the newest run.
    w.prs.get(1)!.verdict = "APPROVE";
    await tick(w, { prNumber: 1 });
    expect(current(w, 1, "success")).toBe(true);
    expect(w.checks).toHaveLength(2);
  });

  it("a targeted run on a PR into another branch does nothing", async () => {
    const w = new World();
    w.add({ number: 1, reviewed: true, verdict: "APPROVE" });
    const o = w.octokit();
    const get = o.rest.pulls.get;
    o.rest.pulls.get = async (p: any) => {
      const r = await get(p);
      return { data: { ...r.data, base: { ref: "release/1.x" } } };
    };
    const r = await runHybridGate({ octokit: o, checksOctokit: o, owner: "o", repo: "r", policy: { ...POLICY }, checkName: CHECK, checkApp: APP, baseBranch: "main", merge: "agent-only", rollout: undefined, prNumber: 1, dryRun: false });
    expect(r.evaluated).toBe(0);
    expect(w.checks).toEqual([]);
    expect(w.merged).toEqual([]);
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
    // CI still running: an event run publishes nothing rather than a failure.
    expect(w.result(801)).toBeUndefined();
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


describe("the gate's own run is not CI", () => {
  // On a pull_request or pull_request_review event the gate's own job is a check
  // run on the PR's head, in progress while the gate reads that head.
  const ownJob = { name: "gate", status: "in_progress", conclusion: null, details_url: runUrl(SELF.runId) };

  it("an event run whose own job is in progress publishes success on a ready head", async () => {
    const w = new World();
    w.add({ number: 1, reviewed: true, verdict: "APPROVE", extra: [ownJob] });
    await tick(w, { prNumber: 1 });
    expect(current(w, 1, "success")).toBe(true);
  });

  it("this run is recognised by its run id alone, whatever its job is called", async () => {
    const w = new World();
    w.add({ number: 1, reviewed: true, verdict: "APPROVE", extra: [{ ...ownJob, name: "Fletch gate" }] });
    await tick(w, { prNumber: 1, self: { runId: SELF.runId } });
    expect(current(w, 1, "success")).toBe(true);
  });

  it.each(["cancelled", "timed_out", "failure"])("an earlier run of the gate that ended %s never counts as failing CI", async (conclusion) => {
    for (const prNumber of [1, undefined]) {
      const w = new World();
      w.add({ number: 1, reviewed: true, verdict: "APPROVE", extra: [{ name: "gate", status: "completed", conclusion, details_url: runUrl(6999) }, ownJob] });
      await tick(w, { prNumber });
      expect(current(w, 1, "success"), `pr-number ${prNumber}`).toBe(true);
    }
  });

  it("an earlier run of the gate still in progress does not count either", async () => {
    const w = new World();
    w.add({ number: 1, reviewed: true, verdict: "APPROVE", extra: [{ name: "gate", status: "in_progress", conclusion: null, details_url: runUrl(6999) }] });
    await tick(w); // the scheduled pass: its own job is on the default branch, not here
    expect(current(w, 1, "success")).toBe(true);
  });

  it("an unrelated check still in progress is still pending CI", async () => {
    const w = new World();
    w.add({ number: 1, reviewed: true, verdict: "APPROVE", extra: [ownJob, { name: "rerun", status: "in_progress", conclusion: null, details_url: runUrl(8123) }] });
    await tick(w);
    expect(current(w, 1, "failure")).toBe(true);
    expect(w.result(1)!.output.text).toContain("`rerun`: in_progress");
    expect(w.result(1)!.output.text).not.toContain("`gate`");
  });

  it("a job of another run whose id merely starts with this run's is not this run", async () => {
    const w = new World();
    w.add({ number: 1, reviewed: true, verdict: "APPROVE", extra: [{ name: "build", status: "completed", conclusion: "failure", details_url: runUrl(`${SELF.runId}1`) }] });
    await tick(w);
    expect(current(w, 1, "failure")).toBe(true);
  });

  it("a check named like the gate's job from another app still counts", async () => {
    const w = new World();
    w.add({ number: 1, reviewed: true, verdict: "APPROVE", extra: [{ name: "gate", status: "completed", conclusion: "failure", app: "some-ci", details_url: runUrl(SELF.runId) }] });
    await tick(w);
    expect(current(w, 1, "failure")).toBe(true);
  });

  it("the scheduled pass is unaffected: a ready head is success, failed CI is failure", async () => {
    const w = new World();
    w.add({ number: 1, reviewed: true, verdict: "APPROVE" });
    w.add({ number: 2, reviewed: true, verdict: "APPROVE", extra: [{ name: "test", status: "completed", conclusion: "failure" }] });
    await tick(w);
    expect(current(w, 1, "success")).toBe(true);
    expect(current(w, 2, "failure")).toBe(true);
  });
});

describe("an event run while other workflows are still starting on the head", () => {
  // A review or label starts other workflows too (a repo may re-run checks on
  // pull_request_review), so at the moment of a verdict their jobs
  // are queued on the head.
  const starting = { name: "rerun", status: "queued", conclusion: null, details_url: runUrl(8123) };

  it("publishes nothing when pending CI is all that stands between the head and success", async () => {
    const w = new World();
    w.add({ number: 1, reviewed: true, verdict: "APPROVE", extra: [starting] });
    await tick(w, { prNumber: 1 });
    expect(w.result(1)).toBeUndefined();
  });

  it("leaves the head's existing result as it is — no success → formal approval → failure loop", async () => {
    const w = new World();
    w.add({ number: 1, reviewed: true, verdict: "APPROVE" });
    await tick(w); // the scheduled pass: success
    expect(current(w, 1, "success")).toBe(true);
    // A person's formal approval is a review event: it starts this run and other workflows.
    w.prs.get(1)!.extra = [starting, { name: "gate", status: "in_progress", conclusion: null, details_url: runUrl(SELF.runId) }];
    const before = w.checks.map((c) => ({ ...c }));
    await tick(w, { prNumber: 1 });
    expect(w.checks).toEqual(before);
    // The pass settles it once they finish.
    w.prs.get(1)!.extra = [{ ...starting, status: "completed", conclusion: "success" }];
    await tick(w);
    expect(current(w, 1, "success")).toBe(true);
  });

  it("still publishes failure for failed CI, and for another failing clause while CI is pending", async () => {
    const w = new World();
    w.add({ number: 1, reviewed: true, verdict: "APPROVE", extra: [{ ...starting, status: "completed", conclusion: "failure" }] });
    w.add({ number: 2, reviewed: true, verdict: "APPROVE", labels: ["hold"], extra: [starting] });
    w.add({ number: 3, reviewed: true, verdict: "REQUEST_CHANGES", extra: [starting] });
    for (const n of [1, 2, 3]) await tick(w, { prNumber: n });
    expect(current(w, 1, "failure")).toBe(true);
    expect(current(w, 2, "failure")).toBe(true);
    expect(current(w, 3, "failure")).toBe(true);
  });

  it("the scheduled pass still reports pending CI as failure", async () => {
    const w = new World();
    w.add({ number: 1, reviewed: true, verdict: "APPROVE", extra: [starting] });
    await tick(w);
    expect(current(w, 1, "failure")).toBe(true);
  });
});

describe("a leftover 0.3 neutral result", () => {
  it("is withdrawn on a head with no verdict — a neutral would pass a required check", async () => {
    const w = new World();
    w.add({ number: 1, reviewed: true }); // no verdict
    w.checks.push({ id: 0, sha: w.headSha(1), name: CHECK, app: APP, status: "completed", conclusion: "neutral", output: { title: "Awaiting the approver", summary: "awaiting the approver" } });
    await tick(w, { prNumber: 1 });
    expect(w.result(1)!.status).toBe("in_progress");
    // (The approver is not held up by it: its select job ignores the gate's checks — see reviewer-controls.)
    // A verdict then replaces it like any result.
    w.prs.get(1)!.verdict = "APPROVE";
    await tick(w, { prNumber: 1 });
    expect(current(w, 1, "success")).toBe(true);
  });

  it.each(["success", "failure", "action_required"])("a %s result whose verdict is gone is still withdrawn", async (conclusion) => {
    const w = new World();
    w.add({ number: 1, reviewed: true });
    w.checks.push({ id: 0, sha: w.headSha(1), name: CHECK, app: APP, status: "completed", conclusion, output: { title: "t", summary: "s" } });
    await tick(w, { prNumber: 1 });
    expect(w.result(1)!.status).toBe("in_progress");
  });
});

describe("the window holds only PRs in scope", () => {
  const SKIP = "fletch:skip";
  /** `total` reviewed PRs, the first `skipped` of them carrying the skip label. */
  const repo = (total: number, skipped: number) => {
    const w = new World();
    for (let n = 1; n <= total; n++) w.add({ number: n, user: `dev${n % 7}`, reviewed: true, verdict: "APPROVE", labels: n <= skipped ? [SKIP] : [] });
    return w;
  };
  const seenIn = async (w: World, rotation: number) => {
    const seen: number[] = [];
    const o = w.octokit();
    const get = o.rest.pulls.get;
    o.rest.pulls.get = async (p: any) => {
      seen.push(p.pull_number);
      return get(p);
    };
    const r = await runHybridGate({
      octokit: o, checksOctokit: o, owner: "o", repo: "r", policy: { ...POLICY }, checkName: CHECK, checkApp: APP, baseBranch: "main", merge: "off", rollout: { skipLabel: SKIP }, dryRun: false, rotation,
    });
    return { seen, evaluated: r.evaluated };
  };

  it("the search itself leaves out the skip label", async () => {
    const w = repo(10, 3);
    await tick(w, { rollout: { skipLabel: SKIP } });
    expect(w.queries).toEqual([`repo:o/r is:pr is:open base:main reviewed-by:${BOT} -label:"${SKIP}"`]);
  });

  it("100 candidates, 90 skipped: one tick evaluates all 10 in scope, even when the search returns the skipped ones", async () => {
    const w = repo(100, 90);
    w.honourLabelExclusion = false;
    for (const rotation of [0, 1, 7]) {
      const { seen, evaluated } = await seenIn(w, rotation);
      expect(evaluated).toBe(10);
      expect(seen.sort((a, b) => a - b)).toEqual([91, 92, 93, 94, 95, 96, 97, 98, 99, 100]);
    }
  });

  it("a tick evaluates up to 20 in scope, and covers every in-scope PR within ⌈n ÷ 20⌉ ticks", async () => {
    const w = repo(200, 150); // 50 in scope
    w.honourLabelExclusion = false;
    const all = new Set<number>();
    const ticks = Math.ceil(50 / GATE_TICK_LIMIT);
    for (let t = 0; t < ticks; t++) {
      const { seen, evaluated } = await seenIn(w, 40 + t);
      expect(evaluated).toBe(GATE_TICK_LIMIT);
      expect(seen.every((n) => n > 150)).toBe(true);
      seen.forEach((n) => all.add(n));
    }
    expect(all.size).toBe(50);
  });

  it("dependabot's lane is searched without the exclusion: the skip label does not stop that lane", async () => {
    const w = new World();
    w.add({ number: 1, user: "dependabot[bot]", labels: [SKIP] });
    const o = w.octokit();
    const r = await runHybridGate({
      octokit: o, checksOctokit: o, owner: "o", repo: "r", checkName: CHECK, checkApp: APP, baseBranch: "main", merge: "off", rollout: { skipLabel: SKIP }, dryRun: false,
      policy: { ...POLICY, dependabot: { autoMerge: ["patch"] } } as any,
    });
    expect(w.queries[1]).toBe("repo:o/r is:pr is:open base:main author:app/dependabot");
    expect(r.evaluated).toBe(1);
  });
});

describe("0.4.1: the re-review label at the gate", () => {
  const LABELLED = "2026-11-17T12:00:00Z";
  const before = "2026-11-17T11:00:00Z";
  const after = "2026-11-17T13:00:00Z";

  it("holds the result at in progress while there is no verdict newer than the label, and merges nothing", async () => {
    const w = new World();
    w.add({ number: 1, reviewed: true, verdict: "APPROVE", verdictAt: before, labels: ["re-review"], rereviewAt: LABELLED });
    await tick(w, { prNumber: 1, merge: "agent-only", rereview: true });
    expect(w.result(1)!.status).toBe("in_progress");
    expect(w.result(1)!.output.title).toBe("Re-review requested");
    expect(w.merged).toEqual([]);
    expect(w.prs.get(1)!.labels).toEqual(["re-review"]);
  });

  it("an earlier passing result is superseded, not left passing", async () => {
    const w = new World();
    w.add({ number: 1, reviewed: true, verdict: "APPROVE", verdictAt: before });
    await tick(w, { prNumber: 1, rereview: true });
    expect(current(w, 1, "success")).toBe(true);
    w.prs.get(1)!.labels = ["re-review"];
    w.prs.get(1)!.rereviewAt = LABELLED;
    await tick(w, { prNumber: 1, rereview: true });
    expect(w.result(1)!.status).toBe("in_progress");
  });

  it("a fresh verdict ends it: the label comes off and the head is judged (and merged) as usual", async () => {
    const w = new World();
    w.add({ number: 1, reviewed: true, verdict: "APPROVE", verdictAt: after, labels: ["re-review"], rereviewAt: LABELLED });
    await tick(w, { prNumber: 1, merge: "agent-only", rereview: true });
    expect(w.prs.get(1)!.labels).toEqual([]);
    expect(current(w, 1, "success")).toBe(true);
    expect(w.merged).toEqual([{ pr: 1, sha: w.headSha(1) }]);
  });

  it("an unreadable label history holds the result (never skips the PR, leaving a stale success)", async () => {
    const w = new World();
    w.add({ number: 1, reviewed: true, verdict: "APPROVE", verdictAt: before });
    await tick(w, { prNumber: 1, rereview: true });
    expect(current(w, 1, "success")).toBe(true);
    Object.assign(w.prs.get(1)!, { labels: ["re-review"], rereviewAt: LABELLED, eventsFail: true });
    await tick(w, { prNumber: 1, merge: "agent-only", rereview: true });
    expect(w.result(1)!.status).toBe("in_progress");
    expect(w.result(1)!.output.summary).toContain("could not read");
    expect(w.merged).toEqual([]);
    expect(w.prs.get(1)!.labels).toEqual(["re-review"]);
  });

  it("a request that cannot be dated has no cutoff: judged as usual, and the label comes off", async () => {
    const w = new World();
    w.add({ number: 1, reviewed: true, verdict: "APPROVE", verdictAt: before, labels: ["re-review"], rereviewAt: LABELLED, undated: true });
    await tick(w, { prNumber: 1, rereview: true });
    expect(current(w, 1, "success")).toBe(true);
    expect(w.prs.get(1)!.labels).toEqual([]);
  });

  it("the label comes off only AFTER the merge: its unlabeled event's run cannot cancel a merge halfway", async () => {
    const w = new World();
    w.add({ number: 1, reviewed: true, verdict: "APPROVE", verdictAt: after, labels: ["re-review"], rereviewAt: LABELLED });
    await tick(w, { prNumber: 1, merge: "agent-only", rereview: true });
    expect(w.merged).toHaveLength(1);
    expect(w.order.lastIndexOf("issues.removeLabel")).toBeGreaterThan(w.order.lastIndexOf("pulls.merge"));
  });

  it("means nothing on the dependabot lane, which never gets a verdict: no hold", async () => {
    const w = new World();
    w.add({ number: 1, user: "dependabot[bot]", labels: ["re-review"], rereviewAt: LABELLED });
    const o = w.octokit();
    await runHybridGate({
      octokit: o, checksOctokit: o, owner: "o", repo: "r", checkName: CHECK, checkApp: APP, baseBranch: "main", merge: "off", rollout: {}, dryRun: false, prNumber: 1,
      rereviewLabel: "re-review",
      policy: { ...POLICY, rereviewLabel: "re-review", dependabot: { autoMerge: ["patch"] } } as any,
    });
    expect(w.result(1)?.output.title ?? "").not.toBe("Re-review requested");
  });

  it("is off without the label configured: an old verdict still counts", async () => {
    const w = new World();
    w.add({ number: 1, reviewed: true, verdict: "APPROVE", verdictAt: before, labels: ["re-review"], rereviewAt: LABELLED });
    await tick(w, { prNumber: 1 });
    expect(current(w, 1, "success")).toBe(true);
    expect(w.calls["issues.listEvents"]).toBeUndefined();
  });
});

describe("quiet_verdicts: a verdict delivered as a check run", () => {
  // After the fake head commit (11-15), before the fake clock.
  const T = (h: number) => `2026-11-16T${String(h).padStart(2, "0")}:00:00Z`;
  const quiet = (word: string, at: string, over: object = {}) => ({
    name: QUIET_CHECK, status: "completed", conclusion: "success", app: QUIET_APP, completed_at: at, output: { title: `Verdict: ${word}`, summary: "Looks right." }, ...over,
  });

  it("a head with only a quiet APPROVE gets its result — and a rerun of the gate changes nothing", async () => {
    const w = new World();
    w.add({ number: 1, reviewed: true });
    w.prs.get(1)!.extra = [{ ...quiet("APPROVE", T(10)), head_sha: w.headSha(1) }];
    await tick(w, { prNumber: 1, quiet: true });
    expect(current(w, 1, "success")).toBe(true);
    const before = w.checks.map((c) => ({ ...c }));
    await tick(w, { prNumber: 1, quiet: true });
    expect(w.checks).toEqual(before);
  });

  it("is not CI: the quiet check itself is left out of the rollup", async () => {
    const w = new World();
    w.add({ number: 1, reviewed: true });
    w.prs.get(1)!.extra = [{ ...quiet("APPROVE", T(10)), head_sha: w.headSha(1), status: "in_progress", conclusion: null } as any, { ...quiet("APPROVE", T(10)), head_sha: w.headSha(1) }];
    await tick(w, { prNumber: 1, quiet: true });
    expect(current(w, 1, "success")).toBe(true);
  });

  it("a later REQUEST_CHANGES review overrides an earlier quiet APPROVE", async () => {
    const w = new World();
    w.add({ number: 1, reviewed: true, verdict: "REQUEST_CHANGES", verdictAt: T(11) });
    w.prs.get(1)!.extra = [{ ...quiet("APPROVE", T(10)), head_sha: w.headSha(1) }];
    await tick(w, { prNumber: 1, quiet: true });
    expect(current(w, 1, "failure")).toBe(true);
  });

  it("…and a later quiet APPROVE overrides an earlier rejection review", async () => {
    const w = new World();
    w.add({ number: 1, reviewed: true, verdict: "REQUEST_CHANGES", verdictAt: T(9) });
    w.prs.get(1)!.extra = [{ ...quiet("APPROVE", T(10)), head_sha: w.headSha(1) }];
    await tick(w, { prNumber: 1, quiet: true });
    expect(current(w, 1, "success")).toBe(true);
  });

  it("a check of the same name from another App is no verdict", async () => {
    const w = new World();
    w.add({ number: 1, reviewed: true });
    w.prs.get(1)!.extra = [{ ...quiet("APPROVE", T(10), { app: "someone-else" }), head_sha: w.headSha(1) }];
    await tick(w, { prNumber: 1, quiet: true });
    expect(w.result(1)).toBeUndefined();
  });

  it("off (no verdict-checks): a quiet check is no verdict, and no extra read is made", async () => {
    const w = new World();
    w.add({ number: 1, reviewed: true });
    w.prs.get(1)!.extra = [{ ...quiet("APPROVE", T(10)), head_sha: w.headSha(1) }];
    const before = w.calls["checks.listForRef"] ?? 0;
    await tick(w, { prNumber: 1 });
    expect(w.result(1)).toBeUndefined();
    // One read of the head's checks (the CI rollup), as before.
    expect((w.calls["checks.listForRef"] ?? 0) - before).toBe(1);
  });

  it("a re-review request makes an earlier quiet verdict stale; a fresh one ends it", async () => {
    const w = new World();
    w.add({ number: 1, reviewed: true, labels: ["re-review"], rereviewAt: T(11) });
    w.prs.get(1)!.extra = [{ ...quiet("APPROVE", T(10)), head_sha: w.headSha(1) }];
    await tick(w, { prNumber: 1, quiet: true, rereview: true });
    expect(w.result(1)!.status).toBe("in_progress");
    w.prs.get(1)!.extra = [{ ...quiet("APPROVE", T(12)), head_sha: w.headSha(1) }];
    await tick(w, { prNumber: 1, quiet: true, rereview: true });
    expect(current(w, 1, "success")).toBe(true);
    expect(w.prs.get(1)!.labels).toEqual([]);
  });
});
