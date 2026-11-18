/**
 * quiet_verdicts=: a verdict lane delivers chosen verdicts (the approve word) as
 * a check run owned by the harness App instead of a review. Here: the compiled
 * output with the option off is byte-identical to what came before; the wiring
 * with it on; validation; and the sweep's "decided" test against a stub gh.
 * (The post step is in post-review.test.ts, the gate in
 * actions/merge-gate/src/schedule.test.ts, the context in agent-context.)
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import yaml from "js-yaml";
import { loadHarness } from "../src/config/load.js";
import { compile } from "../src/index.js";
import { validate } from "../src/validate/validate.js";
import type { FoundryConfig, Harness } from "../src/ir/types.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const base = join(root, "test/fixtures/verdict-lanes/.github");

function fixture(edit: (dot: string) => string = (d) => d, cfg: (c: FoundryConfig) => FoundryConfig = (c) => c): Harness {
  const { harness, parseErrors } = loadHarness(join(base, "harness.dot"), join(base, "agents/foundry.config.yaml"));
  expect(parseErrors).toEqual([]);
  if (edit) {
    // Re-parse the edited graph through the same loader: write it beside the original.
    const dir = mkdtempSync(join(tmpdir(), "gpf-quiet-"));
    writeFileSync(join(dir, "harness.dot"), edit(readFileSync(join(base, "harness.dot"), "utf8")));
    const h = loadHarness(join(dir, "harness.dot"), join(base, "agents/foundry.config.yaml")).harness;
    return { ...h, config: cfg(h.config) };
  }
  return { ...harness, config: cfg(harness.config) };
}
const readFile = (rel: string) => {
  try {
    return readFileSync(join(base, rel), "utf8");
  } catch {
    return undefined;
  }
};
const files = (h: Harness) => compile(h, { readFile }, { specDir: ".github" }).files;
const wf = (h: Harness, name: string): any => yaml.load(files(h).find((f) => f.path.endsWith(`/${name}.yml`))!.contents);
const QUIET = (d: string) => d.replace('requires_review=true, post="review"', 'requires_review=true, post="review", quiet_verdicts="APPROVE"');

describe("off: the compiled output is byte-identical to before quiet verdicts existed", () => {
  it("every file of the verdict-lanes fixture", () => {
    const out = files(fixture());
    expect(out.length).toBeGreaterThan(0);
    const drift = out.filter((f) => readFileSync(join(root, "test/fixtures/verdict-lanes", f.path), "utf8") !== f.contents).map((f) => f.path);
    expect(drift).toEqual([]);
  });
});

describe("on: the verdict-lanes-quiet snapshot is what this compiler generates (CI lints it)", () => {
  it("every file", () => {
    const qbase = join(root, "test/fixtures/verdict-lanes-quiet/.github");
    const { harness, parseErrors } = loadHarness(join(qbase, "harness.dot"), join(qbase, "agents/foundry.config.yaml"));
    expect(parseErrors).toEqual([]);
    const qread = (rel: string) => {
      try {
        return readFileSync(join(qbase, rel), "utf8");
      } catch {
        return undefined;
      }
    };
    const out = compile(harness, { readFile: qread }, { specDir: ".github" }).files;
    const drift = out.filter((f) => readFileSync(join(root, "test/fixtures/verdict-lanes-quiet", f.path), "utf8") !== f.contents).map((f) => f.path);
    expect(drift).toEqual([]);
  });
});

describe("on: the wiring", () => {
  const h = () => fixture(QUIET);

  it("the lane's App token may write checks; the post step knows the check and the App", () => {
    const job = wf(h(), "approver").jobs.approver;
    expect(job.steps.find((s: any) => s.id === "app-token").with["permission-checks"]).toBe("write");
    const post = job.steps.find((s: any) => s.name === "Post the review");
    expect(post.env).toMatchObject({ QUIET_LINES: "**Verdict:** APPROVE", VERDICT_CHECK: "gp-foundry/verdict (approver)", BOT_APP: "agent-app" });
  });

  it("the context lists the quiet checks with the reviews", () => {
    for (const [file, job] of [["approver", "approver"], ["reviewer", "reviewer"]] as const) {
      const c = wf(h(), file).jobs[job].steps.find((s: any) => s.id === "ctx").with;
      expect(c["verdict-checks"], file).toBe("gp-foundry/verdict (approver)");
      expect(c["verdict-app"], file).toBe("agent-app");
    }
  });

  it("the gate reads them as verdicts", () => {
    const gate = wf(h(), "gate").jobs.gate.steps.find((s: any) => String(s.uses ?? "").includes("merge-gate")).with;
    expect(gate["verdict-checks"]).toBe("gp-foundry/verdict (approver)");
    expect(gate["verdict-app"]).toBe("agent-app");
  });

  it("the gate takes the PR to evaluate as a dispatch input, in that PR's concurrency slot", () => {
    const gate = wf(h(), "gate");
    expect(gate.on.workflow_dispatch.inputs.pr).toMatchObject({ required: false, type: "string" });
    expect(gate.concurrency.group).toBe("${{ (github.event.pull_request.number || inputs.pr) && format('gate-pr-{0}', (github.event.pull_request.number || inputs.pr)) || 'gate' }}");
    expect(gate.concurrency["cancel-in-progress"]).toBe("${{ (github.event.pull_request.number || inputs.pr) && true || false }}");
    expect(gate.jobs.gate.steps.find((s: any) => String(s.uses ?? "").includes("merge-gate")).with["pr-number"]).toBe("${{ github.event.pull_request.number || inputs.pr }}");
    // The approver may dispatch it with its own token.
    expect(wf(h(), "approver").jobs.approver.permissions.actions).toBe("write");
  });

  it("verdict_check= names the check", () => {
    const h2 = fixture((d) => QUIET(d).replace('quiet_verdicts="APPROVE"', 'quiet_verdicts="APPROVE", verdict_check="approver/verdict"'));
    expect(wf(h2, "approver").jobs.approver.steps.find((s: any) => s.name === "Post the review").env.VERDICT_CHECK).toBe("approver/verdict");
    expect(wf(h2, "gate").jobs.gate.steps.find((s: any) => String(s.uses ?? "").includes("merge-gate")).with["verdict-checks"]).toBe("approver/verdict");
  });
});

describe("validation", () => {
  const codes = (h: Harness) => validate(h, { readFile }).filter((d) => d.level === "error").map((d) => d.code);

  it("accepts the approve word on a verdict lane under App auth", () => {
    expect(codes(fixture(QUIET))).toEqual([]);
  });
  it("only the approve word: the others ask something of the author", () => {
    expect(codes(fixture((d) => QUIET(d).replace('quiet_verdicts="APPROVE"', 'quiet_verdicts="APPROVE,ESCALATE"')))).toContain("node.bad-quiet-verdicts");
  });
  it("only on a verdict lane (a sweep with post=review)", () => {
    expect(codes(fixture((d) => d.replace('skip="unchanged-diff"', 'skip="unchanged-diff", quiet_verdicts="APPROVE"')))).toContain("node.quiet-verdicts-not-verdict-lane");
  });
  it("needs App auth and the App's bot login", () => {
    const pat = (c: FoundryConfig) => ({ ...c, identity: { ...c.identity, app_id_secret: undefined, app_key_secret: undefined } }) as FoundryConfig;
    expect(codes(fixture(QUIET, pat))).toContain("node.quiet-verdicts-needs-app");
    const plainLogin = (c: FoundryConfig) => ({ ...c, identity: { ...c.identity, bot_login: "agent-app" } }) as FoundryConfig;
    expect(codes(fixture(QUIET, plainLogin))).toContain("node.quiet-verdicts-needs-app");
  });
  it("verdict_check= alone is an error", () => {
    expect(codes(fixture((d) => d.replace('requires_review=true, post="review"', 'requires_review=true, post="review", verdict_check="x"')))).toContain("node.verdict-check-without-quiet");
  });
});

// ── the sweep, against a stub gh ─────────────────────────────────────────────

const GH_STUB = `#!/usr/bin/env bash
path=""; jqe=""
while [ $# -gt 0 ]; do case "$1" in --jq) jqe="$2"; shift 2;; --paginate) shift;; api) shift;; -H) shift 2;; *) path="$1"; shift;; esac; done
file="$FIXTURES/$(printf '%s' "$path" | sed 's/[^A-Za-z0-9]/_/g')"
[ -f "$file" ] || { echo "stub gh: no fixture for $path" >&2; exit 1; }
if [ -n "$jqe" ]; then jq -r "$jqe" "$file"; else cat "$file"; fi
`;

function runStep(step: any, env: Record<string, string>, fixtures: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "gpf-quiet-sweep-"));
  const bin = join(dir, "bin");
  const fx = join(dir, "fx");
  mkdirSync(bin);
  mkdirSync(fx);
  writeFileSync(join(bin, "gh"), GH_STUB);
  chmodSync(join(bin, "gh"), 0o755);
  for (const [p, body] of Object.entries(fixtures)) writeFileSync(join(fx, p.replace(/[^A-Za-z0-9]/g, "_")), JSON.stringify(body));
  const out = join(dir, "out");
  writeFileSync(out, "");
  const literal: Record<string, string> = {};
  for (const [k, v] of Object.entries(step.env as Record<string, string>)) if (!String(v).includes("${{")) literal[k] = String(v);
  let stdout = "";
  try {
    stdout = execFileSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", step.run], {
      env: { PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: out, GITHUB_REPOSITORY: "o/r", FIXTURES: fx, ...literal, ...env },
      encoding: "utf8",
    });
  } catch (e: any) {
    stdout = (e.stdout ?? "") + (e.stderr ?? "");
  }
  const prs = readFileSync(out, "utf8").split("\n").find((l) => l.startsWith("prs="));
  return { stdout, prs: prs ? JSON.parse(prs.slice(4)) : undefined };
}

describe("the sweep: a quiet verdict decides the head", () => {
  const select = () => wf(fixture(QUIET), "approver").jobs.approver_select.steps.find((s: any) => s.id === "select");
  const BOT = "agent-app[bot]";
  const CHECK = "gp-foundry/verdict (approver)";
  const reviewed = (n: number) => [{ user: { login: BOT }, commit_id: `sha${n}`, submitted_at: "2026-11-18T09:00:00Z", body: "Two findings." }];
  const head = (n: number, checks: unknown[], reviews: unknown[] = reviewed(n)) => ({
    [`repos/o/r/commits/sha${n}/check-runs?per_page=100&filter=all`]: { check_runs: [{ name: "ci", status: "completed", app: { slug: "github-actions" } }, ...checks] },
    [`repos/o/r/commits/sha${n}/status`]: { total_count: 0 },
    [`repos/o/r/pulls/${n}/reviews?per_page=100`]: reviews,
  });
  const quiet = (over: object = {}) => ({ name: CHECK, status: "completed", conclusion: "success", completed_at: "2026-11-18T10:00:00Z", app: { slug: "agent-app" }, output: { title: "Verdict: APPROVE" }, ...over });
  const pr = (n: number, since?: string) => ({ number: n, sha: `sha${n}`, base: "main", requested: 0, quiet: 3600, ...(since ? { since } : {}) });
  const scoped = (...p: unknown[]) => ({ SCOPED: JSON.stringify(p), SCOPE_LISTED: "true" });

  it("the App's quiet check decides; another App's check of the same name does not", () => {
    const r = runStep(select(), scoped(pr(1), pr(2), pr(3)), {
      ...head(1, [quiet()]),
      ...head(2, [quiet({ app: { slug: "someone-else" } })]),
      ...head(3, []),
    });
    expect(r.stdout).toContain("#1: already decided at sha1 (a quiet verdict)");
    expect(r.prs.map((p: any) => p.number)).toEqual([2, 3]);
  });

  it("a quiet head with NO check runs at all is still selected once the PR has settled (the settle timer is not clobbered)", () => {
    const empty = {
      "repos/o/r/commits/sha1/check-runs?per_page=100&filter=all": { check_runs: [] },
      "repos/o/r/commits/sha1/status": { total_count: 0 },
      "repos/o/r/pulls/1/reviews?per_page=100": reviewed(1),
    };
    const r = runStep(select(), scoped(pr(1)), empty);
    expect(r.prs.map((p: any) => p.number)).toEqual([1]);
  });

  it("a check of that name and App without a verdict title does not decide", () => {
    const r = runStep(select(), scoped(pr(1)), head(1, [quiet({ output: { title: "Verdict: foo bar" } })]));
    expect(r.prs.map((p: any) => p.number)).toEqual([1]);
  });

  it("mixed history: a verdict review decides as before, a quiet check as well", () => {
    const verdictReview = [...reviewed(1), { user: { login: BOT }, commit_id: "sha1", submitted_at: "2026-11-18T09:30:00Z", body: "ok\n\n**Verdict:** REQUEST_CHANGES" }];
    const r = runStep(select(), scoped(pr(1), pr(2)), { ...head(1, [], verdictReview), ...head(2, [quiet()]) });
    expect(r.stdout).toContain("#1: already decided at sha1");
    expect(r.stdout).toContain("#2: already decided at sha2 (a quiet verdict)");
    expect(r.prs).toEqual([]);
  });

  it("a re-review request makes an earlier quiet verdict stale, a later one still decides", () => {
    const r = runStep(select(), scoped(pr(1, "2026-11-18T11:00:00Z"), pr(2, "2026-11-18T09:45:00Z")), {
      ...head(1, [quiet()], [{ user: { login: BOT }, commit_id: "sha1", submitted_at: "2026-11-18T11:30:00Z", body: "Fresh look." }]),
      ...head(2, [quiet()]),
    });
    expect(r.prs.map((p: any) => p.number)).toEqual([1]);
    expect(r.stdout).toContain("#2: already decided at sha2 (a quiet verdict)");
  });

  it("the mark job counts a quiet check as the verdict the run delivered", () => {
    const mark = wf(fixture(QUIET), "approver").jobs.approver_mark.steps.find((s: any) => String(s.run ?? "").includes("JOBS="));
    expect(mark.env).toMatchObject({ VERDICT_CHECK: CHECK, BOT_APP: "agent-app" });
    expect(mark.run).toContain("quiet_verdicts: a verdict delivered as the harness App's check run counts too.");
  });
});
