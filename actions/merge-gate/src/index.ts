/**
 * merge-gate action wrapper (C7).
 *
 * Thin I/O shell around the pure `evaluateMergeGate` core in `gate.ts`. Two modes:
 *   - pr-number given  → evaluate + act on that single PR.
 *   - pr-number absent → POLLER: list open candidate PRs (on branch-prefix branches,
 *     targeting base-branch, oldest first), evaluate each, and merge the first that
 *     qualifies (one merge per run, mirroring gp-dixie's Shipper).
 *
 * Approval is detected from a formal APPROVED review OR a review/COMMENT whose body
 * matches `approvalBodyRegex` (the Critic posts its "**Verdict:** APPROVE" as a comment).
 * No gp-dixie hardcodes live here: everything comes from the policy file / inputs.
 */

import { readFileSync } from "node:fs";
import * as core from "@actions/core";
import * as github from "@actions/github";
import yaml from "js-yaml";
import {
  visibleBody,
  checkConclusion,
  describeCheckRunsFailure,
  evaluateMergeGate,
  filterCandidateNumbers,
  filterEvaluateCandidates,
  latestHeadVerdictIsEscalation,
  openThreads,
  filterCountableVerdicts,
  latestAttemptPerCheck,
  latestValidApproval,
  normalizePolicyKeys,
  parseDependabotBump,
  DEPENDABOT_LOGIN,
  type CandidateSelection,
  type CheckConclusion,
  type CheckRunFact,
  type MergePolicy,
  type ReviewThreadFact,
  type PullRequestFacts,
  type PrFile,
  type CiStatus,
  type MergeDecision,
  type VerdictEvent,
  type VerdictTrustPolicy,
} from "./gate.js";
import { parseVerdictWords, verdictRegexSource, type VerdictWords } from "../../../src/shared/verdicts.js";

interface PolicyFile extends MergePolicy, VerdictTrustPolicy {
  approvalBodyRegex?: string;
  /** Body marker that INVALIDATES earlier approvals (default: "REQUEST_CHANGES"). */
  rejectionBodyRegex?: string;
  ciIgnoreCheckNames?: string[];
  mergeMethod?: "merge" | "squash" | "rebase";
  deleteBranchOnMerge?: boolean;
  // Label applied when a merge fails on a conflict, so a Fixer can pick it up and rebase.
  rebaseLabel?: string;
  /** Evaluate mode: a trusted verdict on the head matching this is an escalation (check `action_required`). */
  escalationBodyRegex?: string;
  /** From the `verdicts` input (not the policy file): the words the default markers are built from. */
  verdictWords?: VerdictWords;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The approval / rejection / escalation markers, derived from the verdict words
 * (the `verdicts` input, else APPROVE / REQUEST_CHANGES / ESCALATE) — the grammar
 * the sweep reads, so a head the sweep counts as decided is one the gate can read.
 * Approval and escalation are the exact last line. Rejection is deliberately
 * LOOSE (`Verdict.*<word>`): the errors are not symmetric — a rejection the gate
 * misses leaves an earlier approval standing and the PR merges, one it reads too
 * eagerly only holds a merge back — and approval is tested first, so the loose
 * form cannot misread an approval that discusses the earlier request. A policy
 * regex overrides any of them.
 */
export function verdictMarkers(policy: PolicyFile): { approval: RegExp; rejection: RegExp; escalation: RegExp } {
  const words = policy.verdictWords ?? parseVerdictWords(undefined);
  return {
    approval: new RegExp(policy.approvalBodyRegex ?? verdictRegexSource(words.approve)),
    rejection: new RegExp(policy.rejectionBodyRegex ?? `Verdict.*${escapeRegex(words.requestChanges)}`),
    escalation: new RegExp(policy.escalationBodyRegex ?? verdictRegexSource(words.escalate)),
  };
}

type Octokit = ReturnType<typeof github.getOctokit>;

export function loadPolicy(path: string): PolicyFile {
  const parsed = (yaml.load(readFileSync(path, "utf8")) ?? {}) as unknown;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`policy file ${path} did not parse to an object`);
  }
  // Accept snake_case policy files (same convention as foundry.config.yaml).
  return normalizePolicyKeys(parsed) as PolicyFile;
}

function isApprovalReview(review: { state?: string | null; body?: string | null }, bodyRe?: RegExp): boolean {
  if (review.state === "APPROVED") return true;
  if (review.state === "COMMENTED" && bodyRe && review.body) return bodyRe.test(review.body);
  return false;
}

function rollupCi(
  checkRuns: { name?: string | null; status?: string | null; conclusion?: string | null }[],
  ignoreNames: Set<string>,
): CiStatus {
  const relevant = checkRuns.filter((c) => !ignoreNames.has(c.name ?? ""));
  if (relevant.length === 0) return "unknown";
  if (relevant.some((c) => c.conclusion === "failure" || c.conclusion === "timed_out" || c.conclusion === "cancelled")) return "failing";
  if (relevant.every((c) => c.status === "completed" && (c.conclusion === "success" || c.conclusion === "skipped" || c.conclusion === "neutral"))) return "passing";
  if (relevant.some((c) => c.status === "in_progress" || c.status === "queued" || c.status === "pending")) return "pending";
  return "unknown";
}

// GraphQL is the only API with thread resolution; same shape as agent-context's
// reviewThreads query, trimmed to what the open-thread rule reads.
const REVIEW_THREADS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved
          path
          line
          originalLine
          firstComment: comments(first: 1) {
            nodes { reactions(first: 100) { nodes { content user { login } } } }
          }
          comments(first: 100) {
            nodes { author { login } body }
          }
        }
      }
    }
  }
}`;

interface ThreadsQueryResult {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<{
          isResolved: boolean;
          path: string | null;
          line: number | null;
          originalLine: number | null;
          firstComment: { nodes: Array<{ reactions: { nodes: Array<{ content: string; user: { login: string } | null } | null> } } | null> };
          comments: { nodes: Array<{ author: { login: string } | null; body: string } | null> };
        } | null>;
      };
    } | null;
  } | null;
}

/** Every review thread of a PR. Throws on any failure: the caller fails closed. */
export async function fetchReviewThreads(octokit: Octokit, owner: string, repo: string, number: number): Promise<ReviewThreadFact[]> {
  const threads: ReviewThreadFact[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 100; page++) {
    const result: ThreadsQueryResult = await octokit.graphql<ThreadsQueryResult>(REVIEW_THREADS_QUERY, { owner, repo, number, cursor });
    const connection = result?.repository?.pullRequest?.reviewThreads;
    if (!connection) throw new Error("GraphQL returned no reviewThreads for this pull request");
    for (const node of connection.nodes) {
      if (!node) continue;
      threads.push({
        isResolved: node.isResolved,
        path: node.path,
        line: node.line ?? node.originalLine ?? null,
        comments: node.comments.nodes.filter((c) => c !== null).map((c) => ({ author: c!.author?.login ?? null, body: c!.body })),
        firstCommentReactions: (node.firstComment.nodes[0]?.reactions.nodes ?? [])
          .filter((r) => r !== null)
          .map((r) => ({ content: r!.content, user: r!.user?.login ?? null })),
      });
    }
    if (!connection.pageInfo.hasNextPage || !connection.pageInfo.endCursor) break;
    cursor = connection.pageInfo.endCursor;
  }
  return threads;
}

export async function gatherFacts(octokit: Octokit, owner: string, repo: string, prNumber: number, policy: PolicyFile, checksOctokit: Octokit = octokit): Promise<PullRequestFacts> {
  const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  const labels = pr.labels.map((l) => (typeof l === "string" ? l : l.name ?? "")).filter(Boolean);
  const markers = verdictMarkers(policy);
  const bodyRe = markers.approval;
  // Rejections invalidate earlier approvals. The default marker is ANCHORED like the
  // approval one (a bare "REQUEST_CHANGES" substring would misread an approval whose
  // prose mentions the earlier requested changes — e.g. a fix-loop re-approval).
  const rejectRe = markers.rejection;

  // Collect verdict-bearing events (reviews + marker comments) in time order, then
  // apply the integrity rule: latest verdict wins, approval must match the head SHA
  // (or, for comments, postdate the head commit). See gate.latestValidApproval.
  const rawEvents: VerdictEvent[] = [];
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, { owner, repo, pull_number: prNumber, per_page: 100 });
  // Approval is tested FIRST: per the reviewer contract the verdict is the body's
  // final "**Verdict:** …" line, and an approval may legitimately quote or discuss
  // the earlier REQUEST_CHANGES items in its prose. A body matching the approval
  // marker is an approval, full stop.
  // Bodies are tested as a reader sees them (visibleBody: HTML comments removed,
  // trailing whitespace trimmed), so an anchored `…$` marker matches a verdict
  // line that ends in a newline OR is followed by the harness's own markers.
  for (const r of reviews) {
    if (!r.submitted_at) continue;
    const who = { author: r.user?.login, authorAssociation: r.author_association, source: "review" as const };
    const body = visibleBody(r.body);
    if (isApprovalReview({ state: r.state, body }, bodyRe)) {
      rawEvents.push({ at: r.submitted_at, kind: "approve", sha: r.commit_id, ...who });
    } else if (r.state === "CHANGES_REQUESTED" || (r.state === "COMMENTED" && body && rejectRe.test(body))) {
      rawEvents.push({ at: r.submitted_at, kind: "reject", sha: r.commit_id, ...who });
    }
  }
  // Plain issue comments are an approval channel only when a consumer opts in:
  // a comment verdict cannot be bound to a head SHA, and every user who can
  // comment on the PR can write one.
  if (bodyRe && policy.allowCommentApprovals) {
    const comments = await octokit.paginate(octokit.rest.issues.listComments, { owner, repo, issue_number: prNumber, per_page: 100 });
    for (const c of comments) {
      if (!c.body || !c.created_at) continue;
      const who = { author: c.user?.login, authorAssociation: c.author_association, source: "comment" as const };
      const body = visibleBody(c.body);
      if (bodyRe.test(body)) rawEvents.push({ at: c.created_at, kind: "approve", ...who });
      else if (rejectRe.test(body)) rawEvents.push({ at: c.created_at, kind: "reject", ...who });
    }
  }
  // Only verdicts from authors this repo trusts reach the integrity rule below.
  const events = filterCountableVerdicts(rawEvents, policy);
  const ignored = rawEvents.length - events.length;
  if (ignored > 0) {
    core.info(`PR #${prNumber}: ignored ${ignored} verdict(s) from untrusted authors/channels`);
  }
  let headCommittedAt: string | null = null;
  try {
    const { data: headCommit } = await octokit.rest.repos.getCommit({ owner, repo, ref: pr.head.sha });
    headCommittedAt = headCommit.commit.committer?.date ?? headCommit.commit.author?.date ?? null;
  } catch (e) {
    core.warning(`Could not resolve head commit time for #${prNumber}: ${(e as Error).message}`);
  }
  const approvedAt = latestValidApproval(events, pr.head.sha, headCommittedAt);

  const filesRaw = await octokit.paginate(octokit.rest.pulls.listFiles, { owner, repo, pull_number: prNumber, per_page: 100 });
  const files: PrFile[] = filesRaw.map((f) => ({ path: f.filename, additions: f.additions, deletions: f.deletions }));

  const ignore = new Set(policy.ciIgnoreCheckNames ?? []);
  type CheckRunRaw = { id?: number | null; name?: string | null; status?: string | null; conclusion?: string | null; app?: { slug?: string | null } | null };
  let checkRunsRaw: CheckRunRaw[];
  try {
    // Deliberately a SEPARATE token from the one that merges. Reading check-runs
    // needs the Checks permission, which only a GitHub App has — fine-grained
    // PATs cannot grant it at all (GitHub's permission list has no Checks entry).
    // GITHUB_TOKEN is an App installation token, so the caller passes it here for
    // this read while the merge itself keeps using the PAT, which is what makes
    // the merge attributable and lets its events cascade.
    checkRunsRaw = await checksOctokit.paginate(checksOctokit.rest.checks.listForRef, { owner, repo, ref: pr.head.sha, per_page: 100 });
  } catch (e) {
    // Fail closed, but say what to wire up — see describeCheckRunsFailure.
    throw new Error(describeCheckRunsFailure(e as { status?: number; message?: string }));
  }
  // Superseded attempts are history: judge only the newest attempt of each check, in
  // both the rollup and the requiredChecks gate below.
  checkRunsRaw = latestAttemptPerCheck(checkRunsRaw);
  const ciStatus = rollupCi(checkRunsRaw, ignore);
  // Same fetch feeds the requiredChecks gate: those must be present AND green,
  // which the CI rollup cannot express (it only judges checks that exist).
  const checkRuns: CheckRunFact[] = checkRunsRaw.map((c) => ({
    name: c.name ?? "",
    status: c.status,
    conclusion: c.conclusion,
    // Who wrote it matters as much as what it says: a `requiredChecks` entry can
    // pin the author, and the name alone is public knowledge.
    appSlug: c.app?.slug ?? null,
  }));

  let cleanRebase: boolean | undefined;
  if (pr.mergeable === true && pr.mergeable_state && pr.mergeable_state !== "dirty") cleanRebase = true;
  else if (pr.mergeable === false || pr.mergeable_state === "dirty") cleanRebase = false;
  const overrideRebase = core.getInput("clean-rebase");
  if (overrideRebase === "true") cleanRebase = true;
  else if (overrideRebase === "false") cleanRebase = false;

  const authorLogin = pr.user?.login;
  const dependabotUpdateType = authorLogin === DEPENDABOT_LOGIN ? parseDependabotBump(pr.title) : undefined;

  // Evaluate-mode facts. Threads cost a GraphQL query, so only when the clause is on.
  const reviewThreads = policy.requireNoOpenThreads ? await fetchReviewThreads(octokit, owner, repo, prNumber) : undefined;
  const requestedReviewers = [
    ...(pr.requested_reviewers ?? []).map((u) => u.login),
    ...(pr.requested_teams ?? []).map((t) => `team:${t.slug}`),
  ];
  const escalated = latestHeadVerdictIsEscalation(
    reviews.filter((r) => r.submitted_at).map((r) => ({ at: r.submitted_at!, sha: r.commit_id, author: r.user?.login, authorAssociation: r.author_association, body: r.body })),
    pr.head.sha,
    policy,
    markers,
  );

  return { number: prNumber, title: pr.title, headSha: pr.head.sha, headRefName: pr.head.ref, baseRefName: pr.base.ref, labels, ciStatus, checkRuns, approvedAt, files, cleanRebase, authorLogin, dependabotUpdateType, reviewThreads, requestedReviewers, escalated };
}

/** Open PRs on branch-prefix (or, when the dependabot lane is on, dependabot/) branches targeting base, oldest first. */
async function listCandidates(octokit: Octokit, owner: string, repo: string, policy: PolicyFile, base: string): Promise<number[]> {
  const prs = await octokit.paginate(octokit.rest.pulls.list, { owner, repo, state: "open", base, sort: "created", direction: "asc", per_page: 100 });
  const includeDependabot = (policy.dependabot?.autoMerge?.length ?? 0) > 0;
  return filterCandidateNumbers(prs.map((p) => ({ number: p.number, headRefName: p.head.ref })), policy.branchPrefix, includeDependabot);
}

async function comment(octokit: Octokit, owner: string, repo: string, prNumber: number, body: string): Promise<void> {
  try {
    await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body });
  } catch (e) {
    core.warning(`Could not comment on PR #${prNumber}: ${(e as Error).message}`);
  }
}

async function actOnDecision(octokit: Octokit, owner: string, repo: string, prNumber: number, facts: PullRequestFacts, decision: MergeDecision, policy: PolicyFile, dryRun: boolean): Promise<boolean> {
  core.info(`PR #${prNumber}: ${decision.action} (${decision.code}) — ${decision.reason}`);
  if (dryRun) return false;

  // Reconcile the awaiting-approval label: it is a non-blocking "ready, please
  // approve" marker, so it must come off the moment that stops being true (the
  // PR got approved and moved on, or another reason now applies). Runs before the
  // action below, so a PR that just got approved is de-labeled and then merged.
  const awaitingLabel = policy.labels?.awaitingApproval;
  if (
    awaitingLabel &&
    facts.labels.includes(awaitingLabel) &&
    !(decision.action === "label" && decision.label === awaitingLabel)
  ) {
    try {
      await octokit.rest.issues.removeLabel({ owner, repo, issue_number: prNumber, name: awaitingLabel });
      core.info(`Removed stale \`${awaitingLabel}\` from PR #${prNumber}`);
    } catch (e) {
      core.debug(`Could not remove \`${awaitingLabel}\` from #${prNumber}: ${(e as Error).message}`);
    }
  }

  if (decision.action === "label" && decision.label) {
    // Idempotent: apply and explain only on the FIRST run that reaches this
    // label. Blocking labels (needs-human / needs-rebase) short-circuit on the
    // next poll so they never re-comment anyway; a NON-blocking label like
    // awaiting-approval would otherwise re-comment every cadence — so guard here.
    if (facts.labels.includes(decision.label)) {
      core.info(`PR #${prNumber} already labeled \`${decision.label}\``);
      return false;
    }
    await octokit.rest.issues.addLabels({ owner, repo, issue_number: prNumber, labels: [decision.label] });
    core.info(`Labeled PR #${prNumber} \`${decision.label}\``);
    // Explain why it was held back (skipped plain-skips stay quiet; a label is a real block).
    await comment(octokit, owner, repo, prNumber, `## 🔀 Auto-merge\n\nHeld this PR back and labeled \`${decision.label}\` — ${decision.reason}. A human should take a look.`);
    return false;
  }
  if (decision.action === "merge") {
    try {
      await octokit.rest.pulls.merge({
        owner,
        repo,
        pull_number: prNumber,
        merge_method: policy.mergeMethod ?? "rebase",
        // Merge exactly what was scored. Without this, a head that moved between
        // scoring and merging — the janitor's rebase sweep runs on the same
        // cadence as this poller — would be merged unreviewed. GitHub 409s when
        // the SHA no longer matches, which lands in the recovery path below.
        ...(facts.headSha ? { sha: facts.headSha } : {}),
      });
    } catch (e) {
      // A merge can still fail at merge time (e.g. a conflict that appeared after
      // another PR landed, or the head moved). Don't crash the poller — label it
      // so a Fixer rebases it and the next run re-scores the new head.
      core.warning(`Merge of #${prNumber} rejected: ${(e as Error).message}`);
      const rebaseLabel = policy.rebaseLabel ?? "needs-rebase";
      try {
        await octokit.rest.issues.addLabels({ owner, repo, issue_number: prNumber, labels: [rebaseLabel] });
      } catch (le) {
        core.warning(`Could not label #${prNumber} \`${rebaseLabel}\`: ${(le as Error).message}`);
      }
      await comment(octokit, owner, repo, prNumber, `## 🔀 Auto-merge\n\nEverything passed the gate, but GitHub rejected the merge — the head moved, or a conflict appeared after another PR landed. Nothing was merged: the gate only merges the exact commit it scored (\`${(facts.headSha ?? "").slice(0, 8)}\`). Labeled \`${rebaseLabel}\` so the janitor sweep can rebase this onto \`${facts.baseRefName ?? "the base branch"}\`; the next poll re-scores the new head.`);
      return false;
    }
    if (policy.deleteBranchOnMerge ?? true) {
      try {
        await octokit.rest.git.deleteRef({ owner, repo, ref: `heads/${facts.headRefName}` });
      } catch (e) {
        core.warning(`Could not delete branch ${facts.headRefName}: ${(e as Error).message}`);
      }
    }
    core.info(`Merged PR #${prNumber}`);
    // Explain the decision on the PR (an audit trail humans can scan).
    await comment(octokit, owner, repo, prNumber, `## 🔀 Auto-merge\n\nMerged (\`${policy.mergeMethod ?? "rebase"}\`) — ${decision.reason}.`);
    return true;
  }
  return false;
}

// ────────────────────────────────────────────────────────────────────────────
// Evaluate mode: publish the gate's result as a check run, never merge
// ────────────────────────────────────────────────────────────────────────────

/** The app GITHUB_TOKEN writes check runs as; an evaluate gate updates only its own run. */
export const CHECK_APP = "github-actions";

export interface CheckOutput {
  conclusion: CheckConclusion;
  title: string;
  summary: string;
  text: string;
}

const CHECK_TEXT_LIMIT = 60000; // GitHub caps output.text at 65535 characters

/**
 * The check run for one head. Deterministic for an unchanged state — no clock in
 * it — so the next tick can tell nothing changed and skip the write. (The
 * ready-to-merge reason carries "approved Nm ago", so success gets fixed text.)
 */
export function renderCheckOutput(decision: MergeDecision, facts: PullRequestFacts, policy: PolicyFile, ownCheck: string): CheckOutput {
  const conclusion = checkConclusion(decision, facts);
  const gateLine = decision.action === "merge"
    ? "`ready-to-merge` — every clause of the merge policy passes on this head."
    : `\`${decision.code}\` — ${decision.reason}`;
  const title =
    conclusion === "action_required" ? "Escalated: a human decides" : conclusion === "success" ? "Ready to merge" : `Not ready: ${decision.code}`;
  const summary =
    conclusion === "action_required"
      ? `The reviewer escalated this head to a human.\n\nGate: ${gateLine}`
      : gateLine;

  const sections: string[] = [];
  const threads = openThreads(facts, policy);
  if (threads.length) {
    sections.push(
      "### Open review threads",
      ...threads.map((t) => {
        const first = t.comments[0];
        const where = t.path ? `\`${t.path}${t.line ? `:${t.line}` : ""}\`` : "(no path)";
        const gist = (first?.body ?? "").split("\n").find((l) => l.trim())?.trim().slice(0, 140) ?? "";
        return `- ${where} — @${first?.author ?? "unknown"}: ${gist}`;
      }),
    );
  }
  const ignore = new Set([...(policy.ciIgnoreCheckNames ?? []), ownCheck]);
  const failing = (facts.checkRuns ?? []).filter(
    (c) => !ignore.has(c.name) && !(c.status === "completed" && ["success", "skipped", "neutral"].includes(c.conclusion ?? "")),
  );
  if (failing.length) {
    sections.push("### Checks not passing", ...failing.map((c) => `- \`${c.name}\`: ${c.status === "completed" ? c.conclusion : c.status ?? "pending"}`));
  }
  if (facts.requestedReviewers?.length) {
    sections.push("### Review requested from", ...facts.requestedReviewers.map((r) => `- \`${r}\``));
  }
  let text = sections.join("\n");
  if (text.length > CHECK_TEXT_LIMIT) text = `${text.slice(0, CHECK_TEXT_LIMIT)}\n…(truncated)`;
  return { conclusion, title, summary, text };
}

/**
 * Publish `out` as the head's `name` check run: update this app's existing run
 * (one current result per head), create one if there is none, and write nothing
 * when the existing run already says the same thing.
 */
export async function publishCheck(
  checksOctokit: Octokit,
  owner: string,
  repo: string,
  headSha: string,
  name: string,
  out: CheckOutput,
): Promise<"created" | "updated" | "unchanged"> {
  const runs = await checksOctokit.paginate(checksOctokit.rest.checks.listForRef, { owner, repo, ref: headSha, check_name: name, filter: "all", per_page: 100 });
  const mine = runs
    .filter((r) => r.name === name && r.app?.slug === CHECK_APP)
    .sort((a, b) => b.id - a.id)[0];
  if (
    mine &&
    mine.status === "completed" &&
    mine.conclusion === out.conclusion &&
    (mine.output?.summary ?? "") === out.summary &&
    (mine.output?.text ?? "") === out.text
  ) {
    return "unchanged";
  }
  const output = { title: out.title, summary: out.summary, text: out.text };
  if (mine) {
    await checksOctokit.rest.checks.update({ owner, repo, check_run_id: mine.id, status: "completed", conclusion: out.conclusion, output });
    return "updated";
  }
  await checksOctokit.rest.checks.create({ owner, repo, name, head_sha: headSha, status: "completed", conclusion: out.conclusion, output });
  return "created";
}

/** The evaluate-mode PR selection inputs the compiler passes from the node. */
export function selectionFromInputs(get: (name: string) => string, botLogin?: string): CandidateSelection {
  const list = (s: string) => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
  const authors = list(get("authors")).map((a) => a.toLowerCase());
  const skipLabels = list(get("skip-labels"));
  const optInLabel = get("opt-in-label").trim();
  return {
    ...(authors.length ? { authors } : {}),
    ...(optInLabel ? { optInLabel } : {}),
    ...(skipLabels.length ? { skipLabels } : {}),
    ...(get("skip-bot-authors").trim() === "true" ? { skipBotAuthors: true } : {}),
    ...(botLogin ? { botLogin } : {}),
  };
}

/**
 * Evaluate every PR in scope and publish one check run per head. Never merges,
 * never labels, never comments. A PR whose facts cannot be read keeps its last
 * check and is retried next tick.
 */
export async function runEvaluate(opts: {
  octokit: Octokit;
  checksOctokit: Octokit;
  owner: string;
  repo: string;
  policy: PolicyFile;
  checkName: string;
  baseBranch: string;
  selection: CandidateSelection;
  prNumber?: number;
  dryRun: boolean;
}): Promise<{ evaluated: number; written: number }> {
  const { octokit, checksOctokit, owner, repo, checkName } = opts;
  // The gate's own check sits on the head it judges: left in the CI rollup, a
  // failing verdict would read as failing CI and hold itself failing forever.
  const policy: PolicyFile = { ...opts.policy, ciIgnoreCheckNames: [...(opts.policy.ciIgnoreCheckNames ?? []), checkName] };
  // mergeable_state is computed lazily and only a merge attempt settles it; an
  // evaluate gate makes no attempt, so the rebase clause is off unless set.
  if (policy.requireCleanRebase === undefined) policy.requireCleanRebase = false;

  let numbers: number[];
  if (opts.prNumber !== undefined) {
    numbers = [opts.prNumber];
  } else {
    const prs = await octokit.paginate(octokit.rest.pulls.list, { owner, repo, state: "open", base: opts.baseBranch, sort: "created", direction: "asc", per_page: 100 });
    const includeDependabot = (policy.dependabot?.autoMerge?.length ?? 0) > 0;
    numbers = filterEvaluateCandidates(
      prs.map((p) => ({
        number: p.number,
        headRefName: p.head.ref,
        draft: p.draft,
        authorLogin: p.user?.login,
        authorType: p.user?.type,
        labels: p.labels.map((l) => l.name ?? "").filter(Boolean),
      })),
      policy.branchPrefix,
      includeDependabot,
      opts.selection,
    );
  }
  core.info(`${numbers.length} PR(s) to evaluate: ${numbers.join(", ") || "(none)"}`);
  let written = 0;
  for (const n of numbers) {
    try {
      const facts = await gatherFacts(octokit, owner, repo, n, policy, checksOctokit);
      const decision = evaluateMergeGate(facts, policy);
      const out = renderCheckOutput(decision, facts, policy, checkName);
      core.info(`PR #${n}: ${out.conclusion} (${decision.code}) — ${decision.reason}`);
      if (opts.dryRun || !facts.headSha) continue;
      const result = await publishCheck(checksOctokit, owner, repo, facts.headSha, checkName, out);
      if (result !== "unchanged") written++;
      core.info(`PR #${n}: check \`${checkName}\` ${result} on ${facts.headSha.slice(0, 8)}`);
    } catch (e) {
      core.warning(`PR #${n}: not evaluated this tick — ${(e as Error).message}`);
    }
  }
  return { evaluated: numbers.length, written };
}

export async function run(): Promise<void> {
  try {
    const token = core.getInput("token", { required: true });
    const policyPath = core.getInput("policy-path", { required: true });
    const prNumberInput = core.getInput("pr-number");
    const baseBranch = core.getInput("base-branch") || "main";
    const branchPrefixInput = core.getInput("branch-prefix");
    const dryRun = core.getInput("dry-run") === "true";

    const policy = loadPolicy(policyPath);
    if (branchPrefixInput) policy.branchPrefix = branchPrefixInput; // input overrides policy file
    // The compiler passes these from foundry.config.yaml / the graph, so a
    // consumer's identity and human-gate wiring don't have to be restated in the
    // policy file. Inputs win over the policy file, same as branch-prefix.
    // The verdict words the compiler passes from foundry.config.yaml (`verdicts:`).
    const verdictsInput = core.getInput("verdicts").trim();
    if (verdictsInput) policy.verdictWords = parseVerdictWords(verdictsInput);
    const botLoginInput = core.getInput("bot-login").trim();
    if (botLoginInput) policy.botLogin = botLoginInput;
    const requiredChecksInput = core.getInput("required-checks").trim();
    if (requiredChecksInput) {
      policy.requiredChecks = requiredChecksInput
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (!policy.botLogin && !policy.trustedAuthorAssociations) {
      core.warning(
        "merge-gate: no bot-login and no trusted_author_associations configured — approvals are accepted from anyone with write access (OWNER/MEMBER/COLLABORATOR) only.",
      );
    }
    const octokit = github.getOctokit(token);
    // Reading check-runs is the one call the harness token cannot make when it is
    // a fine-grained PAT (no Checks permission exists for those), so it gets its
    // own token. Everything else — merging, labeling, commenting — stays on the
    // harness token so writes are attributed and their events cascade.
    const checksTokenInput = core.getInput("checks-token").trim();
    const checksOctokit = checksTokenInput ? github.getOctokit(checksTokenInput) : octokit;
    if (!checksTokenInput) {
      core.warning(
        "merge-gate: no checks-token supplied; reading check-runs with the harness token. That only works for a GitHub App token — a fine-grained PAT will 403. Run `gp-foundry build` to wire GITHUB_TOKEN through.",
      );
    }
    const { owner, repo } = github.context.repo;

    const mode = core.getInput("mode").trim() || "merge";
    if (mode !== "merge" && mode !== "evaluate") throw new Error(`mode must be "merge" or "evaluate", got "${mode}"`);
    if (mode === "evaluate") {
      const checkName = core.getInput("check-name").trim();
      if (!checkName) throw new Error("mode: evaluate needs a check-name");
      let prNumber: number | undefined;
      if (prNumberInput) {
        prNumber = parseInt(prNumberInput, 10);
        if (Number.isNaN(prNumber)) throw new Error("pr-number must be an integer");
      }
      const { evaluated, written } = await runEvaluate({
        octokit, checksOctokit, owner, repo, policy, checkName, baseBranch, prNumber, dryRun,
        selection: selectionFromInputs((n) => core.getInput(n), policy.botLogin),
      });
      core.setOutput("evaluated", String(evaluated));
      core.setOutput("checks-written", String(written));
      core.setOutput("merged", "false");
      core.setOutput("merged-pr", "");
      return;
    }

    // Single-PR mode.
    if (prNumberInput) {
      const prNumber = parseInt(prNumberInput, 10);
      if (Number.isNaN(prNumber)) throw new Error("pr-number must be an integer");
      const facts = await gatherFacts(octokit, owner, repo, prNumber, policy, checksOctokit);
      const decision = evaluateMergeGate(facts, policy);
      const merged = await actOnDecision(octokit, owner, repo, prNumber, facts, decision, policy, dryRun);
      core.setOutput("action", decision.action);
      core.setOutput("code", decision.code);
      core.setOutput("reason", decision.reason);
      core.setOutput("merged", String(merged));
      core.setOutput("merged-pr", merged ? String(prNumber) : "");
      return;
    }

    // Poller mode.
    const candidates = await listCandidates(octokit, owner, repo, policy, baseBranch);
    core.info(`${candidates.length} candidate PR(s): ${candidates.join(", ") || "(none)"}`);
    let mergedPr = "";
    for (const n of candidates) {
      const facts = await gatherFacts(octokit, owner, repo, n, policy, checksOctokit);
      const decision = evaluateMergeGate(facts, policy);
      const merged = await actOnDecision(octokit, owner, repo, n, facts, decision, policy, dryRun);
      if (merged) { mergedPr = String(n); break; } // one merge per run
    }
    core.setOutput("merged", String(mergedPr !== ""));
    core.setOutput("merged-pr", mergedPr);
    if (!mergedPr) core.info("No PR qualified for merge this run.");
  } catch (err) {
    core.setFailed((err as Error).message);
  }
}

// Imported by the wrapper tests, which call run() themselves.
if (!process.env.VITEST) void run();
