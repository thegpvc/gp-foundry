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
  escalationLabel,
  sameLogin,
  checkVerdict,
  validateHandoffClauses,
  parseTimestamp,
  standingChangeRequests,
  visibleBody,
  checkConclusion,
  describeCheckRunsFailure,
  evaluateMergeGate,
  filterCandidateNumbers,
  filterEvaluateCandidates,
  awaitingApprover,
  latestHeadVerdict,
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
import { inScope, isAgentWritten, type Rollout } from "../../../src/shared/scope.js";

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
/** One formal review, as the sign-off rule reads it. */
export interface SignoffReview {
  at: string;
  author?: string | null;
  state?: string | null;
  sha?: string | null;
}

/**
 * The candidates for signing off a policy handoff on `headSha`: reviewers whose
 * latest decisive review (APPROVED, CHANGES_REQUESTED or DISMISSED — a COMMENTED
 * review changes no one's standing) is an APPROVED review of this exact commit,
 * from anyone but the harness's identity and the PR's author. Most recent first.
 * A bot other than the harness counts like a person.
 */
export function signoffCandidates(
  reviews: SignoffReview[],
  headSha: string,
  harness: string | undefined,
  prAuthor: string | undefined,
): { reviewer: string; at: string }[] {
  const latest = new Map<string, SignoffReview & { login: string }>();
  for (const r of reviews) {
    const state = (r.state ?? "").toUpperCase();
    if (!r.author || !["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(state)) continue;
    const key = r.author.toLowerCase();
    const prev = latest.get(key);
    if (!prev || parseTimestamp(r.at) >= parseTimestamp(prev.at)) latest.set(key, { ...r, state, login: r.author });
  }
  return [...latest.values()]
    .filter((r) => r.state === "APPROVED" && r.sha === headSha && !sameLogin(r.login, harness) && !sameLogin(r.login, prAuthor))
    .sort((a, b) => parseTimestamp(b.at) - parseTimestamp(a.at))
    .map((r) => ({ reviewer: r.login, at: r.at }));
}

const REVIEW_DECISION_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) { reviewDecision } }
}`;

/**
 * GitHub's own review decision for the PR — the result of branch protection's
 * required approvals and code owners, which the gate does not re-implement.
 * `null` when the branch requires no review. Throws when it cannot be read.
 */
export async function fetchReviewDecision(octokit: Octokit, owner: string, repo: string, number: number): Promise<string | null> {
  const r = await octokit.graphql<{ repository: { pullRequest: { reviewDecision: string | null } | null } | null }>(REVIEW_DECISION_QUERY, {
    owner,
    repo,
    number,
  });
  const pr = r.repository?.pullRequest;
  if (!pr) throw new Error(`PR #${number} not found`);
  return pr.reviewDecision ?? null;
}

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
  // Rejections invalidate earlier approvals. The default rejection marker is loose
  // on purpose (see verdictMarkers); approval is tested first, so it cannot misread
  // an approval whose prose mentions the earlier requested changes.
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
  // Only verdicts from authors this repo trusts reach the integrity rule below —
  // and never a person's approval of their OWN pull request. GitHub refuses a
  // formal APPROVED review from a PR's author, but a COMMENTED review is allowed,
  // and its body can end in the approval line: without this, any trusted
  // collaborator could open a PR and approve it themselves. The harness bot is
  // the one exception, and a deliberate one — it both writes and reviews agent
  // PRs under a single identity, which is why its verdict is a comment at all.
  const events = filterCountableVerdicts(rawEvents, policy).filter(
    (e) => !(e.kind === "approve" && sameLogin(e.author, pr.user?.login) && !sameLogin(e.author, policy.botLogin)),
  );
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
  // Whose formal review stands at "changes requested" — read only by the opt-in
  // require_no_human_changes_requested clause, but cheap: the reviews are in hand.
  const changesRequestedBy = standingChangeRequests(
    reviews.filter((r) => r.submitted_at).map((r) => ({ at: r.submitted_at!, author: r.user?.login, state: r.state })),
    policy.botLogin,
  );
  const headVerdict = latestHeadVerdict(
    reviews.filter((r) => r.submitted_at).map((r) => ({ at: r.submitted_at!, sha: r.commit_id, author: r.user?.login, authorAssociation: r.author_association, body: r.body })),
    pr.head.sha,
    policy,
    markers,
  );

  // A sign-off on a policy handoff. Only when the policy names handoff clauses,
  // and GitHub's review decision is read only when there is a candidate.
  let signoff: PullRequestFacts["signoff"];
  let signoffUnavailable: string | undefined;
  if (policy.handoffClauses?.length) {
    const candidates = signoffCandidates(
      reviews.filter((r) => r.submitted_at).map((r) => ({ at: r.submitted_at!, author: r.user?.login, state: r.state, sha: r.commit_id })),
      pr.head.sha,
      policy.botLogin,
      authorLogin,
    );
    if (candidates.length) {
      let decision: string | null | undefined;
      try {
        decision = await fetchReviewDecision(octokit, owner, repo, prNumber);
      } catch (e) {
        signoffUnavailable = `GitHub's review decision for this PR could not be read (${(e as Error).message}), so ${candidates[0]!.reviewer}'s approval cannot be accepted as a sign-off yet`;
      }
      if (decision === null || decision === "APPROVED") signoff = { reviewer: candidates[0]!.reviewer, sha: pr.head.sha };
      else if (decision !== undefined) {
        signoffUnavailable = `${candidates[0]!.reviewer} approved this head, but GitHub's review requirements are not met yet (review decision: ${decision})`;
      }
    }
  }

  return { number: prNumber, title: pr.title, headSha: pr.head.sha, headRefName: pr.head.ref, baseRefName: pr.base.ref, labels, ciStatus, checkRuns, approvedAt, files, cleanRebase, authorLogin, dependabotUpdateType, reviewThreads, requestedReviewers, changesRequestedBy, escalated: headVerdict === "escalate" || escalationLabel({ labels }, policy) !== undefined, headVerdict, ...(signoff ? { signoff } : {}), ...(signoffUnavailable ? { signoffUnavailable } : {}) };
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

/** Check runs on the head that are not (yet) green, minus the ignored ones. */
function checksNotPassing(facts: PullRequestFacts, ignore: Set<string>): CheckRunFact[] {
  return (facts.checkRuns ?? []).filter(
    (c) => !ignore.has(c.name) && !(c.status === "completed" && ["success", "skipped", "neutral"].includes(c.conclusion ?? "")),
  );
}

/**
 * The neutral summary: the approver's verdict is missing, plus every other clause
 * that fails on the head, so the author sees what else they will need. A failing
 * CI clause is told as counts of running and failed checks.
 */
function awaitingSummary(alsoFailing: MergeDecision[], facts: PullRequestFacts, ignore: Set<string>): string {
  if (alsoFailing.length === 0) {
    return "awaiting the approver — every other clause of the merge policy passes on this head.";
  }
  const describe = (d: MergeDecision): string => {
    if (d.code === "ci-not-passing") {
      const notPassing = checksNotPassing(facts, ignore);
      const running = notPassing.filter((c) => c.status !== "completed").length;
      const failed = notPassing.length - running;
      const parts = [
        running ? `${running} check run${running === 1 ? "" : "s"} still running` : "",
        failed ? `${failed} check run${failed === 1 ? "" : "s"} not successful` : "",
      ].filter(Boolean);
      if (parts.length) return `CI: ${parts.join(", ")}`;
    }
    if (d.code === "open-threads" && d.detail?.openThreads) {
      const n = d.detail.openThreads;
      return `${n} unanswered review thread${n === 1 ? "" : "s"}`;
    }
    return d.reason;
  };
  return [
    "awaiting the approver — the approver has not given a verdict on this head yet. Also failing:",
    "",
    ...alsoFailing.map((d) => `- \`${d.code}\` — ${describe(d)}`),
  ].join("\n");
}

/**
 * The check run for one head. Deterministic for an unchanged state — no clock in
 * it — so the next tick can tell nothing changed and skip the write. (The
 * ready-to-merge reason carries "approved Nm ago", so success gets fixed text.)
 */
export function renderCheckOutput(_decision: MergeDecision, facts: PullRequestFacts, policy: PolicyFile, ownCheck: string): CheckOutput {
  const verdict = checkVerdict(facts, policy);
  const { decision, conclusion, outstanding, signedOff } = verdict;
  const alsoFailing = verdict.alsoFailing;
  const handoffOnly = conclusion === "action_required" && !facts.escalated;
  const ignore = new Set([...(policy.ciIgnoreCheckNames ?? []), ownCheck]);
  const gateLine = decision.action === "merge"
    ? "`ready-to-merge` — every clause of the merge policy passes on this head."
    : `\`${decision.code}\` — ${decision.reason}`;
  const signed = signedOff.length && facts.signoff
    ? `Policy handoff signed off: ${signedOff.map((d) => `\`${d.code}\``).join(", ")} by @${facts.signoff.reviewer} on \`${facts.signoff.sha.slice(0, 7)}\`.` +
      (facts.headVerdict ? ` The reviewer's own verdict on this head stands: ${facts.headVerdict}.` : "")
    : "";
  const title = handoffOnly
    ? `A person decides: ${outstanding.map((d) => d.code).join(", ")}`
    : conclusion === "action_required"
      ? "Escalated: a human decides"
      : conclusion === "success"
        ? signed ? `Ready to merge — signed off by @${facts.signoff!.reviewer}` : "Ready to merge"
        : conclusion === "neutral"
          ? "Awaiting the approver"
          : `Not ready: ${decision.code}`;
  const handoffSummary = [
    ...outstanding.map((d) => `\`${d.code}\` — ${d.reason}.`),
    "",
    `This change needs a person. A formal approval of this head from someone other than \`${policy.botLogin ?? "the pipeline"}\`, once GitHub's own review requirements are met, signs it off here.`,
    ...(facts.signoffUnavailable ? ["", `Not yet: ${facts.signoffUnavailable}.`] : []),
  ].join("\n");
  const base =
    handoffOnly
      ? handoffSummary
      : conclusion === "action_required"
      ? `${escalationLabel(facts, policy) ? `Escalated to a human by the \`${escalationLabel(facts, policy)}\` label.` : "The reviewer escalated this head to a human."}\n\nGate: ${gateLine}`
      : conclusion === "neutral"
        ? awaitingSummary(alsoFailing ?? [], facts, ignore)
        : gateLine;
  const summary = [base, signed, !signed && !handoffOnly && facts.signoffUnavailable ? `Policy handoff not signed off: ${facts.signoffUnavailable}.` : ""]
    .filter(Boolean)
    .join("\n\n");

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
  const failing = checksNotPassing(facts, ignore);
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
  // The app whose runs this gate adopts and updates: github-actions when it
  // publishes with GITHUB_TOKEN, the harness's own App when it publishes with
  // that App's token (see the `check-app` input).
  app: string = CHECK_APP,
): Promise<"created" | "updated" | "unchanged"> {
  const runs = await checksOctokit.paginate(checksOctokit.rest.checks.listForRef, { owner, repo, ref: headSha, check_name: name, filter: "all", per_page: 100 });
  const mine = runs
    .filter((r) => r.name === name && r.app?.slug === app)
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
  if (policy.noVerdictConclusion !== undefined && policy.noVerdictConclusion !== "failure" && policy.noVerdictConclusion !== "neutral") {
    throw new Error(`no_verdict_conclusion must be "failure" or "neutral", got ${JSON.stringify(policy.noVerdictConclusion)}`);
  }
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

export type MergeSetting = "off" | "agent-only";

/**
 * The single gate (`merge=` on the node). Each tick, for every pull request the
 * pipeline looks at — the rollout dial decides that, not a branch prefix:
 *
 *   1. work out the result against the policy;
 *   2. publish it as the check on the PR's head, human PR or agent PR alike;
 *   3. with merge="agent-only", act on a PR the pipeline WROTE: merge it when
 *      ready, or apply the policy's labels when not.
 *
 * A human-written PR gets the check and nothing else, ever: no merge, no label,
 * no comment. The check a person reads on their PR is, by construction, the same
 * decision that merges an agent's.
 */
export async function runHybridGate(opts: {
  octokit: Octokit;
  checksOctokit: Octokit;
  owner: string;
  repo: string;
  policy: PolicyFile;
  checkName: string;
  checkApp: string;
  baseBranch: string;
  merge: MergeSetting;
  rollout: Rollout | undefined;
  prNumber?: number;
  dryRun: boolean;
}): Promise<{ evaluated: number; written: number; mergedPr: string }> {
  const { octokit, checksOctokit, owner, repo, checkName, rollout } = opts;
  if (opts.policy.noVerdictConclusion !== undefined && opts.policy.noVerdictConclusion !== "failure" && opts.policy.noVerdictConclusion !== "neutral") {
    throw new Error(`no_verdict_conclusion must be "failure" or "neutral", got ${JSON.stringify(opts.policy.noVerdictConclusion)}`);
  }
  // Scope comes from the rollout dial, so the branch prefix is not a clause here:
  // a person's PR on any branch is judged on its merits, not failed for its name.
  // The gate's own check is left out of the CI rollup, or a failing result would
  // read as failing CI and hold itself failing.
  const base: PolicyFile = { ...opts.policy, branchPrefix: undefined, ciIgnoreCheckNames: [...(opts.policy.ciIgnoreCheckNames ?? []), checkName] };
  // The CHECK does not judge mergeability unless the policy asks: GitHub computes
  // it lazily and only a merge attempt settles it. The MERGE keeps the default.
  const checkPolicy: PolicyFile = { ...base, requireCleanRebase: opts.policy.requireCleanRebase ?? false };
  const botLogin = base.botLogin;
  const dependabotLane = (base.dependabot?.autoMerge?.length ?? 0) > 0;

  const prs =
    opts.prNumber !== undefined
      ? [(await octokit.rest.pulls.get({ owner, repo, pull_number: opts.prNumber })).data]
      : await octokit.paginate(octokit.rest.pulls.list, { owner, repo, state: "open", base: opts.baseBranch, sort: "created", direction: "asc", per_page: 100 });

  let evaluated = 0;
  let written = 0;
  let mergedPr = "";
  for (const p of prs) {
    const n = p.number;
    const author = p.user?.login;
    const scope = inScope(
      { authorLogin: author, authorType: p.user?.type, draft: p.draft, labels: p.labels.map((l) => (typeof l === "string" ? l : l.name ?? "")).filter(Boolean) },
      rollout,
      botLogin,
    );
    // The policy's dependabot lane is its own explicit opt-in, and stays one:
    // when it is on, dependabot's PRs are judged (and merged) on that lane.
    const onDependabotLane = dependabotLane && author === DEPENDABOT_LOGIN && !p.draft;
    if (!scope.inScope && !onDependabotLane) {
      core.info(`PR #${n}: out of scope — ${scope.detail}`);
      continue;
    }
    evaluated++;
    try {
      const facts = await gatherFacts(octokit, owner, repo, n, checkPolicy, checksOctokit);

      // Who merges this PR? Only asked when the gate may merge at all.
      let writer: { agentWritten: boolean; detail: string } | undefined;
      if (opts.merge === "agent-only" && !onDependabotLane) {
        let commits: { authorLogin?: string | null }[] | undefined;
        if (sameLogin(author, botLogin)) {
          try {
            commits = (await octokit.paginate(octokit.rest.pulls.listCommits, { owner, repo, pull_number: n, per_page: 100 })).map((c) => ({ authorLogin: c.author?.login }));
          } catch (e) {
            core.warning(`PR #${n}: could not read its commits (${(e as Error).message}) — treating it as human-written`);
          }
        }
        writer = isAgentWritten({ authorLogin: author }, commits, botLogin);
      }

      const decision = evaluateMergeGate(facts, checkPolicy);
      const out = renderCheckOutput(decision, facts, checkPolicy, checkName);
      // Say, on the PR, who will merge it — the one thing the result alone does not.
      if (opts.merge === "agent-only") {
        const line = onDependabotLane
          ? "Merge: the pipeline merges this PR on the dependabot lane when it is ready."
          : writer?.agentWritten
            ? "Merge: the pipeline wrote this PR and merges it when it is ready."
            : `Merge: a person merges this PR — it is not agent-written (${writer?.detail ?? "unknown"}).`;
        out.text = out.text ? `${out.text}\n\n${line}` : line;
      }
      core.info(`PR #${n}: ${out.conclusion} (${decision.code}) — ${decision.reason}`);
      if (!opts.dryRun && facts.headSha) {
        const result = await publishCheck(checksOctokit, owner, repo, facts.headSha, checkName, out, opts.checkApp);
        if (result !== "unchanged") written++;
        core.info(`PR #${n}: check \`${checkName}\` ${result} on ${facts.headSha.slice(0, 8)}`);
      }

      // Acting is for the pipeline's own PRs only, and one merge per run.
      if (opts.merge !== "agent-only" || mergedPr) continue;
      if (!onDependabotLane && !writer?.agentWritten) continue;
      // Judged again under the merge's own policy: the rebase clause is on here
      // by default, where the check above leaves it off.
      const mergeDecision = evaluateMergeGate(facts, base);
      if (await actOnDecision(octokit, owner, repo, n, facts, mergeDecision, base, opts.dryRun)) mergedPr = String(n);
    } catch (e) {
      core.warning(`PR #${n}: not evaluated this tick — ${(e as Error).message}`);
    }
  }
  core.info(`${evaluated} PR(s) in scope${mergedPr ? `; merged #${mergedPr}` : ""}`);
  return { evaluated, written, mergedPr };
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
    // Fail loudly on a policy handoff that is not one: it would otherwise be ignored.
    validateHandoffClauses(policy.handoffClauses);
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

    // merge= — the single gate. Scope from the rollout dial, a check on every PR
    // in scope, and (agent-only) merges for the PRs the pipeline wrote.
    const mergeSetting = core.getInput("merge").trim();
    if (mergeSetting) {
      if (mergeSetting !== "off" && mergeSetting !== "agent-only") throw new Error(`merge must be "off" or "agent-only", got "${mergeSetting}"`);
      // `mode` has no default in action.yml, so a non-empty value here was set by
      // the workflow. (0.3.0 defaulted it to "merge", which made every merge= gate throw.)
      const modeSetting = core.getInput("mode").trim();
      if (modeSetting) throw new Error(`set merge or mode, not both: merge replaces mode (got merge="${mergeSetting}" and mode="${modeSetting}")`);
      const checkName = core.getInput("check-name").trim();
      if (!checkName) throw new Error("merge needs a check-name: the gate publishes its result as a check");
      const rolloutInput = core.getInput("rollout").trim();
      let rollout: Rollout | undefined;
      if (rolloutInput) {
        try {
          rollout = JSON.parse(rolloutInput) as Rollout;
        } catch {
          throw new Error("rollout must be the JSON the compiler writes — run `gp-foundry build`");
        }
      }
      let prNumber: number | undefined;
      if (prNumberInput) {
        prNumber = parseInt(prNumberInput, 10);
        if (Number.isNaN(prNumber)) throw new Error("pr-number must be an integer");
      }
      const r = await runHybridGate({
        octokit, checksOctokit, owner, repo, policy, checkName, baseBranch, prNumber, dryRun, rollout,
        merge: mergeSetting,
        checkApp: core.getInput("check-app").trim() || CHECK_APP,
      });
      core.setOutput("evaluated", String(r.evaluated));
      core.setOutput("checks-written", String(r.written));
      core.setOutput("merged", String(r.mergedPr !== ""));
      core.setOutput("merged-pr", r.mergedPr);
      return;
    }

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
