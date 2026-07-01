/**
 * C9 — wait-for-checks
 *
 * Poll a named CI workflow (by file name) or a named check-run for a given head
 * SHA until it reaches a terminal conclusion or a timeout is hit. Emits a single
 * `conclusion` output (success | failure | cancelled | skipped | timeout | …).
 *
 * The wait/decision logic mirrors the "Wait for CI" gate in gp-dixie's
 * agent-review workflow, but every hardcode (workflow file, poll counts,
 * intervals) is now an input. The actual pass/fail decision is delegated to the
 * pure, unit-tested {@link aggregate} in ./status.ts.
 */

import * as core from "@actions/core";
import { getOctokit, context } from "@actions/github";
import {
  aggregate,
  isTerminal,
  type CheckRunLike,
  type Conclusion,
} from "./status.js";

type Octokit = ReturnType<typeof getOctokit>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse an integer input with a default and a floor. */
function intInput(name: string, fallback: number, min = 0): number {
  const raw = core.getInput(name);
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) {
    core.warning(`Input '${name}'='${raw}' is not an integer; using ${fallback}`);
    return fallback;
  }
  return Math.max(min, n);
}

/**
 * Fetch the runs relevant to this poll from the appropriate GitHub API.
 *
 * - `workflow-name` (a workflow file name like "ci.yml") → the Actions
 *   "list workflow runs" API filtered by head SHA. We look at the most recent
 *   run(s) for that SHA.
 * - `check-name` → the "list check-runs for a ref" API filtered by name.
 *
 * Returns a normalized {@link CheckRunLike}[] for {@link aggregate}.
 */
async function fetchRuns(
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string,
  workflowName: string,
  checkName: string,
): Promise<CheckRunLike[]> {
  if (workflowName) {
    const res = await octokit.rest.actions.listWorkflowRuns({
      owner,
      repo,
      workflow_id: workflowName,
      head_sha: sha,
      per_page: 10,
    });
    return res.data.workflow_runs.map((r) => ({
      status: r.status,
      conclusion: r.conclusion,
    }));
  }

  // check-name path
  const res = await octokit.rest.checks.listForRef({
    owner,
    repo,
    ref: sha,
    check_name: checkName || undefined,
    per_page: 100,
  });
  return res.data.check_runs.map((r) => ({
    status: r.status,
    conclusion: r.conclusion,
  }));
}

async function run(): Promise<void> {
  const sha = core.getInput("sha", { required: true });
  const workflowName = core.getInput("workflow-name").trim();
  const checkName = core.getInput("check-name").trim();
  const token = core.getInput("token", { required: true });

  const timeoutSeconds = intInput("timeout-seconds", 900, 1);
  const pollInterval = intInput("poll-interval", 20, 1);

  if (!workflowName && !checkName) {
    core.setFailed(
      "One of 'workflow-name' or 'check-name' must be provided.",
    );
    return;
  }

  const owner = core.getInput("owner") || context.repo.owner;
  const repo = core.getInput("repo") || context.repo.repo;

  const target = workflowName
    ? `workflow '${workflowName}'`
    : `check '${checkName}'`;
  core.info(
    `Waiting for ${target} on ${owner}/${repo}@${sha.slice(0, 8)} ` +
      `(timeout ${timeoutSeconds}s, poll every ${pollInterval}s)…`,
  );

  const octokit = getOctokit(token);
  const deadline = Date.now() + timeoutSeconds * 1000;

  let conclusion: Conclusion = "timeout";
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt += 1;
    let runs: CheckRunLike[] = [];
    try {
      runs = await fetchRuns(
        octokit,
        owner,
        repo,
        sha,
        workflowName,
        checkName,
      );
    } catch (err) {
      // Transient API errors should not abort the wait; log and retry.
      core.warning(
        `Attempt ${attempt}: error querying checks: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    const decision = aggregate(runs);

    if (isTerminal(decision)) {
      conclusion = decision;
      core.info(`Attempt ${attempt}: ${target} → ${decision}`);
      break;
    }

    core.info(
      `Attempt ${attempt}: ${target} status = ${decision}` +
        (runs.length ? ` (${runs.length} run(s))` : "") +
        `, waiting ${pollInterval}s…`,
    );

    // Don't sleep past the deadline.
    if (Date.now() + pollInterval * 1000 >= deadline) break;
    await sleep(pollInterval * 1000);
  }

  if (conclusion === "timeout") {
    core.warning(`Timed out after ${timeoutSeconds}s waiting for ${target}.`);
  }

  core.setOutput("conclusion", conclusion);
  core.info(`conclusion=${conclusion}`);
}

run().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
