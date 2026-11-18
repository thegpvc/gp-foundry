import type { getOctokit } from "@actions/github";
import { verdictLine } from "../../../src/shared/verdicts.js";
import type {
  ChangedFileData,
  CheckRunData,
  ContextData,
  ContextType,
  InlineCommentData,
  PullRequestData,
  ReviewData,
  ReviewThreadData,
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
  /**
   * A second client, used ONLY to read check runs on the PR head. Separate from
   * the main one because the Checks permission has no fine-grained-PAT
   * equivalent: the harness token cannot read check runs, GITHUB_TOKEN can.
   * Omit to skip check conclusions entirely.
   */
  checksOctokit?: Octokit;
  /**
   * quiet_verdicts=: check runs that carry a lane's verdict instead of a review,
   * and the App whose runs alone count. Listed with the reviews (needs checksOctokit).
   */
  verdictChecks?: { checks: string[]; app: string };
}

/**
 * Fetch GitHub context based on type.
 */
export async function fetchContext(
  octokit: Octokit,
  opts: FetchOptions
): Promise<ContextData> {
  const { owner, repo, number, type, includeDiff, checksOctokit, verdictChecks } = opts;

  switch (type) {
    case "issue":
      return fetchIssue(octokit, owner, repo, number);
    case "pr-review":
    case "pr-full":
      return fetchPRFull(octokit, owner, repo, number, includeDiff, checksOctokit, verdictChecks);
    case "pr-diff":
      return fetchPRDiff(octokit, owner, repo, number, includeDiff, checksOctokit);
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

/**
 * The quiet verdicts among a head's check runs, as review records: completed runs
 * of a named verdict check, owned by the harness App (another app's run of the
 * same name is ignored), titled `Verdict: <WORD>`. The body is the check's
 * summary followed by the verdict line, as a verdict review would read.
 */
export function quietVerdictReviews(
  checkRuns: CheckRunData[] | undefined,
  verdictChecks: FetchOptions["verdictChecks"],
  headSha: string | undefined,
): ReviewData[] {
  if (!checkRuns || !verdictChecks?.checks.length) return [];
  const out: ReviewData[] = [];
  for (const r of checkRuns) {
    const word = /^Verdict: (\S+)$/.exec((r.output?.title ?? "").trim())?.[1];
    if (!verdictChecks.checks.includes(r.name) || r.app?.slug !== verdictChecks.app || r.status !== "completed" || !word) continue;
    out.push({
      user: { login: `${verdictChecks.app}[bot]` } as ReviewData["user"],
      state: `VERDICT (check run \`${r.name}\`)`,
      submitted_at: r.completed_at ?? undefined,
      body: `${r.output?.summary ?? ""}\n\n${verdictLine(word)}`,
      commit_id: r.head_sha ?? headSha ?? null,
    });
  }
  return out;
}

async function fetchPRFull(
  octokit: Octokit,
  owner: string,
  repo: string,
  number: number,
  includeDiff: boolean,
  checksOctokit: Octokit | undefined,
  verdictChecks?: FetchOptions["verdictChecks"],
): Promise<ContextData> {
  const base = await fetchPRDiff(octokit, owner, repo, number, includeDiff, checksOctokit);
  const reviews = (await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number: number,
  })) as unknown as ReviewData[];
  // A verdict delivered as a check run (quiet_verdicts=) sits with the reviews,
  // in time order, so a later lane reads the decision where it reads the others.
  const quiet = quietVerdictReviews(base.checkRuns, verdictChecks, base.pr?.head?.sha);
  if (quiet.length) {
    reviews.push(...quiet);
    reviews.sort((a, b) => (a.submitted_at ?? "").localeCompare(b.submitted_at ?? ""));
  }
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: number,
  });

  // Threads are the better view (ids, resolution state, reactions) but they are
  // GraphQL-only, and a token or an outage that breaks GraphQL must not cost the
  // agent its whole context. On failure, fall back to the flat REST comments and
  // flag it, so the formatter can say which view the reader is looking at.
  const fetchWarnings = [...(base.fetchWarnings ?? [])];
  let reviewThreads: ReviewThreadData[] | undefined;
  let inlineComments: InlineCommentData[] = [];
  let reviewThreadsUnavailable = false;
  try {
    reviewThreads = await fetchReviewThreads(octokit, owner, repo, number);
  } catch (error) {
    reviewThreadsUnavailable = true;
    fetchWarnings.push(`review threads unavailable (GraphQL): ${errorMessage(error)}`);
    inlineComments = (await octokit.paginate(octokit.rest.pulls.listReviewComments, {
      owner,
      repo,
      pull_number: number,
    })) as unknown as InlineCommentData[];
  }

  return {
    ...base,
    reviews,
    reviewThreads,
    ...(reviewThreadsUnavailable ? { reviewThreadsUnavailable } : {}),
    inlineComments,
    comments: comments as unknown as ContextData["comments"],
    ...(fetchWarnings.length > 0 ? { fetchWarnings } : {}),
  };
}

/** What every PR type carries: the PR, its changed files, checks, and the diff. */
async function fetchPRDiff(
  octokit: Octokit,
  owner: string,
  repo: string,
  number: number,
  includeDiff: boolean,
  checksOctokit: Octokit | undefined
): Promise<ContextData> {
  const { data: pr } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: number,
  });
  const files = (await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: number,
    per_page: 100,
  })) as unknown as ChangedFileData[];

  const result: ContextData = { pr: pr as unknown as PullRequestData, files, diff: null };

  if (checksOctokit) {
    // Best-effort, like the threads: a missing permission on the checks token
    // degrades to a note in the context, never to a failed job.
    try {
      const sha = (pr as unknown as PullRequestData).head?.sha;
      if (!sha) throw new Error("the pull request has no head SHA");
      result.checkRuns = (await checksOctokit.paginate(checksOctokit.rest.checks.listForRef, {
        owner,
        repo,
        ref: sha,
        per_page: 100,
      })) as unknown as CheckRunData[];
    } catch (error) {
      result.checksUnavailable = true;
      result.fetchWarnings = [`check runs unavailable: ${errorMessage(error)}`];
    }
  }

  if (includeDiff) {
    try {
      result.diff = await fetchDiff(octokit, owner, repo, number);
    } catch (error) {
      // Only "too large" has a fallback (the per-file patches already in
      // `files`). Anything else — auth, a missing PR, an outage — is a real
      // failure and must stay one.
      if (!isDiffTooLarge(error)) throw error;
      result.diffTooLarge = true;
    }
  }

  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Did GitHub refuse the diff for its size? That is HTTP 406 on the diff media
 * type (over 20,000 lines / 300 files), or on some endpoints a 422 whose error
 * code is `too_large`.
 */
function isDiffTooLarge(error: unknown): boolean {
  const e = error as { status?: number; message?: string; response?: { data?: unknown } } | null;
  if (!e || typeof e !== "object") return false;
  if (e.status === 406) return true;
  if (e.status !== 422) return false;
  let detail = "";
  try {
    detail = JSON.stringify(e.response?.data ?? "");
  } catch {
    // An unserializable error body tells us nothing either way.
  }
  return /too_large/i.test(`${e.message ?? ""} ${detail}`);
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

// Reactions are requested on the FIRST comment only (the finding itself), via an
// aliased one-element connection, so the query cost does not multiply reactions
// by every reply in every thread.
const REVIEW_THREADS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          originalLine
          firstComment: comments(first: 1) {
            nodes { reactions(first: 100) { nodes { content user { login } } } }
          }
          comments(first: 100) {
            totalCount
            nodes { author { __typename login } body }
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
          id: string;
          isResolved: boolean;
          isOutdated: boolean;
          path: string;
          line: number | null;
          originalLine: number | null;
          firstComment: {
            nodes: Array<{
              reactions: { nodes: Array<{ content: string; user: { login: string } | null } | null> };
            } | null>;
          };
          comments: {
            totalCount: number;
            nodes: Array<{
              author: { __typename?: string; login: string } | null;
              body: string;
            } | null>;
          };
        } | null>;
      };
    } | null;
  } | null;
}

// A PR does not have 5,000 review threads; a cursor that never ends is a bug or
// a hostile response, and the loop should stop either way.
const MAX_THREAD_PAGES = 100;

/**
 * Fetch every review thread of a PR via GraphQL — the only API that exposes
 * thread ids and resolution state. Throws on any failure; the caller decides
 * what to fall back to.
 */
async function fetchReviewThreads(
  octokit: Octokit,
  owner: string,
  repo: string,
  number: number
): Promise<ReviewThreadData[]> {
  const threads: ReviewThreadData[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_THREAD_PAGES; page++) {
    const result: ThreadsQueryResult = await octokit.graphql<ThreadsQueryResult>(
      REVIEW_THREADS_QUERY,
      { owner, repo, number, cursor }
    );
    const connection = result?.repository?.pullRequest?.reviewThreads;
    if (!connection) throw new Error("GraphQL returned no reviewThreads for this pull request");
    for (const node of connection.nodes) {
      if (!node) continue;
      threads.push({
        id: node.id,
        isResolved: node.isResolved,
        isOutdated: node.isOutdated,
        path: node.path,
        // An outdated thread has no line in the current diff; its original one
        // still says where the finding was made.
        line: node.line ?? node.originalLine ?? null,
        comments: node.comments.nodes
          .filter((c): c is NonNullable<typeof c> => c !== null)
          .map((c) => ({ user: c.author ? { login: restLogin(c.author) } : null, body: c.body })),
        totalComments: node.comments.totalCount,
        reactions: (node.firstComment.nodes[0]?.reactions.nodes ?? [])
          .filter((r): r is NonNullable<typeof r> => r !== null)
          .map((r) => ({ content: r.content, user: r.user ? { login: r.user.login } : null })),
      });
    }
    if (!connection.pageInfo.hasNextPage || !connection.pageInfo.endCursor) break;
    cursor = connection.pageInfo.endCursor;
  }
  return threads;
}

/**
 * GraphQL names a GitHub App's account `my-app`; REST names the same account
 * `my-app[bot]`. Everything else in this action (and `trusted-authors`) speaks
 * the REST form, so a thread comment by the reviewer bot must be normalized or
 * it would silently stop matching and be framed as a stranger's.
 */
function restLogin(author: { __typename?: string; login: string }): string {
  return author.__typename === "Bot" && !author.login.endsWith("[bot]")
    ? `${author.login}[bot]`
    : author.login;
}
