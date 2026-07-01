/**
 * merge-gate action wrapper (C7).
 *
 * Thin I/O shell around the pure `evaluateMergeGate` core in `gate.ts`:
 *   1. read inputs (pr-number, token, policy-path)
 *   2. load + parse the policy (YAML or JSON)
 *   3. gather PR facts from the GitHub API (labels, CI rollup, approval time,
 *      changed files, clean-rebase flag)
 *   4. call the pure gate
 *   5. act on the decision: merge, apply a label, or no-op — and emit outputs
 *
 * No gp-dixie hardcodes live here: bot login, approval marker, protected paths,
 * exclude globs, size limit, labels, etc. all come from the policy file.
 */

import { readFileSync } from "node:fs";
import * as core from "@actions/core";
import * as github from "@actions/github";
import yaml from "js-yaml";
import {
  evaluateMergeGate,
  type MergePolicy,
  type PullRequestFacts,
  type PrFile,
  type CiStatus,
} from "./gate.js";

/** Policy file shape = MergePolicy plus a couple of I/O-only knobs. */
interface PolicyFile extends MergePolicy {
  /**
   * Regex tested against a COMMENTED review body to count it as an approval
   * (e.g. "Verdict.*APPROVE"). APPROVED reviews always count regardless.
   */
  approvalBodyRegex?: string;
  /** Check-run names to ignore in the CI rollup (the agent's own runs). */
  ciIgnoreCheckNames?: string[];
  /** Merge method used when the gate says merge. Default "rebase". */
  mergeMethod?: "merge" | "squash" | "rebase";
  /** Delete the head branch on merge. Default true. */
  deleteBranchOnMerge?: boolean;
}

type Octokit = ReturnType<typeof github.getOctokit>;

function loadPolicy(path: string): PolicyFile {
  const raw = readFileSync(path, "utf8");
  const parsed = (yaml.load(raw) ?? {}) as unknown;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`policy file ${path} did not parse to an object`);
  }
  return parsed as PolicyFile;
}

/** Does a review count as a qualifying approval? */
function isApproval(
  review: { state?: string | null; body?: string | null },
  bodyRe?: RegExp,
): boolean {
  if (review.state === "APPROVED") return true;
  if (review.state === "COMMENTED" && bodyRe && review.body) {
    return bodyRe.test(review.body);
  }
  return false;
}

/** Roll a set of check-runs up to a single CI status. */
function rollupCi(
  checkRuns: { name?: string | null; status?: string | null; conclusion?: string | null }[],
  ignoreNames: Set<string>,
): CiStatus {
  const relevant = checkRuns.filter((c) => !ignoreNames.has(c.name ?? ""));
  if (relevant.length === 0) return "unknown";
  if (relevant.some((c) => c.conclusion === "failure" || c.conclusion === "timed_out" || c.conclusion === "cancelled")) {
    return "failing";
  }
  if (relevant.every((c) => c.status === "completed" && (c.conclusion === "success" || c.conclusion === "skipped" || c.conclusion === "neutral"))) {
    return "passing";
  }
  if (relevant.some((c) => c.status === "in_progress" || c.status === "queued" || c.status === "pending")) {
    return "pending";
  }
  return "unknown";
}

async function gatherFacts(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  policy: PolicyFile,
): Promise<PullRequestFacts> {
  const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });

  const labels = pr.labels.map((l) => (typeof l === "string" ? l : l.name ?? "")).filter(Boolean);

  // Approval time: latest qualifying review's submittedAt.
  const bodyRe = policy.approvalBodyRegex ? new RegExp(policy.approvalBodyRegex) : undefined;
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });
  const approvalTimes = reviews
    .filter((r) => isApproval(r, bodyRe))
    .map((r) => r.submitted_at)
    .filter((t): t is string => !!t)
    .sort();
  const approvedAt = approvalTimes.length ? approvalTimes[approvalTimes.length - 1] : null;

  // Changed files.
  const filesRaw = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });
  const files: PrFile[] = filesRaw.map((f) => ({
    path: f.filename,
    additions: f.additions,
    deletions: f.deletions,
  }));

  // CI rollup for the head SHA.
  const ignore = new Set(policy.ciIgnoreCheckNames ?? []);
  const checkRuns = await octokit.paginate(octokit.rest.checks.listForRef, {
    owner,
    repo,
    ref: pr.head.sha,
    per_page: 100,
  });
  const ciStatus = rollupCi(checkRuns, ignore);

  // Clean-rebase flag: GitHub's mergeable_state. "dirty" = conflicts. When
  // unknown/null, leave undefined so the gate treats it as not-yet-verified.
  let cleanRebase: boolean | undefined;
  if (pr.mergeable === true && pr.mergeable_state && pr.mergeable_state !== "dirty") {
    cleanRebase = true;
  } else if (pr.mergeable === false || pr.mergeable_state === "dirty") {
    cleanRebase = false;
  } else {
    cleanRebase = undefined;
  }
  // Allow an explicit override input to bypass mergeable-state guessing.
  const overrideRebase = core.getInput("clean-rebase");
  if (overrideRebase === "true") cleanRebase = true;
  else if (overrideRebase === "false") cleanRebase = false;

  return {
    number: prNumber,
    title: pr.title,
    headRefName: pr.head.ref,
    labels,
    ciStatus,
    approvedAt,
    files,
    cleanRebase,
  };
}

async function run(): Promise<void> {
  try {
    const prNumber = parseInt(core.getInput("pr-number", { required: true }), 10);
    const token = core.getInput("token", { required: true });
    const policyPath = core.getInput("policy-path", { required: true });
    const dryRun = core.getInput("dry-run") === "true";

    if (Number.isNaN(prNumber)) throw new Error("pr-number must be an integer");

    const policy = loadPolicy(policyPath);
    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;

    const facts = await gatherFacts(octokit, owner, repo, prNumber, policy);
    const decision = evaluateMergeGate(facts, policy);

    core.info(`Decision for PR #${prNumber}: ${decision.action} (${decision.code}) — ${decision.reason}`);
    core.setOutput("action", decision.action);
    core.setOutput("code", decision.code);
    core.setOutput("reason", decision.reason);
    if (decision.label) core.setOutput("label", decision.label);
    core.setOutput("merged", "false");

    if (dryRun) {
      core.info("dry-run: not performing any mutation");
      return;
    }

    if (decision.action === "label" && decision.label) {
      await octokit.rest.issues.addLabels({
        owner,
        repo,
        issue_number: prNumber,
        labels: [decision.label],
      });
      core.info(`Labeled PR #${prNumber} with \`${decision.label}\``);
      return;
    }

    if (decision.action === "merge") {
      await octokit.rest.pulls.merge({
        owner,
        repo,
        pull_number: prNumber,
        merge_method: policy.mergeMethod ?? "rebase",
      });
      if ((policy.deleteBranchOnMerge ?? true)) {
        try {
          await octokit.rest.git.deleteRef({ owner, repo, ref: `heads/${facts.headRefName}` });
        } catch (e) {
          core.warning(`Could not delete branch ${facts.headRefName}: ${(e as Error).message}`);
        }
      }
      core.setOutput("merged", "true");
      core.info(`Merged PR #${prNumber}`);
    }
    // action === "skip": pure no-op.
  } catch (err) {
    core.setFailed((err as Error).message);
  }
}

void run();
