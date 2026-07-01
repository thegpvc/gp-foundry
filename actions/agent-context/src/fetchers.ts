import type { getOctokit } from "@actions/github";
import type {
  ContextData,
  ContextType,
  PullRequestData,
} from "./formatters.js";

/** The concrete Octokit instance type produced by @actions/github. */
export type Octokit = ReturnType<typeof getOctokit>;

/** Options controlling what context is fetched. */
export interface FetchOptions {
  owner: string;
  repo: string;
  number: number;
  type: ContextType;
  includeDiff: boolean;
}

/**
 * Fetch GitHub context based on type.
 */
export async function fetchContext(
  octokit: Octokit,
  opts: FetchOptions
): Promise<ContextData> {
  const { owner, repo, number, type, includeDiff } = opts;

  switch (type) {
    case "issue":
      return fetchIssue(octokit, owner, repo, number);
    case "pr-review":
    case "pr-full":
      return fetchPRFull(octokit, owner, repo, number, includeDiff);
    case "pr-diff":
      return fetchPRDiff(octokit, owner, repo, number, includeDiff);
    default:
      throw new Error(`Unknown context type: ${type}`);
  }
}

async function fetchIssue(
  octokit: Octokit,
  owner: string,
  repo: string,
  number: number
): Promise<ContextData> {
  const { data: issue } = await octokit.rest.issues.get({
    owner,
    repo,
    issue_number: number,
  });
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: number,
  });
  return { issue: issue as unknown as ContextData["issue"], comments: comments as unknown as ContextData["comments"] };
}

async function fetchPRFull(
  octokit: Octokit,
  owner: string,
  repo: string,
  number: number,
  includeDiff: boolean
): Promise<ContextData> {
  const { data: pr } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: number,
  });
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number: number,
  });
  const inlineComments = await octokit.paginate(
    octokit.rest.pulls.listReviewComments,
    { owner, repo, pull_number: number }
  );
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: number,
  });

  const diff = includeDiff
    ? await fetchDiff(octokit, owner, repo, number)
    : null;

  return {
    pr: pr as unknown as PullRequestData,
    reviews: reviews as unknown as ContextData["reviews"],
    inlineComments: inlineComments as unknown as ContextData["inlineComments"],
    comments: comments as unknown as ContextData["comments"],
    diff,
  };
}

async function fetchPRDiff(
  octokit: Octokit,
  owner: string,
  repo: string,
  number: number,
  includeDiff: boolean
): Promise<ContextData> {
  const { data: pr } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: number,
  });

  const diff = includeDiff
    ? await fetchDiff(octokit, owner, repo, number)
    : null;

  return { pr: pr as unknown as PullRequestData, diff };
}

/** Fetch the raw unified diff for a PR via the diff media type. */
async function fetchDiff(
  octokit: Octokit,
  owner: string,
  repo: string,
  number: number
): Promise<string> {
  const { data } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: number,
    mediaType: { format: "diff" },
  });
  // With the diff media type the response body is the raw diff string, though
  // the generated types still describe it as the PR object.
  return data as unknown as string;
}
