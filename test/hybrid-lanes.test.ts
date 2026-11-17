/**
 * A hybrid harness — the config has a `rollout:` block — scopes every PR lane by
 * the rollout dial, through one shared rule (the pr-scope action), and lets a
 * lane that writes act only on PRs the pipeline wrote. Without the block, every
 * lane compiles exactly as it did before.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { parseDot } from "../src/parser/parse.js";
import { loadConfig } from "../src/config/load.js";
import { compile } from "../src/index.js";
import { releaseTag } from "../src/shared/version.js";
import { validate } from "../src/validate/validate.js";
import type { Diagnostic, FoundryConfig, Harness } from "../src/ir/types.js";

const BOT = "agent-bot[bot]";
const ROLLOUT = { authors: ["Alice", "bob"], opt_in_label: "agent_review", skip_label: "no-agent-review" };
const LABELS = { agent_review: "bot:review" };

function mkHarness(dot: string, cfg: Partial<FoundryConfig> = {}): Harness {
  const g = parseDot(dot);
  expect(g.errors).toEqual([]);
  const config = { ...loadConfig(undefined), identity: { bot_login: BOT }, ...cfg } as FoundryConfig;
  return { name: g.name, nodes: g.nodes, edges: g.edges, config, sourcePath: "test.dot" };
}
const hybrid = (over: Partial<FoundryConfig> = {}): Partial<FoundryConfig> => ({ rollout: ROLLOUT, labels: LABELS, ...over });
function workflow(dot: string, file: string, cfg: Partial<FoundryConfig> = {}): any {
  const { files } = compile(mkHarness(dot, cfg));
  const f = files.find((x) => x.path.endsWith(`/${file}.yml`));
  expect(f, `${file}.yml`).toBeTruthy();
  return yaml.load(f!.contents);
}
const codes = (dot: string, cfg: Partial<FoundryConfig>, level = "error") =>
  validate(mkHarness(dot, cfg)).filter((d: Diagnostic) => d.level === level).map((d) => d.code);

const DOT = (reviewerAttrs = "") => `digraph t {
  start    [type=start]
  builder  [type=producer, role="agents/roles/builder.md"]
  reviewer [type=pr-review, role="agents/roles/reviewer.md", context="pr-diff"${reviewerAttrs ? ", " + reviewerAttrs : ""}]
  fixer    [type=pr-fix, role="agents/roles/fixer.md"]
  human    [type=exit]
  start    -> builder  [on="issues.opened"]
  builder  -> reviewer [on="pull_request.opened, pull_request.synchronize"]
  reviewer -> fixer    [when="verdict=request_changes"]
  fixer    -> reviewer [on="push"]
  fixer    -> human    [when="attempts>=3"]
}`;
const PR = "github.event.pull_request";

describe("a reading lane in a hybrid harness", () => {
  const wf = (cfg = hybrid(), attrs = "") => workflow(DOT(attrs), "reviewer", cfg);

  it("runs behind a guard that asks the shared scope rule", () => {
    const w = wf();
    expect(Object.keys(w.jobs)).toEqual(["reviewer_guard", "reviewer"]);
    const scope = w.jobs.reviewer_guard.steps.find((s: any) => s.id === "scope");
    expect(scope.uses).toBe(`thegpvc/gp-foundry/actions/pr-scope@${releaseTag()}`);
    expect(scope.with.number).toBe("${{ github.event.pull_request.number }}");
    expect(scope.with.token).toBe("${{ github.token }}");
    expect(scope.with["bot-login"]).toBe(BOT);
    expect(scope.with["require-agent-written"]).toBeUndefined();
    // The dial as parsed: lower-cased logins, labels resolved through config.labels.
    expect(JSON.parse(scope.with.rollout)).toEqual({ authors: ["alice", "bob"], optInLabel: "bot:review", skipLabel: "no-agent-review" });
    expect(w.jobs.reviewer_guard.outputs.run).toBe("${{ steps.scope.outputs.run }}");
    expect(w.jobs.reviewer_guard.permissions).toEqual({ contents: "read", "pull-requests": "read" });
    expect(w.jobs.reviewer.needs).toEqual(["reviewer_guard"]);
    expect(w.jobs.reviewer.if).toBe("needs.reviewer_guard.outputs.run == 'true'");
  });

  it("is not limited to agent branches: no branch-prefix clause", () => {
    expect(wf().jobs.reviewer_guard.if).not.toContain("startsWith(");
  });

  it("is prefiltered on the event, so no runner starts for a PR plainly out of scope", () => {
    const guard: string = wf().jobs.reviewer_guard.if;
    expect(guard).toContain(`${PR}.draft == false`);
    expect(guard).toContain(`!contains(${PR}.labels.*.name, 'no-agent-review')`);
    expect(guard).toContain(
      `(${PR}.user.login == '${BOT}' || ${PR}.user.login == 'alice' || ${PR}.user.login == 'bob' || contains(${PR}.labels.*.name, 'bot:review'))`,
    );
  });

  it("with the dial fully open, the prefilter is just drafts", () => {
    const guard: string = wf(hybrid({ rollout: {} })).jobs.reviewer_guard.if;
    expect(guard).toContain(`${PR}.draft == false`);
    expect(guard).not.toContain("user.login");
    expect(wf(hybrid({ rollout: {} })).jobs.reviewer_guard.steps.find((s: any) => s.id === "scope").with.rollout).toBeUndefined();
  });

  it("listens for a draft being marked ready, and for the opt-in label", () => {
    const w = wf();
    expect(w.on.pull_request.types).toEqual(expect.arrayContaining(["opened", "synchronize", "ready_for_review", "labeled"]));
    // Any other label still starts a run; it is turned away, and kept out of the PR's concurrency group.
    expect(w.jobs.reviewer_guard.if).toContain("(github.event.action != 'labeled' || github.event.label.name == 'bot:review')");
    expect(w.concurrency.group).toContain("reviewer-noop-{0}");
    // No opt-in label, no label events.
    expect(wf(hybrid({ rollout: { authors: ["alice"] } })).on.pull_request.types).not.toContain("labeled");
  });

  it("keeps skip=\"unchanged-diff\": a lane's own behaviour, decided after scope", () => {
    const w = wf(hybrid(), 'skip="unchanged-diff"');
    const steps = w.jobs.reviewer_guard.steps;
    expect(steps.map((s: any) => s.id).filter(Boolean)).toEqual(["scope", "decide"]);
    const decide = steps.find((s: any) => s.id === "decide");
    expect(decide.env.SCOPE_RUN).toBe("${{ steps.scope.outputs.run }}");
    expect(decide.run).not.toContain("${{");
    expect(w.jobs.reviewer_guard.outputs.run).toBe("${{ steps.decide.outputs.run }}");
    expect(w.jobs.reviewer.steps.at(-1).name).toBe("Stamp the review with the diff hash");

    // Out of scope wins, before any API call: run the compiled script.
    const dir = mkdtempSync(join(tmpdir(), "gpf-hyb-"));
    const out = join(dir, "out");
    writeFileSync(out, "");
    execFileSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", decide.run], {
      env: { PATH: process.env.PATH!, GITHUB_OUTPUT: out, GITHUB_REPOSITORY: "o/r", NODE: "reviewer", PR: "7", SCOPE_RUN: "false", SCOPE_REASON: "bob is not in rollout.authors" },
      encoding: "utf8",
    });
    const written = readFileSync(out, "utf8");
    expect(written).toContain("run=false");
    expect(written).toContain("reason=bob is not in rollout.authors");
  });

  it("in vendored mode, checks the scope action out from the base ref first", () => {
    const steps = wf(hybrid({ runtime: { mode: "vendored" } })).jobs.reviewer_guard.steps;
    expect(steps[0].uses).toBe("actions/checkout@v5");
    expect(steps[0].with).toMatchObject({
      ref: "${{ github.event.pull_request.base.ref }}",
      "sparse-checkout": ".github/actions/pr-scope",
      "persist-credentials": false,
    });
    expect(steps[1].uses).toBe("./.github/actions/pr-scope");
  });
});

describe("a writing lane in a hybrid harness", () => {
  const wf = (cfg = hybrid()) => workflow(DOT(), "fixer", cfg);

  it("the fixer runs only behind the agent-written test", () => {
    const w = wf();
    expect(Object.keys(w.jobs)).toEqual(["fixer_guard", "fixer"]);
    const scope = w.jobs.fixer_guard.steps.find((s: any) => s.id === "scope");
    expect(scope.with["require-agent-written"]).toBe("true");
    expect(scope.name).toBe("Is this a PR the pipeline wrote?");
    expect(w.jobs.fixer.needs).toEqual(["fixer_guard"]);
    expect(w.jobs.fixer.if).toBe("needs.fixer_guard.outputs.run == 'true'");
  });

  it("is prefiltered to PRs the bot opened — never by the opt-in label", () => {
    const guard: string = wf().jobs.fixer_guard.if;
    expect(guard).toContain(`${PR}.user.login == '${BOT}'`);
    expect(guard).not.toContain("'alice'");
    expect(guard).not.toContain("bot:review");
    expect(guard).not.toContain("startsWith(");
    // The verdict that triggers it is still required.
    expect(guard).toContain("**Verdict:** REQUEST_CHANGES");
    expect(wf().on.pull_request_review.types).toEqual(["submitted"]);
  });

  it("needs a bot login: nothing else can be called agent-written", () => {
    expect(codes(DOT(), hybrid({ identity: {} }))).toContain("node.writing-lane-needs-bot-login");
    expect(codes(DOT(), hybrid())).toEqual([]);
  });
});

describe("the producer is not a PR lane: it is untouched", () => {
  it("compiles the same with and without a rollout block", () => {
    const strip = (w: any) => JSON.stringify(w);
    expect(strip(workflow(DOT(), "builder", hybrid()))).toBe(strip(workflow(DOT(), "builder")));
  });
});

describe("one scope: the rollout block", () => {
  it("rejects per-node scope attributes in a hybrid harness", () => {
    for (const attrs of ['authors="alice"', 'opt_in_label="x"', 'skip="draft"', 'skip="bot-author,label:foo,unchanged-diff"']) {
      expect(codes(DOT(attrs), hybrid()), attrs).toContain("node.scope-attr-with-rollout");
    }
    expect(codes(DOT('skip="unchanged-diff"'), hybrid())).toEqual([]);
  });

  it("rejects repo.authors alongside a rollout block", () => {
    const repo = { ...loadConfig(undefined).repo, authors: ["alice"] };
    expect(codes(DOT(), hybrid({ repo }))).toContain("config.authors-and-rollout");
  });

  it("warns when a vendored harness has not vendored the scope action", () => {
    const g = mkHarness(DOT(), hybrid({ runtime: { mode: "vendored" } }));
    const ds = validate(g, { fileExists: (p) => !p.includes("pr-scope") });
    expect(ds.some((d) => d.code === "runtime.action-not-vendored" && d.message.includes("pr-scope"))).toBe(true);
  });
});

describe("without a rollout block nothing changes", () => {
  it("the reviewer has no guard and is held to the branch prefix; the fixer has no guard", () => {
    const reviewer = workflow(DOT(), "reviewer");
    expect(Object.keys(reviewer.jobs)).toEqual(["reviewer"]);
    expect(reviewer.jobs.reviewer.if).toContain("startsWith(github.event.pull_request.head.ref, 'agent/')");
    expect(reviewer.on.pull_request.types).toEqual(["opened", "synchronize"]);
    const fixer = workflow(DOT(), "fixer");
    expect(Object.keys(fixer.jobs)).toEqual(["fixer"]);
    expect(fixer.jobs.fixer.needs).toBeUndefined();
  });

  it("per-node scope attributes still work", () => {
    expect(codes(DOT('authors="alice", skip="draft"'), {})).toEqual([]);
    const w = workflow(DOT('authors="alice"'), "reviewer");
    expect(w.jobs.reviewer_guard.steps[0].id).toBe("decide");
    expect(JSON.stringify(w)).not.toContain("pr-scope");
  });
});

describe("a sweep in a hybrid harness", () => {
  const SWEEP = `digraph t {
    approver [type=pr-review, role="agents/roles/a.md", context="pr-review", select="sweep", schedule="*/10 * * * *"]
  }`;
  const select = (cfg = hybrid()) => workflow(SWEEP, "approver", cfg).jobs.approver_select;

  it("takes its candidates from the shared scope rule, not from a filter of its own", () => {
    const job = select();
    const scope = job.steps.find((s: any) => s.id === "scope");
    expect(scope.uses).toBe(`thegpvc/gp-foundry/actions/pr-scope@${releaseTag()}`);
    expect(scope.with).toMatchObject({ list: "true", "base-branch": "main", "bot-login": BOT });
    expect(JSON.parse(scope.with.rollout)).toEqual({ authors: ["alice", "bob"], optInLabel: "bot:review", skipLabel: "no-agent-review" });
    const step = job.steps.find((s: any) => s.id === "select");
    expect(step.env.SCOPED).toBe("${{ steps.scope.outputs.prs }}");
    // No listing, branch-prefix or author filter left in the script.
    expect(step.run).not.toContain("pulls?state=open");
    expect(step.run).not.toContain("startswith(env.PREFIX)");
    expect(step.run).not.toContain("env.AUTHORS");
  });

  it("in vendored mode, checks the scope action out first", () => {
    const steps = select(hybrid({ runtime: { mode: "vendored" } })).steps;
    expect(steps[0].with["sparse-checkout"]).toBe(".github/actions/pr-scope");
    expect(steps[1].uses).toBe("./.github/actions/pr-scope");
  });

  function runSelect(env: Record<string, string>) {
    const step = select().steps.find((s: any) => s.id === "select");
    const dir = mkdtempSync(join(tmpdir(), "gpf-sweep-"));
    const out = join(dir, "out");
    writeFileSync(out, "");
    // A stub gh: every head has one completed check, no status, no reviews.
    writeFileSync(
      join(dir, "gh"),
      `#!/usr/bin/env bash
path=""; jqe=""
while [ $# -gt 0 ]; do case "$1" in --jq) jqe="$2"; shift 2;; --paginate) shift;; api) shift;; *) path="$1"; shift;; esac; done
case "$path" in
  *check-runs*) body='{"check_runs":[{"status":"completed","name":"ci","app":{"slug":"github-actions"}}]}' ;;
  */status) body='{"total_count":0}' ;;
  */reviews*) body='[]' ;;
  *) echo "unexpected: $path" >&2; exit 1 ;;
esac
jq -r "$jqe" <<< "$body"
`,
      { mode: 0o755 },
    );
    const literal: Record<string, string> = {};
    for (const [k, v] of Object.entries(step.env as Record<string, string>)) if (!String(v).includes("\${{")) literal[k] = String(v);
    let status = 0;
    let stdout = "";
    try {
      stdout = execFileSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", step.run], {
        env: { PATH: `${dir}:${process.env.PATH}`, GITHUB_OUTPUT: out, GITHUB_REPOSITORY: "o/r", ...literal, ...env },
        encoding: "utf8",
      });
    } catch (e: any) {
      status = e.status ?? 1;
      stdout = (e.stdout ?? "") + (e.stderr ?? "");
    }
    const outputs = Object.fromEntries(readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    return { status, stdout, outputs };
  }

  it("selects from the scoped list — a person's PR on any branch included", () => {
    const scoped = [
      { number: 3, sha: "sha3", base: "main", requested: 0, quiet: 3600 },
      { number: 9, sha: "sha9", base: "release", requested: 0, quiet: 3600 },
      { number: 12, sha: "sha12", base: "main", requested: 1, quiet: 3600 }, // still waiting on a reviewer
    ];
    const r = runSelect({ SCOPED: JSON.stringify(scoped), SCOPE_LISTED: "true" });
    expect(r.status, r.stdout).toBe(0);
    expect(JSON.parse(r.outputs.prs!)).toEqual([
      { number: 3, sha: "sha3", base: "main" },
      { number: 9, sha: "sha9", base: "release" },
    ]);
  });

  it("has a quiet tick when the open PRs could not be listed", () => {
    const r = runSelect({ SCOPED: "[]", SCOPE_LISTED: "false" });
    expect(r.status).toBe(0);
    expect(r.outputs).toMatchObject({ prs: "[]", count: "0" });
    expect(r.stdout).toContain("could not list open pull requests this tick");
  });

  it("without a rollout block the sweep lists and filters as before", () => {
    const job = workflow(SWEEP, "approver").jobs.approver_select;
    expect(job.steps.map((s: any) => s.id)).toEqual(["select"]);
    expect(job.steps[0].run).toContain("startswith(env.PREFIX)");
  });
});
