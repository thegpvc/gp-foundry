// post="review": the agent prints its review as a fenced json block; a compiled
// step posts it with the lane's token. The agent gets no GitHub token.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { parseDot } from "../src/parser/parse.js";
import { loadConfig } from "../src/config/load.js";
import { compile } from "../src/index.js";
import { validate } from "../src/validate/validate.js";
import { IS_VERDICT_JQ } from "../src/handlers/attrs.js";
import type { FoundryConfig, Harness } from "../src/ir/types.js";

const BOT = "agent-bot[bot]";

function mkHarness(dot: string, cfg: Partial<FoundryConfig> = {}): Harness {
  const g = parseDot(dot);
  expect(g.errors).toEqual([]);
  const config = { ...loadConfig(undefined), identity: { bot_login: BOT }, ...cfg } as FoundryConfig;
  return { name: g.name, nodes: g.nodes, edges: g.edges, config, sourcePath: "test.dot" };
}

const roleWithTools = (tools: string) => () => `---\nrole: Reviewer\ntools: "${tools}"\n---\nbody\n`;

function job(dot: string, id: string, readFile?: () => string): any {
  const { files } = compile(mkHarness(dot), readFile ? { readFile } : {});
  const f = files.find((x) => x.path.endsWith(`/${id}.yml`));
  expect(f, `${id}.yml`).toBeTruthy();
  return (yaml.load(f!.contents) as any).jobs[id];
}

const codes = (dot: string, level: string, readFile?: () => string) =>
  validate(mkHarness(dot), readFile ? { readFile } : {})
    .filter((d) => d.level === level)
    .map((d) => d.code);

const lane = (attrs = "") => `digraph t {
  start    [type=start]
  reviewer [type=pr-review, role="agents/roles/reviewer.md", context="pr-diff"${attrs ? ", " + attrs : ""}]
  start    -> reviewer [on="pull_request.opened, pull_request.synchronize"]
}`;
const SWEEP = `digraph t {
  approver [type=pr-review, role="agents/roles/approver.md", context="pr-review", select="sweep", schedule="*/10 * * * *", post="review"]
}`;

const stepNamed = (j: any, name: string) => j.steps.find((s: any) => s.name === name);

describe('post="review" compiles', () => {
  it("runs the agent without a GitHub token, even when its role lists gh, and posts after it", () => {
    const j = job(lane('post="review", skip="unchanged-diff"'), "reviewer", roleWithTools("Read,Bash(gh:*)"));
    const agent = stepNamed(j, "Run agent");
    expect(agent.id).toBe("agent");
    expect(agent.with["github-token"]).toBeUndefined();
    expect(agent.with["output-contract"]).toContain("```json");
    expect(agent.with["output-contract"]).toContain("The fence is required: a bare object at the very end is accepted as a fallback");
    expect(agent.with["output-contract"]).not.toContain("must be exactly one of");
    const names = j.steps.map((s: any) => s.name);
    // Post after the agent, and before the diff stamp, which stamps the posted review.
    expect(names.indexOf("Post the review")).toBe(names.indexOf("Run agent") + 1);
    expect(names.indexOf("Stamp the review with the diff hash")).toBeGreaterThan(names.indexOf("Post the review"));
    const post = stepNamed(j, "Post the review");
    expect(post.if).toBe("${{ success() }}");
    expect(post.env).toMatchObject({
      PR: "${{ github.event.pull_request.number }}",
      HEAD_SHA: "${{ github.event.pull_request.head.sha }}",
      STDOUT_FILE: "${{ steps.agent.outputs.stdout-file }}",
      BOT_LOGIN: BOT,
      POST_MARKER: "PR #<n> head <sha>",
      REQUIRE_VERDICT: "false",
    });
    expect(post.env.GH_TOKEN).toBeTruthy();
    // Nothing the agent wrote is spliced into the script.
    expect(post.run).not.toContain("${{");
  });

  it("leaves a lane without post= exactly as it was", () => {
    const j = job(lane(), "reviewer");
    expect(stepNamed(j, "Run agent").id).toBeUndefined();
    expect(stepNamed(j, "Run agent").with["output-contract"]).toBeUndefined();
    expect(stepNamed(j, "Post the review")).toBeUndefined();
  });

  it("holds a sweep lane's review to the verdict grammar, per matrix job", () => {
    const j = job(SWEEP, "approver");
    const post = stepNamed(j, "Post the review");
    expect(post.env).toMatchObject({ PR: "${{ matrix.pr.number }}", HEAD_SHA: "${{ matrix.pr.sha }}", REQUIRE_VERDICT: "true" });
    expect(post.env.VERDICT_LINES).toBe("**Verdict:** APPROVE\n**Verdict:** REQUEST_CHANGES\n**Verdict:** ESCALATE");
    expect(stepNamed(j, "Run agent").with["output-contract"]).toContain("must be exactly one of: `**Verdict:** APPROVE`");
  });

  it("takes a custom post_marker", () => {
    const j = job(lane('post="review", post_marker="Review of <sha> (#<n>)"'), "reviewer");
    expect(stepNamed(j, "Post the review").env.POST_MARKER).toBe("Review of <sha> (#<n>)");
  });
});

describe('validate: post= and post_marker=', () => {
  it("accepts post=review on a PR lane, and on a sweep", () => {
    expect(codes(lane('post="review"'), "error")).toEqual([]);
    expect(codes(SWEEP, "error")).toEqual([]);
  });
  it("rejects other values and other node types", () => {
    expect(codes(lane('post="comment"'), "error")).toContain("node.bad-post");
    const producer = `digraph t {\n  start [type=start]\n  b [type=producer, role="r.md", post="review"]\n  start -> b [on="issues.opened"]\n}`;
    expect(codes(producer, "error")).toContain("node.post-unsupported");
  });
  it("rejects post_marker without post, and a multi-line marker", () => {
    expect(codes(lane('post_marker="x"'), "error")).toContain("node.post-marker-without-post");
  });
  it("warns when the role still lists gh tools", () => {
    expect(codes(lane('post="review"'), "warning", roleWithTools("Read,Bash(gh pr view:*)"))).toContain("node.post-review-gh-tools");
    expect(codes(lane('post="review"'), "warning", roleWithTools("Read,Grep"))).not.toContain("node.post-review-gh-tools");
  });
});

// ── the post script, run against a stub gh ───────────────────────────────────

const GH_STUB = `#!/usr/bin/env bash
[ "$1" = "api" ] || { echo "stub gh: unsupported: $*" >&2; exit 2; }
shift
path=""; jqexpr=""; method="GET"; input=""; fields="{}"
while [ $# -gt 0 ]; do
  case "$1" in
    --jq) jqexpr="$2"; shift 2 ;;
    --method) method="$2"; shift 2 ;;
    --input) input="$2"; shift 2 ;;
    -f) fields=$(jq -c --arg kv "$2" '. + {($kv | split("=") | .[0]): ($kv | split("=") | .[1:] | join("="))}' <<< "$fields"); shift 2 ;;
    --paginate) shift ;;
    *) path="$1"; shift ;;
  esac
done
LINE_422='{"message":"Unprocessable Entity","errors":["Line could not be resolved"],"documentation_url":"https://docs.github.com/rest/pulls/reviews#create-a-review-for-a-pull-request","status":"422"}'
if [ "$method" != "GET" ]; then
  { echo "$method $path"; if [ -n "$input" ]; then cat "$input"; else echo "$fields"; fi; echo; } >> "$FIXTURES/writes.log"
  if [ -n "\${STUB_DISPATCH_FAIL:-}" ] && [[ "$path" == */dispatches ]]; then echo 'gh: Resource not accessible by integration (HTTP 403)' >&2; exit 1; fi
  # A rejection in gh's real shape: GitHub's error body on STDOUT, and only
  # gh's one-line summary on stderr.
  if [ -n "\${STUB_422_ALWAYS:-}" ] || { [ -n "\${STUB_422_IF_COMMENTS:-}" ] && [ "$(jq '.comments | length' "$input")" != "0" ]; }; then
    echo "\${STUB_422_BODY:-$LINE_422}"
    echo 'gh: Unprocessable Entity (HTTP 422)' >&2
    exit 1
  fi
  [ -n "\${STUB_NO_URL:-}" ] || echo '{"id":99,"html_url":"https://github.com/o/r/pull/7#pullrequestreview-99"}'
  exit 0
fi
if [ -n "\${STUB_EVENTS_FAIL:-}" ] && [[ "$path" == */events* ]]; then echo 'gh: Server Error (HTTP 502)' >&2; exit 1; fi
file="$FIXTURES/$(printf '%s' "$path" | sed 's/[^A-Za-z0-9]/_/g')"
[ -f "$file" ] || { echo "stub gh: no fixture for $path" >&2; exit 1; }
if [ -n "$jqexpr" ]; then jq -r "$jqexpr" "$file"; else cat "$file"; fi
`;

interface Ran {
  status: number;
  stdout: string;
  posts: any[];
  /** Every write, in order: `<METHOD> <path>` and its JSON body. */
  writes: { call: string; body: any }[];
  /** What the step appended to the job summary. */
  summary: string;
}

/** `files`: the PR's changed files (null: the read fails). */
function runPost(
  step: any,
  agentStdout: string,
  reviews: unknown[] = [],
  env: Record<string, string> = {},
  files: string[] | null = ["src/a.ts"],
  /** The PR's issue events (label history); omitted: the read fails. */
  events?: unknown[],
  /** The head's runs of the quiet verdict check (quiet_verdicts=); omitted: the read fails. */
  verdictChecks?: unknown[],
): Ran {
  const dir = mkdtempSync(join(tmpdir(), "gpf-post-"));
  const bin = join(dir, "bin");
  const fx = join(dir, "fx");
  mkdirSync(bin);
  mkdirSync(fx);
  writeFileSync(join(bin, "gh"), GH_STUB);
  chmodSync(join(bin, "gh"), 0o755);
  writeFileSync(join(fx, "repos/o/r/pulls/7/reviews?per_page=100".replace(/[^A-Za-z0-9]/g, "_")), JSON.stringify(reviews));
  if (events) {
    writeFileSync(join(fx, "repos/o/r/issues/7/events?per_page=100".replace(/[^A-Za-z0-9]/g, "_")), JSON.stringify(events));
    // The labels on the PR: those whose latest event (in API order) is "labeled".
    const on = new Map<string, boolean>();
    for (const e of events as { event: string; label?: { name: string } }[]) if (e.label) on.set(e.label.name, e.event === "labeled");
    writeFileSync(join(fx, "repos/o/r/issues/7/labels?per_page=100".replace(/[^A-Za-z0-9]/g, "_")), JSON.stringify([...on].filter(([, v]) => v).map(([name]) => ({ name }))));
  }
  if (verdictChecks && step.env.VERDICT_CHECK) {
    const q = `repos/o/r/commits/head1/check-runs?check_name=${encodeURIComponent(step.env.VERDICT_CHECK).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())}&filter=all&per_page=100`;
    writeFileSync(join(fx, q.replace(/[^A-Za-z0-9]/g, "_")), JSON.stringify({ check_runs: verdictChecks }));
  }
  if (files) {
    writeFileSync(
      join(fx, "repos/o/r/pulls/7/files?per_page=100".replace(/[^A-Za-z0-9]/g, "_")),
      JSON.stringify(files.map((filename) => ({ filename }))),
    );
  }
  const out = join(dir, "stdout.txt");
  writeFileSync(out, agentStdout);
  const summaryFile = join(dir, "summary.md");
  writeFileSync(summaryFile, "### Agent output\n\n(the agent's text)\n");
  const literal: Record<string, string> = {};
  for (const [k, v] of Object.entries(step.env as Record<string, string>)) if (!String(v).includes("${{")) literal[k] = String(v);
  let status = 0;
  let stdout = "";
  try {
    stdout = execFileSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", step.run], {
      env: { PATH: `${bin}:${process.env.PATH}`, GITHUB_REPOSITORY: "o/r", FIXTURES: fx, ...literal, PR: "7", HEAD_SHA: "head1", STDOUT_FILE: out, GH_TOKEN: "t", GITHUB_STEP_SUMMARY: summaryFile, ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e: any) {
    status = e.status ?? 1;
    stdout = (e.stdout ?? "") + (e.stderr ?? "");
  }
  const log = join(fx, "writes.log");
  const writes: Ran["writes"] = [];
  if (existsSync(log)) {
    // Each write is "<METHOD> <path>" then its JSON body (one line; blank lines between).
    const lines = readFileSync(log, "utf8").split("\n").filter((l) => l.trim());
    for (let i = 0; i < lines.length; i++) {
      if (/^(POST|PUT|PATCH|DELETE) /.test(lines[i]!)) writes.push({ call: lines[i]!, body: JSON.parse(lines[++i]!) });
    }
  }
  const posts = writes.filter((w) => w.call === "POST repos/o/r/pulls/7/reviews").map((w) => w.body);
  return { status, stdout, posts, writes, summary: readFileSync(summaryFile, "utf8").replace("### Agent output\n\n(the agent's text)\n", "") };
}

const fence = (obj: unknown) => "```json\n" + JSON.stringify(obj) + "\n```\n";
const REVIEW = { body: "Two findings.\n\nBoth `minor`, with \"quotes\" and $(dollars).", comments: [{ path: "src/a.ts", line: 4, side: "RIGHT", body: "Leaks the handle." }], event: "COMMENT" };

/** The hidden marker a lane's post step appends: its record of "I posted this, for this head". */
const posted = (node: string, sha = "head1") => `\n\n<!-- gp-foundry:posted:${node}:${sha} -->`;

describe("the post script, run against a stub gh", () => {
  const plain = () => stepNamed(job(lane('post="review"'), "reviewer"), "Post the review");
  const verdictLane = () => stepNamed(job(SWEEP, "approver"), "Post the review");

  it("posts the last fenced json block, headed and bound to the head", () => {
    const out = `Here is my review.\n\n${fence({ body: "draft" })}\nOn reflection:\n\n${fence(REVIEW)}`;
    const r = runPost(plain(), out);
    expect(r.status).toBe(0);
    expect(r.posts).toHaveLength(1);
    expect(r.posts[0]).toEqual({
      commit_id: "head1",
      event: "COMMENT",
      body: `PR #7 head head1\n\n${REVIEW.body}${posted("reviewer")}`,
      comments: REVIEW.comments,
    });
  });

  it("posts nothing, with a warning, when there is no block or it is malformed", () => {
    const none = runPost(plain(), "I couldn't post the review: the shell blocked it.");
    expect(none.status).toBe(0);
    expect(none.posts).toEqual([]);
    expect(none.stdout).toContain("::warning::no review in the agent's output: neither a fenced json block nor a bare JSON object");
    expect(none.stdout).toContain("I couldn't post the review");

    const broken = runPost(plain(), "```json\n{\"body\": \"unterminated\n```\n");
    expect(broken.status).toBe(0);
    expect(broken.posts).toEqual([]);
    expect(broken.stdout).toContain("::warning::the review block is not a valid review");

    for (const bad of [
      { comments: [] },
      { body: "x", event: "APPROVE" },
      { body: "x", comments: [{ path: "a", line: 1.5, body: "y" }] },
      { body: "x", comments: [{ path: "a", body: "y" }] },
      ["not", "an", "object"],
    ]) {
      const r = runPost(plain(), fence(bad));
      expect(r.posts, JSON.stringify(bad)).toEqual([]);
      expect(r.stdout).toContain("not a valid review");
    }
  });

  describe("with no fence, falls back to a bare JSON object at the end", () => {
    const expected = { commit_id: "head1", event: "COMMENT", body: `PR #7 head head1\n\n${REVIEW.body}${posted("reviewer")}`, comments: REVIEW.comments };

    it("posts a bare object that ends the output, exactly as the fenced form", () => {
      // Observed live: the agent ended its final message with the object, unfenced.
      const fenced = runPost(plain(), fence(REVIEW));
      const bare = runPost(plain(), JSON.stringify(REVIEW) + "\n");
      expect(bare.status).toBe(0);
      expect(bare.posts).toEqual([expected]);
      expect(bare.posts).toEqual(fenced.posts);
      expect(bare.stdout).toContain("using the bare JSON object at its end");
    });

    it("finds the object after prose, pretty-printed, and ignores trailing noise", () => {
      const prose = runPost(plain(), `Here is my review.\n\nIt covers {braces} too.\n${JSON.stringify(REVIEW)}`);
      expect(prose.posts).toEqual([expected]);
      // Pretty-printed: the comment's own "{" line is not mistaken for the review.
      const pretty = runPost(plain(), `Done.\n\n${JSON.stringify(REVIEW, null, 2)}\n\nThat is all.\n`);
      expect(pretty.posts).toEqual([expected]);
    });

    it("lets a fenced block win over a later bare object", () => {
      const r = runPost(plain(), `${fence(REVIEW)}\nAnd again:\n${JSON.stringify({ body: "the bare one" })}\n`);
      expect(r.posts).toEqual([expected]);
      expect(r.stdout).not.toContain("bare JSON object at its end");
    });

    it("posts nothing when the bare object has no string body", () => {
      for (const bad of [{ comments: [] }, { body: 3 }]) {
        const r = runPost(plain(), `My review:\n${JSON.stringify(bad)}\n`);
        expect(r.status).toBe(0);
        expect(r.posts, JSON.stringify(bad)).toEqual([]);
        expect(r.stdout).toContain("neither a fenced json block nor a bare JSON object");
      }
    });

    it("holds a bare object to the same validation and verdict rules", () => {
      const r = runPost(plain(), JSON.stringify({ body: "x", event: "APPROVE" }));
      expect(r.posts).toEqual([]);
      expect(r.stdout).toContain("not a valid review");
      expect(runPost(verdictLane(), JSON.stringify({ body: "Ship it." })).stdout).toContain("not one of the verdict lines");
      expect(runPost(verdictLane(), JSON.stringify({ body: "Ship it.\n\n**Verdict:** APPROVE" })).posts).toHaveLength(1);
    });
  });

  it("does not post again when its heading is already on the head", () => {
    const existing = [{ user: { login: BOT }, commit_id: "head1", body: "PR #7 head head1\n\nEarlier text." }];
    const r = runPost(plain(), fence(REVIEW), existing);
    expect(r.status).toBe(0);
    expect(r.posts).toEqual([]);
    expect(r.stdout).toContain("reviewer has already posted its review on head1");
    // The same heading on another head, or by someone else, does not count.
    expect(runPost(plain(), fence(REVIEW), [{ ...existing[0], commit_id: "old" }]).posts).toHaveLength(1);
    expect(runPost(plain(), fence(REVIEW), [{ ...existing[0], user: { login: "mallory" } }]).posts).toHaveLength(1);
  });

  describe("idempotency is keyed on the lane that posted", () => {
    const heading = "PR #7 head head1\n\n";
    const by = (body: string, over: Record<string, unknown> = {}) => ({ user: { login: BOT }, commit_id: "head1", body, ...over });
    const approve = fence({ body: "Ship it.\n\n**Verdict:** APPROVE" });
    const reject = { body: "One problem.\n\n**Verdict:** REQUEST_CHANGES", comments: [], event: "COMMENT" };

    it("two lanes sharing a bot login and a heading do not silence each other", () => {
      const reviewers = by(`${heading}Two findings, both minor.${posted("reviewer")}`);
      const approvers = by(`${heading}Fine.\n\n**Verdict:** APPROVE${posted("approver")}`);

      // The reviewer's review on the head does not stop the approver's verdict…
      const approver = runPost(verdictLane(), approve, [reviewers]);
      expect(approver.posts).toHaveLength(1);
      expect(approver.posts[0].body).toBe(`${heading}Ship it.\n\n**Verdict:** APPROVE${posted("approver")}`);
      // …and the approver's verdict does not stop the reviewer.
      expect(runPost(plain(), fence(REVIEW), [approvers]).posts).toHaveLength(1);

      // Each is stopped by its own.
      const again = runPost(verdictLane(), approve, [reviewers, approvers]);
      expect(again.posts).toEqual([]);
      expect(again.stdout).toContain("approver has already posted its review on head1");
      expect(runPost(plain(), fence(REVIEW), [approvers, reviewers]).posts).toEqual([]);
    });

    it("a reviewer that posts its OWN verdict does not post it twice", () => {
      // The classic reviewer → fixer lane: not a sweep, but its review ends in a
      // verdict line. Keyed on "is it a verdict", a re-run on the same head
      // (labeled, ready_for_review, a workflow re-run) posted a duplicate — and
      // every duplicate is a new review event that fires the fixer.
      const first = runPost(plain(), fence(reject));
      expect(first.posts).toHaveLength(1);
      expect(first.posts[0].body).toBe(`${heading}${reject.body}${posted("reviewer")}`);
      const rerun = runPost(plain(), fence(reject), [by(first.posts[0].body)]);
      expect(rerun.status).toBe(0);
      expect(rerun.posts).toEqual([]);
    });

    it("the marker binds to the head: the same lane posts again on a new one", () => {
      const old = by(`${heading}Earlier.${posted("reviewer", "old")}`, { commit_id: "old" });
      expect(runPost(plain(), fence(REVIEW), [old]).posts).toHaveLength(1);
      // A marker for another head quoted into a review on this one is not this head's.
      const quoted = by(`Something else entirely.${posted("reviewer", "old")}`);
      expect(runPost(plain(), fence(REVIEW), [quoted]).posts).toHaveLength(1);
    });

    it("only the bot's own marker counts", () => {
      const forged = by(`${heading}x${posted("reviewer")}`, { user: { login: "mallory" } });
      expect(runPost(plain(), fence(REVIEW), [forged]).posts).toHaveLength(1);
    });

    describe("reviews posted before the marker existed", () => {
      const legacyPlain = by(`${heading}Two findings, both minor.`);
      const legacyVerdict = by(`${heading}Fine.\n\n**Verdict:** APPROVE\n\n<!-- gp-foundry:diff:approver:abc -->`);
      const legacyReject = by(`${heading}One problem.\n\n**Verdict:** REQUEST_CHANGES`);

      it("a verdict lane is stopped by an unmarked verdict under its heading, not by a plain review", () => {
        expect(runPost(verdictLane(), approve, [legacyPlain]).posts).toHaveLength(1);
        expect(runPost(verdictLane(), approve, [legacyPlain, legacyVerdict]).posts).toEqual([]);
      });

      it("a plain lane is stopped by any unmarked review under its heading, verdict or not", () => {
        expect(runPost(plain(), fence(REVIEW), [legacyPlain]).posts).toEqual([]);
        expect(runPost(plain(), fence(reject), [legacyReject]).posts).toEqual([]);
      });

      it("the fallback never applies to a review another lane has marked as its own", () => {
        // Same heading, but it is the approver's: the reviewer still posts.
        const approvers = by(`${heading}Fine.\n\n**Verdict:** APPROVE${posted("approver")}`);
        expect(runPost(plain(), fence(reject), [approvers]).posts).toHaveLength(1);
      });
    });

    it("compiles the lane's id and the marker prefix into the step", () => {
      expect(plain().env.NODE).toBe("reviewer");
      expect(verdictLane().env.NODE).toBe("approver");
      expect(plain().env.POSTED_PREFIX).toBe("<!-- gp-foundry:posted:");
      expect(plain().env.REQUIRE_VERDICT).toBe("false");
      expect(verdictLane().env.REQUIRE_VERDICT).toBe("true");
      // Both places the script tests verdict-ness use the one shared expression.
      expect(plain().run).not.toContain("__IS_VERDICT_JQ__");
      expect(plain().run.split(IS_VERDICT_JQ)).toHaveLength(3);
    });
  });

  it("on a 422 for an inline comment, retries once with the findings in the body", () => {
    const r = runPost(plain(), fence(REVIEW), [], { STUB_422_IF_COMMENTS: "1" });
    expect(r.status).toBe(0);
    expect(r.posts).toHaveLength(2);
    expect(r.posts[1].comments).toEqual([]);
    expect(r.posts[1].body).toBe(`PR #7 head head1\n\n${REVIEW.body}\n\n### Findings on unchanged lines\n\n- \`src/a.ts:4\` — Leaks the handle.${posted("reviewer")}`);
    expect(r.stdout).toContain("posting the findings in the body instead");
    // The reason comes from the response body, not gh's stderr line.
    expect(r.stdout).toContain("Line could not be resolved");
  });

  it("retries any 422 that has inline comments to move, but only once", () => {
    const body = '{"message":"Validation Failed","errors":["pull_request_review_thread.end_commit_oid is not part of the pull request"]}';
    const r = runPost(plain(), fence(REVIEW), [], { STUB_422_ALWAYS: "1", STUB_422_BODY: body });
    expect(r.status).not.toBe(0);
    expect(r.posts).toHaveLength(2);
    expect(r.posts[1].comments).toEqual([]);
    expect(r.stdout).toContain("could not post the review: gh: Unprocessable Entity (HTTP 422) Validation Failed — pull_request_review_thread");
  });

  it("fails on a 422 with no inline comments, quoting the response body", () => {
    const body = '{"message":"Validation Failed","errors":[{"resource":"PullRequestReview","code":"custom","message":"Body is too long"}]}';
    const r = runPost(plain(), fence({ body: "No findings." }), [], { STUB_422_ALWAYS: "1", STUB_422_BODY: body });
    expect(r.status).toBe(1);
    expect(r.posts).toHaveLength(1);
    expect(r.stdout).not.toContain("posting the findings in the body instead");
    expect(r.stdout).toContain("::error::could not post the review: gh: Unprocessable Entity (HTTP 422) Validation Failed — Body is too long");
  });

  describe("comments on files outside the diff", () => {
    const OFF = { path: "tests/fake.py", line: 179, side: "RIGHT", body: "Not in this PR." };
    const review = { ...REVIEW, comments: [...REVIEW.comments, OFF] };

    it("moves them into the body before posting, so GitHub never rejects the review", () => {
      const r = runPost(plain(), fence(review), [], {}, ["src/a.ts", "src/b.ts"]);
      expect(r.status).toBe(0);
      expect(r.posts).toHaveLength(1);
      expect(r.posts[0].comments).toEqual(REVIEW.comments);
      expect(r.posts[0].body).toBe(
        `PR #7 head head1\n\n${REVIEW.body}\n\n### Findings on unchanged lines\n\n- \`tests/fake.py:179\` — Not in this PR.${posted("reviewer")}`,
      );
      expect(r.stdout).toContain("1 inline comment(s) on files outside the PR's diff");
    });

    it("keeps a verdict lane's verdict line last", () => {
      const r = runPost(verdictLane(), fence({ ...review, body: "Fine.\n\n**Verdict:** APPROVE" }));
      expect(r.posts).toHaveLength(1);
      expect(r.posts[0].comments).toEqual(REVIEW.comments);
      expect(r.posts[0].body).toContain("### Findings on unchanged lines\n\n- `tests/fake.py:179`");
      expect(r.posts[0].body.endsWith(`\n\n**Verdict:** APPROVE${posted("approver")}`)).toBe(true);
    });

    it("lists every finding once when the rest are then rejected too", () => {
      const r = runPost(plain(), fence(review), [], { STUB_422_IF_COMMENTS: "1" });
      expect(r.status).toBe(0);
      expect(r.posts).toHaveLength(2);
      expect(r.posts[1].comments).toEqual([]);
      expect(r.posts[1].body.split("### Findings on unchanged lines")).toHaveLength(2);
      expect(r.posts[1].body).toContain("- `src/a.ts:4` — Leaks the handle.\n- `tests/fake.py:179` — Not in this PR.");
    });

    it("posts the comments as they are when the changed files cannot be read", () => {
      const r = runPost(plain(), fence(review), [], {}, null);
      expect(r.status).toBe(0);
      expect(r.posts).toHaveLength(1);
      expect(r.posts[0].comments).toEqual(review.comments);
      expect(r.stdout).toContain("could not read the PR's changed files");
    });
  });

  it("keeps a verdict lane's verdict line last when it moves the findings", () => {
    const review = { ...REVIEW, body: "Fine.\n\n**Verdict:** APPROVE" };
    const r = runPost(verdictLane(), fence(review), [], { STUB_422_IF_COMMENTS: "1" });
    expect(r.posts).toHaveLength(2);
    // Last VISIBLE line: only the hidden posted marker follows it.
    expect(r.posts[1].body.endsWith(`\n\n**Verdict:** APPROVE${posted("approver")}`)).toBe(true);
    expect(r.posts[1].body).toContain("### Findings on unchanged lines");
  });

  it("on a verdict lane, posts only a body ending in an exact verdict line", () => {
    expect(runPost(verdictLane(), fence({ body: "Ship it.\n\n**Verdict:** APPROVE" })).posts).toHaveLength(1);
    for (const body of ["Ship it.", "Ship it.\n\n**Verdict:** APPROVE (once gates pass)", "**Verdict:** APPROVE\n\nThanks!"]) {
      const r = runPost(verdictLane(), fence({ body }));
      expect(r.posts, body).toEqual([]);
      expect(r.stdout).toContain("not one of the verdict lines");
    }
  });

  it("fails red, without posting, when the existing reviews cannot be read", () => {
    const dir = runPost(plain(), fence(REVIEW), "missing" as any);
    // A fixture that is not a JSON array makes the read fail.
    expect(dir.status).not.toBe(0);
    expect(dir.posts).toEqual([]);
  });
});

describe("run-agent: output contract and stdout-file", () => {
  const action: any = yaml.load(readFileSync(new URL("../actions/run-agent/action.yml", import.meta.url), "utf8"));
  const stepRun = (name: string) => action.runs.steps.find((s: any) => s.name === name).run;

  it("appends the output contract as the prompt's last section", () => {
    const dir = mkdtempSync(join(tmpdir(), "gpf-assemble-"));
    const role = join(dir, "role.md");
    const ctxFile = join(dir, "ctx.md");
    writeFileSync(role, "You review.\n");
    writeFileSync(ctxFile, "THE DIFF\n");
    const out = join(dir, "out");
    writeFileSync(out, "");
    execFileSync("bash", ["-c", stepRun("Assemble prompt")], {
      env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, ROLE_FILE: role, PROMPT_OVERRIDE_FILE: "", CONTEXT_FILE: ctxFile, CONVENTIONS: "", COMMS_FILE: "", SCOPE_PATH: "", OUTPUT_CONTRACT: "End with a json block." },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const promptFile = readFileSync(out, "utf8").match(/prompt-file=(.*)/)![1]!;
    const prompt = readFileSync(promptFile, "utf8");
    expect(prompt.indexOf("THE DIFF")).toBeLessThan(prompt.indexOf("## Output"));
    expect(prompt.trimEnd().endsWith("## Output\n\nEnd with a json block.")).toBe(true);
  });

  it("exposes the agent's stdout file as an output", () => {
    expect(action.outputs["stdout-file"].value).toBe("${{ steps.run.outputs.stdout-file }}");
    expect(action.runs.steps.find((s: any) => s.name === "Run agent").id).toBe("run");
    expect(stepRun("Run agent")).toContain('echo "stdout-file=${STDOUT_LOG}"');
  });
});

describe("the job summary says what became of the review", () => {
  const plain = () => stepNamed(job(lane('post="review"'), "reviewer"), "Post the review");
  const verdictLane = () => stepNamed(job(SWEEP, "approver"), "Post the review");

  it("links to the posted review, under the agent's output", () => {
    const r = runPost(plain(), fence(REVIEW));
    expect(r.posts).toHaveLength(1);
    expect(r.summary.trim()).toBe("**Review posted:** https://github.com/o/r/pull/7#pullrequestreview-99");
  });

  it("still says it was posted when the response carries no URL", () => {
    const r = runPost(plain(), fence(REVIEW), [], { STUB_NO_URL: "1" });
    expect(r.summary).toContain("**Review posted** on head1.");
  });

  it("links to the review posted by the 422 retry", () => {
    const r = runPost(plain(), fence(REVIEW), [], { STUB_422_IF_COMMENTS: "1" });
    expect(r.posts).toHaveLength(2);
    expect(r.summary).toContain("**Review posted:** https://github.com/o/r/pull/7#pullrequestreview-99");
  });

  it("says plainly when nothing was posted, and why", () => {
    expect(runPost(plain(), "").summary).toContain("No review was posted: the agent printed nothing");
    expect(runPost(plain(), "Just prose, no block.").summary).toContain("No review was posted: the agent's output held no review block");
    expect(runPost(plain(), fence({ body: 7 })).summary).toContain("No review was posted: the review block was not valid");
    expect(runPost(verdictLane(), fence({ body: "No verdict here." })).summary).toContain("its last line is not one of the verdict lines");
  });

  it("says so when this head's review was already posted", () => {
    const existing = [{ user: { login: BOT }, commit_id: "head1", body: "PR #7 head head1\n\nEarlier.\n\n<!-- gp-foundry:posted:reviewer:head1 -->" }];
    const r = runPost(plain(), fence(REVIEW), existing);
    expect(r.posts).toEqual([]);
    expect(r.summary).toContain("already posted");
  });

  it("writes nothing when there is no job summary to write to", () => {
    const r = runPost(plain(), fence(REVIEW), [], { GITHUB_STEP_SUMMARY: "" });
    expect(r.status).toBe(0);
    expect(r.posts).toHaveLength(1);
  });
});

describe("a re-review request: the post step posts a fresh review on the same head", () => {
  const RR = { rollout: {}, labels: { re_review: "re-review" } } as Partial<FoundryConfig>;
  const step = () => {
    const { files } = compile(mkHarness(lane('post="review"'), RR));
    const wf = yaml.load(files.find((f) => f.path.endsWith("/reviewer.yml"))!.contents) as any;
    return stepNamed(wf.jobs.reviewer, "Post the review");
  };
  const mine = (at: string) => ({ user: { login: BOT }, commit_id: "head1", submitted_at: at, body: `PR #7 head head1\n\nEarlier.\n\n<!-- gp-foundry:posted:reviewer:head1 -->` });
  const labelled = [{ event: "labeled", label: { name: "re-review" }, created_at: "2026-11-17T12:00:00Z" }, { event: "labeled", label: { name: "other" }, created_at: "2026-11-17T13:00:00Z" }];

  it("carries the label to the step", () => {
    expect(step().env.REREVIEW_LABEL).toBe("re-review");
    // Without one configured, no extra read.
    expect(stepNamed(job(lane('post="review"'), "reviewer"), "Post the review").env.REREVIEW_LABEL).toBeUndefined();
  });

  it("a review posted before the label was added no longer stops it", () => {
    const r = runPost(step(), fence(REVIEW), [mine("2026-11-17T11:00:00Z")], {}, ["src/a.ts"], labelled);
    expect(r.status).toBe(0);
    expect(r.posts).toHaveLength(1);
  });

  it("…but the fresh one does: a re-run on the same head posts nothing", () => {
    const r = runPost(step(), fence(REVIEW), [mine("2026-11-17T11:00:00Z"), mine("2026-11-17T12:30:00Z")], {}, ["src/a.ts"], labelled);
    expect(r.posts).toEqual([]);
  });

  it("never re-requested: idempotent as before", () => {
    const r = runPost(step(), fence(REVIEW), [mine("2026-11-17T11:00:00Z")], {}, ["src/a.ts"], []);
    expect(r.posts).toEqual([]);
  });

  it("the label on but its history unreadable: posts anyway, with a warning (a duplicate at worst, never a dropped request)", () => {
    const r = runPost(step(), fence(REVIEW), [mine("2026-11-17T11:00:00Z")], { STUB_EVENTS_FAIL: "1" }, ["src/a.ts"], labelled);
    expect(r.status).toBe(0);
    expect(r.posts).toHaveLength(1);
  });

  it("the label NOT on: no history read is needed, and a re-run stays idempotent", () => {
    const r = runPost(step(), fence(REVIEW), [mine("2026-11-17T11:00:00Z")], { STUB_EVENTS_FAIL: "1" }, ["src/a.ts"], []);
    expect(r.posts).toEqual([]);
  });

  it("removed and re-added in the same second: API order decides, as in the gate (the request stands)", () => {
    const toggled = [
      { event: "labeled", label: { name: "re-review" }, created_at: "2026-11-17T10:00:00Z" },
      { event: "unlabeled", label: { name: "re-review" }, created_at: "2026-11-17T12:00:00Z" },
      { event: "labeled", label: { name: "re-review" }, created_at: "2026-11-17T12:00:00Z" },
    ];
    const r = runPost(step(), fence(REVIEW), [mine("2026-11-17T11:00:00Z")], {}, ["src/a.ts"], toggled);
    expect(r.posts).toHaveLength(1);
  });

  it("the label removed by hand since: no request, idempotent as before", () => {
    const removed = [...labelled, { event: "unlabeled", label: { name: "re-review" }, created_at: "2026-11-17T12:10:00Z" }];
    const r = runPost(step(), fence(REVIEW), [mine("2026-11-17T11:00:00Z")], {}, ["src/a.ts"], removed);
    expect(r.posts).toEqual([]);
  });
});

describe("quiet_verdicts: a verdict that needs nothing from the author is a check run, not a review", () => {
  const APP_CFG = { identity: { bot_login: BOT, app_id_secret: "APP_ID", app_key_secret: "APP_KEY" } } as Partial<FoundryConfig>;
  const QUIET_SWEEP = SWEEP.replace('post="review"', 'post="review", quiet_verdicts="APPROVE"');
  const quietStep = () => {
    const { files } = compile(mkHarness(QUIET_SWEEP, APP_CFG));
    const wf = yaml.load(files.find((f) => f.path.endsWith("/approver.yml"))!.contents) as any;
    return stepNamed(wf.jobs.approver, "Post the review");
  };
  const CHECK = "gp-foundry/verdict (approver)";
  const approve = { body: "Looks right.\n\n**Verdict:** APPROVE", comments: [{ path: "src/a.ts", line: 4, body: "Nit: name." }] };
  const reject = { body: "One blocker.\n\n**Verdict:** REQUEST_CHANGES", comments: [] };
  const ours = (over: object = {}) => ({ name: CHECK, head_sha: "head1", status: "completed", conclusion: "success", completed_at: "2026-11-18T10:00:00Z", app: { slug: "agent-bot" }, output: { title: "Verdict: APPROVE" }, ...over });

  it("an APPROVE is delivered as the App's completed check on the head — no review", () => {
    const r = runPost(quietStep(), fence(approve), [], {}, ["src/a.ts"], undefined, []);
    expect(r.status).toBe(0);
    expect(r.posts).toEqual([]);
    expect(r.writes.map((w) => w.call)).toEqual(["POST repos/o/r/check-runs"]);
    const c = r.writes[0]!.body;
    expect(c).toMatchObject({ name: CHECK, head_sha: "head1", status: "completed", conclusion: "success", external_id: "gp-foundry:verdict:approver:head1" });
    expect(c.output.title).toBe("Verdict: APPROVE");
    // The visible body without the verdict line; inline findings moved into it.
    expect(c.output.summary).toContain("Looks right.");
    expect(c.output.summary).toContain("`src/a.ts:4` — Nit: name.");
    expect(c.output.summary).not.toContain("**Verdict:**");
    expect(r.summary).toContain("Verdict delivered as a check");
  });

  it("any other verdict still posts a review, exactly as before", () => {
    const r = runPost(quietStep(), fence(reject), [], {}, ["src/a.ts"], undefined, []);
    expect(r.posts).toHaveLength(1);
    expect(r.writes.map((w) => w.call)).toEqual(["POST repos/o/r/pulls/7/reviews"]);
  });

  it("a retried post step creates no second check: the App's check on this head counts as posted", () => {
    const r = runPost(quietStep(), fence(approve), [], {}, ["src/a.ts"], undefined, [ours()]);
    expect(r.status).toBe(0);
    expect(r.writes).toEqual([]);
  });

  it("a check of the same name from another App does not", () => {
    const r = runPost(quietStep(), fence(approve), [], {}, ["src/a.ts"], undefined, [ours({ app: { slug: "someone-else" } })]);
    expect(r.writes.map((w) => w.call)).toEqual(["POST repos/o/r/check-runs"]);
  });

  it("the title comes from the verdict line, even with findings and a trailing HTML comment", () => {
    const body = { body: "Looks good.\n\n**Verdict:** APPROVE\n<!-- note -->", comments: [{ path: "src/a.ts", line: 2, body: "nit: rename foo" }] };
    const r = runPost(quietStep(), fence(body), [], {}, ["src/a.ts"], undefined, []);
    const c = r.writes[0]!.body;
    expect(c.output.title).toBe("Verdict: APPROVE");
    expect(c.output.summary).toBe("Looks good.\n\n### Findings\n\n- `src/a.ts:2` — nit: rename foo");
  });

  it("a check of the right name and App but no verdict title is not a verdict: delivered again", () => {
    const r = runPost(quietStep(), fence(approve), [], {}, ["src/a.ts"], undefined, [ours({ output: { title: "Verdict: foo bar" } })]);
    expect(r.writes.map((w) => w.call)).toEqual(["POST repos/o/r/check-runs"]);
  });

  it("the App's slug is compared without case", () => {
    const r = runPost(quietStep(), fence(approve), [], {}, ["src/a.ts"], undefined, [ours({ app: { slug: "Agent-Bot" } })]);
    expect(r.writes).toEqual([]);
  });

  it("a token from another App than identity.bot_login names: posted as a review, with a warning", () => {
    const s = quietStep();
    expect(s.env.MINTED_APP).toBe("${{ steps.app-token.outputs.app-slug }}");
    const r = runPost(s, fence(approve), [], { MINTED_APP: "other-app" }, ["src/a.ts"], undefined, []);
    expect(r.posts).toHaveLength(1);
    expect(r.stdout).toContain("posted as a review");
    expect(runPost(s, fence(approve), [], { MINTED_APP: "agent-bot" }, ["src/a.ts"], undefined, []).writes.map((w) => w.call)).toEqual(["POST repos/o/r/check-runs"]);
  });

  it("an unreadable check history: nothing posted, red (a retry must not deliver twice)", () => {
    const r = runPost(quietStep(), fence(approve), [], {}, ["src/a.ts"]);
    expect(r.status).not.toBe(0);
    expect(r.writes).toEqual([]);
  });

  it("output without a verdict line is still refused", () => {
    const r = runPost(quietStep(), fence({ body: "No verdict here." }), [], {}, ["src/a.ts"], undefined, []);
    expect(r.writes).toEqual([]);
  });

  it("off: the step is the one it always was", () => {
    const off = stepNamed(job(SWEEP, "approver"), "Post the review");
    expect(off.run).not.toContain("quiet_verdicts");
    expect(off.env.VERDICT_CHECK).toBeUndefined();
  });
});

describe("quiet_verdicts: the gate is nudged, since a check run starts no gate run", () => {
  const APP_CFG = { identity: { bot_login: BOT, app_id_secret: "APP_ID", app_key_secret: "APP_KEY" }, rollout: {} } as Partial<FoundryConfig>;
  const WITH_GATE = `digraph t {
  approver [type=pr-review, role="agents/roles/approver.md", context="pr-review", select="sweep", schedule="*/10 * * * *", post="review", quiet_verdicts="APPROVE"]
  merge_gate [type=merge-gate, policy="agents/policy/merge.yaml", schedule="*/10 * * * *", merge="off"]
}`;
  const step = () => {
    const { files } = compile(mkHarness(WITH_GATE, APP_CFG));
    const wf = yaml.load(files.find((f) => f.path.endsWith("/approver.yml"))!.contents) as any;
    return stepNamed(wf.jobs.approver, "Post the review");
  };
  const approve = { body: "Looks right.\n\n**Verdict:** APPROVE" };

  it("after delivering the check, dispatches the gate for this PR with the job's own token", () => {
    const s = step();
    expect(s.env).toMatchObject({ GATE_WORKFLOWS: "merge_gate.yml", DISPATCH_TOKEN: "${{ github.token }}", BASE_BRANCH: "main" });
    const r = runPost(s, fence(approve), [], { DISPATCH_TOKEN: "gt" }, ["src/a.ts"], undefined, []);
    expect(r.status).toBe(0);
    expect(r.writes.map((w) => w.call)).toEqual(["POST repos/o/r/check-runs", "POST repos/o/r/actions/workflows/merge_gate.yml/dispatches"]);
    expect(r.writes[1]!.body).toEqual({ ref: "main", "inputs[pr]": "7" });
  });

  it("a failed dispatch is a warning: the verdict is delivered, the scheduled pass catches up", () => {
    const r = runPost(step(), fence(approve), [], { STUB_DISPATCH_FAIL: "1", DISPATCH_TOKEN: "gt" }, ["src/a.ts"], undefined, []);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("its scheduled pass will evaluate it");
  });

  it("a review-delivered verdict dispatches nothing: its own event starts the gate", () => {
    const r = runPost(step(), fence({ body: "No.\n\n**Verdict:** REQUEST_CHANGES" }), [], {}, ["src/a.ts"], undefined, []);
    expect(r.writes.map((w) => w.call)).toEqual(["POST repos/o/r/pulls/7/reviews"]);
  });
});
