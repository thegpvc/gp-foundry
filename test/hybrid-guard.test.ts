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
