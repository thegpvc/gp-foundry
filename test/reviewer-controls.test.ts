/**
 * Review-lane controls: cancel_in_progress=, checkout="partial", check-run
 * gates, the skip= guard job, select="sweep", and API-key agent auth.
 *
 * The guard / selector / stamp scripts are not only inspected but RUN, against a
 * stub `gh` that serves fixture JSON — the selection logic lives in shell, and a
 * string assertion cannot tell a correct jq filter from a plausible one.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { parseDot } from "../src/parser/parse.js";
import { loadConfig } from "../src/config/load.js";
import { compile } from "../src/index.js";
import { validate } from "../src/validate/validate.js";
import { parseGates } from "../src/handlers/attrs.js";
import type { Diagnostic, FoundryConfig, Harness, HarnessNode } from "../src/ir/types.js";

const BOT = "agent-bot";

function mkHarness(dot: string, cfg: Partial<FoundryConfig> = {}): Harness {
  const g = parseDot(dot);
  expect(g.errors).toEqual([]);
  const base = loadConfig(undefined);
  const config = { ...base, identity: { bot_login: BOT }, ...cfg } as FoundryConfig;
  return { name: g.name, nodes: g.nodes, edges: g.edges, config, sourcePath: "test.dot" };
}

function workflow(dot: string, file: string, cfg: Partial<FoundryConfig> = {}): any {
  const { files } = compile(mkHarness(dot, cfg));
  const f = files.find((x) => x.path.endsWith(`/${file}.yml`));
  expect(f, `${file}.yml should be generated`).toBeTruthy();
  return yaml.load(f!.contents);
}

function diags(dot: string, cfg: Partial<FoundryConfig> = {}): Diagnostic[] {
  return validate(mkHarness(dot, cfg));
}
const codes = (ds: Diagnostic[], level?: string) =>
  ds.filter((d) => !level || d.level === level).map((d) => d.code);

/** A reviewer lane; `attrs` is spliced into the reviewer node. */
const lane = (attrs = "") => `digraph t {
  start    [type=start]
  builder  [type=producer, role="agents/roles/builder.md"]
  reviewer [type=pr-review, role="agents/roles/reviewer.md", context="pr-diff"${attrs ? ", " + attrs : ""}]
  start    -> builder  [on="issues.opened"]
  builder  -> reviewer [on="pull_request.opened, pull_request.synchronize"]
}`;

// ── a stub `gh` for running the generated scripts ────────────────────────────

const GH_STUB = `#!/usr/bin/env bash
# gh api <path> [--paginate] [--jq <expr>] [-H <h>] [--method <m>] [-f k=v]
[ "$1" = "api" ] || { echo "stub gh: unsupported: $*" >&2; exit 2; }
shift
path=""; jqexpr=""; method="GET"; field=""
while [ $# -gt 0 ]; do
  case "$1" in
    --jq) jqexpr="$2"; shift 2 ;;
    --method) method="$2"; shift 2 ;;
    -f) field="$2"; shift 2 ;;
    -H) shift 2 ;;
    --paginate) shift ;;
    *) path="$1"; shift ;;
  esac
done
if [ "$method" != "GET" ]; then
  printf '%s %s\\n%s\\n' "$method" "$path" "$field" >> "$FIXTURES/writes.log"
  exit 0
fi
file="$FIXTURES/$(printf '%s' "$path" | sed 's/[^A-Za-z0-9]/_/g')"
[ -f "$file" ] || { echo "stub gh: no fixture for $path" >&2; exit 1; }
if [ -n "$jqexpr" ]; then jq -r "$jqexpr" "$file"; else cat "$file"; fi
`;

interface Ran {
  status: number;
  stdout: string;
  outputs: Record<string, string>;
  writes: string;
}

/** Run a generated step's script the way Actions does (`bash -eo pipefail`). */
function runStepScript(step: any, fixtures: Record<string, unknown>, env: Record<string, string> = {}): Ran {
  const dir = mkdtempSync(join(tmpdir(), "gpf-step-"));
  const bin = join(dir, "bin");
  const fx = join(dir, "fx");
  mkdirSync(bin);
  mkdirSync(fx);
  writeFileSync(join(bin, "gh"), GH_STUB);
  chmodSync(join(bin, "gh"), 0o755);
  for (const [path, body] of Object.entries(fixtures)) {
    const name = path.replace(/[^A-Za-z0-9]/g, "_");
    writeFileSync(join(fx, name), typeof body === "string" ? body : JSON.stringify(body));
  }
  const outFile = join(dir, "output");
  writeFileSync(outFile, "");
  // Literal step env only: `${{ … }}` expressions are supplied by the caller.
  const stepEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries((step.env ?? {}) as Record<string, string>)) {
    if (!String(v).includes("${{")) stepEnv[k] = String(v);
  }
  let status = 0;
  let stdout = "";
  try {
    stdout = execFileSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", step.run], {
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_REPOSITORY: "o/r",
        GITHUB_OUTPUT: outFile,
        FIXTURES: fx,
        ...stepEnv,
        ...env,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e: any) {
    status = e.status ?? 1;
    stdout = (e.stdout ?? "") + (e.stderr ?? "");
  }
  const outputs: Record<string, string> = {};
  for (const line of readFileSync(outFile, "utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) outputs[line.slice(0, i)] = line.slice(i + 1);
  }
  const writesLog = join(fx, "writes.log");
  return { status, stdout, outputs, writes: existsSync(writesLog) ? readFileSync(writesLog, "utf8") : "" };
}

// ── 1. cancel_in_progress ────────────────────────────────────────────────────

describe("cancel_in_progress= on agent nodes", () => {
  it("is off by default and on when asked", () => {
    expect(workflow(lane(), "reviewer").concurrency["cancel-in-progress"]).toBe(false);
    const wf = workflow(lane("cancel_in_progress=true"), "reviewer");
    expect(wf.concurrency["cancel-in-progress"]).toBe(true);
    // Still one slot per PR: the newer event cancels THIS PR's run, nobody else's.
    expect(wf.concurrency.group).toContain("github.event.pull_request.number");
  });

  it("can switch off the issue-agent default", () => {
    const dot = (attrs: string) => `digraph t {
      start [type=start]
      scout [type=issue-agent, role="agents/roles/scout.md"${attrs}]
      start -> scout [on="issues.opened"]
    }`;
    expect(workflow(dot(""), "scout").concurrency["cancel-in-progress"]).toBe(true);
    expect(workflow(dot(", cancel_in_progress=false"), "scout").concurrency["cancel-in-progress"]).toBe(false);
  });

  it("applies to a scheduled agent lane", () => {
    const wf = workflow(
      `digraph t {
        sweeper [type=scheduled-agent, role="agents/roles/s.md", schedule="0 8 * * *", commit=none, cancel_in_progress=true]
      }`,
      "sweeper",
    );
    expect(wf.concurrency).toEqual({ group: "sweeper", "cancel-in-progress": true });
  });

  it("rejects a non-boolean and leaves the default in place", () => {
    const dot = lane('cancel_in_progress="yes"');
    expect(codes(diags(dot), "error")).toContain("node.bad-cancel-in-progress");
    expect(workflow(dot, "reviewer").concurrency["cancel-in-progress"]).toBe(false);
  });

  it("is ignored — with a warning — on a node that is not an agent", () => {
    const dot = `digraph t {
      gate [type=merge-gate, policy="agents/policy/merge.yaml", schedule="*/30 * * * *", cancel_in_progress=true]
    }`;
    expect(codes(diags(dot), "warning")).toContain("node.cancel-in-progress-ignored");
    expect(workflow(dot, "gate").concurrency["cancel-in-progress"]).toBe(false);
  });

  it("warns that cancelling a code-writing lane discards unpushed work", () => {
    const dot = lane().replace('role="agents/roles/builder.md"', 'role="agents/roles/builder.md", cancel_in_progress=true');
    expect(codes(diags(dot), "warning")).toContain("node.cancel-in-progress-discards-work");
    expect(codes(diags(lane("cancel_in_progress=true")))).not.toContain("node.cancel-in-progress-discards-work");
  });
});

// ── 2. checkout="partial" ────────────────────────────────────────────────────

describe('checkout="partial"', () => {
  const checkoutOf = (wf: any, job: string) => wf.jobs[job].steps.find((s: any) => s.name === "Checkout").with;

  it("compiles to a blob-less clone with full history", () => {
    const w = checkoutOf(workflow(lane('checkout="partial"'), "reviewer"), "reviewer");
    expect(w.filter).toBe("blob:none");
    expect(w["fetch-depth"]).toBe(0);
    expect(w.ref).toBe("${{ github.event.pull_request.head.sha }}");
  });

  it("deepens a lane that is shallow by default (history is the point)", () => {
    const dot = (attrs: string) => lane().replace('role="agents/roles/builder.md"', `role="agents/roles/builder.md"${attrs}`);
    expect(checkoutOf(workflow(dot(""), "builder"), "builder")["fetch-depth"]).toBeUndefined();
    const w = checkoutOf(workflow(dot(", checkout=partial"), "builder"), "builder");
    expect(w).toMatchObject({ "fetch-depth": 0, filter: "blob:none" });
  });

  it("leaves every other lane's checkout untouched", () => {
    const w = checkoutOf(workflow(lane(), "reviewer"), "reviewer");
    expect(w.filter).toBeUndefined();
    expect(w["fetch-depth"]).toBe(0);
  });

  it("rejects any other value", () => {
    expect(codes(diags(lane('checkout="sparse"')), "error")).toContain("node.bad-checkout");
  });
});

// ── 3. check-run gates ───────────────────────────────────────────────────────

describe("gates= check-run entries and the ?N grace suffix", () => {
  const node = (gates: string): HarnessNode => ({ id: "n", type: "pr-review", attrs: { gates }, files: {}, raw: {} });

  it("parses workflow files, check names, and grace suffixes", () => {
    expect(parseGates(node("ci.yml, lint / eslint, e2e (chromium)?90, nightly.yaml?30"))).toEqual([
      { name: "ci.yml", kind: "workflow" },
      { name: "lint / eslint", kind: "check" },
      { name: "e2e (chromium)", kind: "check", graceSeconds: 90 },
      { name: "nightly.yaml", kind: "workflow", graceSeconds: 30 },
    ]);
  });

  it("rejects a malformed grace suffix", () => {
    for (const bad of ["lint?", "lint?soon", "lint?0", "?90"]) {
      expect(() => parseGates(node(bad)), bad).toThrow();
      expect(codes(diags(lane(`gates="${bad}"`)), "error"), bad).toContain("node.bad-gates");
    }
  });

  it("compiles a check entry to wait-for-checks with check-name", () => {
    const job = workflow(lane('gates="ci.yml, lint / eslint, e2e?90"'), "reviewer").jobs.reviewer;
    const waits = job.steps.filter((s: any) => String(s.uses ?? "").includes("wait-for-checks"));
    expect(waits.map((s: any) => s.name)).toEqual(["Wait for ci.yml", "Wait for lint / eslint", "Wait for e2e"]);

    expect(waits[0].with["workflow-name"]).toBe("ci.yml");
    expect(waits[0].with["check-name"]).toBeUndefined();
    expect(waits[0].with["missing-grace-seconds"]).toBeUndefined();

    expect(waits[1].with["check-name"]).toBe("lint / eslint");
    expect(waits[1].with["workflow-name"]).toBeUndefined();

    expect(waits[2].with["check-name"]).toBe("e2e");
    expect(waits[2].with["missing-grace-seconds"]).toBe(90);
    for (const w of waits) expect(w.with.sha).toBe("${{ github.event.pull_request.head.sha }}");
  });

  it("reads check-runs with GITHUB_TOKEN and grants the job checks: read", () => {
    // A fine-grained PAT cannot hold the Checks permission; the harness token would 403.
    const job = workflow(lane('gates="ci.yml, lint"'), "reviewer", {
      auth: { mode: "pat", token_secret: "AGENT_PAT" },
    }).jobs.reviewer;
    const [wf, check] = job.steps.filter((s: any) => String(s.uses ?? "").includes("wait-for-checks"));
    expect(wf.with.token).toBe("${{ secrets.AGENT_PAT }}");
    expect(check.with.token).toBe("${{ github.token }}");
    expect(job.permissions.checks).toBe("read");
    // Workflow-only gates need no extra scope.
    expect(workflow(lane('gates="ci.yml"'), "reviewer").jobs.reviewer.permissions.checks).toBeUndefined();
  });

  it("puts every gate's conclusion in front of the reviewer, with unique step ids", () => {
    const job = workflow(lane('gates="ci.yml, lint / eslint?90"'), "reviewer").jobs.reviewer;
    const record = job.steps.find((s: any) => s.name === "Record CI gate results in the context");
    expect(record.env.GATE_2_NAME).toBe("lint / eslint");
    const ids = job.steps.filter((s: any) => String(s.uses ?? "").includes("wait-for-checks")).map((s: any) => s.id);
    expect(new Set(ids).size).toBe(2);
    expect(record.env.GATE_2_RESULT).toBe(`\${{ steps.${ids[1]}.outputs.conclusion }}`);
    expect(job["timeout-minutes"]).toBe(45); // 15 + 15 × 2 gates
  });
});

// ── 4. skip= guard job ───────────────────────────────────────────────────────

describe("skip= compiles to a guard job", () => {
  const SKIP = 'skip="draft,bot-author,label:no-agent-review,unchanged-diff"';
  const wf = () => workflow(lane(SKIP), "reviewer", { labels: { "no-agent-review": "skip-ai-review" } });

  it("chains the lane behind the guard, which carries the wiring guard", () => {
    const w = wf();
    expect(Object.keys(w.jobs)).toEqual(["reviewer_guard", "reviewer"]);
    // The branch-prefix guard moves to the guard job; a skipped guard skips the lane.
    expect(w.jobs.reviewer_guard.if).toContain("startsWith(github.event.pull_request.head.ref, 'agent/')");
    expect(w.jobs.reviewer.needs).toEqual(["reviewer_guard"]);
    expect(w.jobs.reviewer.if).toBe("needs.reviewer_guard.outputs.run == 'true'");
    expect(w.jobs.reviewer_guard.outputs.run).toBe("${{ steps.decide.outputs.run }}");
    // Read-only, on GITHUB_TOKEN, with no checkout and no agent.
    expect(w.jobs.reviewer_guard.permissions).toEqual({ contents: "read", "pull-requests": "read" });
    expect(w.jobs.reviewer_guard.steps).toHaveLength(1);
    expect(w.jobs.reviewer_guard.steps[0].env.GH_TOKEN).toBe("${{ github.token }}");
  });

  it("keeps untrusted values out of the script text", () => {
    const step = wf().jobs.reviewer_guard.steps[0];
    expect(step.run).not.toContain("${{");
    expect(step.env.PR).toBe("${{ github.event.pull_request.number }}");
    // label:<key> resolves through config.labels like every other label guard.
    expect(step.env.SKIP_LABEL_1).toBe("skip-ai-review");
    expect(step.run).not.toContain("skip-ai-review");
  });

  it("re-fires when a draft is marked ready", () => {
    expect(wf().on.pull_request.types).toContain("ready_for_review");
    // …but only when draft PRs are being skipped.
    expect(workflow(lane('skip="bot-author"'), "reviewer").on.pull_request.types).not.toContain("ready_for_review");
    expect(workflow(lane(), "reviewer").on.pull_request.types).not.toContain("ready_for_review");
  });

  it("lets ready_for_review through a guard made of event discriminators", () => {
    // A guarded sibling edge turns the unguarded events into explicit OR-clauses;
    // the synthesized event has to be one of them or it never passes the `if:`.
    const dot = `digraph t {
      start    [type=start]
      builder  [type=producer, role="agents/roles/builder.md"]
      reviewer [type=pr-review, role="agents/roles/reviewer.md", context="pr-diff", skip="draft"]
      start    -> builder  [on="issues.opened"]
      builder  -> reviewer [on="pull_request.opened"]
      start    -> reviewer [when="label=re-review"]
    }`;
    const guard = workflow(dot, "reviewer").jobs.reviewer_guard.if;
    expect(guard).toContain("github.event.action == 'ready_for_review'");
  });

  it("emits no guard job without skip=", () => {
    const w = workflow(lane(), "reviewer");
    expect(Object.keys(w.jobs)).toEqual(["reviewer"]);
    expect(w.jobs.reviewer.needs).toBeUndefined();
    expect(w.jobs.reviewer.if).toContain("startsWith(");
  });

  it("stamps the review only when unchanged-diff is asked for", () => {
    const stamp = (w: any) => w.jobs.reviewer.steps.find((s: any) => s.name === "Stamp the review with the diff hash");
    expect(stamp(workflow(lane('skip="draft"'), "reviewer"))).toBeUndefined();
    const s = stamp(wf());
    expect(s.if).toBe("${{ success() && needs.reviewer_guard.outputs.diff_hash != '' }}");
    expect(s.env.DIFF_HASH).toBe("${{ needs.reviewer_guard.outputs.diff_hash }}");
    expect(s.env.MARKER_PREFIX).toBe("<!-- gp-foundry:diff:reviewer:");
    // The stamp is the last step: it runs after the agent has posted the review.
    expect(wf().jobs.reviewer.steps.at(-1).name).toBe("Stamp the review with the diff hash");
  });

  describe("validation", () => {
    it("rejects an unknown entry", () => {
      expect(codes(diags(lane('skip="draft,wip"')), "error")).toContain("node.bad-skip");
      expect(codes(diags(lane('skip="label:"')), "error")).toContain("node.bad-skip");
    });

    it("needs identity.bot_login for unchanged-diff", () => {
      const ds = diags(lane('skip="unchanged-diff"'), { identity: {} });
      expect(codes(ds, "error")).toContain("node.skip-needs-bot-login");
      expect(codes(diags(lane('skip="draft"'), { identity: {} }), "error")).not.toContain("node.skip-needs-bot-login");
    });

    it("refuses nodes that have no PR event to guard", () => {
      const noCtx = lane('skip="draft"').replace(', context="pr-diff"', "");
      expect(codes(diags(noCtx), "error")).toContain("node.skip-unsupported");
      const onProducer = lane().replace('role="agents/roles/builder.md"', 'role="agents/roles/builder.md", skip="draft"');
      expect(codes(diags(onProducer), "error")).toContain("node.skip-unsupported");
      expect(codes(diags(lane('skip="draft"')), "error")).toEqual([]);
    });

    it("refuses a diamond leg, and never emits a leg chained to a missing job", () => {
      const dot = `digraph t {
        start [type=start]
        builder [type=producer, role="agents/roles/builder.md"]
        split [type=parallel]
        a [type=analyst, role="agents/roles/a.md", context="pr-diff", skip="draft"]
        b [type=analyst, role="agents/roles/b.md", context="pr-diff"]
        panel [type=fan_in, role="agents/roles/panel.md"]
        start -> builder [on="issues.opened"]
        builder -> split [on="pull_request.opened"]
        split -> a
        split -> b
        a -> panel
        b -> panel
      }`;
      expect(codes(diags(dot), "error")).toContain("node.skip-unsupported");
      const w = workflow(dot, "panel");
      expect(Object.keys(w.jobs).sort()).toEqual(["a", "b", "panel"]);
      expect(w.jobs.a.needs).toBeUndefined();
    });
  });

  describe("the guard script, run against a stub gh", () => {
    const step = () => wf().jobs.reviewer_guard.steps[0];
    const pr = (over: Record<string, unknown> = {}) => ({
      draft: false,
      user: { login: BOT, type: "User" },
      labels: [],
      head: { sha: "head1" },
      base: { sha: "base1" },
      ...over,
    });
    const DIFF = [
      "diff --git a/a.txt b/a.txt",
      "index 1111111..2222222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,3 +1,4 @@ fn main()",
      " one",
      "+two",
      " three",
      "",
    ].join("\n");
    const fixtures = (prJson: unknown, reviews: unknown[] = [], diff = DIFF) => ({
      "repos/o/r/pulls/7": prJson,
      "repos/o/r/compare/base1...head1": diff,
      "repos/o/r/pulls/7/reviews": reviews,
    });
    const run = (fx: Record<string, unknown>, action = "synchronize") =>
      runStepScript(step(), fx, { PR: "7", EVENT_ACTION: action });

    it("runs a plain PR and reports the diff hash", () => {
      const r = run(fixtures(pr()));
      expect(r.status).toBe(0);
      expect(r.outputs.run).toBe("true");
      expect(r.outputs.head_sha).toBe("head1");
      expect(r.outputs.diff_hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("skips a draft", () => {
      const r = run(fixtures(pr({ draft: true })));
      expect(r.outputs.run).toBe("false");
      expect(r.outputs.reason).toContain("draft");
    });

    it("skips another bot's PR but never the harness's own", () => {
      expect(run(fixtures(pr({ user: { login: "dependabot[bot]", type: "Bot" } }))).outputs.run).toBe("false");
      expect(run(fixtures(pr({ user: { login: "renovate[bot]", type: "User" } }))).outputs.run).toBe("false");
      expect(run(fixtures(pr({ user: { login: BOT, type: "Bot" } }))).outputs.run).toBe("true");
      expect(run(fixtures(pr({ user: { login: "a-human", type: "User" } }))).outputs.run).toBe("true");
    });

    it("skips on the configured label only", () => {
      expect(run(fixtures(pr({ labels: [{ name: "skip-ai-review" }] }))).outputs.run).toBe("false");
      // The semantic key is not the repo label once config.labels maps it.
      expect(run(fixtures(pr({ labels: [{ name: "no-agent-review" }, { name: "bug" }] }))).outputs.run).toBe("true");
    });

    it("skips when the bot's last stamped review covers the same diff", () => {
      const hash = run(fixtures(pr())).outputs.diff_hash!;
      const stamped = (h: string, login = BOT) => ({
        user: { login },
        body: `Looks fine.\n\n**Verdict:** APPROVE\n\n<!-- gp-foundry:diff:reviewer:${h} -->`,
      });
      const same = run(fixtures(pr(), [stamped("0".repeat(64)), stamped(hash)]));
      expect(same.outputs.run).toBe("false");
      expect(same.outputs.reason).toContain("unchanged");

      // Only the LAST stamp counts: an older review of this diff does not excuse a newer change.
      expect(run(fixtures(pr(), [stamped(hash), stamped("0".repeat(64))])).outputs.run).toBe("true");
      // Someone else quoting the marker is not the bot's review.
      expect(run(fixtures(pr(), [stamped(hash, "mallory")])).outputs.run).toBe("true");
      // Another lane's stamp (same bot, different node) is not this lane's.
      const other = { user: { login: BOT }, body: `<!-- gp-foundry:diff:approver:${hash} -->` };
      expect(run(fixtures(pr(), [other])).outputs.run).toBe("true");
    });

    it("only ever skips a push on unchanged-diff — an explicit ask is still reviewed", () => {
      const hash = run(fixtures(pr())).outputs.diff_hash!;
      const stamped = { user: { login: BOT }, body: `<!-- gp-foundry:diff:reviewer:${hash} -->` };
      expect(run(fixtures(pr(), [stamped]), "synchronize").outputs.run).toBe("false");
      for (const action of ["labeled", "ready_for_review", "opened"]) {
        const r = run(fixtures(pr(), [stamped]), action);
        expect(r.outputs.run, action).toBe("true");
        // The hash is still reported, so the new review gets stamped.
        expect(r.outputs.diff_hash, action).toBe(hash);
      }
      expect(step().env.EVENT_ACTION).toBe("${{ github.event.action }}");
    });

    it("hashes a rebased diff the same, and a changed diff differently", () => {
      const base = run(fixtures(pr())).outputs.diff_hash;
      const rebased = DIFF.replace("index 1111111..2222222", "index 3333333..4444444").replace("@@ -1,3 +1,4 @@", "@@ -41,3 +41,4 @@");
      expect(run(fixtures(pr(), [], rebased)).outputs.diff_hash).toBe(base);
      expect(run(fixtures(pr(), [], DIFF.replace("+two", "+2"))).outputs.diff_hash).not.toBe(base);
    });

    it("fails open when the PR or its diff cannot be read", () => {
      const noPr = run({});
      expect(noPr.status).toBe(0);
      expect(noPr.outputs.run).toBe("true");

      const noDiff = run({ "repos/o/r/pulls/7": pr(), "repos/o/r/pulls/7/reviews": [] });
      expect(noDiff.status).toBe(0);
      expect(noDiff.outputs.run).toBe("true");
      expect(noDiff.outputs.diff_hash).toBe("");
    });
  });

  describe("the stamp script, run against a stub gh", () => {
    const step = () => wf().jobs.reviewer.steps.at(-1);
    const env = { PR: "7", HEAD_SHA: "head1", DIFF_HASH: "f".repeat(64), GH_TOKEN: "t" };
    const review = (id: number, over: Record<string, unknown> = {}) => ({
      id,
      user: { login: BOT },
      commit_id: "head1",
      body: "**Verdict:** APPROVE",
      ...over,
    });

    it("appends the marker to the bot's review of this head", () => {
      const r = runStepScript(
        step(),
        {
          "repos/o/r/pulls/7/reviews": [review(1, { commit_id: "old" }), review(2), review(3, { user: { login: "human" } })],
          "repos/o/r/pulls/7/reviews/2": review(2),
        },
        env,
      );
      expect(r.status).toBe(0);
      expect(r.writes).toContain("PUT repos/o/r/pulls/7/reviews/2");
      expect(r.writes).toContain("**Verdict:** APPROVE");
      expect(r.writes).toContain(`<!-- gp-foundry:diff:reviewer:${"f".repeat(64)} -->`);
    });

    it("writes nothing when the agent posted no review on this head", () => {
      const r = runStepScript(
        step(),
        { "repos/o/r/pulls/7/reviews": [review(1, { commit_id: "old" }), review(2, { body: "x <!-- gp-foundry:diff:reviewer:abc -->" })] },
        env,
      );
      expect(r.status).toBe(0);
      expect(r.writes).toBe("");
    });
  });
});

// ── 5. select="sweep" ────────────────────────────────────────────────────────

describe('select="sweep" on pr-review', () => {
  const SWEEP = `digraph t {
    start    [type=start]
    builder  [type=producer, role="agents/roles/builder.md"]
    approver [type=pr-review, role="agents/roles/approver.md", context="pr-review", select="sweep", schedule="*/15 * * * *"]
    start    -> builder  [on="issues.opened"]
    builder  -> approver [on="pull_request.opened"]
  }`;
  const wf = (dot = SWEEP) => workflow(dot, "approver");

  it("is driven by its schedule, never by PR events", () => {
    const w = wf();
    expect(w.on).toEqual({ schedule: [{ cron: "*/15 * * * *" }], workflow_dispatch: {} });
    // One sweep at a time; a queued tick re-selects after the running one decided.
    expect(w.concurrency).toEqual({ group: "approver", "cancel-in-progress": false });
    expect(codes(diags(SWEEP), "error")).toEqual([]);
  });

  it("fans the lane out over the selected heads", () => {
    const w = wf();
    expect(Object.keys(w.jobs)).toEqual(["approver_select", "approver"]);
    expect(w.jobs.approver_select.if).toBeUndefined();
    expect(w.jobs.approver_select.permissions).toEqual({
      contents: "read",
      "pull-requests": "read",
      checks: "read",
      statuses: "read",
    });
    const job = w.jobs.approver;
    expect(job.needs).toEqual(["approver_select"]);
    expect(job.if).toBe("needs.approver_select.outputs.count != '0'");
    expect(job.strategy).toEqual({
      "fail-fast": false,
      matrix: { pr: "${{ fromJSON(needs.approver_select.outputs.prs) }}" },
    });
  });

  it("reads the PR from the matrix, not from an event payload that is not there", () => {
    const job = workflow(SWEEP.replace('select="sweep"', 'select="sweep", gates="ci.yml, lint"'), "approver").jobs.approver;
    expect(JSON.stringify(job)).not.toContain("github.event.pull_request");
    expect(job.steps.find((s: any) => s.name === "Checkout").with.ref).toBe("${{ matrix.pr.sha }}");
    expect(job.steps.find((s: any) => s.name === "Fetch context").with.number).toBe("${{ matrix.pr.number }}");
    for (const s of job.steps.filter((x: any) => String(x.uses ?? "").includes("wait-for-checks"))) {
      expect(s.with.sha).toBe("${{ matrix.pr.sha }}");
    }
  });

  describe("validation", () => {
    it("needs a schedule, a pr-review node and a PR context", () => {
      expect(codes(diags(SWEEP.replace(', schedule="*/15 * * * *"', "")), "error")).toContain("node.sweep-no-schedule");
      expect(codes(diags(SWEEP.replace('context="pr-review", ', "")), "error")).toContain("node.select-unsupported");
      expect(codes(diags(SWEEP.replace("type=pr-review", "type=analyst")), "error")).toContain("node.select-unsupported");
      expect(codes(diags(SWEEP.replace('select="sweep"', 'select="all"')), "error")).toContain("node.bad-select");
    });

    it("a half-configured sweep compiles as the plain event lane it was", () => {
      const w = workflow(SWEEP.replace(', schedule="*/15 * * * *"', ""), "approver");
      expect(Object.keys(w.jobs)).toEqual(["approver"]);
      expect(w.on.pull_request.types).toContain("opened");
    });

    it("does not combine with skip=", () => {
      const dot = SWEEP.replace('select="sweep"', 'select="sweep", skip="draft"');
      expect(codes(diags(dot), "error")).toContain("node.skip-unsupported");
      expect(Object.keys(workflow(dot, "approver").jobs)).toEqual(["approver_select", "approver"]);
    });

    it("warns when no bot login pins who may decide", () => {
      expect(codes(diags(SWEEP, { identity: {} }), "warning")).toContain("node.sweep-no-bot-login");
    });
  });

  describe("the selector script, run against a stub gh", () => {
    const step = () => wf().jobs.approver_select.steps[0];
    const open = (number: number, over: Record<string, unknown> = {}) => ({
      number,
      draft: false,
      head: { ref: `agent/${number}-x`, sha: `sha${number}` },
      requested_reviewers: [],
      requested_teams: [],
      ...over,
    });
    const LIST = "repos/o/r/pulls?state=open&sort=created&direction=asc&per_page=100";
    const head = (
      n: number,
      o: { checks?: unknown[]; status?: unknown; reviews?: unknown[] } = {},
    ): Record<string, unknown> => ({
      [`repos/o/r/commits/sha${n}/check-runs?per_page=100`]: { check_runs: o.checks ?? [{ status: "completed" }] },
      [`repos/o/r/commits/sha${n}/status`]: o.status ?? { total_count: 0, state: "pending" },
      [`repos/o/r/pulls/${n}/reviews?per_page=100`]: o.reviews ?? [],
    });
    const select = (fx: Record<string, unknown>, env: Record<string, string> = {}) => {
      const r = runStepScript(step(), fx, env);
      return { ...r, prs: r.outputs.prs ? JSON.parse(r.outputs.prs) : undefined };
    };
    const verdict = (n: number, login = BOT, sha = `sha${n}`) => ({
      user: { login },
      commit_id: sha,
      body: "Ship it.\n\n**Verdict:** APPROVE",
    });

    it("selects a head whose reviews and checks are in and which is undecided", () => {
      const r = select({ [LIST]: [open(1)], ...head(1) });
      expect(r.status).toBe(0);
      expect(r.prs).toEqual([{ number: 1, sha: "sha1" }]);
      expect(r.outputs.count).toBe("1");
    });

    it("leaves out drafts, human branches and outstanding review requests", () => {
      const r = select({
        [LIST]: [
          open(1, { draft: true }),
          open(2, { head: { ref: "feature/x", sha: "sha2" } }),
          open(3, { requested_reviewers: [{ login: "a" }] }),
          open(4, { requested_teams: [{ slug: "t" }] }),
          open(5),
        ],
        ...head(5),
      });
      expect(r.prs).toEqual([{ number: 5, sha: "sha5" }]);
    });

    it("waits for every check-run and commit status to conclude", () => {
      const r = select({
        [LIST]: [open(1), open(2), open(3), open(4)],
        ...head(1, { checks: [{ status: "completed" }, { status: "in_progress" }] }),
        ...head(2, { checks: [{ status: "queued" }] }),
        ...head(3, { status: { total_count: 2, state: "pending" } }),
        // Concluded is not the same as green: a failed check is still an answer.
        ...head(4, { checks: [{ status: "completed", conclusion: "failure" }], status: { total_count: 1, state: "failure" } }),
      });
      expect(r.prs).toEqual([{ number: 4, sha: "sha4" }]);
    });

    it("skips a head that already carries the bot's verdict — and only that head", () => {
      const r = select({
        [LIST]: [open(1), open(2), open(3), open(4)],
        ...head(1, { reviews: [verdict(1)] }),
        // A verdict on an OLDER head is not a decision about this one.
        ...head(2, { reviews: [verdict(2, BOT, "older")] }),
        // Someone else's verdict-shaped review does not pre-empt the bot.
        ...head(3, { reviews: [verdict(3, "mallory")] }),
        // A bot review with no verdict is commentary, not a decision.
        ...head(4, { reviews: [{ user: { login: BOT }, commit_id: "sha4", body: "nit: typo" }] }),
      });
      expect(r.prs).toEqual([
        { number: 2, sha: "sha2" },
        { number: 3, sha: "sha3" },
        { number: 4, sha: "sha4" },
      ]);
    });

    it("is deterministic: oldest first, capped, the rest left for the next tick", () => {
      const fx: Record<string, unknown> = { [LIST]: [open(1), open(2), open(3)] };
      for (const n of [1, 2, 3]) Object.assign(fx, head(n));
      const r = select(fx, { LIMIT: "2" });
      expect(r.prs).toEqual([
        { number: 1, sha: "sha1" },
        { number: 2, sha: "sha2" },
      ]);
      expect(select(fx, { LIMIT: "2" }).outputs.prs).toBe(r.outputs.prs);
    });

    it("fails closed on a head it cannot read, without sinking the sweep", () => {
      // PR 1 has no fixtures at all: every read of it errors.
      const r = select({ [LIST]: [open(1), open(2)], ...head(2) });
      expect(r.status).toBe(0);
      expect(r.prs).toEqual([{ number: 2, sha: "sha2" }]);
    });

    it("reports an empty sweep as count=0 (the lane job is skipped, not errored)", () => {
      const r = select({ [LIST]: [] });
      expect(r.status).toBe(0);
      expect(r.outputs.prs).toBe("[]");
      expect(r.outputs.count).toBe("0");
    });

    it("fails the job when the PR list itself cannot be read", () => {
      expect(select({}).status).not.toBe(0);
    });
  });
});

// ── 6. API-key auth ──────────────────────────────────────────────────────────

describe("API-key auth for run-agent", () => {
  const runAgentWith = (cfg: Partial<FoundryConfig>) =>
    workflow(lane(), "reviewer", cfg).jobs.reviewer.steps.find((s: any) => s.name === "Run agent").with;
  const agent = (over: Record<string, unknown>) =>
    ({ agent: { ...loadConfig(undefined).agent, ...over } }) as Partial<FoundryConfig>;

  it("passes the OAuth token by default", () => {
    const w = runAgentWith({});
    expect(w["claude-code-oauth-token"]).toBe("${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}");
    expect(w["anthropic-api-key"]).toBeUndefined();
  });

  it("passes the API key INSTEAD when agent.api_key_secret is set", () => {
    const w = runAgentWith(agent({ api_key_secret: "ANTHROPIC_API_KEY" }));
    expect(w["anthropic-api-key"]).toBe("${{ secrets.ANTHROPIC_API_KEY }}");
    expect(w["claude-code-oauth-token"]).toBeUndefined();
  });

  it("is accepted by the config schema", () => {
    const schema = JSON.parse(readFileSync(fileURLToPath(new URL("../schema/config.schema.json", import.meta.url)), "utf8"));
    expect(schema.properties.agent.properties.api_key_secret.type).toBe("string");
  });

  describe("the action's Run agent step", () => {
    const action: any = yaml.load(
      readFileSync(fileURLToPath(new URL("../actions/run-agent/action.yml", import.meta.url)), "utf8"),
    );
    const script: string = action.runs.steps.find((s: any) => s.name === "Run agent").run;

    /** Run the step with a stub `claude` that records which credentials it was handed. */
    function run(creds: Record<string, string>) {
      const dir = mkdtempSync(join(tmpdir(), "gpf-auth-"));
      const bin = join(dir, "bin");
      mkdirSync(bin);
      writeFileSync(
        join(bin, "claude"),
        `#!/usr/bin/env bash\ncat > /dev/null\nprintf 'oauth=%s key=%s\\n' "\${CLAUDE_CODE_OAUTH_TOKEN-UNSET}" "\${ANTHROPIC_API_KEY-UNSET}"\n`,
      );
      chmodSync(join(bin, "claude"), 0o755);
      writeFileSync(join(dir, "prompt"), "hi");
      try {
        const stdout = execFileSync("bash", ["-e", "-o", "pipefail", "-c", script], {
          env: {
            PATH: `${bin}:${process.env.PATH}`,
            PROMPT_FILE: join(dir, "prompt"),
            ROLE_FILE: "",
            MODEL: "m",
            ALLOWED_TOOLS: "Read",
            EXTRA_ARGS: "",
            EXTRA_ENV: "",
            MAX_ATTEMPTS: "1",
            RETRY_BASE_DELAY_SECONDS: "0",
            ...creds,
          },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        return { status: 0, stdout };
      } catch (e: any) {
        return { status: e.status ?? 1, stdout: (e.stdout ?? "") + (e.stderr ?? "") };
      }
    }

    it("declares both credentials optional", () => {
      expect(action.inputs["claude-code-oauth-token"].required).toBe(false);
      expect(action.inputs["anthropic-api-key"].required).toBe(false);
    });

    it("hands the CLI the API key alone", () => {
      // Actions passes an unused input as an EMPTY env var; it must not reach the CLI.
      const r = run({ ANTHROPIC_API_KEY: "sk-test", CLAUDE_CODE_OAUTH_TOKEN: "" });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("oauth=UNSET key=sk-test");
    });

    it("hands the CLI the OAuth token alone", () => {
      const r = run({ ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "tok" });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("oauth=tok key=UNSET");
    });

    it("refuses both, and refuses neither", () => {
      const both = run({ ANTHROPIC_API_KEY: "sk-test", CLAUDE_CODE_OAUTH_TOKEN: "tok" });
      expect(both.status).not.toBe(0);
      expect(both.stdout).toContain("pass exactly one");
      const neither = run({ ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "" });
      expect(neither.status).not.toBe(0);
      expect(neither.stdout).toContain("no agent credential");
    });
  });
});
