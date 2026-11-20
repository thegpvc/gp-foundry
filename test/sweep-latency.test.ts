/**
 * The sweep's time to a verdict:
 *   - #51: dispatch= starts a sweep for ONE PR, in a concurrency slot of its own;
 *   - #53: hold_on_review_requests=false lets the sweep decide a head with a
 *     pending review request.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { parseDot } from "../src/parser/parse.js";
import { loadConfig } from "../src/config/load.js";
import { compile } from "../src/index.js";
import { validate } from "../src/validate/validate.js";
import type { FoundryConfig, Harness } from "../src/ir/types.js";

const BOT = "agent-bot[bot]";

const dot = (o: { reviewer?: string; approver?: string; gate?: string } = {}) => `digraph t {
  start    [type=start]
  reviewer [type=pr-review, role="agents/roles/reviewer.md", context="pr-diff", post="review"${o.reviewer ? ", " + o.reviewer : ""}]
  approver [type=pr-review, role="agents/roles/approver.md", context="pr-review", select="sweep", schedule="*/5 * * * *", requires_review=true, post="review"${o.approver ? ", " + o.approver : ""}]
  gate     [type=merge-gate, policy="agents/policy/merge.yaml", schedule="*/10 * * * *", merge="off"${o.gate ? ", " + o.gate : ""}]
  start -> reviewer [on="pull_request.opened, pull_request.synchronize"]
}`;
function harness(d: string, hybrid = true): Harness {
  const g = parseDot(d);
  expect(g.errors).toEqual([]);
  const config = { ...loadConfig(undefined), identity: { bot_login: BOT }, ...(hybrid ? { rollout: {} } : {}) } as FoundryConfig;
  return { name: g.name, nodes: g.nodes, edges: g.edges, config, sourcePath: "t.dot" };
}
const wf = (d: string, name: string, hybrid = true): any =>
  yaml.load(compile(harness(d, hybrid)).files.find((f) => f.path.endsWith(`/${name}.yml`))!.contents);
const errors = (d: string) => validate(harness(d)).filter((x) => x.level === "error").map((x) => x.code);
const selectStep = (d: string, hybrid = true) => wf(d, "approver", hybrid).jobs.approver_select.steps.find((s: any) => s.id === "select");

// ── the selector, run against a stub gh ──────────────────────────────────────

const GH_STUB = `#!/usr/bin/env bash
path=""; jqe=""
while [ $# -gt 0 ]; do case "$1" in --jq) jqe="$2"; shift 2;; --paginate) shift;; api) shift;; -H) shift 2;; *) path="$1"; shift;; esac; done
file="$FIXTURES/$(printf '%s' "$path" | sed 's/[^A-Za-z0-9]/_/g')"
[ -f "$file" ] || { echo "stub gh: no fixture for $path" >&2; exit 1; }
if [ -n "$jqe" ]; then jq -r "$jqe" "$file"; else cat "$file"; fi
`;

function runSelect(step: any, scoped: unknown[], fixtures: Record<string, unknown>, extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gpf-sweep-"));
  const bin = join(dir, "bin");
  const fx = join(dir, "fx");
  mkdirSync(bin);
  mkdirSync(fx);
  writeFileSync(join(bin, "gh"), GH_STUB);
  chmodSync(join(bin, "gh"), 0o755);
  for (const [p, body] of Object.entries(fixtures)) writeFileSync(join(fx, p.replace(/[^A-Za-z0-9]/g, "_")), JSON.stringify(body));
  const out = join(dir, "out");
  writeFileSync(out, "");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(step.env as Record<string, string>)) if (!String(v).includes("${{")) env[k] = String(v);
  let stdout = "";
  let status = 0;
  try {
    stdout = execFileSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", step.run], {
      env: { PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: out, GITHUB_REPOSITORY: "o/r", FIXTURES: fx, ...env, SCOPED: JSON.stringify(scoped), SCOPE_LISTED: "true", ...extra },
      encoding: "utf8",
    });
  } catch (e: any) {
    status = e.status ?? 1;
    stdout = (e.stdout ?? "") + (e.stderr ?? "");
  }
  const lines = readFileSync(out, "utf8").split("\n");
  const get = (k: string) => lines.find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1);
  const prs = get("prs");
  return { stdout, status, prs: prs ? JSON.parse(prs) : undefined, get };
}

/** A head that is ready in every respect: CI done, reviewed, undecided. */
const ready = (n: number) => ({
  [`repos/o/r/commits/sha${n}/check-runs?per_page=100&filter=all`]: { check_runs: [{ name: "ci", status: "completed", app: { slug: "github-actions" } }] },
  [`repos/o/r/commits/sha${n}/status`]: { total_count: 0 },
  [`repos/o/r/pulls/${n}/reviews?per_page=100`]: [{ user: { login: BOT }, commit_id: `sha${n}`, submitted_at: "2026-11-20T10:00:00Z", body: "Two findings." }],
});
const pr = (n: number, requested = 0) => ({ number: n, sha: `sha${n}`, base: "main", requested, quiet: 3600 });

// ── #53 ──────────────────────────────────────────────────────────────────────

describe("hold_on_review_requests (#53)", () => {
  it("default: a pending review request holds the head, as before", () => {
    const r = runSelect(selectStep(dot()), [pr(1, 2), pr(2)], { ...ready(1), ...ready(2) });
    expect(r.stdout).toContain("#1: 2 review request(s) outstanding");
    expect(r.prs.map((p: any) => p.number)).toEqual([2]);
  });

  it("=false: the head is decided despite the request", () => {
    const r = runSelect(selectStep(dot({ approver: "hold_on_review_requests=false" })), [pr(1, 2), pr(2)], { ...ready(1), ...ready(2) });
    expect(r.prs.map((p: any) => p.number)).toEqual([1, 2]);
  });

  it("=false on a non-hybrid sweep too", () => {
    expect(selectStep(dot({ approver: "hold_on_review_requests=false" }), false).run).not.toContain("review request(s) outstanding");
    expect(selectStep(dot(), false).run).toContain("review request(s) outstanding");
  });

  it("validates: a sweep only, true or false", () => {
    expect(errors(dot({ approver: "hold_on_review_requests=false" }))).toEqual([]);
    expect(errors(dot({ approver: 'hold_on_review_requests="sometimes"' }))).toContain("node.bad-hold-on-review-requests");
    expect(errors(dot({ reviewer: "hold_on_review_requests=false" }))).toContain("node.hold-on-review-requests-unsupported");
  });
});

// ── #51 ──────────────────────────────────────────────────────────────────────

describe("a sweep started for one PR (#51)", () => {
  const D = dot({ reviewer: 'dispatch="approver"' });

  it("the upstream lane passes the PR to the sweep", () => {
    const post = wf(D, "reviewer").jobs.reviewer.steps.find((s: any) => s.name === "Post the review");
    expect(post.env.DISPATCH_TARGETS).toBe("approver.yml pr");
  });

  it("the sweep takes `pr`, and a run for one PR has that PR's own concurrency slot", () => {
    const w = wf(D, "approver");
    expect(w.on.workflow_dispatch.inputs.pr).toMatchObject({ type: "string", required: false });
    expect(w.concurrency).toEqual({ group: "${{ inputs.pr && format('approver-pr-{0}', inputs.pr) || 'approver' }}", "cancel-in-progress": false });
  });

  it("the scope step reads that PR directly; the select step narrows to it", () => {
    const job = wf(D, "approver").jobs.approver_select;
    expect(job.steps.find((s: any) => s.id === "scope").with.only).toBe("${{ inputs.pr }}");
    expect(job.steps.find((s: any) => s.id === "select").env.ONLY_PR).toBe("${{ inputs.pr }}");
  });

  it("given a PR, only that one is considered — under the same rules", () => {
    const step = selectStep(D);
    const fx = { ...ready(1), ...ready(2) };
    expect(runSelect(step, [pr(1), pr(2)], fx, { ONLY_PR: "2" }).prs.map((p: any) => p.number)).toEqual([2]);
    expect(runSelect(step, [pr(1), pr(2)], fx, { ONLY_PR: "" }).prs.map((p: any) => p.number)).toEqual([1, 2]);
    const gone = runSelect(step, [pr(1)], fx, { ONLY_PR: "9" });
    expect(gone.prs).toEqual([]);
    expect(gone.stdout).toContain("#9: not a candidate");
    // Not ready is not selected (and so costs no idle run): CI still going.
    const busy = { ...fx, "repos/o/r/commits/sha2/check-runs?per_page=100&filter=all": { check_runs: [{ name: "ci", status: "in_progress", app: { slug: "github-actions" } }] } };
    expect(runSelect(step, [pr(2)], busy, { ONLY_PR: "2" }).prs).toEqual([]);
  });

  it("a malformed pr input fails the run", () => {
    const r = runSelect(selectStep(D), [pr(1)], ready(1), { ONLY_PR: "1; rm -rf /" });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("must be a PR number");
  });

  it("non-hybrid: the listing is narrowed the same way", () => {
    expect(selectStep(D, false).run).toContain('awk -v n="$ONLY_PR"');
  });

  it("off: a sweep no dispatch= names is unchanged", () => {
    const w = wf(dot(), "approver");
    expect(w.on.workflow_dispatch).toEqual({});
    expect(w.concurrency).toEqual({ group: "approver", "cancel-in-progress": false });
    expect(selectStep(dot()).env.ONLY_PR).toBeUndefined();
    expect(selectStep(dot()).run).not.toContain("ONLY_PR");
  });
});

// ── #52 ──────────────────────────────────────────────────────────────────────

describe("explain_on: why an undecided head is waiting, on the gate's check (#52)", () => {
  const D = dot({ approver: 'explain_on="gate"' });

  it("the select job gives a reason for each waiting head, and for the one it selects", () => {
    const busy = (n: number) => ({ ...ready(n), [`repos/o/r/commits/sha${n}/check-runs?per_page=100&filter=all`]: { check_runs: [{ name: "ci", status: "in_progress", app: { slug: "github-actions" } }] } });
    const unreviewed = (n: number) => ({ ...ready(n), [`repos/o/r/pulls/${n}/reviews?per_page=100`]: [] });
    const decided = (n: number) => ({ ...ready(n), [`repos/o/r/pulls/${n}/reviews?per_page=100`]: [{ user: { login: BOT }, commit_id: `sha${n}`, submitted_at: "2026-11-20T10:00:00Z", body: "ok\n\n**Verdict:** APPROVE" }] });
    const r = runSelect(selectStep(D), [pr(1, 1), pr(2), pr(3), pr(4), pr(5)], { ...ready(1), ...busy(2), ...unreviewed(3), ...decided(4), ...ready(5) });
    expect(r.prs.map((p: any) => p.number)).toEqual([5]);
    expect(JSON.parse(r.get("waiting")!)).toEqual([
      { number: 1, sha: "sha1", title: "Waiting: 1 review request(s) outstanding" },
      { number: 2, sha: "sha2", title: "Waiting: 1 check(s) still running" },
      { number: 3, sha: "sha3", title: "Waiting: the upstream review of this head" },
      { number: 5, sha: "sha5", title: "approver is deciding" },
    ]);
  });

  it("a head that gave up says so, and how to retry", () => {
    const failed = { ...ready(1), "repos/o/r/commits/sha1/check-runs?per_page=100&filter=all": { check_runs: [1, 2, 3].map(() => ({ name: "gp-foundry/sweep-failed (approver)", status: "completed", app: { slug: "github-actions" } })) } };
    const r = runSelect(selectStep(D), [pr(1)], failed);
    expect(JSON.parse(r.get("waiting")!)).toEqual([{ number: 1, sha: "sha1", title: "Waiting: approver gave up after 3 failed runs — push to retry" }]);
  });

  it("the gate takes the reason with the PR; the sweep gets an explain job", () => {
    const gate = wf(D, "gate");
    expect(Object.keys(gate.on.workflow_dispatch.inputs)).toEqual(["pr", "reason", "reason_sha"]);
    const w = gate.jobs.gate.steps.find((s: any) => String(s.uses ?? "").includes("merge-gate")).with;
    expect(w).toMatchObject({ "pr-number": "${{ github.event.pull_request.number || inputs.pr }}", "waiting-title": "${{ inputs.reason }}", "waiting-sha": "${{ inputs.reason_sha }}" });
    const job = wf(D, "approver").jobs.approver_explain;
    expect(job.needs).toEqual(["approver_select"]);
    expect(job.permissions).toEqual({ checks: "read", actions: "write" });
    expect(job.steps[0].env).toMatchObject({ GATE_WORKFLOW: "gate.yml", GATE_CHECK: "gp-foundry/approval (gate)", GATE_APP: "github-actions" });
    // The select job stays read-only.
    expect(wf(D, "approver").jobs.approver_select.permissions.actions).toBeUndefined();
  });

  it("the explain job dispatches only a changed reason", () => {
    const step = wf(D, "approver").jobs.approver_explain.steps[0];
    const dir = mkdtempSync(join(tmpdir(), "gpf-explain-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const log = join(dir, "log");
    // The gate's check per head: #1 already says it, #2 says something else, #3 has a
    // result, #4 none yet, #5 the gate's own re-review hold, #6 unreadable.
    writeFileSync(
      join(bin, "gh"),
      `#!/usr/bin/env bash
if [ "$2" = "--method" ]; then printf '%s\\n' "$*" >> "$LOG"; exit 0; fi
jqe=""; path="$2"; while [ $# -gt 0 ]; do [ "$1" = "--jq" ] && jqe="$2"; shift; done
case "$path" in
  *sha1*) body='{"check_runs":[{"id":1,"status":"in_progress","app":{"slug":"github-actions"},"output":{"title":"approver is deciding"}}]}' ;;
  *sha2*) body='{"check_runs":[{"id":1,"status":"in_progress","app":{"slug":"github-actions"},"output":{"title":"Waiting: CI has not started on this head"}}]}' ;;
  *sha3*) body='{"check_runs":[{"id":1,"status":"completed","app":{"slug":"github-actions"},"output":{"title":"Ready"}}]}' ;;
  *sha4*) body='{"check_runs":[{"id":9,"status":"completed","app":{"slug":"someone-else"},"output":{"title":"x"}}]}' ;;
  *sha5*) body='{"check_runs":[{"id":1,"status":"in_progress","app":{"slug":"github-actions"},"output":{"title":"Re-review requested"}}]}' ;;
  *) echo "HTTP 502" >&2; exit 1 ;;
esac
jq -r "$jqe" <<< "$body"
`,
    );
    chmodSync(join(bin, "gh"), 0o755);
    const waiting = [1, 2, 3, 4, 5, 6].map((n) => ({ number: n, sha: `sha${n}`, title: "approver is deciding" }));
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(step.env as Record<string, string>)) if (!String(v).includes("${{")) env[k] = String(v);
    const out = execFileSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", step.run], {
      env: { PATH: `${bin}:${process.env.PATH}`, GITHUB_REPOSITORY: "o/r", LOG: log, ...env, WAITING: JSON.stringify(waiting) },
      encoding: "utf8",
    });
    const sent = readFileSync(log, "utf8").trim().split("\n");
    expect(sent).toEqual([
      "api --method POST repos/o/r/actions/workflows/gate.yml/dispatches -f ref=main -f inputs[pr]=2 -f inputs[reason]=approver is deciding -f inputs[reason_sha]=sha2",
      "api --method POST repos/o/r/actions/workflows/gate.yml/dispatches -f ref=main -f inputs[pr]=4 -f inputs[reason]=approver is deciding -f inputs[reason_sha]=sha4",
    ]);
    expect(out).toContain("#1: already shows");
    expect(out).toContain("#3: gp-foundry/approval (gate) has a result");
    expect(out).toContain("#5: held for a re-review");
    expect(out).toContain("::warning::#6: could not read");
  });

  it("validates: a sweep, naming a scheduled single gate, one sweep per gate", () => {
    expect(errors(D)).toEqual([]);
    expect(errors(dot({ reviewer: 'explain_on="gate"' }))).toContain("node.explain-on-unsupported");
    expect(errors(dot({ approver: 'explain_on="reviewer"' }))).toContain("node.bad-explain-on");
    expect(errors(dot({ approver: 'explain_on="gate"' }).replace(', schedule="*/10 * * * *", merge', ", merge"))).toContain("node.bad-explain-on");
    const two = D.replace("  gate ", `  approver2 [type=pr-review, role="agents/roles/approver.md", context="pr-review", select="sweep", schedule="*/5 * * * *", post="review", explain_on="gate"]\n  gate `);
    expect(errors(two)).toContain("node.duplicate-explain-on");
  });

  it("off: no reasons, no explain job, the gate takes no reason", () => {
    const w = wf(dot(), "approver");
    expect(w.jobs.approver_explain).toBeUndefined();
    expect(w.jobs.approver_select.outputs.waiting).toBeUndefined();
    expect(w.jobs.approver_select.steps.find((s: any) => s.id === "select").run).not.toContain("wait_for");
    expect(wf(dot(), "gate").on.workflow_dispatch).toEqual({});
  });
});
