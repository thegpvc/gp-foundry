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
import { staleGeneratedWorkflows } from "../src/cli/common.js";
import type { Diagnostic, FoundryConfig, Harness, HarnessNode } from "../src/ir/types.js";

const BOT = "agent-bot";

function mkHarness(dot: string, cfg: Partial<FoundryConfig> = {}): Harness {
  const g = parseDot(dot);
  expect(g.errors).toEqual([]);
  const base = loadConfig(undefined);
  const config = { ...base, identity: { bot_login: BOT }, ...cfg } as FoundryConfig;
  return { name: g.name, nodes: g.nodes, edges: g.edges, config, sourcePath: "test.dot" };
}

function workflow(dot: string, file: string, cfg: Partial<FoundryConfig> = {}, specDir = ""): any {
  const { files } = compile(mkHarness(dot, cfg), {}, { specDir });
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
    -f) field="$field$2
"; shift 2 ;;
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
    // Reads on GITHUB_TOKEN, with no checkout and no agent. unchanged-diff edits the
    // bot's review (the also-head marker) with the stamp token, which under
    // github-token auth is GITHUB_TOKEN, so that one scope is write.
    expect(w.jobs.reviewer_guard.permissions).toEqual({ contents: "read", "pull-requests": "write" });
    expect(w.jobs.reviewer_guard.steps).toHaveLength(1);
    expect(w.jobs.reviewer_guard.steps[0].env.GH_TOKEN).toBe("${{ github.token }}");
    expect(w.jobs.reviewer_guard.steps[0].env.STAMP_TOKEN).toBe(w.jobs.reviewer.steps.at(-1).env.GH_TOKEN);
  });

  it("stays read-only without unchanged-diff, and under PAT or App auth", () => {
    const plain = workflow(lane('skip="draft"'), "reviewer");
    expect(plain.jobs.reviewer_guard.permissions).toEqual({ contents: "read", "pull-requests": "read" });
    const pat = workflow(lane(SKIP), "reviewer", { auth: { mode: "pat", token_secret: "AGENT_PAT" } } as Partial<FoundryConfig>);
    expect(pat.jobs.reviewer_guard.permissions).toEqual({ contents: "read", "pull-requests": "read" });
    expect(pat.jobs.reviewer_guard.steps[0].env.STAMP_TOKEN).toBe("${{ secrets.AGENT_PAT }}");
    // App auth: the guard mints its own token, narrowed to pull requests.
    const app = workflow(lane(SKIP), "reviewer", { auth: { mode: "app", app_id_secret: "APP_ID", app_key_secret: "APP_KEY" } } as Partial<FoundryConfig>);
    const guard = app.jobs.reviewer_guard;
    expect(guard.permissions).toEqual({ contents: "read", "pull-requests": "read" });
    expect(guard.steps[0]).toMatchObject({ id: "app-token", with: { "permission-pull-requests": "write" } });
    expect(guard.steps[1].env.STAMP_TOKEN).toBe("${{ steps.app-token.outputs.token }}");
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

    it("marks the covering review with the skipped head, appending once", () => {
      const hash = run(fixtures(pr())).outputs.diff_hash!;
      const body = `Looks fine.\n\n<!-- gp-foundry:diff:reviewer:${hash} -->\n<!-- gp-foundry:also-head:reviewer:older -->`;
      const fx = { ...fixtures(pr(), [{ id: 41, user: { login: BOT }, body }]), "repos/o/r/pulls/7/reviews/41": { body } };
      const r = run(fx);
      expect(r.outputs.run).toBe("false");
      expect(r.writes).toContain("PUT repos/o/r/pulls/7/reviews/41");
      // Appended after every existing marker, never replacing one.
      expect(r.writes).toContain(`body=${body}\n<!-- gp-foundry:also-head:reviewer:head1 -->`);

      // Already marked for this head: no second write.
      const marked = `${body}\n<!-- gp-foundry:also-head:reviewer:head1 -->`;
      const again = run({ ...fixtures(pr(), [{ id: 41, user: { login: BOT }, body: marked }]), "repos/o/r/pulls/7/reviews/41": { body: marked } });
      expect(again.outputs.run).toBe("false");
      expect(again.writes).toBe("");

      // A changed diff is reviewed, and nothing is marked.
      const changed = run({ ...fx, "repos/o/r/compare/base1...head1": DIFF.replace("+two", "+2") });
      expect(changed.outputs.run).toBe("true");
      expect(changed.writes).toBe("");
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
    expect(Object.keys(w.jobs)).toEqual(["approver_select", "approver", "approver_mark"]);
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

    it("takes skip= draft, bot-author and label:<key>, but not unchanged-diff", () => {
      const ok = SWEEP.replace('select="sweep"', 'select="sweep", skip="draft,bot-author,label:hold"');
      expect(codes(diags(ok), "error")).toEqual([]);
      expect(Object.keys(workflow(ok, "approver").jobs)).toEqual(["approver_select", "approver", "approver_mark"]);
      const bad = SWEEP.replace('select="sweep"', 'select="sweep", skip="label:hold,unchanged-diff"');
      expect(codes(diags(bad), "error")).toContain("node.skip-unsupported");
    });

    it("warns when no bot login pins who may decide", () => {
      expect(codes(diags(SWEEP, { identity: {} }), "warning")).toContain("node.sweep-no-bot-login");
    });
  });

  describe("the selector script text", () => {
    it("lists every check run, not GitHub's default latest-per-name", () => {
      const run: string = wf().jobs.approver_select.steps[0].run;
      expect(run).toContain('commits/$SHA/check-runs?per_page=100&filter=all"');
      expect(run).not.toMatch(/check-runs\?per_page=100"/);
    });

    it("excludes skip= labels (resolved through config.labels) and bot authors", () => {
      const dot = SWEEP.replace('select="sweep"', 'select="sweep", skip="bot-author,label:hold,label:raw-label"');
      const step = workflow(dot, "approver", { labels: { hold: "do-not-approve" } } as any).jobs.approver_select.steps[0];
      expect(step.env.SKIP_LABEL_1).toBe("do-not-approve");
      expect(step.env.SKIP_LABEL_2).toBe("raw-label");
      expect(step.run).toContain("| select((.labels // []) | any(.name == env.SKIP_LABEL_1) | not)");
      expect(step.run).toContain("| select((.labels // []) | any(.name == env.SKIP_LABEL_2) | not)");
      expect(step.run).toContain(
        '| select((.user.login // "") == env.BOT_LOGIN or (((.user.type // "") != "Bot") and ((.user.login // "") | endswith("[bot]") | not)))',
      );
      const plain: string = wf().jobs.approver_select.steps[0].run;
      expect(plain).not.toContain("SKIP_LABEL");
      expect(plain).not.toContain('endswith("[bot]")');
    });

    it("reads a verdict only from the review's last non-empty line", () => {
      const run: string = wf().jobs.approver_select.steps[0].run;
      expect(run).toContain(
        '(.body // "") | split("\\n") | map(select(length > 0)) | (last // "") | startswith(env.VERDICT_MARKER)',
      );
      expect(run).not.toContain("contains(env.VERDICT_MARKER)");
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
      updated_at: "2020-01-01T00:00:00Z",
      base: { ref: "main" },
      ...over,
    });
    const LIST = "repos/o/r/pulls?state=open&sort=created&direction=asc&per_page=100";
    const head = (
      n: number,
      o: { checks?: unknown[]; status?: unknown; reviews?: unknown[] } = {},
    ): Record<string, unknown> => ({
      [`repos/o/r/commits/sha${n}/check-runs?per_page=100&filter=all`]: { check_runs: o.checks ?? [{ status: "completed" }] },
      [`repos/o/r/commits/sha${n}/status`]: o.status ?? { total_count: 0, state: "pending" },
      [`repos/o/r/pulls/${n}/reviews?per_page=100`]: o.reviews ?? [],
    });
    const select = (fx: Record<string, unknown>, env: Record<string, string> = {}) => {
      const r = runStepScript(step(), fx, env);
      const full: any[] | undefined = r.outputs.prs ? JSON.parse(r.outputs.prs) : undefined;
      // `base` rides along for the harness checkout; asserted once, below.
      return { ...r, full, prs: full?.map(({ number, sha }) => ({ number, sha })) };
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
      expect(r.full).toEqual([{ number: 1, sha: "sha1", base: "main" }]);
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

    it("skips a head an earlier sweep already ran the lane on, verdict or not", () => {
      // The shadow-mode loop: a role that posts nothing leaves no verdict, so
      // without the lane's own marker the head is re-picked on every tick.
      const swept = (app = "github-actions", name = "gp-foundry/swept (approver)") => ({
        status: "completed",
        name,
        app: { slug: app },
      });
      const r = select({
        [LIST]: [open(1), open(2), open(3)],
        ...head(1, { checks: [{ status: "completed", name: "ci" }, swept()] }),
        // Only GITHUB_TOKEN's check counts: the harness token must not be able to fake "done".
        ...head(2, { checks: [swept("my-agent-app")] }),
        // Another sweep lane's marker is not this lane's.
        ...head(3, { checks: [swept("github-actions", "gp-foundry/swept (other)")] }),
      });
      expect(r.prs).toEqual([
        { number: 2, sha: "sha2" },
        { number: 3, sha: "sha3" },
      ]);
    });

    it("counts every check run, not only the newest per name", () => {
      const failed = { status: "completed", name: "gp-foundry/sweep-failed (approver)", app: { slug: "github-actions" } };
      // GitHub's default (filter=latest) view: one run per name. Served too, so a
      // script that drops filter=all reads it and gets both heads wrong.
      const latest = (n: number, checks: unknown[]) => ({ [`repos/o/r/commits/sha${n}/check-runs?per_page=100`]: { check_runs: checks } });
      const r = select({
        [LIST]: [open(1), open(2)],
        // Three failed lane runs: the cap is reached.
        ...head(1, { checks: [failed, failed, failed] }),
        ...latest(1, [failed]),
        // A real run still in progress, hidden in the latest view by a newer skipped run of the same job.
        ...head(2, {
          checks: [
            { status: "in_progress", name: "reviewer" },
            { status: "completed", conclusion: "skipped", name: "reviewer" },
          ],
        }),
        ...latest(2, [{ status: "completed", conclusion: "skipped", name: "reviewer" }]),
      });
      expect(r.prs).toEqual([]);
      expect(r.stdout).toContain("#1: gave up on sha1 after 3 failed runs");
      expect(r.stdout).toContain("#2: 1 check-run(s) still running");
    });

    it("leaves out PRs with a skip= label or by a bot, but not the harness's own", () => {
      const dot = SWEEP.replace('select="sweep"', 'select="sweep", skip="bot-author,label:hold"');
      const st = workflow(dot, "approver", { labels: { hold: "do-not-approve" } } as any).jobs.approver_select.steps[0];
      const fx: Record<string, unknown> = {
        [LIST]: [
          open(1, { labels: [{ name: "do-not-approve" }] }),
          open(2, { labels: [{ name: "hold" }] }), // the key, not the resolved label
          open(3, { user: { login: "dependabot[bot]", type: "Bot" } }),
          open(4, { user: { login: "renovate[bot]" } }),
          open(5, { user: { login: BOT, type: "Bot" } }),
          open(6, { user: { login: "dpup", type: "User" } }),
        ],
      };
      for (const n of [1, 2, 3, 4, 5, 6]) Object.assign(fx, head(n));
      const r = runStepScript(st, fx);
      expect(r.status).toBe(0);
      expect(JSON.parse(r.outputs.prs!).map((p: any) => p.number)).toEqual([2, 5, 6]);
    });

    it("does not read a quoted verdict marker as a decision", () => {
      const review = (n: number, body: string) => ({ user: { login: BOT }, commit_id: `sha${n}`, body });
      const r = select({
        [LIST]: [open(1), open(2), open(3)],
        ...head(1, { reviews: [review(1, "The role file says to end with `**Verdict:**` and a decision.\n\nLooks fine otherwise.")] }),
        ...head(2, { reviews: [review(2, "Ship it.\n\n**Verdict:** APPROVE\n\n")] }),
        ...head(3, { reviews: [review(3, "**Verdict:** quoted at the top\nthen more text")] }),
      });
      expect(r.prs).toEqual([
        { number: 1, sha: "sha1" },
        { number: 3, sha: "sha3" },
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

// ── the sweep's own "done" marker ────────────────────────────────────────────

describe("sweep mark job: a head the lane ran on is not swept again", () => {
  const SWEEP = `digraph t {
    approver [type=pr-review, role="agents/roles/approver.md", context="pr-review", select="sweep", schedule="*/10 * * * *"]
  }`;
  const wf = () => workflow(SWEEP, "approver");

  it("runs after the lane, in a job of its own that holds checks: write and no agent", () => {
    const w = wf();
    const mark = w.jobs.approver_mark;
    expect(mark.needs).toEqual(["approver_select", "approver"]);
    expect(mark.if).toContain("always()");
    expect(mark.permissions).toEqual({ checks: "write", actions: "read", "pull-requests": "read" });
    expect(mark.steps).toHaveLength(1);
    expect(mark.steps[0].env.GH_TOKEN).toBe("${{ github.token }}");
    expect(mark.steps[0].run).not.toContain("${{");
    // The agent lane itself never gains the scope the human-gate approval is written with.
    expect(w.jobs.approver.permissions.checks).toBe("read");
    // The lane job is named per PR so its result can be read back.
    expect(w.jobs.approver.name).toBe("approver #${{ matrix.pr.number }}");
    expect(mark.steps[0].env.JOB_PREFIX).toBe("approver #");
  });

  describe("the mark script, run against a stub gh", () => {
    const JOBS = "repos/o/r/actions/runs/99/attempts/1/jobs?per_page=100";
    const env = {
      RUN_ID: "99",
      RUN_ATTEMPT: "1",
      PRS: JSON.stringify([
        { number: 1, sha: "sha1" },
        { number: 2, sha: "sha2" },
        { number: 12, sha: "sha12" },
      ]),
    };
    const run = (fx: Record<string, unknown>, e = env) => runStepScript(wf().jobs.approver_mark.steps[0], fx, e);
    const reviews = (n: number, body = "Ship it.\n\n**Verdict:** APPROVE") => ({
      [`repos/o/r/pulls/${n}/reviews?per_page=100`]: [{ user: { login: BOT }, commit_id: `sha${n}`, body }],
    });

    it("marks exactly the heads whose lane job succeeded", () => {
      const r = run({
        ...reviews(1),
        ...reviews(12),
        [JOBS]: {
          jobs: [
            { name: "approver_select", conclusion: "success" },
            { name: "approver #1", conclusion: "success" },
            { name: "approver #2", conclusion: "failure" },
            { name: "approver #12", conclusion: "success" },
          ],
        },
      });
      expect(r.status).toBe(0);
      const posts = r.writes.split("\n").filter((l) => l.startsWith("POST"));
      expect(posts).toHaveLength(3); // two swept, one failed-run record
      expect(r.stdout).toContain("#1: marked sha1");
      expect(r.stdout).toContain("#12: marked sha12");
      // A failed lane is retried by the next sweep — and the failure is counted.
      expect(r.stdout).toContain("#2: lane failure — recorded failed run 1 of 3 on sha2");
    });

    it("marks a successful head only once the bot's verdict is on it", () => {
      const jobs = { [JOBS]: { jobs: [{ name: "approver #1", conclusion: "success" }] } };
      const one = { ...env, PRS: JSON.stringify([{ number: 1, sha: "sha1" }]) };
      // Nothing to decide yet: no review, a review on an older head, a quoted marker.
      for (const fx of [
        { "repos/o/r/pulls/1/reviews?per_page=100": [] },
        { "repos/o/r/pulls/1/reviews?per_page=100": [{ user: { login: BOT }, commit_id: "older", body: "**Verdict:** APPROVE" }] },
        reviews(1, "Quoting `**Verdict:**` from the role file.\nNo decision yet."),
      ]) {
        const r = run({ ...jobs, ...fx }, one);
        expect(r.status).toBe(0);
        expect(r.writes).toBe(""); // neither swept nor counted as a failure
        expect(r.stdout).toContain("#1: no verdict posted on sha1; left for the next sweep");
      }
      const r = run({ ...jobs, ...reviews(1) }, one);
      expect(r.writes).toContain("POST repos/o/r/check-runs");
      expect(r.writes).toContain("name=gp-foundry/swept (approver)");
      expect(r.stdout).toContain("#1: marked sha1");
    });

    it("leaves a successful head unmarked when its reviews cannot be read", () => {
      const r = run({ [JOBS]: { jobs: [{ name: "approver #1", conclusion: "success" }] } }, { ...env, PRS: JSON.stringify([{ number: 1, sha: "sha1" }]) });
      expect(r.status).toBe(0);
      expect(r.writes).toBe("");
      expect(r.stdout).toContain("could not read reviews on sha1");
    });

    it("matches the job name exactly: #1 succeeding does not mark #12", () => {
      const r = run({ ...reviews(1), [JOBS]: { jobs: [{ name: "approver #1", conclusion: "success" }] } });
      expect(r.stdout).toContain("#1: marked sha1");
      expect(r.stdout).toContain("#12: lane did not finish");
    });

    it("fails loudly when it cannot tell which lanes succeeded", () => {
      const r = run({});
      expect(r.status).not.toBe(0);
      expect(r.writes).toBe("");
    });
  });
});

// ── authors= ─────────────────────────────────────────────────────────────────

describe("authors= restricts a PR lane to an allowlist", () => {
  const AUTHORS_IF = "github.event.pull_request.user.login == 'dpup'";

  it("puts the allowlist on the job-level if:, so no runner is spent on anyone else", () => {
    const w = workflow(lane('authors="Dpup"'), "reviewer");
    // The first job of the workflow carries it; lower-cased (GitHub's == ignores case).
    expect(w.jobs.reviewer_guard.if).toContain(AUTHORS_IF);
    expect(w.jobs.reviewer_guard.if).toContain("startsWith(github.event.pull_request.head.ref, 'agent/')");
    expect(w.jobs.reviewer.needs).toEqual(["reviewer_guard"]);
  });

  it("ORs several logins inside one parenthesized clause", () => {
    const w = workflow(lane('authors="dpup, octocat, dependabot[bot]"'), "reviewer");
    expect(w.jobs.reviewer_guard.if).toContain(
      "(github.event.pull_request.user.login == 'dpup' || github.event.pull_request.user.login == 'octocat' || github.event.pull_request.user.login == 'dependabot[bot]')",
    );
  });

  it("emits a guard job even with no skip=, and re-checks the live author there", () => {
    const step = workflow(lane('authors="dpup"'), "reviewer").jobs.reviewer_guard.steps[0];
    expect(step.env.AUTHORS).toBe("dpup");
    expect(step.run).toContain("env.AUTHORS");
    expect(step.run).not.toContain("dpup");
  });

  it("can come from repo.authors in foundry.config.yaml, and the node attr overrides it", () => {
    const repo = { ...loadConfig(undefined).repo, authors: ["DPUP", "octocat"] };
    const fromCfg = workflow(lane(), "reviewer", { repo });
    expect(fromCfg.jobs.reviewer_guard.steps[0].env.AUTHORS).toBe("dpup,octocat");
    const overridden = workflow(lane('authors="hubot"'), "reviewer", { repo });
    expect(overridden.jobs.reviewer_guard.steps[0].env.AUTHORS).toBe("hubot");
    expect(overridden.jobs.reviewer_guard.if).not.toContain("'dpup'");
  });

  it("binds the fixer too (job-level if only — it has no guard job)", () => {
    const dot = `digraph t {
      start    [type=start]
      builder  [type=producer, role="agents/roles/builder.md"]
      reviewer [type=pr-review, role="agents/roles/reviewer.md", context="pr-diff"]
      fixer    [type=pr-fix, role="agents/roles/fixer.md"]
      human    [type=exit]
      start    -> builder  [on="issues.opened"]
      builder  -> reviewer [on="pull_request.opened"]
      reviewer -> fixer    [when="verdict=request_changes"]
      fixer    -> reviewer [on="push"]
      fixer    -> human    [when="attempts>=3"]
    }`;
    const repo = { ...loadConfig(undefined).repo, authors: ["dpup"] };
    const w = workflow(dot, "fixer", { repo });
    expect(Object.keys(w.jobs)).toEqual(["fixer"]);
    expect(w.jobs.fixer.if).toContain(AUTHORS_IF);
    expect(w.jobs.fixer.if).toContain("**Verdict:** REQUEST_CHANGES");
  });

  it("leaves issue lanes and unrestricted harnesses alone", () => {
    const w = workflow(lane(), "reviewer");
    expect(Object.keys(w.jobs)).toEqual(["reviewer"]);
    expect(w.jobs.reviewer.if).not.toContain("user.login");
    const repo = { ...loadConfig(undefined).repo, authors: ["dpup"] };
    expect(JSON.stringify(workflow(lane(), "builder", { repo }))).not.toContain("user.login");
  });

  it("filters the sweep's selection by the same list", () => {
    const dot = `digraph t {
      approver [type=pr-review, role="agents/roles/a.md", context="pr-review", select="sweep", schedule="*/10 * * * *", authors="dpup"]
    }`;
    const step = workflow(dot, "approver").jobs.approver_select.steps[0];
    expect(step.env.AUTHORS).toBe("dpup");
    const pr = (number: number, login: string) => ({
      number,
      draft: false,
      user: { login },
      head: { ref: `agent/${number}`, sha: `sha${number}` },
      requested_reviewers: [],
      requested_teams: [],
      updated_at: "2020-01-01T00:00:00Z",
      base: { ref: "main" },
    });
    const fx: Record<string, unknown> = {
      "repos/o/r/pulls?state=open&sort=created&direction=asc&per_page=100": [pr(1, "someone-else"), pr(2, "DPup"), pr(3, "dpup-impostor")],
    };
    for (const n of [1, 2, 3]) {
      fx[`repos/o/r/commits/sha${n}/check-runs?per_page=100&filter=all`] = { check_runs: [] };
      fx[`repos/o/r/commits/sha${n}/status`] = { total_count: 0 };
      fx[`repos/o/r/pulls/${n}/reviews?per_page=100`] = [];
    }
    const r = runStepScript(step, fx);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.outputs.prs!)).toEqual([{ number: 2, sha: "sha2", base: "main" }]);
  });

  describe("the guard script, run against a stub gh", () => {
    const step = () => workflow(lane('authors="dpup, octocat"'), "reviewer").jobs.reviewer_guard.steps[0];
    const run = (fx: Record<string, unknown>) => runStepScript(step(), fx, { PR: "7" });
    const pr = (login: string) => ({ "repos/o/r/pulls/7": { user: { login }, head: { sha: "h" }, draft: false, labels: [] } });

    it("runs for an allowlisted author, whatever the case", () => {
      expect(run(pr("dpup")).outputs.run).toBe("true");
      expect(run(pr("OctoCat")).outputs.run).toBe("true");
    });

    it("skips everyone else — no prefix or substring matches", () => {
      for (const login of ["mallory", "dpup2", "xdpup", "dpu", ""]) {
        const r = run(pr(login));
        expect(r.outputs.run, login).toBe("false");
        expect(r.outputs.reason, login).toContain("allowlist");
      }
    });

    it("fails CLOSED when the author cannot be verified", () => {
      const r = run({});
      expect(r.status).toBe(0);
      expect(r.outputs.run).toBe("false");
      expect(r.outputs.reason).toContain("verify its author");
    });
  });

  describe("validation", () => {
    it("rejects a value that is not a login (it is spliced into an if: expression)", () => {
      for (const bad of ["dpup' || true || '", "a b", "-lead", "trail-", ","]) {
        expect(codes(diags(lane(`authors="${bad}"`)), "error"), bad).toContain("node.bad-authors");
      }
      expect(codes(diags(lane('authors="dpup, my-app[bot]"')), "error")).toEqual([]);
    });

    it("a malformed allowlist compiles to nobody, never to everybody", () => {
      const w = workflow(lane(`authors="dpup' || true || '"`), "reviewer");
      expect(w.jobs.reviewer_guard.if).not.toContain("true");
      expect(w.jobs.reviewer_guard.if).toContain("user.login == 'no author matches");
    });

    it("rejects a malformed repo.authors", () => {
      const repo = { ...loadConfig(undefined).repo, authors: ["ok", "not a login"] };
      expect(codes(diags(lane(), { repo }), "error")).toContain("config.bad-authors");
    });

    it("refuses a node it cannot bind", () => {
      const onProducer = lane().replace('role="agents/roles/builder.md"', 'role="agents/roles/builder.md", authors="dpup"');
      expect(codes(diags(onProducer), "error")).toContain("node.authors-unsupported");
      const noCtx = lane('authors="dpup"').replace(', context="pr-diff"', "");
      expect(codes(diags(noCtx), "error")).toContain("node.authors-unsupported");
    });
  });
});

// ── opt_in_label= ────────────────────────────────────────────────────────────

describe("opt_in_label= widens an allowlist by a PR label", () => {
  const AUTHORS_IF = "github.event.pull_request.user.login == 'dpup'";
  const LABELS = { agent_review: "fletch:review" };
  const cfg = { labels: LABELS } as Partial<FoundryConfig>;
  const optInLane = () => lane('authors="dpup", opt_in_label="agent_review"');

  it("ORs the label into the job-level if:, and admits only that label's labeled event", () => {
    const cond = workflow(optInLane(), "reviewer", cfg).jobs.reviewer_guard.if;
    expect(cond).toContain(
      `(${AUTHORS_IF} || contains(github.event.pull_request.labels.*.name, 'fletch:review'))`,
    );
    expect(cond).toContain("(github.event.action != 'labeled' || github.event.label.name == 'fletch:review')");
    expect(cond).toContain("startsWith(github.event.pull_request.head.ref, 'agent/')");
    // The key resolves through config.labels; the key itself never reaches the workflow.
    expect(cond).not.toContain("agent_review");
  });

  it("listens for pull_request.labeled", () => {
    const w = workflow(optInLane(), "reviewer", cfg);
    expect(w.on.pull_request.types).toEqual(["opened", "synchronize", "labeled"]);
    // Without the attr, no labeled trigger.
    expect(workflow(lane('authors="dpup"'), "reviewer").on.pull_request.types).not.toContain("labeled");
  });

  it("uses an unmapped key literally, as skip label: does", () => {
    const w = workflow(optInLane(), "reviewer");
    expect(w.jobs.reviewer_guard.if).toContain("contains(github.event.pull_request.labels.*.name, 'agent_review')");
    expect(w.jobs.reviewer_guard.steps[0].env.OPT_IN_LABEL).toBe("agent_review");
  });

  it("works with skip=draft: both extra triggers, each passing the if:", () => {
    const w = workflow(lane('authors="dpup", opt_in_label="agent_review", skip="draft"'), "reviewer", cfg);
    expect(w.on.pull_request.types).toEqual(["opened", "synchronize", "ready_for_review", "labeled"]);
  });

  describe("concurrency: an unrelated label event must not cancel a review", () => {
    const PR_GROUP = "format('reviewer-{0}', github.event.pull_request.number)";
    const NOOP =
      "github.event.action == 'labeled' && github.event.label.name != 'fletch:review'" +
      " && format('reviewer-noop-{0}', github.run_id)";

    it("sends other labels to a per-run group, everything else to the PR's group", () => {
      const w = workflow(lane('authors="dpup", opt_in_label="agent_review", cancel_in_progress=true'), "reviewer", cfg);
      expect(w.concurrency).toEqual({
        group: `\${{ ${NOOP} || ${PR_GROUP} }}`,
        "cancel-in-progress": true,
      });
      // The resolved label reaches the expression; the key does not.
      expect(w.concurrency.group).toContain("'fletch:review'");
      expect(w.concurrency.group).not.toContain("agent_review");
    });

    it("does the same without cancel_in_progress: a skipped run would still replace a pending one", () => {
      const w = workflow(optInLane(), "reviewer", cfg);
      expect(w.concurrency.group).toContain(NOOP);
      expect(w.concurrency["cancel-in-progress"]).toBe(false);
    });

    it("leaves the group unchanged without opt_in_label", () => {
      const w = workflow(lane('authors="dpup", cancel_in_progress=true'), "reviewer", cfg);
      expect(w.concurrency).toEqual({
        group: "reviewer-${{ github.event.pull_request.number }}",
        "cancel-in-progress": true,
      });
    });

    it("quotes the label for the expression", () => {
      const w = workflow(optInLane(), "reviewer", { labels: { agent_review: "it's" } });
      expect(w.concurrency.group).toContain("github.event.label.name != 'it''s'");
    });
  });

  it("lets the labeled event through a lane that also has guarded edges", () => {
    const dot = `digraph t {
      start    [type=start]
      reviewer [type=pr-review, role="agents/roles/reviewer.md", context="pr-diff", authors="dpup", opt_in_label="agent_review"]
      fixer    [type=pr-fix, role="agents/roles/fixer.md"]
      start    -> reviewer [on="pull_request.opened"]
      fixer    -> reviewer [on="pull_request_review.submitted", when="verdict=request_changes"]
    }`;
    const cond = workflow(dot, "reviewer", cfg).jobs.reviewer_guard.if;
    // Without its own event clause, the verdict guard would swallow every labeled event.
    expect(cond).toContain("(github.event_name == 'pull_request' && github.event.action == 'labeled')");
    expect(cond).toContain("(github.event.action != 'labeled' || github.event.label.name == 'fletch:review')");
  });

  it("admits the opt-in label beside a label= edge instead of blocking it", () => {
    const dot = `digraph t {
      start    [type=start]
      reviewer [type=pr-review, role="agents/roles/reviewer.md", context="pr-diff", authors="dpup", opt_in_label="agent_review"]
      start    -> reviewer [on="pull_request.opened"]
      start    -> reviewer [when="label=rereview"]
    }`;
    const cond = workflow(dot, "reviewer", cfg).jobs.reviewer_guard.if;
    expect(cond).toContain("github.event.label.name == 'rereview'");
    expect(cond).toContain(
      "((github.event_name == 'pull_request' && github.event.action == 'labeled') && github.event.label.name == 'fletch:review')",
    );
    expect(cond).not.toContain("github.event.action != 'labeled'");
  });

  it("passes OPT_IN_LABEL to the guard, whose script tests it", () => {
    const step = workflow(optInLane(), "reviewer", cfg).jobs.reviewer_guard.steps[0];
    expect(step.env.AUTHORS).toBe("dpup");
    expect(step.env.OPT_IN_LABEL).toBe("fletch:review");
    expect(step.run).toContain("env.OPT_IN_LABEL");
    expect(step.run).not.toContain("fletch:review");
    expect(step.run).not.toContain("agent_review");
  });

  describe("the guard script, run against a stub gh", () => {
    const step = () => workflow(optInLane(), "reviewer", cfg).jobs.reviewer_guard.steps[0];
    const run = (fx: Record<string, unknown>) => runStepScript(step(), fx, { PR: "7" });
    const pr = (login: string, labels: string[] = []) => ({
      "repos/o/r/pulls/7": { user: { login }, head: { sha: "h" }, draft: false, labels: labels.map((name) => ({ name })) },
    });

    it("runs for an allowlisted author with no label", () => {
      expect(run(pr("dpup")).outputs.run).toBe("true");
    });

    it("runs for anyone else when the PR carries the opt-in label", () => {
      expect(run(pr("mallory", ["bug", "fletch:review"])).outputs.run).toBe("true");
    });

    it("skips anyone else without it — the key or another label does not count", () => {
      for (const labels of [[], ["agent_review"], ["fletch:review-later"]]) {
        const r = run(pr("mallory", labels));
        expect(r.outputs.run, labels.join()).toBe("false");
        expect(r.outputs.reason).toBe("the author mallory is not in the allowlist and no fletch:review label");
      }
    });

    it("still fails CLOSED when the PR cannot be read", () => {
      expect(run({}).outputs.run).toBe("false");
    });
  });

  it("filters the sweep's selection by author OR label", () => {
    const dot = `digraph t {
      approver [type=pr-review, role="agents/roles/a.md", context="pr-review", select="sweep", schedule="*/10 * * * *", authors="dpup", opt_in_label="agent_review"]
    }`;
    const step = workflow(dot, "approver", cfg).jobs.approver_select.steps[0];
    expect(step.env.OPT_IN_LABEL).toBe("fletch:review");
    expect(step.run).toContain("(.labels // []) | any(.name == env.OPT_IN_LABEL)");
    const pr = (number: number, login: string, labels: string[] = []) => ({
      number,
      draft: false,
      user: { login },
      labels: labels.map((name) => ({ name })),
      head: { ref: `agent/${number}`, sha: `sha${number}` },
      requested_reviewers: [],
      requested_teams: [],
      updated_at: "2020-01-01T00:00:00Z",
      base: { ref: "main" },
    });
    const fx: Record<string, unknown> = {
      "repos/o/r/pulls?state=open&sort=created&direction=asc&per_page=100": [
        pr(1, "someone-else"),
        pr(2, "dpup"),
        pr(3, "someone-else", ["fletch:review"]),
        pr(4, "someone-else", ["agent_review"]),
      ],
    };
    for (const n of [1, 2, 3, 4]) {
      fx[`repos/o/r/commits/sha${n}/check-runs?per_page=100&filter=all`] = { check_runs: [] };
      fx[`repos/o/r/commits/sha${n}/status`] = { total_count: 0 };
      fx[`repos/o/r/pulls/${n}/reviews?per_page=100`] = [];
    }
    const r = runStepScript(step, fx);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.outputs.prs!).map((p: { number: number }) => p.number)).toEqual([2, 3]);
  });

  it("binds the fixer's if: too (no labeled trigger — a label does not start a fix)", () => {
    const dot = `digraph t {
      start    [type=start]
      builder  [type=producer, role="agents/roles/builder.md"]
      reviewer [type=pr-review, role="agents/roles/reviewer.md", context="pr-diff", authors="dpup"]
      fixer    [type=pr-fix, role="agents/roles/fixer.md", authors="dpup", opt_in_label="agent_review"]
      human    [type=exit]
      start    -> builder  [on="issues.opened"]
      builder  -> reviewer [on="pull_request.opened"]
      reviewer -> fixer    [when="verdict=request_changes"]
      fixer    -> reviewer [on="push"]
      fixer    -> human    [when="attempts>=3"]
    }`;
    const w = workflow(dot, "fixer", cfg);
    expect(w.jobs.fixer.if).toContain("contains(github.event.pull_request.labels.*.name, 'fletch:review')");
    expect(w.on.pull_request).toBeUndefined();
  });

  describe("validation", () => {
    it("errors without an allowlist to widen", () => {
      const ds = diags(lane('opt_in_label="agent_review"'), cfg);
      expect(codes(ds, "error")).toContain("node.opt-in-without-authors");
      expect(ds.find((d) => d.code === "node.opt-in-without-authors")!.hint).toBe(
        "opt_in_label= widens an allowlist; set authors= or repo.authors, or drop the label to run for everyone",
      );
      // …and compiles to no change at all.
      expect(workflow(lane('opt_in_label="agent_review"'), "reviewer", cfg).on.pull_request.types).not.toContain("labeled");
    });

    it("accepts it with authors= or with repo.authors", () => {
      expect(codes(diags(optInLane(), cfg), "error")).toEqual([]);
      const repo = { ...loadConfig(undefined).repo, authors: ["dpup"] };
      expect(codes(diags(lane('opt_in_label="agent_review"'), { ...cfg, repo }), "error")).toEqual([]);
    });

    it("rejects an empty value and nodes that take no allowlist", () => {
      expect(codes(diags(lane('authors="dpup", opt_in_label=""'), cfg), "error")).toContain("node.bad-opt-in-label");
      const dot = `digraph t {
        start   [type=start]
        builder [type=producer, role="agents/roles/builder.md", opt_in_label="agent_review"]
        start   -> builder [on="issues.opened"]
      }`;
      expect(codes(diags(dot, cfg), "error")).toContain("node.opt-in-label-unsupported");
    });
  });
});

// ── unknown attributes ───────────────────────────────────────────────────────

describe("unknown attributes are errors, not silent no-ops", () => {
  it("rejects an attribute the compiler does not know", () => {
    const d = diags(lane('reviewers="dpup"')).find((x) => x.code === "attr.unknown");
    expect(d?.level).toBe("error");
    expect(d?.message).toContain("'reviewers='");
    expect(d?.where?.node).toBe("reviewer");
  });

  it("suggests the attribute a typo was reaching for", () => {
    const hint = (attr: string) => diags(lane(attr)).find((x) => x.code === "attr.unknown")?.hint;
    expect(hint('author="dpup"')).toContain("'authors='");
    expect(hint("max_attempt=3")).toContain("'max_attempts='");
    expect(hint('cancel_in_progres=true')).toContain("'cancel_in_progress='");
  });

  it("rejects unknown edge attributes too", () => {
    const dot = lane().replace('[on="issues.opened"]', '[on="issues.opened", if="label=x"]');
    const d = diags(dot).find((x) => x.code === "attr.unknown");
    expect(d?.where?.edge).toEqual(["start", "builder"]);
  });

  it("accepts every attribute the shipped templates and reference use", () => {
    for (const rel of ["../skill/templates/harness.dot", "../examples/starter/.github/harness.dot", "./fixtures/dixie/harness.dot"]) {
      const dot = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
      expect(codes(diags(dot)).filter((c) => c === "attr.unknown"), rel).toEqual([]);
    }
    const all = `digraph t {
      a [type=analyst, role="r.md", prompt="p.md", tools="t", context=issue, name="A", output=comment, timeout=20,
         agent_attempts=1, secrets="X", permissions="id-token: write", cancel_in_progress=false, checkout=partial]
      b [type=pr-review, role="r.md", context="pr-diff", gates="ci.yml", skip="draft", authors="dpup"]
      c [type=pr-review, role="r.md", context="pr-diff", select="sweep", schedule="0 * * * *"]
      d [type=pr-fix, role="r.md", max_attempts=3]
      e [type=scheduled-agent, role="r.md", schedule="0 8 * * *", commit=pr, paths="memory/"]
      f [type=merge-gate, policy="p.yaml", schedule="*/30 * * * *"]
      g [type=human-gate, environment=production]
      h [type=fan_in, role="r.md", on_complete_label=done]
      a -> b [on="pull_request.opened", when="label=x", do="dispatch"]
    }`;
    expect(codes(diags(all)).filter((c) => c === "attr.unknown")).toEqual([]);
  });
});

// ── immutable guard / stale generated workflows ──────────────────────────────

describe("immutable-paths guard is only generated where a lane writes code", () => {
  const paths = (dot: string) => compile(mkHarness(dot)).files.map((f) => f.path);
  const GUARD = ".github/workflows/immutable-guard.yml";
  const reviewOnly = (extra = "") => `digraph t {
    start    [type=start]
    reviewer [type=pr-review, role="agents/roles/reviewer.md", context="pr-diff"]
    ${extra}
    start    -> reviewer [on="pull_request.opened"]
  }`;

  it("is omitted from a review-only harness", () => {
    expect(paths(reviewOnly())).not.toContain(GUARD);
    // A read-only scheduled lane and a merge gate write no code either.
    expect(paths(reviewOnly('herald [type=scheduled-agent, role="r.md", schedule="0 8 * * *", commit=none]'))).not.toContain(GUARD);
    expect(paths(reviewOnly('gate [type=merge-gate, policy="p.yaml", schedule="*/30 * * * *"]'))).not.toContain(GUARD);
  });

  it("is kept as soon as any lane can commit", () => {
    expect(paths(lane())).toContain(GUARD); // producer
    expect(paths(reviewOnly('fixer [type=pr-fix, role="r.md"]'))).toContain(GUARD);
    expect(paths(reviewOnly('scribe [type=scheduled-agent, role="r.md", schedule="0 8 * * *"]'))).toContain(GUARD);
    expect(paths(reviewOnly('scribe [type=scheduled-agent, role="r.md", schedule="0 8 * * *", commit=pr]'))).toContain(GUARD);
  });

  it("a guard left on disk by an earlier build is reported as stale — hand-written workflows never are", () => {
    const root = mkdtempSync(join(tmpdir(), "gpf-stale-"));
    const wfDir = join(root, ".github", "workflows");
    mkdirSync(wfDir, { recursive: true });
    const before = compile(mkHarness(lane())).files;
    for (const f of before.filter((x) => x.path.startsWith(".github/workflows/"))) {
      writeFileSync(join(root, f.path), f.contents);
    }
    writeFileSync(join(wfDir, "ci.yml"), "name: CI\non: push\n");
    expect(staleGeneratedWorkflows(root, before)).toEqual([]);

    const after = compile(mkHarness(reviewOnly())).files;
    expect(staleGeneratedWorkflows(root, after)).toEqual([".github/workflows/builder.yml", GUARD]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 0.2.12
// ═════════════════════════════════════════════════════════════════════════════

const stepNamed = (job: any, name: string) => job.steps.find((s: any) => s.name === name);
const APP = { auth: { mode: "app", app_id_secret: "APP_ID", app_key_secret: "APP_KEY" } } as Partial<FoundryConfig>;

const FULL = `digraph t {
  start    [type=start]
  scout    [type=issue-agent, role="agents/roles/scout.md"]
  builder  [type=producer, role="agents/roles/builder.md"]
  reviewer [type=pr-review, role="agents/roles/reviewer.md", context="pr-diff"]
  fixer    [type=pr-fix, role="agents/roles/fixer.md"]
  janitor  [type=scheduled-agent, role="agents/roles/janitor.md", schedule="0 8 * * *"]
  gate     [type=merge-gate, policy="agents/policy/merge.yaml", schedule="*/30 * * * *"]
  human    [type=exit]
  start    -> scout    [on="issues.opened"]
  scout    -> builder  [when="label=build"]
  builder  -> reviewer [on="pull_request.opened"]
  reviewer -> fixer    [when="verdict=request_changes"]
  fixer    -> reviewer [on="push"]
  fixer    -> human    [when="attempts>=3"]
}`;

describe("harness files come from the base ref, not the PR head", () => {
  const job = (dot = lane(), cfg: Partial<FoundryConfig> = {}, file = "reviewer") =>
    workflow(dot, file, cfg, ".github").jobs[file];

  it("checks the base ref's harness directories out beside the PR head", () => {
    const j = job();
    const names = j.steps.map((s: any) => s.name);
    // After the PR-head checkout, before anything that reads a harness file.
    expect(names.indexOf("Checkout")).toBeLessThan(names.indexOf("Checkout harness files (base ref)"));
    expect(names.indexOf("Checkout harness files (base ref)")).toBeLessThan(names.indexOf("Setup agent toolchain"));
    const h = stepNamed(j, "Checkout harness files (base ref)").with;
    expect(h.ref).toBe("${{ github.event.pull_request.base.ref }}");
    expect(h.path).toBe(".gp-foundry/harness");
    expect(h["fetch-depth"]).toBe(1);
    expect(h["sparse-checkout"].split("\n").sort()).toEqual([".github/agent-setup", ".github/agents"]);
    expect(h["persist-credentials"]).toBe(false);
    // The PR head is still what the agent works in.
    expect(stepNamed(j, "Checkout").with.ref).toBe("${{ github.event.pull_request.head.sha }}");
  });

  it("points the role, scope, comms and the setup composite at the base-ref copy", () => {
    const j = job();
    const agent = stepNamed(j, "Run agent").with;
    expect(agent["role-file"]).toBe(".gp-foundry/harness/.github/agents/roles/reviewer.md");
    expect(agent["scope-path"]).toBe(".gp-foundry/harness/.github/agents/scope.yaml");
    expect(agent["comms-file"]).toBe(".gp-foundry/harness/.github/agents/communication.md");
    expect(stepNamed(j, "Setup agent toolchain").uses).toBe("./.gp-foundry/harness/.github/agent-setup");
  });

  it("covers a prompt override and a role kept outside agents/", () => {
    const dot = lane('prompt="prompts/review.md"').replace('role="agents/roles/reviewer.md"', 'role="roles/reviewer.md"');
    const j = job(dot);
    expect(stepNamed(j, "Run agent").with["prompt-override-file"]).toBe(".gp-foundry/harness/.github/prompts/review.md");
    expect(stepNamed(j, "Checkout harness files (base ref)").with["sparse-checkout"].split("\n").sort()).toEqual([
      ".github/agent-setup",
      ".github/agents",
      ".github/prompts",
      ".github/roles",
    ]);
  });

  it("keeps the copy out of what a lane can commit", () => {
    const exclude = stepNamed(job(), "Keep the harness copy out of the working tree");
    expect(exclude.run).toContain('echo "/.gp-foundry/" >> .git/info/exclude');
    // The fixer runs `git add -A`; the exclude step must come before it.
    const fixer = workflow(FULL, "fixer", {}, ".github").jobs.fixer;
    const names = fixer.steps.map((s: any) => s.name);
    expect(names.indexOf("Keep the harness copy out of the working tree")).toBeGreaterThan(-1);
    expect(names.indexOf("Keep the harness copy out of the working tree")).toBeLessThan(names.indexOf("Commit and push fixes"));
    expect(stepNamed(fixer, "Run agent").with["role-file"]).toBe(".gp-foundry/harness/.github/agents/roles/fixer.md");
  });

  it("takes the vendored runtime actions from the base ref too", () => {
    const j = job(lane('gates="ci.yml"'), { runtime: { mode: "vendored" } });
    expect(stepNamed(j, "Checkout harness files (base ref)").with["sparse-checkout"].split("\n")).toContain(".github/actions");
    for (const s of j.steps.filter((x: any) => /wait-for-checks|agent-context|run-agent/.test(x.uses ?? ""))) {
      expect(s.uses).toMatch(/^\.\/\.gp-foundry\/harness\/\.github\/actions\//);
    }
    // Pinned mode references the release, which a PR cannot edit.
    expect(stepNamed(job(), "Run agent").uses).toBe("thegpvc/gp-foundry/actions/run-agent@v1");
  });

  it("a sweep takes the base ref from the selected PR", () => {
    const dot = `digraph t {
      approver [type=pr-review, role="agents/roles/a.md", context="pr-review", select="sweep", schedule="*/10 * * * *"]
    }`;
    const j = workflow(dot, "approver", {}, ".github").jobs.approver;
    expect(stepNamed(j, "Checkout harness files (base ref)").with.ref).toBe("${{ matrix.pr.base }}");
  });

  it('harness_ref="head" opts out — with a warning', () => {
    const dot = lane('harness_ref="head"');
    const j = job(dot);
    expect(stepNamed(j, "Checkout harness files (base ref)")).toBeUndefined();
    expect(stepNamed(j, "Run agent").with["role-file"]).toBe(".github/agents/roles/reviewer.md");
    expect(stepNamed(j, "Setup agent toolchain").uses).toBe("./.github/agent-setup");
    expect(codes(diags(dot), "warning")).toContain("node.harness-from-head");
    expect(codes(diags(lane('harness_ref="main"')), "error")).toContain("node.bad-harness-ref");
  });

  it("leaves issue lanes and code producers on the single checkout", () => {
    for (const id of ["scout", "builder", "janitor"]) {
      const j = workflow(FULL, id, {}, ".github").jobs[id];
      expect(stepNamed(j, "Checkout harness files (base ref)"), id).toBeUndefined();
      expect(stepNamed(j, "Setup agent toolchain").uses, id).toBe("./.github/agent-setup");
    }
    const onProducer = lane().replace('role="agents/roles/builder.md"', 'role="agents/roles/builder.md", harness_ref="base"');
    expect(codes(diags(onProducer), "error")).toContain("node.harness-ref-unsupported");
  });
});

describe("credentials scoped to what the lane can use", () => {
  const mint = (id: string) => workflow(FULL, id, APP).jobs[id].steps.find((s: any) => s.id === "app-token").with;
  const perms = (w: Record<string, string>) =>
    Object.fromEntries(Object.entries(w).filter(([k]) => k.startsWith("permission-")));

  it("narrows the App token by node type", () => {
    expect(perms(mint("reviewer"))).toEqual({
      "permission-contents": "read",
      "permission-pull-requests": "write",
      "permission-checks": "read",
    });
    expect(perms(mint("fixer"))).toEqual({
      "permission-contents": "write",
      "permission-pull-requests": "write",
      "permission-checks": "read",
    });
    expect(perms(mint("builder"))).toEqual({
      "permission-contents": "write",
      "permission-pull-requests": "write",
      "permission-issues": "write",
    });
    expect(perms(mint("scout"))).toEqual({ "permission-contents": "read", "permission-issues": "write" });
  });

  it("leaves the open-ended lanes on the App's own permissions", () => {
    expect(perms(mint("janitor"))).toEqual({});
    expect(perms(mint("gate"))).toEqual({});
  });

  it("adds what permissions= asks for, but never a GITHUB_TOKEN-only scope", () => {
    const dot = lane('permissions="issues: write, id-token: write, checks: none"');
    const w = workflow(dot, "reviewer", APP).jobs.reviewer.steps.find((s: any) => s.id === "app-token").with;
    expect(w["permission-issues"]).toBe("write");
    expect(w["permission-id-token"]).toBeUndefined();
    expect(w["permission-checks"]).toBeUndefined(); // `none` withdraws it
  });

  describe("github-token on run-agent", () => {
    const withTools = (tools: string | undefined, cfg: Partial<FoundryConfig> = {}) => {
      const readFile = () => (tools === undefined ? undefined : `---\nrole: Reviewer\ntools: "${tools}"\n---\nbody\n`);
      const { files } = compile(mkHarness(lane(), cfg), { readFile });
      const wf: any = yaml.load(files.find((f) => f.path.endsWith("/reviewer.yml"))!.contents);
      return stepNamed(wf.jobs.reviewer, "Run agent").with;
    };

    it("is withheld from a role whose tools cannot run gh", () => {
      expect(withTools("Read,Glob,Grep")["github-token"]).toBeUndefined();
      expect(withTools("Read,Bash(git log:*),Bash(git diff:*)")["github-token"]).toBeUndefined();
      // "gh" as a substring of something else is not gh.
      expect(withTools("Read,Bash(right:*),Bash(sigh:*)")["github-token"]).toBeUndefined();
    });

    it("is passed when the role can run gh, or anything at all", () => {
      const pat = { auth: { mode: "pat", token_secret: "AGENT_PAT" } } as Partial<FoundryConfig>;
      expect(withTools("Read,Bash(gh pr view:*)", pat)["github-token"]).toBe("${{ secrets.AGENT_PAT }}");
      expect(withTools("Read,Bash(gh:*)", pat)["github-token"]).toBe("${{ secrets.AGENT_PAT }}");
      expect(withTools("Read,Bash", pat)["github-token"]).toBe("${{ secrets.AGENT_PAT }}");
    });

    it("is passed when the compiler could not read the role (never withheld on a guess)", () => {
      expect(withTools(undefined)["github-token"]).toBeDefined();
      expect(stepNamed(workflow(lane(), "reviewer").jobs.reviewer, "Run agent").with["github-token"]).toBeDefined();
    });
  });

  describe("checkout credentials", () => {
    const checkout = (dot: string, id = "reviewer") => stepNamed(workflow(dot, id).jobs[id], "Checkout").with;

    it("are not persisted on a read-and-advise lane", () => {
      expect(checkout(lane())["persist-credentials"]).toBe(false);
      expect(checkout(lane())["fetch-depth"]).toBe(0); // a full clone: nothing left to fetch
      expect(checkout(FULL, "scout")["persist-credentials"]).toBe(false);
    });

    it("are kept on every lane that pushes", () => {
      for (const id of ["builder", "fixer", "janitor"]) {
        expect(checkout(FULL, id)["persist-credentials"], id).toBeUndefined();
      }
    });

    it('are kept for checkout="partial", whose lazy blob fetches need them', () => {
      expect(checkout(lane('checkout="partial"'))["persist-credentials"]).toBeUndefined();
      const clash = lane('checkout="partial", persist_credentials=false');
      expect(codes(diags(clash), "error")).toContain("node.partial-needs-credentials");
      expect(checkout(lane("persist_credentials=true"))["persist-credentials"]).toBeUndefined();
    });

    it("the attribute is refused on a lane that must push", () => {
      const dot = lane().replace('role="agents/roles/builder.md"', 'role="agents/roles/builder.md", persist_credentials=false');
      expect(codes(diags(dot), "error")).toContain("node.persist-credentials-unsupported");
    });
  });
});

describe("display names", () => {
  it('title= names the workflow, so the check reads "Fletch / reviewer"', () => {
    const w = workflow(lane('title="Fletch", skip="draft"'), "reviewer");
    expect(w.name).toBe("Fletch");
    expect(Object.keys(w.jobs)).toEqual(["reviewer_guard", "reviewer"]);
    expect(w.jobs.reviewer_guard.name).toBe("reviewer guard");
    expect(w.jobs.reviewer.name).toBeUndefined(); // the job key is already the node id
  });

  it("names the sweep's helper jobs the same way", () => {
    const dot = `digraph t {
      approver [type=pr-review, role="agents/roles/a.md", context="pr-review", select="sweep", schedule="*/10 * * * *", title="Fletch"]
    }`;
    const w = workflow(dot, "approver");
    expect(w.name).toBe("Fletch");
    expect(w.jobs.approver_select.name).toBe("approver select");
    expect(w.jobs.approver_mark.name).toBe("approver mark");
  });

  it("defaults to the node id, and still honours the older name=", () => {
    expect(workflow(lane(), "reviewer").name).toBe("reviewer");
    expect(workflow(lane('name="Critic"'), "reviewer").name).toBe("Critic");
  });

  it("rejects an expression in a title", () => {
    expect(codes(diags(lane('title="${{ secrets.X }}"')), "error")).toContain("node.bad-title");
  });
});

describe("agent-context wiring", () => {
  it("a reviewer reads its own past review as a baseline; the fixer as its work item", () => {
    const ctxOf = (id: string) => stepNamed(workflow(FULL, id).jobs[id], "Fetch context").with;
    expect(ctxOf("reviewer")["trusted-framing"]).toBe("baseline");
    expect(ctxOf("fixer")["trusted-framing"]).toBeUndefined(); // the action's default: work-item
    expect(ctxOf("fixer")["trusted-authors"]).toBe(BOT);
  });

  it("PR lanes pass GITHUB_TOKEN for check-run conclusions and declare checks: read", () => {
    for (const id of ["reviewer", "fixer"]) {
      const job = workflow(FULL, id).jobs[id];
      expect(stepNamed(job, "Fetch context").with["checks-token"], id).toBe("${{ github.token }}");
      expect(job.permissions.checks, id).toBe("read");
    }
    const scout = workflow(FULL, "scout").jobs.scout;
    expect(stepNamed(scout, "Fetch context").with["checks-token"]).toBeUndefined();
    expect(scout.permissions.checks).toBeUndefined();
  });
});

describe("gate text: blocking vs informational", () => {
  const block = (gates: string) =>
    stepNamed(workflow(lane(`gates="${gates}"`), "reviewer").jobs.reviewer, "Record CI gate results in the context").run;

  it("parses ?info alone or with a grace", () => {
    const node = (gates: string): HarnessNode => ({ id: "n", type: "pr-review", attrs: { gates }, files: {}, raw: {} });
    expect(parseGates(node("bugbot?info, cursor?info?30, e2e?45?info, ci.yml"))).toEqual([
      { name: "bugbot", kind: "check", info: true },
      { name: "cursor", kind: "check", info: true, graceSeconds: 30 },
      { name: "e2e", kind: "check", graceSeconds: 45, info: true },
      { name: "ci.yml", kind: "workflow" },
    ]);
    expect(() => parseGates(node("x?90?120"))).toThrow();
    expect(() => parseGates(node("x?informational"))).toThrow();
  });

  it("says a non-success blocks only for the blocking gates", () => {
    expect(block("ci.yml, bugbot?info")).toBe(
      [
        "{",
        '  echo ""',
        '  echo "=== CI GATES ==="',
        '  echo "$GATE_1_NAME: $GATE_1_RESULT"',
        '  echo ""',
        "  echo \"A gate whose result is not 'success' is a blocking finding: say which one\"",
        "  echo \"failed and request changes. 'timeout' or 'skipped' means CI never gave an\"",
        '  echo "answer — treat it as unverified, not as a pass."',
        '  echo ""',
        '  echo "Informational checks (advisory — never blocking on their own):"',
        '  echo "$GATE_2_NAME: $GATE_2_RESULT"',
        '  echo ""',
        "  echo \"'skipped', 'neutral' or 'timeout' here means the check did not run or had\"",
        '  echo "nothing to report on this head — that is normal and is not a finding. A"',
        "  echo \"'failure' is input to weigh alongside your own review, not a verdict.\"",
        '} >> "$CONTEXT_FILE"',
      ].join("\n"),
    );
  });

  it("drops the blocking paragraph when every gate is informational", () => {
    const text = block("bugbot?info");
    expect(text).not.toContain("blocking finding");
    expect(text).toContain("Informational checks");
  });
});

describe("sweep: settle window and bounded retries", () => {
  const SWEEP = `digraph t {
    approver [type=pr-review, role="agents/roles/a.md", context="pr-review", select="sweep", schedule="*/10 * * * *"]
  }`;
  const wf = () => workflow(SWEEP, "approver");
  const LIST = "repos/o/r/pulls?state=open&sort=created&direction=asc&per_page=100";
  const open = (number: number, updated: string) => ({
    number,
    draft: false,
    head: { ref: `agent/${number}`, sha: `sha${number}` },
    base: { ref: "main" },
    requested_reviewers: [],
    requested_teams: [],
    updated_at: updated,
  });
  const head = (n: number, checks: unknown[]) => ({
    [`repos/o/r/commits/sha${n}/check-runs?per_page=100&filter=all`]: { check_runs: checks },
    [`repos/o/r/commits/sha${n}/status`]: { total_count: 0 },
    [`repos/o/r/pulls/${n}/reviews?per_page=100`]: [],
  });
  const select = (fx: Record<string, unknown>) => {
    const r = runStepScript(wf().jobs.approver_select.steps[0], fx);
    return { ...r, numbers: (JSON.parse(r.outputs.prs ?? "[]") as any[]).map((p) => p.number) };
  };
  const failed = (app = "github-actions") => ({
    status: "completed",
    name: "gp-foundry/sweep-failed (approver)",
    app: { slug: app },
  });
  const ci = { status: "completed", name: "ci", app: { slug: "github-actions" } };
  const justNow = new Date(Date.now() - 30_000).toISOString().replace(/\.\d+Z$/, "Z");
  const longAgo = "2020-01-01T00:00:00Z";

  it("does not select a fresh head that has no check-run yet", () => {
    const r = select({
      [LIST]: [open(1, justNow), open(2, justNow), open(3, longAgo)],
      ...head(1, []), // pushed seconds ago, CI has not registered: wait
      ...head(2, [ci]), // same age, but a check exists and has concluded: go
      ...head(3, []), // no CI at all, and quiet for the settle window: go
    });
    expect(r.status).toBe(0);
    expect(r.numbers).toEqual([2, 3]);
    expect(r.stdout).toContain("#1: no check-run on sha1 yet");
  });

  it("stops selecting a head after three failed runs", () => {
    const r = select({
      [LIST]: [open(1, longAgo), open(2, longAgo), open(3, longAgo)],
      ...head(1, [ci, failed(), failed()]), // two failures: one retry left
      ...head(2, [ci, failed(), failed(), failed()]), // spent
      // Only GITHUB_TOKEN's records count: the harness token cannot run the budget down.
      ...head(3, [ci, failed("my-agent-app"), failed("my-agent-app"), failed("my-agent-app")]),
    });
    expect(r.numbers).toEqual([1, 3]);
    expect(r.stdout).toContain("#2: gave up on sha2 after 3 failed runs");
  });

  describe("the mark job records failed runs", () => {
    const JOBS = "repos/o/r/actions/runs/99/attempts/1/jobs?per_page=100";
    const env = { RUN_ID: "99", RUN_ATTEMPT: "1", PRS: JSON.stringify([{ number: 1, sha: "sha1", base: "main" }]) };
    const run = (conclusion: string | null, prior: unknown[]) =>
      runStepScript(
        wf().jobs.approver_mark.steps[0],
        {
          [JOBS]: { jobs: [{ name: "approver #1", conclusion }] },
          "repos/o/r/commits/sha1/check-runs?per_page=100&filter=all": { check_runs: prior },
          // GitHub's default view keeps only the newest run per name: a script that
          // drops filter=all reads this and never counts past one.
          "repos/o/r/commits/sha1/check-runs?per_page=100": { check_runs: prior.slice(-1) },
          "repos/o/r/pulls/1/reviews?per_page=100": [{ user: { login: BOT }, commit_id: "sha1", body: "**Verdict:** APPROVE" }],
        },
        env,
      );

    it("publishes one neutral sweep-failed check per failed run", () => {
      const r = run("failure", []);
      expect(r.status).toBe(0);
      expect(r.writes).toContain("name=gp-foundry/sweep-failed (approver)");
      expect(r.writes).toContain("conclusion=neutral");
      expect(r.writes).toContain("output[title]=approver run 1 of 3 failed");
      expect(r.writes).not.toContain("gp-foundry/swept");
    });

    it("lists every prior failed run (filter=all) when counting", () => {
      expect(wf().jobs.approver_mark.steps[0].run).toContain('commits/$SHA/check-runs?per_page=100&filter=all"');
    });

    it("says so when the last retry is spent", () => {
      const r = run("timed_out", [failed(), failed()]);
      expect(r.writes).toContain("output[title]=approver gave up after 3 failed runs");
    });

    it("does not count a cancelled or skipped lane against the head", () => {
      for (const c of ["cancelled", "skipped", null]) {
        const r = run(c, []);
        expect(r.status, String(c)).toBe(0);
        expect(r.writes, String(c)).toBe("");
      }
    });

    it("still marks a success as swept", () => {
      const r = run("success", [failed()]);
      expect(r.writes).toContain("name=gp-foundry/swept (approver)");
      expect(r.writes).not.toContain("sweep-failed");
    });
  });
});

describe("repo_guides=false", () => {
  it("compiles to run-agent's repo-guides input", () => {
    const agent = (attrs: string) => stepNamed(workflow(lane(attrs), "reviewer").jobs.reviewer, "Run agent").with;
    expect(agent("repo_guides=false")["repo-guides"]).toBe("false");
    expect(agent("")["repo-guides"]).toBeUndefined();
    expect(agent("repo_guides=true")["repo-guides"]).toBeUndefined();
    expect(codes(diags(lane('repo_guides="no"')), "error")).toContain("node.bad-repo-guides");
  });
});

describe("HARNESS.md lists the triggers each workflow was compiled with", () => {
  const harnessMd = (dot: string) => compile(mkHarness(dot)).files.find((f) => f.path.endsWith("HARNESS.md"))!.contents;

  it("includes the ready_for_review that skip=draft adds", () => {
    const md = harnessMd(lane('skip="draft"'));
    expect(md).toContain("## Triggers");
    expect(md).toContain("| `reviewer` | pull_request: opened, synchronize, ready_for_review |");
    expect(harnessMd(lane())).toContain("| `reviewer` | pull_request: opened, synchronize |");
  });

  it("shows schedules and the manual dispatch they come with", () => {
    expect(harnessMd(FULL)).toContain("| `gate` | schedule: `*/30 * * * *` · workflow_dispatch |");
  });
});

describe("run-agent: output handling", () => {
  const action: any = yaml.load(readFileSync(fileURLToPath(new URL("../actions/run-agent/action.yml", import.meta.url)), "utf8"));
  const script: string = action.runs.steps.find((s: any) => s.name === "Run agent").run;

  /** Run the step with a stub `claude` (a bash script body) and capture stdout + the job summary. */
  function run(claudeBody: string, env: Record<string, string> = {}) {
    const dir = mkdtempSync(join(tmpdir(), "gpf-run-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "claude"), `#!/usr/bin/env bash\ncat > /dev/null\n${claudeBody}\n`);
    chmodSync(join(bin, "claude"), 0o755);
    writeFileSync(join(dir, "prompt"), "hi");
    const summary = join(dir, "summary.md");
    writeFileSync(summary, "");
    let status = 0;
    let stdout = "";
    try {
      stdout = execFileSync("bash", ["-e", "-o", "pipefail", "-c", script], {
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          CLAUDE_CODE_OAUTH_TOKEN: "tok",
          PROMPT_FILE: join(dir, "prompt"),
          ROLE_FILE: "",
          MODEL: "m",
          ALLOWED_TOOLS: "Read",
          EXTRA_ARGS: "",
          EXTRA_ENV: "",
          MAX_ATTEMPTS: "1",
          RETRY_BASE_DELAY_SECONDS: "0",
          GITHUB_STEP_SUMMARY: summary,
          GITHUB_WORKSPACE: "/work/repo",
          ARGS_FILE: join(dir, "args"),
          ...env,
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e: any) {
      status = e.status ?? 1;
      stdout = (e.stdout ?? "") + (e.stderr ?? "");
    }
    const argsFile = join(dir, "args");
    return {
      status,
      stdout,
      summary: readFileSync(summary, "utf8"),
      args: existsSync(argsFile) ? readFileSync(argsFile, "utf8").split("\n").filter(Boolean) : [],
    };
  }

  describe("job summary", () => {
    it("writes the agent's output under the heading", () => {
      const r = run(`echo "KNOWN-OUTPUT-4711"`, { STEP_SUMMARY: "true", STEP_SUMMARY_HEADING: "Fletch review" });
      expect(r.status).toBe(0);
      expect(r.summary).toContain("### Fletch review");
      expect(r.summary).toContain("KNOWN-OUTPUT-4711");
      expect(r.summary).not.toContain("truncated");
    });

    it("truncates at the cap and points at the log", () => {
      const r = run(`head -c 950000 /dev/zero | tr '\\0' 'x'; echo; echo TAIL-MARKER`, { STEP_SUMMARY: "true" });
      expect(r.status).toBe(0);
      expect(r.summary).toContain("Output truncated at 900000 bytes");
      expect(r.summary).not.toContain("TAIL-MARKER");
      expect(Buffer.byteLength(r.summary)).toBeLessThan(1_000_000); // under GitHub's 1 MiB cap
      expect(r.stdout).toContain("TAIL-MARKER"); // the log keeps all of it
    });

    it("can be switched off, and still records a failed agent's output", () => {
      expect(run(`echo quiet`, { STEP_SUMMARY: "false" }).summary).toBe("");
      const failed = run(`echo "partial findings"; exit 3`, { STEP_SUMMARY: "true" });
      expect(failed.status).toBe(3);
      expect(failed.summary).toContain("partial findings");
    });
  });

  describe("workflow commands in agent output", () => {
    it("suspends command processing around everything the agent prints", () => {
      const r = run(`echo "::error::x"; echo "::add-mask::y" >&2`);
      const lines = r.stdout.split("\n");
      const stops = lines.flatMap((l, i) => (/^::stop-commands::gpf-[0-9a-f]{32}$/.test(l) ? [i] : []));
      expect(stops).toHaveLength(2); // one window for stdout, one for stderr
      for (const [n, payload] of [[0, "::error::x"], [1, "::add-mask::y"]] as const) {
        const token = lines[stops[n]!]!.slice("::stop-commands::".length);
        const resume = lines.indexOf(`::${token}::`);
        const at = lines.indexOf(payload);
        expect(at, payload).toBeGreaterThan(stops[n]!);
        expect(at, payload).toBeLessThan(resume);
      }
      // A fresh, unguessable token per window; our own annotations sit outside them.
      expect(new Set(stops.map((i) => lines[i])).size).toBe(2);
      const warn = lines.indexOf("::warning::Claude produced stderr output:");
      expect(warn).toBeGreaterThan(lines.indexOf(`::${lines[stops[0]!]!.slice("::stop-commands::".length)}::`));
      expect(warn).toBeLessThan(stops[1]!);
    });

    it("resumes on its own line even when the output has no trailing newline", () => {
      const r = run(`printf 'no newline'`);
      expect(r.stdout).toMatch(/no newline\n\n?::gpf-[0-9a-f]{32}::/);
    });

    it("never exposes the token to the agent", () => {
      const r = run(`env | grep -cE 'gpf-[0-9a-f]{32}' || true`);
      expect(r.stdout).toMatch(/\n0\n/);
    });
  });

  describe("repo-guides", () => {
    const record = `printf '%s\\n' "$@" > "$ARGS_FILE"`;

    it("false excludes the repo's CLAUDE.md / AGENTS.md via one intact --settings argument", () => {
      const r = run(record, { REPO_GUIDES: "false" });
      expect(r.status).toBe(0);
      const i = r.args.indexOf("--settings");
      expect(i).toBeGreaterThan(-1);
      expect(JSON.parse(r.args[i + 1]!)).toEqual({
        claudeMdExcludes: [
          "/work/repo/CLAUDE.md",
          "/work/repo/AGENTS.md",
          "/work/repo/**/CLAUDE.md",
          "/work/repo/**/AGENTS.md",
        ],
      });
    });

    it("default leaves the CLI alone", () => {
      expect(run(record).args).not.toContain("--settings");
      expect(run(record, { REPO_GUIDES: "true" }).args).not.toContain("--settings");
    });
  });

  describe("no github-token", () => {
    it("removes the empty variables from the agent's environment", () => {
      const r = run(`echo "gh=\${GH_TOKEN-UNSET} github=\${GITHUB_TOKEN-UNSET}"`, { GH_TOKEN: "", GITHUB_TOKEN: "" });
      expect(r.stdout).toContain("gh=UNSET github=UNSET");
      expect(r.stdout).not.toContain("unauthenticated");
    });

    it("warns when the role has gh but was compiled without a token", () => {
      const r = run(`echo ok`, { GH_TOKEN: "", GITHUB_TOKEN: "", ALLOWED_TOOLS: "Read,Bash(gh pr view:*)" });
      expect(r.stdout).toContain("its gh calls will be unauthenticated");
    });

    it("passes a provided token through", () => {
      const r = run(`echo "gh=\${GH_TOKEN-UNSET}"`, { GH_TOKEN: "t0k", GITHUB_TOKEN: "t0k" });
      expect(r.stdout).toContain("gh=t0k");
    });
  });
});
