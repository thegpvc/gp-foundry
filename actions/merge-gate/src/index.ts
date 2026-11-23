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

import { WAITING_ON_CI, WAITING_TITLE_MAX } from "../../../src/shared/explain.js";
import { existsSync, readFileSync } from "node:fs";
import * as core from "@actions/core";
import * as github from "@actions/github";
import yaml from "js-yaml";
import {
  escalationLabel,
  sameLogin,
  checkVerdict,
  validateHandoffClauses,
  validateSignoffClears,
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
  parseDependabotUpdateType,
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
import { parseVerdictWords, quietVerdictOf, verdictLine, verdictRegexSource, type QuietCheckRunLike, type VerdictWords } from "../../../src/shared/verdicts.js";
import { commitAuthorOf, inScope, isAgentWritten, isBotWritten, isGitHubSignedBy, type Rollout } from "../../../src/shared/scope.js";
import { isFresh, requestedAt, type LabelEvent } from "../../../src/shared/rereview.js";
import { excludeLabelQualifier, reviewedByQualifier, rotatingWindow, searchCandidates, type Candidate } from "../../../src/shared/candidates.js";

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
  /**
   * From the `verdict-checks` / `verdict-app` inputs: the check runs a lane with
   * quiet_verdicts delivers a verdict as, and the App whose runs alone count.
   */
  verdictChecks?: string[];
  verdictApp?: string;
  /** From the `rereview-label` input: the label that asks for a fresh review and verdict. */
  rereviewLabel?: string;
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

/**
 * The gate's own workflow run, as the runtime describes it. An event run of the
 * gate (a review, a label, a push) is itself a GitHub Actions job attached to the
 * PR's head, in progress while it reads that head's check runs; left in the CI
 * rollup, every event run would see "CI pending" and publish `failure`.
 */
export interface GateRun {
  /** GITHUB_RUN_ID: every job of THIS run of the gate workflow. */
  runId?: string;
  /** The check-run name GitHub Actions gives the gate's job (the compiler passes it): any earlier run of it. */
  jobCheckName?: string;
  /** The gate's workflow file (`gate-workflow`): a run named like its job must be of this workflow. */
  workflowPath?: string;
  /** Reads a workflow run's file (`actions-token`, default GITHUB_TOKEN with `actions: read`). */
  actionsOctokit?: Octokit;
}

/** The workflow run a GitHub Actions check run belongs to, from its details or html URL (`…/actions/runs/<id>/job/<id>`). */
export function actionsRunId(c: { details_url?: string | null; html_url?: string | null }): string | undefined {
  for (const url of [c.details_url, c.html_url]) {
    const m = /\/actions\/runs\/(\d+)(?:[/?#]|$)/.exec(url ?? "");
    if (m) return m[1];
  }
  return undefined;
}

/**
 * Is this check run the gate's own job — this run, or an earlier run of the gate
 * workflow (in progress, cancelled, timed out or failed)? Only GitHub Actions
 * check runs qualify (an Actions job is always written by the `github-actions`
 * app), then:
 *
 *   - "own": its details/html URL names this workflow run (GITHUB_RUN_ID);
 *   - "candidate": its name is the gate job's name. The job is named after its
 *     node like every lane's (so its check groups with theirs), which a CI job
 *     may share — so with the gate's workflow file known (`gate-workflow`), a
 *     candidate is the gate's own only once its workflow run turns out to be that
 *     file (gateRunsOnly). Without it (a hand-written setup), the name decides,
 *     as before. 0.5.0 named the job `gp-foundry gate (<node>)`; runs under that
 *     name still on a head are candidates too.
 *
 * The gate's published result (`check-name`) is left out by name separately.
 */
export function classifyGateRun(
  c: { name?: string | null; app?: { slug?: string | null } | null; details_url?: string | null; html_url?: string | null },
  self: GateRun | undefined,
): "own" | "candidate" | "not" {
  if (!self || c.app?.slug !== CHECK_APP) return "not";
  if (self.runId && actionsRunId(c) === self.runId) return "own";
  if (!self.jobCheckName) return "not";
  const names = self.workflowPath ? [self.jobCheckName, `gp-foundry gate (${self.jobCheckName})`] : [self.jobCheckName];
  if (!names.includes(c.name ?? "")) return "not";
  return self.workflowPath ? "candidate" : "own";
}

/** Sync form, for a caller that cannot look a run up: a candidate counts as own (the name rule). */
export function isOwnGateRun(c: Parameters<typeof classifyGateRun>[0], self: GateRun | undefined): boolean {
  return classifyGateRun(c, self) !== "not";
}

/** Workflow file per workflow run id, for the life of this action run. */
const workflowOfRun = new Map<string, string | null>();

/**
 * Drop the gate's own runs from a head's check runs. A candidate (named like the
 * gate's job) is looked up — one read per workflow run, cached — and dropped only
 * if that run is of the gate's workflow file. If the lookup fails, the name rule
 * stands in, with a warning: as it was before the job shared its name with lanes.
 */
export async function withoutGateRuns<T extends Parameters<typeof classifyGateRun>[0]>(
  runs: T[],
  self: GateRun | undefined,
  actionsOctokit: Octokit,
  owner: string,
  repo: string,
): Promise<T[]> {
  const kept: T[] = [];
  for (const c of runs) {
    const k = classifyGateRun(c, self);
    if (k === "own") continue;
    if (k === "candidate") {
      const runId = actionsRunId(c);
      let path: string | null | undefined = runId ? workflowOfRun.get(runId) : null;
      if (runId && path === undefined) {
        try {
          const { data } = await actionsOctokit.rest.actions.getWorkflowRun({ owner, repo, run_id: Number(runId) });
          path = data.path ?? null;
        } catch (e) {
          core.warning(`could not tell whether \`${c.name}\` (run ${runId}) is the gate's own job — treating it as the gate's: ${(e as Error).message}`);
          path = self!.workflowPath!;
        }
        workflowOfRun.set(runId, path);
      }
      // A workflow run's path can carry a ref (`…/gate.yml@refs/heads/main`).
      if ((path ?? "").replace(/@.*$/, "") === self!.workflowPath) continue;
    }
    kept.push(c);
  }
  return kept;
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

/** One formal review, as the sign-off rule reads it. */
export interface SignoffReview {
  at: string;
  author?: string | null;
  /** GitHub's user type for the author ("User", "Bot"). */
  authorType?: string | null;
  /** The author's association with the repo (OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE, …). */
  association?: string | null;
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
  // Who may sign off: a person whose association is trusted (by default write
  // access: OWNER, MEMBER, COLLABORATOR — the policy's trusted_author_associations),
  // or another bot (an App installed on the repo). Without this, anyone who can
  // review — read access is enough — could sign off a branch with no review rule.
  trustedAssociations: string[] = ["OWNER", "MEMBER", "COLLABORATOR"],
): { reviewer: string; at: string }[] {
  const trusted = new Set(trustedAssociations.map((a) => a.toUpperCase()));
  const eligible = (r: SignoffReview & { login: string }) =>
    (r.authorType ?? "").toLowerCase() === "bot" || r.login.toLowerCase().endsWith("[bot]") || trusted.has((r.association ?? "").toUpperCase());
  const latest = new Map<string, SignoffReview & { login: string }>();
  for (const r of reviews) {
    const state = (r.state ?? "").toUpperCase();
    if (!r.author || !["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(state)) continue;
    const key = r.author.toLowerCase();
    const prev = latest.get(key);
    if (!prev || parseTimestamp(r.at) >= parseTimestamp(prev.at)) latest.set(key, { ...r, state, login: r.author });
  }
  return [...latest.values()]
    .filter((r) => r.state === "APPROVED" && r.sha === headSha && !sameLogin(r.login, harness) && !sameLogin(r.login, prAuthor) && eligible(r))
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

/**
 * The quiet verdicts among a head's check runs (quiet_verdicts=), as review-shaped
 * records: each check that quietVerdictOf (src/shared/verdicts.ts) accepts becomes
 * the bot's COMMENTED review on the head, submitted when the check completed, whose
 * body ends in its verdict line.
 */
export function quietVerdictReviews(
  checkRuns: QuietCheckRunLike[],
  headSha: string,
  policy: PolicyFile,
): { submitted_at: string; commit_id: string; state: string; user: { login: string }; author_association: string; body: string }[] {
  if (!policy.verdictChecks?.length || !policy.verdictApp) return [];
  const author = policy.botLogin ?? `${policy.verdictApp}[bot]`;
  return checkRuns.flatMap((r) => {
    const q = quietVerdictOf(r, { checks: policy.verdictChecks!, app: policy.verdictApp!, headSha });
    return q ? [{ submitted_at: q.at, commit_id: headSha, state: "COMMENTED", user: { login: author }, author_association: "NONE", body: `${q.summary}\n\n${verdictLine(q.word)}` }] : [];
  });
}

export async function gatherFacts(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  policy: PolicyFile,
  checksOctokit: Octokit = octokit,
  self?: GateRun,
  opts: { readCommits?: boolean } = {},
): Promise<PullRequestFacts> {
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
  // The head's check runs, read first: CI below, and the quiet verdicts with the reviews.
  type CheckRunRaw = {
    id?: number | null;
    name?: string | null;
    status?: string | null;
    conclusion?: string | null;
    app?: { slug?: string | null } | null;
    details_url?: string | null;
    html_url?: string | null;
    completed_at?: string | null;
    head_sha?: string | null;
    output?: { title?: string | null; summary?: string | null } | null;
  };
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
  const rawEvents: VerdictEvent[] = [];
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, { owner, repo, pull_number: prNumber, per_page: 100 });
  // quiet_verdicts: a verdict delivered as a check run joins the reviews as the
  // bot's verdict on the head, at the time it completed — so "latest verdict
  // wins" orders the two kinds together. Put FIRST: the orderings are stable, so
  // a review from the same second wins the tie (a rejection is never outranked
  // by an approval it cannot be ordered against).
  reviews.unshift(...(quietVerdictReviews(checkRunsRaw, pr.head.sha, policy) as typeof reviews));
  // …and it is not CI. Only the harness App's run is left out: a run of the same
  // name from anything else is judged like any other check.
  checkRunsRaw = checkRunsRaw.filter(
    (c) => !(policy.verdictApp && policy.verdictChecks?.includes(c.name ?? "") && (c.app?.slug ?? "").toLowerCase() === policy.verdictApp.toLowerCase()),
  );
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
  const files: PrFile[] = filesRaw.map((f) => ({ path: f.filename, additions: f.additions, deletions: f.deletions, ...(f.previous_filename ? { previousPath: f.previous_filename } : {}) }));

  const ignore = new Set(policy.ciIgnoreCheckNames ?? []);
  // The gate's own job is not CI: this run is in progress while it reads, and an
  // earlier run of the gate cancelled by a newer event would otherwise read as
  // failing CI. Dropped before anything else reads the list (see isOwnGateRun).
  checkRunsRaw = await withoutGateRuns(checkRunsRaw, self, self?.actionsOctokit ?? checksOctokit, owner, repo);
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
  // The head's commits, once, after the head is known: for a caller that judges
  // who wrote them, and for dependabot's update level. A list whose last commit
  // is not the head (a push in between) counts as unread.
  let headCommits: PullRequestFacts["headCommits"];
  if (opts.readCommits || authorLogin === DEPENDABOT_LOGIN) {
    try {
      const listed = (await octokit.paginate(octokit.rest.pulls.listCommits, { owner, repo, pull_number: prNumber, per_page: 100 })).map(commitAuthorOf);
      if (listed.length && listed[listed.length - 1]!.sha === pr.head.sha) headCommits = listed;
      else core.warning(`PR #${prNumber}: its commits as listed do not end at the head ${pr.head.sha.slice(0, 8)} — treating them as unread`);
    } catch (e) {
      core.warning(`PR #${prNumber}: could not read its commits (${(e as Error).message})`);
    }
  }
  // The level comes from the `updated-dependencies` block in the messages of the
  // commits GitHub made for dependabot (anyone who can push could write one), and
  // from the title; the higher of the two.
  const dependabotUpdateType =
    authorLogin === DEPENDABOT_LOGIN
      ? parseDependabotUpdateType((headCommits ?? []).filter((c) => isGitHubSignedBy(c, DEPENDABOT_LOGIN)).map((c) => c.message), pr.title)
      : undefined;

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
  // A re-review request: only verdicts posted after the label was added count.
  // An unreadable history is recorded, not thrown: the caller holds the result.
  let rereview: PullRequestFacts["rereview"];
  if (policy.rereviewLabel && labels.includes(policy.rereviewLabel)) {
    try {
      const events = await octokit.paginate(octokit.rest.issues.listEvents, { owner, repo, issue_number: prNumber, per_page: 100 });
      const since = requestedAt(events as LabelEvent[], policy.rereviewLabel);
      rereview = since ? { since } : {};
    } catch (e) {
      core.warning(`PR #${prNumber}: could not read when \`${policy.rereviewLabel}\` was added — ${(e as Error).message}`);
      rereview = { unreadable: true };
    }
  }
  const rereviewSince = rereview?.since;
  const headVerdict = latestHeadVerdict(
    reviews
      .filter((r) => r.submitted_at && isFresh(r.submitted_at, rereviewSince))
      .map((r) => ({ at: r.submitted_at!, sha: r.commit_id, author: r.user?.login, authorAssociation: r.author_association, body: r.body })),
    pr.head.sha,
    policy,
    markers,
  );

  // A sign-off. Only when the policy has something for it to clear on this head
  // (handoff clauses; with signoff_clears, the reviewer's escalation or an
  // escalation label), and GitHub's review decision is read only when there is
  // a candidate.
  let signoff: PullRequestFacts["signoff"];
  let signoffUnavailable: string | undefined;
  const clears = policy.signoffClears ?? [];
  if (
    policy.handoffClauses?.length ||
    (clears.includes("agent-escalate") && headVerdict === "escalate") ||
    (clears.includes("escalation-label") && escalationLabel({ labels }, policy) !== undefined)
  ) {
    const candidates = signoffCandidates(
      reviews.filter((r) => r.submitted_at).map((r) => ({ at: r.submitted_at!, author: r.user?.login, authorType: r.user?.type, association: r.author_association, state: r.state, sha: r.commit_id })),
      pr.head.sha,
      policy.botLogin,
      authorLogin,
      policy.trustedAuthorAssociations?.length ? policy.trustedAuthorAssociations : undefined,
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

  return { ...(headCommits ? { headCommits } : {}), number: prNumber, title: pr.title, headSha: pr.head.sha, headRefName: pr.head.ref, baseRefName: pr.base.ref, labels, ciStatus, checkRuns, approvedAt, files, cleanRebase, authorLogin, dependabotUpdateType, reviewThreads, requestedReviewers, changesRequestedBy, escalated: headVerdict === "escalate" || escalationLabel({ labels }, policy) !== undefined, headVerdict, ...(signoff ? { signoff } : {}), ...(signoffUnavailable ? { signoffUnavailable } : {}), ...(rereview ? { rereview } : {}) };
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
      // Another run (an event run and the scheduled pass can both reach a ready
      // PR) may have merged it first. Then there is nothing wrong to report.
      try {
        const now = (await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber })).data;
        if (now.merged) {
          core.info(`PR #${prNumber} was merged by another run`);
          return false;
        }
      } catch {
        // fall through to the rejected-merge handling
      }
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
  const handoffOnly = conclusion === "action_required" && !verdict.escalated;
  const ignore = new Set([...(policy.ciIgnoreCheckNames ?? []), ownCheck]);
  const gateLine = decision.action === "merge"
    ? "`ready-to-merge` — every clause of the merge policy passes on this head."
    : `\`${decision.code}\` — ${decision.reason}`;
  const by = facts.signoff ? `by @${facts.signoff.reviewer} on \`${facts.signoff.sha.slice(0, 7)}\`` : "";
  const handoffsSigned = signedOff.filter((d) => d.code !== "escalated");
  const escalateWord = (policy.verdictWords ?? parseVerdictWords(undefined)).escalate;
  const signed = [
    handoffsSigned.length
      ? `Policy handoff signed off: ${handoffsSigned.map((d) => `\`${d.code}\``).join(", ")} ${by}.` +
        (facts.headVerdict ? ` The reviewer's own verdict on this head stands: ${facts.headVerdict}.` : "")
      : "",
    verdict.escalationSignedOff
      ? `${escalateWord}, signed off ${by}: the reviewer escalated this head to a person, and a person approved it. The reviewer's reasons are in its review.`
      : "",
    signedOff.length > handoffsSigned.length ? `Escalation label \`${escalationLabel(facts, policy)}\` signed off ${by}.` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
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
  // What would answer an escalation the policy lets a sign-off clear.
  const clears = policy.signoffClears ?? [];
  const answerable = escalationLabel(facts, policy) ? clears.includes("escalation-label") && (facts.headVerdict !== "escalate" || clears.includes("agent-escalate")) : clears.includes("agent-escalate");
  const escalationAnswer = answerable
    ? `\n\nA formal approval of this head from a person other than \`${policy.botLogin ?? "the pipeline"}\`, once GitHub's own review requirements are met, signs it off here.`
    : "";
  const base =
    handoffOnly
      ? handoffSummary
      : conclusion === "action_required"
      ? `${escalationLabel(facts, policy) ? `Escalated to a human by the \`${escalationLabel(facts, policy)}\` label.` : "The reviewer escalated this head to a human."}\n\nGate: ${gateLine}${escalationAnswer}`
      : conclusion === "neutral"
        ? awaitingSummary(alsoFailing ?? [], facts, ignore)
        : gateLine;
  const summary = [base, signed, !signed && !handoffOnly && facts.signoffUnavailable ? `${verdict.escalated && answerable ? "Escalation" : "Policy handoff"} not signed off: ${facts.signoffUnavailable}.` : ""]
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
  /** The gate's own workflow run, left out of the CI rollup (see isOwnGateRun). */
  self?: GateRun;
}): Promise<{ evaluated: number; written: number }> {
  const { octokit, checksOctokit, owner, repo, checkName } = opts;
  // The gate's own check sits on the head it judges: left in the CI rollup, a
  // failing verdict would read as failing CI and hold itself failing forever.
  const policy: PolicyFile = { ...opts.policy, ciIgnoreCheckNames: [...(opts.policy.ciIgnoreCheckNames ?? []), checkName] };
  if (policy.noVerdictConclusion !== undefined && policy.noVerdictConclusion !== "failure" && policy.noVerdictConclusion !== "neutral") {
    throw new Error(`no_verdict_conclusion must be "failure" or "neutral", got ${JSON.stringify(policy.noVerdictConclusion)}`);
  }
  if (policy.noVerdictConclusion === "neutral") {
    core.warning(
      'no_verdict_conclusion: neutral — GitHub counts a neutral check as PASSING a required status check, so a head the approver has not decided would pass one. Prefer merge="off", which publishes no result until there is a verdict.',
    );
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
      const facts = await gatherFacts(octokit, owner, repo, n, policy, checksOctokit, opts.self);
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

/** How many PRs one scheduled pass of the single gate evaluates. Not a setting. */
export const GATE_TICK_LIMIT = 20;

/**
 * Withdraw the gate's result from a head that no longer has a verdict (the
 * approver's review was dismissed). A completed run is not reopened — its
 * conclusion would stand — but superseded: a NEW run of the same name, in
 * progress, which is the one GitHub reads for this commit from then on. In
 * progress never counts as passing a required check. The gate's next result
 * on this head completes that new run (publishCheck adopts the newest).
 */
export async function withdrawCheck(checksOctokit: Octokit, owner: string, repo: string, headSha: string, name: string, app: string): Promise<boolean> {
  const runs = await checksOctokit.paginate(checksOctokit.rest.checks.listForRef, { owner, repo, ref: headSha, check_name: name, filter: "all", per_page: 100 });
  const mine = runs.filter((r) => r.name === name && r.app?.slug === app).sort((a, b) => b.id - a.id)[0];
  // Any completed result, including the `neutral` "Awaiting the approver" 0.3.x
  // left on undecided heads: GitHub counts neutral as passing a required check,
  // so it must not stand without a verdict. (Holding the head in progress no
  // longer starves it: the approver's select job does not wait on the gate's own
  // checks — GATE_CHECKS.)
  if (!mine || mine.status !== "completed") return false;
  await checksOctokit.rest.checks.create({
    owner,
    repo,
    name,
    head_sha: headSha,
    status: "in_progress",
    output: { title: "Awaiting the approver", summary: "The approver's verdict on this head is gone (dismissed). The gate publishes a result once there is one." },
  });
  return true;
}

/**
 * Put the gate's result on a head at "in progress" — which never passes a
 * required check — for a re-review request. A completed run is superseded by a
 * new one (its conclusion would otherwise stand); an in-progress run is updated
 * in place. The approver's select job does not wait on the gate's checks
 * (GATE_CHECKS), so the hold cannot stop the fresh verdict it waits for.
 */
export async function pendCheck(
  checksOctokit: Octokit,
  owner: string,
  repo: string,
  headSha: string,
  name: string,
  app: string,
  output: { title: string; summary: string },
  /** Only retitle a run already held in progress; never create one or supersede a result. */
  onlyIfHeld = false,
): Promise<boolean> {
  const runs = await checksOctokit.paginate(checksOctokit.rest.checks.listForRef, { owner, repo, ref: headSha, check_name: name, filter: "all", per_page: 100 });
  const mine = runs.filter((r) => r.name === name && r.app?.slug === app).sort((a, b) => b.id - a.id)[0];
  if (onlyIfHeld && (!mine || mine.status === "completed")) return false;
  if (mine && mine.status !== "completed") {
    if ((mine.output?.title ?? "") === output.title && (mine.output?.summary ?? "") === output.summary) return false;
    await checksOctokit.rest.checks.update({ owner, repo, check_run_id: mine.id, status: "in_progress", output });
    return true;
  }
  await checksOctokit.rest.checks.create({ owner, repo, name, head_sha: headSha, status: "in_progress", output });
  return true;
}

/**
 * The single gate (`merge=` on the node), for one PR (an event run) or for a
 * window of the PRs the bot has reviewed (the scheduled pass):
 *
 *   1. work out the result against the policy;
 *   2. publish it as the check on the PR's head, human PR or agent PR alike —
 *      but only once the approver has a verdict on that head;
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
  /**
   * merge_bots= on the gate: the bots (each in rollout.bot_authors) whose own PRs
   * the gate merges once ready. A separate grant from merge="agent-only", which
   * merges only what the pipeline wrote. Empty: a person merges every bot's PR.
   */
  mergeBots?: string[];
  rollout: Rollout | undefined;
  prNumber?: number;
  dryRun: boolean;
  /** Scheduled pass: stop starting new evaluations after this many seconds. */
  timeBudgetSeconds?: number;
  /** Scheduled pass: the run number, which moves the pass's window each tick. */
  rotation?: number;
  /** Injected clock, for tests. */
  now?: () => number;
  /** The gate's own workflow run, left out of the CI rollup (see isOwnGateRun). */
  self?: GateRun;
  /** The re-review label, when the harness has one (the policy carries it too). */
  rereviewLabel?: string;
  /**
   * explain_on= (#52): why the approver has no verdict on this PR's head yet, as
   * its sweep's select job put it. Shown on the check, in progress, only on that
   * head and only while it has no verdict.
   */
  waiting?: Waiting;
}): Promise<{ evaluated: number; written: number; mergedPr: string; publishedPrs?: number[] }> {
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

  const now = opts.now ?? Date.now;
  const started = now();
  const deadline = opts.timeBudgetSeconds ? started + opts.timeBudgetSeconds * 1000 : Infinity;

  // A targeted run (an event on one PR) evaluates that PR. The scheduled pass
  // evaluates a rotating window of the PRs the gate could have something to say
  // about: the gate publishes only once the approver has a verdict on the head,
  // and a verdict is a review by the harness bot — so the candidates are one
  // search for open PRs the bot has reviewed (plus dependabot's, when the policy
  // runs that lane).
  type Pr = { number: number; draft?: boolean | null; user?: { login?: string; type?: string } | null; labels: { name?: string }[] };
  // Scope is decided from what the listing already carries, BEFORE a scheduled
  // pass takes its window: a window taken first spends its places on PRs it then
  // turns away (in a busy repo most reviewed PRs can carry the skip label).
  const scopeOf = (p: Pr) => {
    const author = p.user?.login;
    const scope = inScope(
      { authorLogin: author, authorType: p.user?.type, draft: p.draft, labels: p.labels.map((l) => (typeof l === "string" ? l : l.name ?? "")).filter(Boolean) },
      rollout,
      botLogin,
    );
    // The policy's dependabot lane is its own explicit opt-in, and stays one:
    // when it is on, dependabot's PRs are judged (and merged) on that lane.
    const onDependabotLane = dependabotLane && author === DEPENDABOT_LOGIN && !p.draft;
    return { ...scope, onDependabotLane, admitted: scope.inScope || onDependabotLane };
  };
  const windowOfInScope = (all: Pr[]): Pr[] => {
    const admitted = all.filter((p) => scopeOf(p).admitted);
    if (admitted.length < all.length) core.info(`${all.length - admitted.length} of ${all.length} candidate(s) out of scope`);
    return rotatingWindow(admitted, GATE_TICK_LIMIT, opts.rotation ?? 0);
  };
  let prs: Pr[];
  if (opts.prNumber !== undefined) {
    const one = (await octokit.rest.pulls.get({ owner, repo, pull_number: opts.prNumber })).data;
    if (one.state !== "open") {
      core.info(`PR #${one.number} is ${one.state} — nothing to evaluate`);
      return { evaluated: 0, written: 0, mergedPr: "" };
    }
    // The gate is configured for one base branch; a PR into any other is not its to judge or merge.
    if (one.base.ref !== opts.baseBranch) {
      core.info(`PR #${one.number} targets ${one.base.ref}, not ${opts.baseBranch} — not this gate's`);
      return { evaluated: 0, written: 0, mergedPr: "" };
    }
    prs = [one];
  } else if (botLogin) {
    let found: Candidate[];
    try {
      found = await searchCandidates((q, v) => octokit.graphql(q, v), {
        owner,
        repo,
        base: opts.baseBranch,
        // The skip label is left out by the search itself too (scope still
        // decides below). Not for dependabot's lane, which the label does not stop.
        qualifiers: [
          [reviewedByQualifier(botLogin), ...excludeLabelQualifier(rollout?.skipLabel)].join(" "),
          ...(dependabotLane ? ["author:app/dependabot"] : []),
        ],
      });
    } catch (e) {
      // No fallback to walking every open PR: that is what used to time out.
      // Verdicts reach the gate through the review event regardless.
      core.notice(`could not search for the PRs to evaluate (${(e as Error).message}) — nothing evaluated this tick; the next tick tries again`);
      return { evaluated: 0, written: 0, mergedPr: "" };
    }
    prs = windowOfInScope(found.map((c) => ({ number: c.number, draft: c.draft, user: { login: c.author, type: c.authorType }, labels: c.labels.map((name) => ({ name })) })));
    core.info(`${found.length} open PR(s) reviewed by ${botLogin}; evaluating ${prs.length} this tick`);
  } else {
    // No bot login to search by: the original listing, in a rotating window.
    const open = await octokit.paginate(octokit.rest.pulls.list, { owner, repo, state: "open", base: opts.baseBranch, sort: "created", direction: "asc", per_page: 100 });
    prs = windowOfInScope(open);
  }

  let evaluated = 0;
  let written = 0;
  // The PRs whose result this run changed: what a dispatch= on the gate wakes its targets for.
  const publishedPrs: number[] = [];
  let mergedPr = "";
  for (const p of prs) {
    if (now() > deadline) {
      core.info("near the job's time limit — the rest wait for the next tick");
      break;
    }
    const n = p.number;
    const author = p.user?.login;
    const scope = scopeOf(p);
    let onDependabotLane = scope.onDependabotLane;
    if (!scope.admitted) {
      core.info(`PR #${n}: out of scope — ${scope.detail}`);
      continue;
    }
    let botWritten: { botWritten: boolean; detail: string } | undefined;
    evaluated++;
    let removeRereviewLabel = false;
    try {
      const gathered = await gatherFacts(octokit, owner, repo, n, checkPolicy, checksOctokit, opts.self, {
        readCommits: scope.reason === "bot-author" || (opts.merge === "agent-only" && sameLogin(author, botLogin)),
      });
      // rollout.bot_authors: the bot's PR is judged on the verdict — and may be
      // merged — only while every commit on the head is the bot's, made and signed
      // by GitHub. Anything else puts it back under the rule for everyone else: the
      // policy's dependabot lane if that is on and the author is dependabot, else
      // out of scope. Commits that cannot be read: not judged this tick (fail closed).
      if (scope.reason === "bot-author") {
        if (!gathered.headCommits) {
          core.warning(`PR #${n}: its commits could not be read — not evaluated this tick`);
          evaluated--;
          continue;
        }
        botWritten = isBotWritten({ authorLogin: author }, gathered.headCommits, rollout);
        if (botWritten.botWritten) {
          onDependabotLane = false;
        } else if (!onDependabotLane) {
          core.info(`PR #${n}: out of scope — ${botWritten.detail}; rollout.bot_authors admits a bot's PR only while every commit is its own`);
          evaluated--;
          continue;
        }
      }
      const facts: PullRequestFacts = { ...gathered, ...(botWritten?.botWritten ? { botWritten: true } : {}) };
      // No verdict from the approver on this head: no result. A missing required
      // check blocks a merge; a neutral one would PASS it. (The dependabot lane
      // needs no verdict.) A result already on this head — its verdict since
      // dismissed — is withdrawn to in progress.
      // A re-review request: until there is a verdict newer than the label, the
      // result is held at in progress (never passing, never merged). Once there
      // is one, the request is done — the label comes off and the head is judged.
      //
      // (The dependabot lane never gets a verdict, so the label means nothing there.)
      if (facts.rereview && opts.rereviewLabel && !onDependabotLane) {
        const held = facts.rereview.unreadable
          ? `could not read when \`${opts.rereviewLabel}\` was added, so whether the verdict on \`${(facts.headSha ?? "").slice(0, 7)}\` is fresh is unknown. The next run tries again; nothing is merged until then.`
          : !facts.rereview.since
            ? // The label is on, but its history shows no labeled event as its latest:
              // the request cannot be dated, so no verdict can be shown to answer it.
              // Held, not judged on a verdict it may have been asking to replace —
              // usually a moment's lag in the events API, which the next run clears.
              `\`${opts.rereviewLabel}\` is on this PR, but its history does not say when it was added, so no verdict can be shown to be newer. The next run tries again; if this persists, remove the label and add it again. Nothing is merged until then.`
            : !facts.headVerdict
            ? `\`${opts.rereviewLabel}\` was added${facts.rereview.since ? ` at ${facts.rereview.since}` : ""}: waiting for a fresh review and a fresh verdict on \`${(facts.headSha ?? "").slice(0, 7)}\`. Earlier verdicts no longer count, and nothing is merged until then.`
            : undefined;
        if (held) {
          if (!opts.dryRun && facts.headSha) {
            await pendCheck(checksOctokit, owner, repo, facts.headSha, checkName, opts.checkApp, { title: "Re-review requested", summary: held });
          }
          core.info(`PR #${n}: re-review requested — held (${facts.rereview.unreadable ? "label history unreadable" : !facts.rereview.since ? "request cannot be dated" : "no fresh verdict yet"})`);
          continue;
        }
        // Done: the label comes off — LAST, once this PR is published and merged.
        // Its removal is itself a PR event, and that event's gate run, in the same
        // concurrency group, would cancel this one partway through a merge.
        removeRereviewLabel = true;
      }
      const verdictless = !facts.headVerdict && !onDependabotLane;
      const waiting = opts.waiting;
      if (verdictless && waiting && opts.prNumber === n && facts.headSha === waiting.sha) {
        // The sweep's reason, for the head it was given for. In progress, which
        // never passes a required check; written only when it changed.
        const short = waiting.sha.slice(0, 7);
        const summary = `${waiting.title}.\n\nThere is no verdict from the approver on \`${short}\` yet, so this check stays in progress — it never passes — until there is one. The reason is the approver's own: its sweep selects the heads it decides. Once the verdict is in, the gate publishes its result here.`;
        if (!opts.dryRun && (await pendCheck(checksOctokit, owner, repo, waiting.sha, checkName, opts.checkApp, { title: waiting.title, summary }))) {
          core.info(`PR #${n}: no verdict yet — check held in progress: ${waiting.title}`);
        }
      } else if (verdictless) {
        const mine = (facts.checkRuns ?? []).find((c) => c.name === checkName && c.appSlug === opts.checkApp);
        if (mine && !opts.dryRun && facts.headSha && (await withdrawCheck(checksOctokit, owner, repo, facts.headSha, checkName, opts.checkApp))) {
          core.info(`PR #${n}: verdict gone from ${facts.headSha.slice(0, 8)} — result withdrawn`);
        } else {
          core.info(`PR #${n}: no verdict from the approver on this head yet — no result published`);
        }
      }

      // Who merges this PR? Only asked when the gate may merge at all.
      let writer: { agentWritten: boolean; detail: string } | undefined;
      if (opts.merge === "agent-only" && !onDependabotLane && !botWritten?.botWritten) {
        writer = isAgentWritten({ authorLogin: author }, facts.headCommits, botLogin);
      }
      // merge_bots=: a bot's own PR is merged only when its author is named there.
      const botMerges = !!botWritten?.botWritten && (opts.mergeBots ?? []).some((b) => sameLogin(b, author));

      const decision = evaluateMergeGate(facts, checkPolicy);
      const out = renderCheckOutput(decision, facts, checkPolicy, checkName);
      // An event run lands while the same event's other workflows are still
      // starting on this head (a review or label starts them too), so CI that is
      // merely pending says nothing yet. When pending CI is all that stands
      // between this head and success, an event run publishes nothing and leaves
      // the head's existing result: the scheduled pass, or the next event, settles
      // it. Only then: with anything else outstanding (a failing clause, a policy
      // handoff no longer signed off) the result is published as before, or a
      // stale success would stand.
      const ciPendingOnly =
        opts.prNumber !== undefined &&
        facts.ciStatus === "pending" &&
        out.conclusion !== "success" &&
        checkVerdict({ ...facts, ciStatus: "passing" }, checkPolicy).conclusion === "success";
      // Say, on the PR, who will merge it — the one thing the result alone does not.
      // signoff_clears: agent-escalate — the reviewer asked for a person, so a
      // person merges what they signed off; the pipeline does not.
      const escalatedToPerson = facts.headVerdict === "escalate" && !!base.signoffClears?.includes("agent-escalate");
      if (opts.merge === "agent-only" || botWritten?.botWritten) {
        const line = escalatedToPerson
          ? "Merge: a person merges this PR — the reviewer escalated this head, and the pipeline does not merge an escalation a person signed off."
          : onDependabotLane
          ? "Merge: the pipeline merges this PR on the dependabot lane when it is ready."
          : botWritten?.botWritten
            ? botMerges
              ? `Merge: ${author} wrote every commit on this PR and the gate's merge_bots names it; the pipeline merges it when it is ready.`
              : `Merge: a person merges this PR — ${author} is a bot author, and the gate's merge_bots does not name it.`
            : writer?.agentWritten
            ? "Merge: the pipeline wrote this PR and merges it when it is ready."
            : `Merge: a person merges this PR — it is not agent-written (${writer?.detail ?? "unknown"}).`;
        out.text = out.text ? `${out.text}\n\n${line}` : line;
      }
      core.info(`PR #${n}: ${out.conclusion} (${decision.code}) — ${decision.reason}`);
      if (ciPendingOnly && !verdictless) {
        core.info(`PR #${n}: CI is still running on ${(facts.headSha ?? "").slice(0, 8)} — no result from an event run; the scheduled pass settles it`);
        // A check held in progress from before the verdict ("approver is deciding")
        // would otherwise go on saying so: say what it now waits for instead. Still
        // in progress; a completed result is left alone. The title is the sweep's
        // own for this wait (explain_on=), so its next tick sends nothing new.
        if (!opts.dryRun && facts.headSha) {
          await pendCheck(checksOctokit, owner, repo, facts.headSha, checkName, opts.checkApp, { title: WAITING_ON_CI, summary: `The approver's verdict on \`${facts.headSha.slice(0, 7)}\` is in; checks are still running on it. This check stays in progress until they finish, then the gate publishes its result.` }, true);
        }
      } else if (!opts.dryRun && facts.headSha && !verdictless) {
        const result = await publishCheck(checksOctokit, owner, repo, facts.headSha, checkName, out, opts.checkApp);
        if (result !== "unchanged") {
          written++;
          publishedPrs.push(n);
        }
        core.info(`PR #${n}: check \`${checkName}\` ${result} on ${facts.headSha.slice(0, 8)}`);
      }

      // Acting is for the pipeline's own PRs only, and one merge per run.
      if (mergedPr) continue;
      if (escalatedToPerson) continue;
      if (botWritten?.botWritten) {
        // A separate grant from merge="agent-only": only the bots merge_bots names.
        if (!botMerges) continue;
      } else {
        if (opts.merge !== "agent-only") continue;
        if (!onDependabotLane && !writer?.agentWritten) continue;
      }
      // Judged again under the merge's own policy: the rebase clause is on here
      // by default, where the check above leaves it off.
      const mergeDecision = evaluateMergeGate(facts, base);
      if (await actOnDecision(octokit, owner, repo, n, facts, mergeDecision, base, opts.dryRun)) mergedPr = String(n);
    } catch (e) {
      core.warning(`PR #${n}: not evaluated this tick — ${(e as Error).message}`);
    } finally {
      if (removeRereviewLabel && opts.rereviewLabel && !opts.dryRun) {
        try {
          await octokit.rest.issues.removeLabel({ owner, repo, issue_number: n, name: opts.rereviewLabel });
          core.info(`PR #${n}: a fresh verdict answers the re-review request — removed \`${opts.rereviewLabel}\``);
        } catch (e) {
          core.warning(`PR #${n}: could not remove \`${opts.rereviewLabel}\`: ${(e as Error).message}`);
        }
      }
    }
  }
  core.info(`${evaluated} PR(s) in scope${mergedPr ? `; merged #${mergedPr}` : ""}`);
  return { evaluated, written, mergedPr, publishedPrs };
}

/** The gate's own run: GITHUB_RUN_ID from the runner, the job's check-run name from the compiler. */
function gateRunFromEnv(): GateRun {
  const runId = (process.env.GITHUB_RUN_ID ?? "").trim();
  const jobCheckName = core.getInput("job-check-name").trim();
  const workflowPath = core.getInput("gate-workflow").trim();
  const actionsToken = core.getInput("actions-token").trim();
  return {
    ...(runId ? { runId } : {}),
    ...(jobCheckName ? { jobCheckName } : {}),
    ...(workflowPath ? { workflowPath } : {}),
    ...(workflowPath && actionsToken ? { actionsOctokit: github.getOctokit(actionsToken) } : {}),
  };
}

/** explain_on=: the reason a sweep gave for a head, and that head. */
export interface Waiting {
  title: string;
  sha: string;
}

/**
 * The waiting-title / waiting-sha inputs. Both or nothing; the title is one line
 * of at most 120 characters (it is a check title), the sha a full commit SHA.
 */
export function waitingFromInputs(rawTitle: string, rawSha: string): Waiting | undefined {
  const title = rawTitle.replace(/[\r\n]+/g, " ").trim().slice(0, WAITING_TITLE_MAX);
  const sha = rawSha.trim();
  if (!title || !sha) return undefined;
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    core.warning(`waiting-sha is not a commit SHA (${JSON.stringify(sha.slice(0, 50))}) — the reason is ignored`);
    return undefined;
  }
  return { title, sha };
}

export async function run(): Promise<void> {
  try {
    const token = core.getInput("token", { required: true });
    const policyPath = core.getInput("policy-path", { required: true });
    const prNumberInput = core.getInput("pr-number");
    const baseBranch = core.getInput("base-branch") || "main";
    const branchPrefixInput = core.getInput("branch-prefix");
    const dryRun = core.getInput("dry-run") === "true";

    // The single gate reads its policy from the BASE branch. On the PR that adds
    // the harness the base has none yet: an event run there has nothing to judge
    // by, which is not a failure of that PR. (A scheduled run still fails loudly.)
    if (core.getInput("merge").trim() && prNumberInput && !existsSync(policyPath)) {
      core.notice(`merge-gate: no policy at ${policyPath} on the base branch yet — nothing to evaluate until it is merged`);
      return;
    }
    const policy = loadPolicy(policyPath);
    // Fail loudly on a policy handoff that is not one: it would otherwise be ignored.
    validateHandoffClauses(policy.handoffClauses);
    validateSignoffClears(policy.signoffClears);
    if (branchPrefixInput) policy.branchPrefix = branchPrefixInput; // input overrides policy file
    // The compiler passes these from foundry.config.yaml / the graph, so a
    // consumer's identity and human-gate wiring don't have to be restated in the
    // policy file. Inputs win over the policy file, same as branch-prefix.
    // The verdict words the compiler passes from foundry.config.yaml (`verdicts:`).
    const verdictChecksInput = core.getInput("verdict-checks").trim();
    const verdictAppInput = core.getInput("verdict-app").trim();
    if (verdictChecksInput && verdictAppInput) {
      policy.verdictChecks = verdictChecksInput.split(/\n/).map((s) => s.trim()).filter(Boolean);
      policy.verdictApp = verdictAppInput;
    }
    const rereviewInput = core.getInput("rereview-label").trim();
    if (rereviewInput) policy.rereviewLabel = rereviewInput;
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
      // merge-bots: bot logins, comma-separated, each one of the rollout's botAuthors.
      const mergeBots = core
        .getInput("merge-bots")
        .split(",")
        .map((b) => b.trim().toLowerCase())
        .filter(Boolean);
      for (const b of mergeBots) {
        if (!(rollout?.botAuthors ?? []).some((a) => sameLogin(a, b))) {
          throw new Error(`merge-bots names ${b}, which the rollout's botAuthors does not — run \`gp-foundry build\``);
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
        ...(mergeBots.length ? { mergeBots } : {}),
        checkApp: core.getInput("check-app").trim() || CHECK_APP,
        timeBudgetSeconds: parseInt(core.getInput("time-budget-seconds"), 10) || undefined,
        // The window advances once per schedule period: computed from the clock,
        // not a run counter, which event runs of the same workflow also advance.
        rereviewLabel: policy.rereviewLabel,
        rotation: Math.floor(Date.now() / (1000 * (parseInt(core.getInput("rotation-period-seconds"), 10) || 300))),
        self: gateRunFromEnv(),
        waiting: waitingFromInputs(core.getInput("waiting-title"), core.getInput("waiting-sha")),
      });
      core.setOutput("evaluated", String(r.evaluated));
      core.setOutput("checks-written", String(r.written));
      core.setOutput("published-prs", (r.publishedPrs ?? []).join(","));
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
        self: gateRunFromEnv(),
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
      const facts = await gatherFacts(octokit, owner, repo, prNumber, policy, checksOctokit, gateRunFromEnv());
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
      const facts = await gatherFacts(octokit, owner, repo, n, policy, checksOctokit, gateRunFromEnv());
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
