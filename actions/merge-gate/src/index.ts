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
  evaluateMergeGate,
  filterCandidateNumbers,
  latestValidApproval,
  normalizePolicyKeys,
  type MergePolicy,
  type PullRequestFacts,
  type PrFile,
  type CiStatus,
  type MergeDecision,
  type VerdictEvent,
} from "./gate.js";

interface PolicyFile extends MergePolicy {
  approvalBodyRegex?: string;
  /** Body marker that INVALIDATES earlier approvals (default: "REQUEST_CHANGES"). */
  rejectionBodyRegex?: string;
  ciIgnoreCheckNames?: string[];
  mergeMethod?: "merge" | "squash" | "rebase";
  deleteBranchOnMerge?: boolean;
  // Label applied when a merge fails on a conflict, so a Fixer can pick it up and rebase.
  rebaseLabel?: string;
}

type Octokit = ReturnType<typeof github.getOctokit>;

function loadPolicy(path: string): PolicyFile {
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

async function gatherFacts(octokit: Octokit, owner: string, repo: string, prNumber: number, policy: PolicyFile): Promise<PullRequestFacts> {
  const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  const labels = pr.labels.map((l) => (typeof l === "string" ? l : l.name ?? "")).filter(Boolean);
  const bodyRe = policy.approvalBodyRegex ? new RegExp(policy.approvalBodyRegex) : undefined;
  // Rejections invalidate earlier approvals. The default marker is ANCHORED like the
  // approval one (a bare "REQUEST_CHANGES" substring would misread an approval whose
  // prose mentions the earlier requested changes — e.g. a fix-loop re-approval).
  const rejectRe = new RegExp(policy.rejectionBodyRegex ?? "Verdict.*REQUEST_CHANGES");

  // Collect verdict-bearing events (reviews + marker comments) in time order, then
  // apply the integrity rule: latest verdict wins, approval must match the head SHA
  // (or, for comments, postdate the head commit). See gate.latestValidApproval.
  const events: VerdictEvent[] = [];
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, { owner, repo, pull_number: prNumber, per_page: 100 });
  // Approval is tested FIRST: per the reviewer contract the verdict is the body's
  // final "**Verdict:** …" line, and an approval may legitimately quote or discuss
  // the earlier REQUEST_CHANGES items in its prose. A body matching the approval
  // marker is an approval, full stop.
  for (const r of reviews) {
    if (!r.submitted_at) continue;
    if (isApprovalReview(r, bodyRe)) {
      events.push({ at: r.submitted_at, kind: "approve", sha: r.commit_id });
    } else if (r.state === "CHANGES_REQUESTED" || (r.state === "COMMENTED" && r.body && rejectRe.test(r.body))) {
      events.push({ at: r.submitted_at, kind: "reject", sha: r.commit_id });
    }
  }
  if (bodyRe) {
    const comments = await octokit.paginate(octokit.rest.issues.listComments, { owner, repo, issue_number: prNumber, per_page: 100 });
    for (const c of comments) {
      if (!c.body || !c.created_at) continue;
      if (bodyRe.test(c.body)) events.push({ at: c.created_at, kind: "approve" });
      else if (rejectRe.test(c.body)) events.push({ at: c.created_at, kind: "reject" });
    }
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
  const checkRuns = await octokit.paginate(octokit.rest.checks.listForRef, { owner, repo, ref: pr.head.sha, per_page: 100 });
  const ciStatus = rollupCi(checkRuns, ignore);

  let cleanRebase: boolean | undefined;
  if (pr.mergeable === true && pr.mergeable_state && pr.mergeable_state !== "dirty") cleanRebase = true;
  else if (pr.mergeable === false || pr.mergeable_state === "dirty") cleanRebase = false;
  const overrideRebase = core.getInput("clean-rebase");
  if (overrideRebase === "true") cleanRebase = true;
  else if (overrideRebase === "false") cleanRebase = false;

  return { number: prNumber, title: pr.title, headRefName: pr.head.ref, baseRefName: pr.base.ref, labels, ciStatus, approvedAt, files, cleanRebase };
}

/** Open PRs on branch-prefix branches targeting base, oldest first. */
async function listCandidates(octokit: Octokit, owner: string, repo: string, policy: PolicyFile, base: string): Promise<number[]> {
  const prs = await octokit.paginate(octokit.rest.pulls.list, { owner, repo, state: "open", base, sort: "created", direction: "asc", per_page: 100 });
  return filterCandidateNumbers(prs.map((p) => ({ number: p.number, headRefName: p.head.ref })), policy.branchPrefix);
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
  if (decision.action === "label" && decision.label) {
    await octokit.rest.issues.addLabels({ owner, repo, issue_number: prNumber, labels: [decision.label] });
    core.info(`Labeled PR #${prNumber} \`${decision.label}\``);
    // Explain why it was held back (skipped plain-skips stay quiet; a label is a real block).
    await comment(octokit, owner, repo, prNumber, `## 🔀 Auto-merge\n\nHeld this PR back and labeled \`${decision.label}\` — ${decision.reason}. A human should take a look.`);
    return false;
  }
  if (decision.action === "merge") {
    try {
      await octokit.rest.pulls.merge({ owner, repo, pull_number: prNumber, merge_method: policy.mergeMethod ?? "rebase" });
    } catch (e) {
      // A merge can still fail at merge time (e.g. a conflict that appeared after
      // another PR landed). Don't crash the poller — label it so a Fixer rebases it.
      core.warning(`Merge of #${prNumber} rejected: ${(e as Error).message}`);
      const rebaseLabel = policy.rebaseLabel ?? "needs-rebase";
      try {
        await octokit.rest.issues.addLabels({ owner, repo, issue_number: prNumber, labels: [rebaseLabel] });
      } catch (le) {
        core.warning(`Could not label #${prNumber} \`${rebaseLabel}\`: ${(le as Error).message}`);
      }
      await comment(octokit, owner, repo, prNumber, `## 🔀 Auto-merge\n\nEverything passed the gate, but GitHub rejected the merge — a conflict appeared after another PR landed. Labeled \`${rebaseLabel}\` so the janitor sweep can rebase this onto \`${facts.baseRefName ?? "the base branch"}\` and try again.`);
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

async function run(): Promise<void> {
  try {
    const token = core.getInput("token", { required: true });
    const policyPath = core.getInput("policy-path", { required: true });
    const prNumberInput = core.getInput("pr-number");
    const baseBranch = core.getInput("base-branch") || "main";
    const branchPrefixInput = core.getInput("branch-prefix");
    const dryRun = core.getInput("dry-run") === "true";

    const policy = loadPolicy(policyPath);
    if (branchPrefixInput) policy.branchPrefix = branchPrefixInput; // input overrides policy file
    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;

    // Single-PR mode.
    if (prNumberInput) {
      const prNumber = parseInt(prNumberInput, 10);
      if (Number.isNaN(prNumber)) throw new Error("pr-number must be an integer");
      const facts = await gatherFacts(octokit, owner, repo, prNumber, policy);
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
      const facts = await gatherFacts(octokit, owner, repo, n, policy);
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

void run();
