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
