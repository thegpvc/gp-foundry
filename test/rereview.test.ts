/**
 * The re-review label (labels.re_review), across the lanes: the reviewer starts
 * on it, the approver treats the head as undecided until a verdict newer than
 * it, and the gate is handed the label. (The gate's own behaviour is in
 * actions/merge-gate/src/schedule.test.ts; the post step's in post-review.test.ts.)
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
import { evalGuard } from "../src/sim/gh-expr.js";
import { lastLabeledAt, isFresh } from "../src/shared/rereview.js";
import type { FoundryConfig, Harness } from "../src/ir/types.js";

const BOT = "agent-bot[bot]";
const RR = { rollout: {}, labels: { re_review: "re-review" } } as Partial<FoundryConfig>;

function mkHarness(dot: string, cfg: Partial<FoundryConfig> = {}): Harness {
  const g = parseDot(dot);
  expect(g.errors).toEqual([]);
  const config = { ...loadConfig(undefined), identity: { bot_login: BOT }, ...cfg } as FoundryConfig;
  return { name: g.name, nodes: g.nodes, edges: g.edges, config, sourcePath: "t.dot" };
}
function workflow(dot: string, file: string, cfg: Partial<FoundryConfig> = RR): any {
  const { files } = compile(mkHarness(dot, cfg));
  return yaml.load(files.find((f) => f.path.endsWith(`/${file}.yml`))!.contents);
}

const DOT = `digraph t {
  start    [type=start]
  reviewer [type=pr-review, role="agents/roles/reviewer.md", context="pr-diff", skip="unchanged-diff"]
  approver [type=pr-review, role="agents/roles/approver.md", context="pr-review", select="sweep", schedule="*/10 * * * *", requires_review=true]
  gate     [type=merge-gate, policy="agents/policy/merge.yaml", schedule="*/10 * * * *", merge="off"]
  start    -> reviewer [on="pull_request.opened, pull_request.synchronize"]
}`;

describe("lastLabeledAt / isFresh", () => {
  it("is the LAST time that label was added", () => {
    const at = lastLabeledAt(
      [
        { event: "labeled", label: { name: "re-review" }, created_at: "2026-01-01T00:00:00Z" },
        { event: "unlabeled", label: { name: "re-review" }, created_at: "2026-01-02T00:00:00Z" },
        { event: "labeled", label: { name: "re-review" }, created_at: "2026-01-03T00:00:00Z" },
        { event: "labeled", label: { name: "other" }, created_at: "2026-01-04T00:00:00Z" },
      ],
      "re-review",
    );
    expect(at).toBe("2026-01-03T00:00:00Z");
    expect(lastLabeledAt([], "re-review")).toBeUndefined();
    expect(isFresh("2026-01-03T00:00:01Z", at)).toBe(true);
    expect(isFresh("2026-01-02T00:00:00Z", at)).toBe(false);
    expect(isFresh("anything", undefined)).toBe(true);
  });
});

describe("the reviewer starts on the re-review label", () => {
  const wf = () => workflow(DOT, "reviewer");
  const guard = () => wf().jobs.reviewer_guard.if as string;
  const pr = { draft: false, labels: [], user: { login: "alice" } };
  const ok = (action: string, label?: string) =>
    evalGuard(guard(), { github: { event_name: "pull_request", event: { action, label: label ? { name: label } : undefined, pull_request: pr } } } as any);

  it("listens for labeled, and admits that label only", () => {
    expect(wf().on.pull_request.types).toContain("labeled");
    expect(ok("labeled", "re-review")).toBe(true);
    expect(ok("labeled", "bug")).toBe(false);
    expect(ok("synchronize")).toBe(true);
  });

  it("another label's event gets a throwaway concurrency group; the re-review label's does not", () => {
    const g: string = wf().concurrency.group;
    expect(g).toContain("github.event.label.name != 're-review'");
    expect(g).toContain("reviewer-noop-{0}");
  });

  it("the label's own event is never skipped as an unchanged diff", () => {
    const decide = wf().jobs.reviewer_guard.steps.find((s: any) => s.id === "decide");
    const dir = mkdtempSync(join(tmpdir(), "gpf-rr-guard-"));
    const out = join(dir, "out");
    writeFileSync(out, "");
    const run = (action: string, label: string) => {
      writeFileSync(out, "");
      try {
        execFileSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", decide.run], {
          // No gh on PATH: reaching the unchanged-diff test would fail to read the PR.
          env: { PATH: "/usr/bin:/bin", GITHUB_OUTPUT: out, GITHUB_REPOSITORY: "o/r", PR: "7", NODE: "reviewer", SCOPE_RUN: "true", REREVIEW_LABEL: "re-review", EVENT_ACTION: action, EVENT_LABEL: label },
          encoding: "utf8",
          stdio: "pipe",
        });
      } catch {
        // fall through
      }
      return readFileSync(out, "utf8");
    };
    const r = run("labeled", "re-review");
    expect(r).toContain("run=true");
    expect(r).toContain("head_sha=\n");
    expect(decide.env.EVENT_LABEL).toBe("${{ github.event.label.name }}");
  });

  it("is off without labels.re_review", () => {
    const w = workflow(DOT, "reviewer", { rollout: {} } as Partial<FoundryConfig>);
    expect(w.on.pull_request.types).not.toContain("labeled");
  });
});

describe("the gate is handed the label, and may remove it", () => {
  it("rereview-label input, and write on issues", () => {
    const w = workflow(DOT, "gate");
    const step = w.jobs.gate.steps.find((s: any) => String(s.uses ?? "").includes("merge-gate"));
    expect(step.with["rereview-label"]).toBe("re-review");
    expect(w.jobs.gate.permissions.issues).toBe("write");
    const off = workflow(DOT, "gate", { rollout: {} } as Partial<FoundryConfig>);
    expect(off.jobs.gate.steps.find((s: any) => String(s.uses ?? "").includes("merge-gate")).with["rereview-label"]).toBeUndefined();
    expect(off.jobs.gate.permissions.issues).toBeUndefined();
  });

  it("checks out the base branch, never the PR's merge commit", () => {
    const w = workflow(DOT, "gate");
    expect(w.jobs.gate.steps.find((s: any) => s.name === "Checkout").with.ref).toBe("main");
  });
});

describe("validation", () => {
  it("warns when the label cannot apply: no rollout block", () => {
    const d = validate(mkHarness(DOT.replace(', merge="off"', ""), { labels: { re_review: "re-review" } } as Partial<FoundryConfig>));
    expect(d.find((x) => x.code === "config.rereview-ignored")?.level).toBe("warning");
    expect(validate(mkHarness(DOT, RR)).some((x) => x.code === "config.rereview-ignored")).toBe(false);
  });
});

// ── the approver's selector, run against a stub gh ───────────────────────────

const GH_STUB = `#!/usr/bin/env bash
path=""; jqe=""
while [ $# -gt 0 ]; do case "$1" in --jq) jqe="$2"; shift 2;; --paginate) shift;; api) shift;; -H) shift 2;; *) path="$1"; shift;; esac; done
file="$FIXTURES/$(printf '%s' "$path" | sed 's/[^A-Za-z0-9]/_/g')"
[ -f "$file" ] || { echo "stub gh: no fixture for $path" >&2; exit 1; }
if [ -n "$jqe" ]; then jq -r "$jqe" "$file"; else cat "$file"; fi
`;

function select(scoped: unknown[], fixtures: Record<string, unknown>) {
  const step = workflow(DOT, "approver").jobs.approver_select.steps.find((s: any) => s.id === "select");
  const dir = mkdtempSync(join(tmpdir(), "gpf-rr-"));
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
  try {
    stdout = execFileSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", step.run], {
      env: { PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: out, GITHUB_REPOSITORY: "o/r", FIXTURES: fx, ...env, SCOPED: JSON.stringify(scoped), SCOPE_LISTED: "true" },
      encoding: "utf8",
    });
  } catch (e: any) {
    stdout = (e.stdout ?? "") + (e.stderr ?? "");
  }
  const prs = readFileSync(out, "utf8").split("\n").find((l) => l.startsWith("prs="));
  return { stdout, prs: prs ? JSON.parse(prs.slice(4)) : undefined };
}

describe("the approver treats a re-review-requested head as undecided", () => {
  const SINCE = "2026-11-17T12:00:00Z";
  const head = (n: number, reviews: unknown[], checks: unknown[] = []) => ({
    [`repos/o/r/commits/sha${n}/check-runs?per_page=100&filter=all`]: { check_runs: [{ name: "ci", status: "completed", app: { slug: "github-actions" } }, ...checks] },
    [`repos/o/r/commits/sha${n}/status`]: { total_count: 0 },
    [`repos/o/r/pulls/${n}/reviews?per_page=100`]: reviews,
  });
  const review = (n: number, at: string, verdict?: string) => ({ user: { login: BOT }, commit_id: `sha${n}`, submitted_at: at, body: verdict ? `ok\n\n**Verdict:** ${verdict}` : "Two findings." });
  const swept = (at: string) => ({ name: "gp-foundry/swept (approver)", status: "completed", app: { slug: "github-actions" }, started_at: at });
  const pr = (n: number, since?: string) => ({ number: n, sha: `sha${n}`, base: "main", requested: 0, quiet: 3600, ...(since ? { since } : {}) });

  it("a head decided BEFORE the request is selected again — once a fresh review covers it", () => {
    const before = "2026-11-17T11:00:00Z";
    const after = "2026-11-17T12:30:00Z";
    const r = select([pr(1, SINCE), pr(2, SINCE), pr(3)], {
      // #1: old review + old verdict + old swept mark; a fresh review since → selected
      ...head(1, [review(1, before), review(1, before, "APPROVE"), review(1, after)], [swept(before)]),
      // #2: old everything, no fresh review yet → waits for the reviewer
      ...head(2, [review(2, before), review(2, before, "APPROVE")], [swept(before)]),
      // #3: no request: decided stays decided
      ...head(3, [review(3, before), review(3, before, "APPROVE")]),
    });
    expect(r.prs).toEqual([{ number: 1, sha: "sha1", base: "main", since: SINCE }]);
    expect(r.stdout).toContain("#2: no review by");
    expect(r.stdout).toContain("#3: already decided");
  });

  it("a fresh verdict is a decision", () => {
    const r = select([pr(1, SINCE)], { ...head(1, [review(1, "2026-11-17T12:10:00Z"), review(1, "2026-11-17T12:20:00Z", "APPROVE")]) });
    expect(r.prs).toEqual([]);
    expect(r.stdout).toContain("already decided");
  });

  it("the sweep's own records from after the request still count (no endless retries)", () => {
    const fresh = "2026-11-17T12:30:00Z";
    const r = select([pr(1, SINCE)], { ...head(1, [review(1, fresh)], [swept(fresh)]) });
    expect(r.prs).toEqual([]);
    expect(r.stdout).toContain("already swept");
  });

  it("the sweep lists with the label", () => {
    const scope = workflow(DOT, "approver").jobs.approver_select.steps.find((s: any) => s.id === "scope").with;
    expect(scope["rereview-label"]).toBe("re-review");
  });
});
