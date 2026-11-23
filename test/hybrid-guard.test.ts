/**
 * The hybrid reviewer guard, run as Actions runs it: step by step, each step's
 * `if:` evaluated before the step, outputs flowing into later steps' env.
 *
 * Running the decision script on its own is not enough. The bug this pins was in
 * the ORDER of steps: an App-token mint between the scope check and the decision
 * ran even for a PR the scope check had turned away — a Dependabot PR, whose runs
 * have no access to the repo's secrets — and failed there, so the decision never
 * ran to record the skip.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { parseDot } from "../src/parser/parse.js";
import { loadConfig } from "../src/config/load.js";
import { compile } from "../src/index.js";
import { evalGuard } from "../src/sim/gh-expr.js";
import type { FoundryConfig, Harness } from "../src/ir/types.js";
import { decide as scopeDecide } from "../actions/pr-scope/src/index.js";
import { wire } from "../src/wiring/wire.js";

const BOT = "agent-bot[bot]";
const APP = { auth: { mode: "app", app_id_secret: "APP_ID", app_key_secret: "APP_KEY" } } as Partial<FoundryConfig>;
const PAT = { auth: { mode: "pat", token_secret: "AGENT_PAT" } } as Partial<FoundryConfig>;
const GHTOKEN = { auth: { mode: "github-token" } } as Partial<FoundryConfig>;
// A rollout naming only a skip label: every PR is in scope except labelled ones,
// drafts and other bots' — so a Dependabot PR passes the event prefilter and only
// the live scope check turns it away.
const ROLLOUT = { rollout: { skip_label: "no-agent-review" } } as Partial<FoundryConfig>;

const dot = (attrs = 'skip="unchanged-diff"') => `digraph t {
  start    [type=start]
  reviewer [type=pr-review, role="agents/roles/reviewer.md", context="pr-diff"${attrs ? ", " + attrs : ""}]
  start    -> reviewer [on="pull_request.opened, pull_request.synchronize"]
}`;

function guardJob(cfg: Partial<FoundryConfig>, attrs?: string): any {
  const g = parseDot(dot(attrs));
  expect(g.errors).toEqual([]);
  const config = { ...loadConfig(undefined), identity: { bot_login: BOT }, ...cfg } as FoundryConfig;
  const ir: Harness = { name: g.name, nodes: g.nodes, edges: g.edges, config, sourcePath: "t.dot" };
  const wf: any = yaml.load(compile(ir).files.find((f) => f.path.endsWith("/reviewer.yml"))!.contents);
  return { wf, job: wf.jobs.reviewer_guard };
}

// ── a stub gh, for the decision script ───────────────────────────────────────

const GH_STUB = `#!/usr/bin/env bash
[ "$1" = "api" ] || { echo "stub gh: unsupported: $*" >&2; exit 2; }
shift
path=""; jqexpr=""; method="GET"; field=""
while [ $# -gt 0 ]; do
  case "$1" in
    --jq) jqexpr="$2"; shift 2 ;;
    --method) method="$2"; shift 2 ;;
    -f) field="$field$2"; shift 2 ;;
    -H) shift 2 ;;
    --paginate) shift ;;
    *) path="$1"; shift ;;
  esac
done
if [ "$method" != "GET" ]; then
  [ -z "\${STUB_FAIL_WRITES:-}" ] || { echo "stub gh: HTTP 502" >&2; exit 1; }
  printf '%s %s token=%s\\n%s\\n' "$method" "$path" "$GH_TOKEN" "$field" >> "$FIXTURES/writes.log"
  exit 0
fi
file="$FIXTURES/$(printf '%s' "$path" | sed 's/[^A-Za-z0-9]/_/g')"
[ -f "$file" ] || { echo "stub gh: no fixture for $path" >&2; exit 1; }
if [ -n "$jqexpr" ]; then jq -r "$jqexpr" "$file"; else cat "$file"; fi
`;

const DIFF = ["diff --git a/a.txt b/a.txt", "index 1111111..2222222 100644", "--- a/a.txt", "+++ b/a.txt", "@@ -1,2 +1,3 @@", " one", "+two", " three", ""].join("\n");

interface World {
  /** What pr-scope outputs for this PR (the action is tested on its own). */
  scope: { run: "true" | "false"; reason: string };
  /** The App secrets are unavailable to this run (a Dependabot-triggered run). */
  noSecrets?: boolean;
  /** API fixtures for the decision script, keyed by path. */
  fixtures?: Record<string, unknown>;
  action?: string;
  env?: Record<string, string>;
}

interface JobResult {
  /** "success" or "failure", as the job concludes. */
  conclusion: "success" | "failure";
  /** Each step: ran, skipped by its if:, or failed. */
  steps: Record<string, "ran" | "skipped" | "failed">;
  outputs: Record<string, string>;
  writes: string;
  log: string;
}

/**
 * Run the compiled guard job the way the runner does: for each step, evaluate
 * its `if:` (default success()); stop at the first failure.
 */
function runGuard(job: any, w: World): JobResult {
  const dir = mkdtempSync(join(tmpdir(), "gpf-guard-"));
  const bin = join(dir, "bin");
  const fx = join(dir, "fx");
  mkdirSync(bin);
  mkdirSync(fx);
  writeFileSync(join(bin, "gh"), GH_STUB);
  chmodSync(join(bin, "gh"), 0o755);
  for (const [path, body] of Object.entries(w.fixtures ?? {})) {
    writeFileSync(join(fx, path.replace(/[^A-Za-z0-9]/g, "_")), typeof body === "string" ? body : JSON.stringify(body));
  }
  const ctx: any = {
    github: { token: "gh-tok", event: { action: w.action ?? "synchronize", pull_request: { number: 7 } } },
    steps: {} as Record<string, { outputs: Record<string, string> }>,
  };
  const resolve = (v: unknown) =>
    String(v).replace(/\$\{\{\s*([^}]*?)\s*\}\}/g, (_m, path: string) => {
      const got = path.split(".").reduce((o: any, k) => (o == null ? undefined : o[k]), ctx);
      return got == null ? "" : String(got);
    });
  const steps: JobResult["steps"] = {};
  let log = "";
  let failed = false;
  for (const step of job.steps) {
    const key = step.id ?? step.name;
    const cond = step.if === undefined ? "success()" : String(step.if).replace(/^\$\{\{\s*|\s*\}\}$/g, "");
    const ok = cond === "success()" ? !failed : !failed && evalGuard(cond, ctx);
    if (!ok) {
      steps[key] = "skipped";
      continue;
    }
    if (String(step.uses ?? "").includes("/pr-scope")) {
      ctx.steps.scope = { outputs: w.scope };
      steps[key] = "ran";
    } else if (String(step.uses ?? "").startsWith("actions/create-github-app-token")) {
      if (w.noSecrets) {
        steps[key] = "failed";
        failed = true;
        log += "app-token: private-key is empty\n";
      } else {
        ctx.steps["app-token"] = { outputs: { token: "app-tok" } };
        steps[key] = "ran";
      }
    } else if (step.run) {
      const out = join(dir, `out-${key}`);
      writeFileSync(out, "");
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(step.env ?? {})) env[k] = resolve(v);
      try {
        log += execFileSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", step.run], {
          env: { PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: out, GITHUB_REPOSITORY: "o/r", FIXTURES: fx, ...env, ...(w.env ?? {}) },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        steps[key] = "ran";
      } catch (e: any) {
        log += (e.stdout ?? "") + (e.stderr ?? "");
        steps[key] = "failed";
        failed = true;
      }
      const outputs: Record<string, string> = {};
      for (const line of readFileSync(out, "utf8").split("\n")) {
        const i = line.indexOf("=");
        if (i > 0) outputs[line.slice(0, i)] = line.slice(i + 1);
      }
      if (step.id) ctx.steps[step.id] = { outputs };
    } else {
      steps[key] = "ran";
    }
  }
  const outputs: Record<string, string> = {};
  for (const [k, v] of Object.entries(job.outputs ?? {})) outputs[k] = resolve(v);
  const writesLog = join(fx, "writes.log");
  return { conclusion: failed ? "failure" : "success", steps, outputs, writes: existsSync(writesLog) ? readFileSync(writesLog, "utf8") : "", log };
}

/** The reviewer job runs only when the guard succeeded and said run=true. */
function reviewerRuns(wf: any, r: JobResult): boolean {
  if (r.conclusion !== "success") return false;
  return evalGuard(String(wf.jobs.reviewer.if), { needs: { reviewer_guard: { outputs: r.outputs } } } as any);
}

const pr = (over: Record<string, unknown> = {}) => ({
  draft: false,
  user: { login: "alice", type: "User" },
  labels: [],
  head: { sha: "head1" },
  base: { sha: "base1" },
  ...over,
});

describe("the emitted guard", () => {
  it("mints the App token only when the scope check admits the PR, between scope and decision", () => {
    const { job } = guardJob({ ...APP, ...ROLLOUT });
    const ids = job.steps.map((s: any) => s.id);
    expect(ids).toEqual(["scope", "app-token", "decide"]);
    expect(job.steps[1].uses).toBe("actions/create-github-app-token@v3");
    expect(job.steps[1].if).toBe("${{ steps.scope.outputs.run == 'true' }}");
    // The decision keeps the default condition, so it runs after a skipped mint.
    expect(job.steps[2].if).toBeUndefined();
    expect(job.steps[2].env.STAMP_TOKEN).toBe("${{ steps.app-token.outputs.token }}");
    expect(job.permissions).toEqual({ contents: "read", "pull-requests": "read" });
  });

  it("other callers of the token helper are unchanged", () => {
    // The reviewer job's own mint has no such condition: it only runs when the guard said run.
    const { wf } = guardJob({ ...APP, ...ROLLOUT });
    const mint = wf.jobs.reviewer.steps.find((s: any) => s.id === "app-token");
    expect(mint).toBeDefined();
    expect(mint.if).toBeUndefined();
  });
});

describe("the existing contract for other lanes and auth modes", () => {
  it("a hybrid lane without unchanged-diff has no mint and no decision step", () => {
    const { job } = guardJob({ ...APP, ...ROLLOUT }, "");
    expect(job.steps.map((s: any) => s.id)).toEqual(["scope"]);
    expect(job.permissions).toEqual({ contents: "read", "pull-requests": "read" });
    expect(job.outputs.run).toBe("${{ steps.scope.outputs.run }}");
  });

  it("PAT auth: no mint; the decision stamps with the PAT", () => {
    const { job } = guardJob({ ...PAT, ...ROLLOUT });
    expect(job.steps.map((s: any) => s.id)).toEqual(["scope", "decide"]);
    expect(job.steps[1].env.STAMP_TOKEN).toBe("${{ secrets.AGENT_PAT }}");
    expect(job.permissions).toEqual({ contents: "read", "pull-requests": "read" });
  });

  it("github-token auth: no mint; the job's own token may edit the review", () => {
    const { job } = guardJob({ ...GHTOKEN, ...ROLLOUT });
    expect(job.steps.map((s: any) => s.id)).toEqual(["scope", "decide"]);
    expect(job.permissions).toEqual({ contents: "read", "pull-requests": "write" });
  });
});

describe("the guard, run as Actions runs it (App auth, unchanged-diff)", () => {
  const compiled = () => guardJob({ ...APP, ...ROLLOUT });

  it("an excluded bot PR without the App secrets: mint skipped, guard succeeds with the scope reason, reviewer skipped", () => {
    const { wf, job } = compiled();
    const r = runGuard(job, {
      scope: { run: "false", reason: "opened by the bot dependabot[bot], which rollout.authors does not name" },
      noSecrets: true,
    });
    expect(r.steps).toEqual({ scope: "ran", "app-token": "skipped", decide: "ran" });
    expect(r.conclusion).toBe("success");
    expect(r.outputs.run).toBe("false");
    expect(r.outputs.reason).toBe("opened by the bot dependabot[bot], which rollout.authors does not name");
    expect(r.log).toContain("::notice::Skipping reviewer: opened by the bot dependabot[bot]");
    expect(r.writes).toBe("");
    expect(reviewerRuns(wf, r)).toBe(false);
  });

  it("before the fix, the same event failed in the mint and the skip was never recorded", () => {
    // The emitted guard with the condition removed: what 0.3.1 shipped.
    const { job } = compiled();
    const old = { ...job, steps: job.steps.map((s: any) => (s.id === "app-token" ? { ...s, if: undefined } : s)) };
    const r = runGuard(old, { scope: { run: "false", reason: "other bot" }, noSecrets: true });
    expect(r.steps["app-token"]).toBe("failed");
    expect(r.steps.decide).toBe("skipped");
    expect(r.conclusion).toBe("failure");
  });

  describe("an in-scope person's PR", () => {
    const inScope = { run: "true" as const, reason: "no rollout authors or opt-in label: every PR is in scope" };
    const fixtures = (reviews: unknown[], diff = DIFF, extra: Record<string, unknown> = {}) => ({
      "repos/o/r/pulls/7": pr(),
      "repos/o/r/compare/base1...head1": diff,
      "repos/o/r/pulls/7/reviews": reviews,
      ...extra,
    });
    /** The hash the guard computes for DIFF, read from a first run with no stamp. */
    const hashOf = (diff = DIFF) => runGuard(compiled().job, { scope: inScope, fixtures: fixtures([], diff) }).outputs.diff_hash!;
    const stamped = (hash: string, id = 41) => ({ id, user: { login: BOT }, body: `Looks fine.\n\n<!-- gp-foundry:diff:reviewer:${hash} -->` });

    it("unchanged diff on synchronize: mints, marks the covering review with the App token, skips the redundant review", () => {
      const { wf, job } = compiled();
      const hash = hashOf();
      const review = stamped(hash);
      const r = runGuard(job, { scope: inScope, fixtures: fixtures([review], DIFF, { "repos/o/r/pulls/7/reviews/41": { body: review.body } }) });
      expect(r.steps).toEqual({ scope: "ran", "app-token": "ran", decide: "ran" });
      expect(r.conclusion).toBe("success");
      expect(r.outputs.run).toBe("false");
      expect(r.outputs.reason).toContain("unchanged since the last review");
      expect(r.writes).toContain("PUT repos/o/r/pulls/7/reviews/41 token=app-tok");
      expect(r.writes).toContain("<!-- gp-foundry:also-head:reviewer:head1 -->");
      expect(reviewerRuns(wf, r)).toBe(false);
    });

    it("unchanged diff but the mark fails: a fresh review is requested", () => {
      const { wf, job } = compiled();
      const hash = hashOf();
      const review = stamped(hash);
      const r = runGuard(job, {
        scope: inScope,
        fixtures: fixtures([review], DIFF, { "repos/o/r/pulls/7/reviews/41": { body: review.body } }),
        env: { STUB_FAIL_WRITES: "1" },
      });
      expect(r.conclusion).toBe("success");
      expect(r.outputs.run).toBe("true");
      expect(r.log).toContain("could not be marked as covering head1");
      expect(reviewerRuns(wf, r)).toBe(true);
    });

    it("changed diff: the reviewer runs, with the hash to stamp", () => {
      const { wf, job } = compiled();
      const r = runGuard(job, { scope: inScope, fixtures: fixtures([stamped("0".repeat(64))]) });
      expect(r.conclusion).toBe("success");
      expect(r.outputs.run).toBe("true");
      expect(r.outputs.diff_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(r.writes).toBe("");
      expect(reviewerRuns(wf, r)).toBe(true);
    });

    it("a mint that fails on an in-scope PR stays visible: the guard fails", () => {
      const { wf, job } = compiled();
      const r = runGuard(job, { scope: inScope, noSecrets: true, fixtures: fixtures([]) });
      expect(r.steps["app-token"]).toBe("failed");
      expect(r.steps.decide).toBe("skipped");
      expect(r.conclusion).toBe("failure");
      expect(reviewerRuns(wf, r)).toBe(false);
    });
  });
});

// ── rollout.bot_authors (#55): the bot's PRs, from a scheduled bot pass ───────

describe("rollout.bot_authors: the reviewer's bot pass", () => {
  const DEP = "dependabot[bot]";
  const BOTS = { rollout: { skip_label: "no-agent-review", bot_authors: [DEP] } } as Partial<FoundryConfig>;
  const ROLE = 'skip="unchanged-diff", post="review"';
  const compiled = (cfg: Partial<FoundryConfig> = BOTS, attrs = ROLE) => guardJob({ ...APP, ...cfg }, attrs).wf;
  const ev = (event: string, payload: Record<string, unknown> = {}) => ({ github: { event_name: event, event: payload, actor: "someone" } }) as any;
  const prEvent = (login: string, type = "Bot") =>
    ev("pull_request", { action: "synchronize", pull_request: { number: 7, draft: false, labels: [], user: { login, type } } });

  it("on the bot's pull_request event, without the App secrets: no mint, the guard succeeds and says why, no review", async () => {
    const wf = compiled();
    const job = wf.jobs.reviewer_guard;
    // The event reaches the guard, so the reason is published rather than nothing at all.
    expect(evalGuard(String(job.if), prEvent(DEP))).toBe(true);
    // pr-scope's own answer for this PR, with the rollout the compiler wrote.
    const rollout = JSON.parse(job.steps.find((s: any) => s.id === "scope").with.rollout);
    const octo = {
      rest: { pulls: { get: async () => ({ data: { draft: false, labels: [], user: { login: DEP, type: "Bot" }, head: { ref: "dependabot/npm/x" } } }) } },
    } as any;
    const s = await scopeDecide(octo, { owner: "o", repo: "r", number: 7, rollout, botLogin: BOT, requireAgentWritten: false });
    const r = runGuard(job, { scope: { run: String(s.run) as "true" | "false", reason: s.reason }, noSecrets: true });
    expect(r.steps).toEqual({ scope: "ran", "app-token": "skipped", decide: "ran" });
    expect(r.conclusion).toBe("success");
    expect(r.log).toContain("::notice::Skipping reviewer:");
    expect(r.log).toContain("bot pass");
    expect(reviewerRuns(wf, r)).toBe(false);
  });

  it("with an author allowlist, the bot's events still reach the guard (and another bot's do not)", () => {
    const wf = compiled({ rollout: { authors: ["alice"], bot_authors: [DEP] } } as Partial<FoundryConfig>);
    expect(evalGuard(String(wf.jobs.reviewer_guard.if), prEvent(DEP))).toBe(true);
    expect(evalGuard(String(wf.jobs.reviewer_guard.if), prEvent("renovate[bot]"))).toBe(false);
    expect(evalGuard(String(wf.jobs.reviewer_guard.if), prEvent("alice", "User"))).toBe(true);
    expect(evalGuard(String(wf.jobs.reviewer_guard.if), prEvent("bob", "User"))).toBe(false);
  });

  it("a scheduled or dispatched run drives the pass, never the event jobs", () => {
    const wf = compiled();
    expect(wf.on.schedule).toEqual([{ cron: "*/15 * * * *" }]);
    expect(wf.on.workflow_dispatch.inputs.pr.type).toBe("string");
    for (const e of ["schedule", "workflow_dispatch"]) {
      expect(evalGuard(String(wf.jobs.reviewer_guard.if), ev(e))).toBe(false);
      expect(evalGuard(String(wf.jobs.reviewer_bots_select.if), ev(e))).toBe(true);
    }
    expect(evalGuard(String(wf.jobs.reviewer_bots_select.if), prEvent(DEP))).toBe(false);
    // Spelled out, not left to the payload prefilter: on a scheduled run the payload is
    // empty, and GitHub reads `null == false` as true.
    expect(String(wf.jobs.reviewer_guard.if)).toMatch(/^github\.event_name != 'schedule' && github\.event_name != 'workflow_dispatch' && /);
    // Its own concurrency slot; an event keeps its PR's.
    expect(wf.concurrency.group).toContain("'reviewer-bots'");
    expect(wf.concurrency.group).toContain("github.event.pull_request.number");
  });

  it("bot_schedule= sets the pass's cron", () => {
    const wf = compiled(BOTS, `${ROLE}, bot_schedule="7 * * * *"`);
    expect(wf.on.schedule).toEqual([{ cron: "7 * * * *" }]);
  });

  it("the pass reviews each selected head with the lane's own role, and records the heads it covered", () => {
    const wf = compiled();
    const lane = wf.jobs.reviewer_bots;
    expect(lane.needs).toEqual(["reviewer_bots_select"]);
    expect(lane.strategy.matrix.pr).toBe("${{ fromJSON(needs.reviewer_bots_select.outputs.prs) }}");
    const agent = lane.steps.find((st: any) => String(st.uses ?? "").includes("run-agent"));
    // The verdict is authorship-blind: the same role as for a person's PR.
    expect(agent.with["role-file"]).toBe(".gp-foundry/harness/agents/roles/reviewer.md");
    expect(lane.steps.find((st: any) => st.name === "Fetch context").with.number).toBe("${{ matrix.pr.number }}");
    const post = lane.steps.find((st: any) => st.name === "Post the review");
    expect(post.env).toMatchObject({ PR: "${{ matrix.pr.number }}", HEAD_SHA: "${{ matrix.pr.sha }}", REQUIRE_VERDICT: "false" });
    const stamp = lane.steps.find((st: any) => st.name === "Stamp the review with the diff hash");
    expect(stamp.env).toMatchObject({ HEAD_SHA: "${{ matrix.pr.sha }}", DIFF_HASH: "${{ matrix.pr.diff_hash }}" });
    expect(wf.jobs.reviewer_bots_mark.needs).toEqual(["reviewer_bots_select", "reviewer_bots"]);
    // It reads the reviews: a head is recorded only once this lane's review is on it.
    expect(wf.jobs.reviewer_bots_mark.permissions).toEqual({ checks: "write", actions: "read", "pull-requests": "read" });
    // A lane that posts for itself leaves no marker to look for: its success is the record.
    const own = compiled(BOTS, 'skip="unchanged-diff"').jobs.reviewer_bots_mark;
    expect(own.permissions).toEqual({ checks: "write", actions: "read" });
    expect(own.steps[0].run).not.toContain("POSTED");
    // Its failure count reads only its own records, as the select job's does.
    expect(wf.jobs.reviewer_bots_mark.steps[0].run).toContain("select(.name == env.FAILED_CHECK and .app.slug == env.MARK_APP");
    expect(wf.jobs.reviewer_bots_mark.steps[0].env.MARK_APP).toBe("github-actions");
    // No job that runs the agent may write checks.
    expect(lane.permissions.checks).toBe("read");
  });

  it("a single-PR dispatch gets its own concurrency slot, apart from the scheduled pass", () => {
    const group = compiled().concurrency.group.slice(4, -3);
    expect(group).toContain("inputs.pr && format('reviewer-bots-pr-{0}', inputs.pr)");
  });

  it("a lane entered on a review, not on a PR's head, gets no bot pass", () => {
    const g = parseDot(`digraph t {
      start    [type=start]
      critic   [type=pr-review, role="agents/roles/reviewer.md", context="pr-diff"]
      start    -> critic [on="pull_request_review.submitted"]
    }`);
    const config = { ...loadConfig(undefined), identity: { bot_login: BOT }, ...APP, ...BOTS } as FoundryConfig;
    const wf: any = yaml.load(compile({ name: g.name, nodes: g.nodes, edges: g.edges, config, sourcePath: "t.dot" }).files.find((f) => f.path.endsWith("/critic.yml"))!.contents);
    expect(wf.on.schedule).toBeUndefined();
    expect(wf.jobs.critic_bots_select).toBeUndefined();
    expect(String(wf.jobs.critic_guard.if)).not.toContain("schedule");
  });

  it("a lane also started by hand keeps its own dispatch; its pass runs on dispatch only for a pr", () => {
    const g = parseDot(`digraph t {
      start    [type=start]
      reviewer [type=pr-review, role="agents/roles/reviewer.md", context="pr-diff"]
      start    -> reviewer [on="pull_request.opened, workflow_dispatch"]
    }`);
    const config = { ...loadConfig(undefined), identity: { bot_login: BOT }, ...APP, ...BOTS } as FoundryConfig;
    const wf: any = yaml.load(compile({ name: g.name, nodes: g.nodes, edges: g.edges, config, sourcePath: "t.dot" }).files.find((f) => f.path.endsWith("/reviewer.yml"))!.contents);
    expect(wf.on.workflow_dispatch.inputs.pr).toBeDefined();
    expect(String(wf.jobs.reviewer_guard.if)).not.toContain("!= 'workflow_dispatch'");
    expect(String(wf.jobs.reviewer_bots_select.if)).toContain("inputs.pr != ''");
  });

  it("a review panel (no guard, no bot pass) leaves the listed bots' PRs alone", () => {
    const g = parseDot(`digraph t {
      start [type=start]
      split [type=parallel]
      a     [type=pr-review, role="agents/roles/reviewer.md", context="pr-diff"]
      b     [type=pr-review, role="agents/roles/reviewer.md", context="pr-diff"]
      join  [type=fan_in, role="agents/roles/reviewer.md"]
      start -> split [on="pull_request.opened"]
      split -> a
      split -> b
      a -> join
      b -> join
    }`);
    const config = { ...loadConfig(undefined), identity: { bot_login: BOT }, ...APP, ...BOTS } as FoundryConfig;
    // The panel's wiring guard. (Its legs' jobs currently take a guard-job
    // condition instead — a known issue that predates bot_authors.)
    const cond = String(wire({ name: g.name, nodes: g.nodes, edges: g.edges, config, sourcePath: "t.dot" }).perNode.join!.guard);
    expect(evalGuard(cond, prEvent(DEP))).toBe(false);
    expect(evalGuard(cond, prEvent("alice", "User"))).toBe(true);
  });

  describe("the context step, run as Actions runs it (#57)", () => {
    const step = () => compiled().jobs.reviewer_bots.steps.find((st: any) => st.name === "Note the dependency update's level");
    const note = (env: Record<string, string>) => {
      const dir = mkdtempSync(join(tmpdir(), "gpf-ctx-"));
      const file = join(dir, "context.md");
      writeFileSync(file, "");
      execFileSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", step().run], { env: { PATH: process.env.PATH!, CONTEXT_FILE: file, BUMP: "", UPDATES: "", ...env }, encoding: "utf8" });
      return readFileSync(file, "utf8");
    };

    it("reads the level and the versions from the matrix entry", () => {
      expect(step().env).toMatchObject({ BUMP: "${{ matrix.pr.bump }}", UPDATES: "${{ matrix.pr.updates }}" });
    });

    it("states the level and each dependency's versions", () => {
      const out = note({ BUMP: "major", UPDATES: "@s/a>1.2.0>1.2.3,b>2.0.0>3.0.0" });
      expect(out).toContain("**major**");
      expect(out).toContain("- @s/a: 1.2.0 → 1.2.3\n- b: 2.0.0 → 3.0.0\n");
    });

    it("the level alone, when the versions are not all named", () => {
      const out = note({ BUMP: "patch" });
      expect(out).toContain("**patch**");
      expect(out).not.toContain("Dependencies updated");
    });

    it("the versions without a level, said plainly, when one of them is not semver", () => {
      const out = note({ UPDATES: "a>1.2.0>20240115" });
      expect(out).toContain("could not be determined");
      expect(out).toContain("- a: 1.2.0 → 20240115");
    });

    it("neither: nothing is added", () => {
      expect(note({})).toBe("");
      expect(note({ BUMP: "unknown" })).toBe("");
    });
  });

  describe("the mark job, run as Actions runs it", () => {
    const JOBS = "repos/o/r/actions/runs/1/attempts/1/jobs?per_page=100";
    const REVIEWS = "repos/o/r/pulls/9/reviews?per_page=100";
    const CHECKS = "repos/o/r/commits/s1/check-runs?per_page=100&filter=all";
    const succeeded = { jobs: [{ conclusion: "success", name: "reviewer bots #9" }] };
    const mark = (fixtures: Record<string, unknown>) =>
      runGuard(compiled().jobs.reviewer_bots_mark, {
        scope: { run: "true", reason: "" },
        fixtures,
        env: { PRS: JSON.stringify([{ number: 9, sha: "s1", base: "main" }]), RUN_ID: "1", RUN_ATTEMPT: "1" },
      });

    it("a lane job that succeeded and left its review: the head is recorded as reviewed", () => {
      const review = { user: { login: BOT }, submitted_at: "2026-01-01T00:00:00Z", body: "ok\n\n<!-- gp-foundry:posted:reviewer:s1 -->" };
      const r = mark({ [JOBS]: succeeded, [REVIEWS]: [review] });
      expect(r.conclusion).toBe("success");
      expect(r.writes).toContain("name=gp-foundry/swept (reviewer)");
      expect(r.writes).not.toContain("sweep-failed");
    });

    it("a lane job that succeeded but posted nothing (the agent printed no usable review): a failed run, not a review", () => {
      const r = mark({ [JOBS]: succeeded, [REVIEWS]: [], [CHECKS]: { check_runs: [] } });
      expect(r.conclusion).toBe("success");
      expect(r.writes).not.toContain("name=gp-foundry/swept (reviewer)");
      expect(r.writes).toContain("name=gp-foundry/sweep-failed (reviewer)");
      expect(r.log).toContain("#9: the lane succeeded but left no review on s1");
    });

    it("a review of another head, or another lane's, does not count", () => {
      const other = [
        { user: { login: BOT }, submitted_at: "2026-01-01T00:00:00Z", body: "ok\n\n<!-- gp-foundry:posted:reviewer:s0 -->" },
        { user: { login: BOT }, submitted_at: "2026-01-01T00:00:00Z", body: "ok\n\n<!-- gp-foundry:posted:approver:s1 -->" },
        { user: { login: "mallory" }, submitted_at: "2026-01-01T00:00:00Z", body: "<!-- gp-foundry:posted:reviewer:s1 -->" },
      ];
      const r = mark({ [JOBS]: succeeded, [REVIEWS]: other, [CHECKS]: { check_runs: [] } });
      expect(r.writes).not.toContain("name=gp-foundry/swept (reviewer)");
    });

    it("reviews that cannot be read: nothing recorded either way, the next run looks again", () => {
      const r = mark({ [JOBS]: succeeded });
      expect(r.conclusion).toBe("success");
      expect(r.writes).toBe("");
      expect(r.log).toContain("its reviews could not be read");
    });
  });

  describe("the select job, run as Actions runs it", () => {
    const select = () => compiled().jobs.reviewer_bots_select;
    const listed = (prs: unknown[]) => ({ run: "true" as const, reason: "", listed: "true", prs: JSON.stringify(prs) }) as any;
    const head = (sha: string) => ({ number: 9, sha, base: "main", requested: 0, quiet: 900, bot: true, bump: "minor", updates: "@s/a>1.2.0>1.3.0,b>2.0.0>2.0.1" });
    const checks = (runs: unknown[] = []) => ({ check_runs: runs });
    const base9 = { "repos/o/r/pulls/9": { base: { sha: "base9" } } };
    const run = (sha: string, fixtures: Record<string, unknown>, env?: Record<string, string>) =>
      runGuard(select(), { scope: listed([head(sha)]), fixtures: { ...base9, ...fixtures }, ...(env ? { env } : {}) });
    const selected = (r: JobResult) => JSON.parse(r.outputs.prs || "[]");

    it("an unreviewed head is selected, with its update level and diff hash", () => {
      const r = run("s1", { "repos/o/r/commits/s1/check-runs?per_page=100&filter=all": checks(), "repos/o/r/pulls/9/reviews?per_page=100": [], "repos/o/r/compare/base9...s1": DIFF, "repos/o/r/pulls/9/reviews": [] });
      expect(r.conclusion).toBe("success");
      const [p] = selected(r);
      expect(p).toMatchObject({ number: 9, sha: "s1", base: "main", bump: "minor", updates: "@s/a>1.2.0>1.3.0,b>2.0.0>2.0.1" });
      expect(p.diff_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(r.outputs.count).toBe("1");
    });

    it("a head the pass already reviewed (its swept check) is not reviewed again", () => {
      const swept = { name: "gp-foundry/swept (reviewer)", app: { slug: "github-actions" }, started_at: "2026-01-01T00:00:00Z" };
      const r = run("s1", { "repos/o/r/commits/s1/check-runs?per_page=100&filter=all": checks([swept]) });
      expect(selected(r)).toEqual([]);
      expect(r.log).toContain("#9: already reviewed at s1");
    });

    it("a head this lane posted its review on (an event run, or a pass whose mark was lost) is not reviewed again", () => {
      const review = { user: { login: BOT }, submitted_at: "2026-01-01T00:00:00Z", body: "ok\n\n<!-- gp-foundry:posted:reviewer:s1 -->" };
      const r = run("s1", { "repos/o/r/commits/s1/check-runs?per_page=100&filter=all": checks(), "repos/o/r/pulls/9/reviews?per_page=100": [review] });
      expect(selected(r)).toEqual([]);
    });

    it("a new head with the same diff (the bot rebased): the last review is marked as covering it, no second review", () => {
      const first = run("s1", { "repos/o/r/commits/s1/check-runs?per_page=100&filter=all": checks(), "repos/o/r/pulls/9/reviews?per_page=100": [], "repos/o/r/compare/base9...s1": DIFF, "repos/o/r/pulls/9/reviews": [] });
      const hash = selected(first)[0].diff_hash;
      const stampedReview = { id: 41, user: { login: BOT }, submitted_at: "2026-01-01T00:00:00Z", body: `ok\n\n<!-- gp-foundry:posted:reviewer:s1 -->\n\n<!-- gp-foundry:diff:reviewer:${hash} -->` };
      const r = run("s2", {
        "repos/o/r/commits/s2/check-runs?per_page=100&filter=all": checks(),
        "repos/o/r/pulls/9/reviews?per_page=100": [stampedReview],
        "repos/o/r/compare/base9...s2": DIFF,
        "repos/o/r/pulls/9/reviews": [stampedReview],
        "repos/o/r/pulls/9/reviews/41": { body: stampedReview.body },
      });
      expect(selected(r)).toEqual([]);
      expect(r.writes).toContain("PUT repos/o/r/pulls/9/reviews/41 token=app-tok");
      expect(r.writes).toContain("<!-- gp-foundry:also-head:reviewer:s2 -->");
    });

    it("a new head with a changed diff is reviewed", () => {
      const stampedReview = { id: 41, user: { login: BOT }, submitted_at: "2026-01-01T00:00:00Z", body: "ok\n\n<!-- gp-foundry:diff:reviewer:" + "0".repeat(64) + " -->" };
      const r = run("s2", {
        "repos/o/r/commits/s2/check-runs?per_page=100&filter=all": checks(),
        "repos/o/r/pulls/9/reviews?per_page=100": [stampedReview],
        "repos/o/r/compare/base9...s2": DIFF,
        "repos/o/r/pulls/9/reviews": [stampedReview],
      });
      expect(selected(r).map((p: any) => p.sha)).toEqual(["s2"]);
      expect(r.writes).toBe("");
    });

    it("a head whose state cannot be read is left for the next run", () => {
      const r = run("s1", {});
      expect(selected(r)).toEqual([]);
      expect(r.conclusion).toBe("success");
    });

    it("a failed listing is a quiet tick", () => {
      const r = runGuard(select(), { scope: { listed: "false", prs: "[]" } as any });
      expect(r.conclusion).toBe("success");
      expect(r.outputs.count).toBe("0");
    });
  });

  describe("the approver sweep and the gate", () => {
    const sweep = 'role="agents/roles/approver.md", context="pr-review", select="sweep", schedule="*/10 * * * *", requires_review=true, post="review"';
    const harness = (cfg: Partial<FoundryConfig>) => {
      const g = parseDot(`digraph t {
        start    [type=start]
        reviewer [type=pr-review, role="agents/roles/reviewer.md", context="pr-diff", post="review", skip="unchanged-diff"]
        approver [type=pr-review, ${sweep}]
        gate     [type=merge-gate, policy="agents/policy/merge.yaml", schedule="*/10 * * * *", merge="off"]
        start    -> reviewer [on="pull_request.opened, pull_request.synchronize"]
      }`);
      const config = { ...loadConfig(undefined), identity: { bot_login: BOT }, ...APP, ...cfg } as FoundryConfig;
      const ir: Harness = { name: g.name, nodes: g.nodes, edges: g.edges, config, sourcePath: "t.dot" };
      return Object.fromEntries(compile(ir).files.filter((f) => f.path.includes("/workflows/")).map((f) => [f.path.split("/").pop()!.replace(".yml", ""), yaml.load(f.contents) as any]));
    };

    it("the approver judges a bot's PR with its own role, and hands the update level to the agent", () => {
      const wf = harness(BOTS).approver;
      const agent = wf.jobs.approver.steps.find((st: any) => String(st.uses ?? "").includes("run-agent"));
      expect(agent.with["role-file"]).toBe(".gp-foundry/harness/agents/roles/approver.md");
      expect(wf.jobs.approver.steps.some((st: any) => st.name === "Note the dependency update's level")).toBe(true);
      const select = wf.jobs.approver_select.steps.find((st: any) => st.id === "select").run;
      expect(select).toContain("{bump: $bump}");
      expect(select).toContain("{updates: $updates}");
      // The approver sweep is already scheduled: it gets no bot pass of its own.
      expect(wf.jobs.approver_bots_select).toBeUndefined();
    });

    it("the gate's event prefilter lets a person's or the harness's event on the bot's PR through, and still not the bot's own", () => {
      const gate = harness(BOTS).gate.jobs.gate;
      const on = (login: string, actor: string) =>
        evalGuard(String(gate.if), { github: { event_name: "pull_request_review", actor, repository: "o/r", event: { pull_request: { state: "open", draft: false, labels: [], base: { ref: "main" }, head: { repo: { full_name: "o/r" } }, user: { login, type: "Bot" } } } } } as any);
      expect(on(DEP, BOT)).toBe(true);
      expect(on(DEP, "alice")).toBe(true);
      expect(on(DEP, DEP)).toBe(false);
      expect(on("renovate[bot]", BOT)).toBe(false);
    });

    it("with no bot_authors (or an empty list) every workflow is byte-identical", () => {
      const plain = { rollout: { skip_label: "no-agent-review" } } as Partial<FoundryConfig>;
      const empty = { rollout: { skip_label: "no-agent-review", bot_authors: [] } } as Partial<FoundryConfig>;
      const a = harness(plain);
      const b = harness(empty);
      expect(yaml.dump(b)).toBe(yaml.dump(a));
      expect(a.reviewer.jobs.reviewer_bots_select).toBeUndefined();
      expect(a.reviewer.on.schedule).toBeUndefined();
    });
  });
});

