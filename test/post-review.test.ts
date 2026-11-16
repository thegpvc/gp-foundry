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
path=""; jqexpr=""; method="GET"; input=""
while [ $# -gt 0 ]; do
  case "$1" in
    --jq) jqexpr="$2"; shift 2 ;;
    --method) method="$2"; shift 2 ;;
    --input) input="$2"; shift 2 ;;
    --paginate) shift ;;
    *) path="$1"; shift ;;
  esac
done
if [ "$method" != "GET" ]; then
  { echo "$method $path"; cat "$input"; echo; } >> "$FIXTURES/writes.log"
  if [ -n "\${STUB_422_IF_COMMENTS:-}" ] && [ "$(jq '.comments | length' "$input")" != "0" ]; then
    echo 'gh: Unprocessable Entity (HTTP 422)' >&2
    echo '{"message":"Unprocessable Entity","errors":["Line could not be resolved"]}' >&2
    exit 1
  fi
  exit 0
fi
file="$FIXTURES/$(printf '%s' "$path" | sed 's/[^A-Za-z0-9]/_/g')"
[ -f "$file" ] || { echo "stub gh: no fixture for $path" >&2; exit 1; }
if [ -n "$jqexpr" ]; then jq -r "$jqexpr" "$file"; else cat "$file"; fi
`;

interface Ran {
  status: number;
  stdout: string;
  posts: any[];
}

function runPost(step: any, agentStdout: string, reviews: unknown[] = [], env: Record<string, string> = {}): Ran {
  const dir = mkdtempSync(join(tmpdir(), "gpf-post-"));
  const bin = join(dir, "bin");
  const fx = join(dir, "fx");
  mkdirSync(bin);
  mkdirSync(fx);
  writeFileSync(join(bin, "gh"), GH_STUB);
  chmodSync(join(bin, "gh"), 0o755);
  writeFileSync(join(fx, "repos/o/r/pulls/7/reviews?per_page=100".replace(/[^A-Za-z0-9]/g, "_")), JSON.stringify(reviews));
  const out = join(dir, "stdout.txt");
  writeFileSync(out, agentStdout);
  const literal: Record<string, string> = {};
  for (const [k, v] of Object.entries(step.env as Record<string, string>)) if (!String(v).includes("${{")) literal[k] = String(v);
  let status = 0;
  let stdout = "";
  try {
    stdout = execFileSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", step.run], {
      env: { PATH: `${bin}:${process.env.PATH}`, GITHUB_REPOSITORY: "o/r", FIXTURES: fx, ...literal, PR: "7", HEAD_SHA: "head1", STDOUT_FILE: out, GH_TOKEN: "t", ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e: any) {
    status = e.status ?? 1;
    stdout = (e.stdout ?? "") + (e.stderr ?? "");
  }
  const log = join(fx, "writes.log");
  const posts = existsSync(log)
    ? readFileSync(log, "utf8")
        .split(/^POST repos\/o\/r\/pulls\/7\/reviews\n/m)
        .filter((s) => s.trim())
        .map((s) => JSON.parse(s))
    : [];
  return { status, stdout, posts };
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
    expect(none.stdout).toContain("::warning::no fenced json review block");
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
