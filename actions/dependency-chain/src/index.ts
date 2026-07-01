/**
 * dependency-chain — GitHub Action entrypoint.
 *
 * Thin adapter around the pure `computeChainOps` logic in ./chain.ts. Runs on a
 * merged PR, fetches the open-issue snapshot, computes label/close ops, and
 * applies them via Octokit. Every domain string (labels, markers, close
 * keywords, comment) is read from a single JSON `config` input, so the action
 * carries no gp-dixie hardcodes.
 */

import * as core from "@actions/core";
import * as github from "@actions/github";
import {
  computeChainOps,
  type ChainConfig,
  type IssueSnapshot,
} from "./chain.js";

/** Parse the `config` JSON input into a validated ChainConfig. */
function readConfig(): ChainConfig {
  const raw = core.getInput("config");
  if (!raw || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`invalid \`config\` JSON: ${(e as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("`config` must be a JSON object");
  }
  return parsed as ChainConfig;
}

async function run(): Promise<void> {
  const token = core.getInput("token", { required: true });
  const config = readConfig();
  const dryRun = core.getBooleanInput("dry-run");

  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;

  // ── Resolve the merged PR body ───────────────────────────────────────────
  // Prefer the explicit `pr-body` input; otherwise fall back to the triggering
  // pull_request event payload. Fetching via the API (like the original
  // workflow's `gh pr view`) is also supported through `pr-number`.
  let prBody: string | null | undefined = core.getInput("pr-body") || undefined;
  const prNumberInput = core.getInput("pr-number");

  if (prBody === undefined) {
    if (prNumberInput) {
      const { data } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: Number(prNumberInput),
      });
      prBody = data.body;
    } else {
      prBody = github.context.payload.pull_request?.body;
    }
  }

  // ── Snapshot open issues (paginated) ─────────────────────────────────────
  // If a blocked label is configured we scope the "unblock" query to it (as the
  // original did), but we still need the full open set to evaluate parent
  // completion, so fetch all open issues and let the pure fn filter.
  const rawIssues = await octokit.paginate(octokit.rest.issues.listForRepo, {
    owner,
    repo,
    state: "open",
    per_page: 100,
  });

  const openIssues: IssueSnapshot[] = rawIssues
    // `listForRepo` returns PRs too; drop them.
    .filter((i) => !("pull_request" in i) || i.pull_request === undefined)
    .map((i) => ({
      number: i.number,
      body: i.body,
      labels: (i.labels ?? []).map((l) =>
        typeof l === "string" ? l : (l.name ?? ""),
      ),
    }));

  const result = computeChainOps({ prBody, openIssues }, config);

  core.info(
    `PR closes issue(s): ${
      result.closedIssues.length ? result.closedIssues.map((n) => `#${n}`).join(", ") : "(none)"
    }`,
  );
  core.info(`Computed ${result.ops.length} op(s).`);

  const unblocked: number[] = [];
  const closedParents: number[] = [];

  for (const op of result.ops) {
    if (op.kind === "unblock") {
      core.info(
        `Unblock #${op.issue} (was blocked on ${op.unblockedBy
          .map((n) => `#${n}`)
          .join(", ")}): -[${op.removeLabels.join(",")}] +[${op.addLabels.join(",")}]`,
      );
      if (!dryRun) {
        for (const label of op.removeLabels) {
          try {
            await octokit.rest.issues.removeLabel({
              owner,
              repo,
              issue_number: op.issue,
              name: label,
            });
          } catch (e) {
            // A 404 just means the label wasn't present; not fatal.
            core.warning(
              `could not remove label "${label}" from #${op.issue}: ${(e as Error).message}`,
            );
          }
        }
        if (op.addLabels.length > 0) {
          await octokit.rest.issues.addLabels({
            owner,
            repo,
            issue_number: op.issue,
            labels: op.addLabels,
          });
        }
      }
      unblocked.push(op.issue);
    } else {
      core.info(`Close parent #${op.issue}`);
      if (!dryRun) {
        if (op.comment) {
          await octokit.rest.issues.createComment({
            owner,
            repo,
            issue_number: op.issue,
            body: op.comment,
          });
        }
        await octokit.rest.issues.update({
          owner,
          repo,
          issue_number: op.issue,
          state: "closed",
        });
      }
      closedParents.push(op.issue);
    }
  }

  core.setOutput("closed-issues", JSON.stringify(result.closedIssues));
  core.setOutput("unblocked", JSON.stringify(unblocked));
  core.setOutput("closed-parents", JSON.stringify(closedParents));
  core.setOutput("ops", JSON.stringify(result.ops));
}

run().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
