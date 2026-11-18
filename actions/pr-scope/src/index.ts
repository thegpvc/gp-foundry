/**
 * pr-scope — the guard every PR lane runs first.
 *
 * Answers two questions about one pull request, with the shared implementation
 * in src/shared/scope.ts (the merge gate uses the same one):
 *
 *   in scope?        the rollout dial: does the pipeline look at this PR at all
 *   agent-written?   may a lane that WRITES act on it
 *
 * Fails CLOSED. This decides whose pull requests the pipeline touches, so a PR
 * that cannot be read is one the lane does not run on — reported as a warning,
 * not as a red job: nothing is wrong with the PR.
 */
import * as core from "@actions/core";
import * as github from "@actions/github";
import { inScope, isAgentWritten, sameLogin, type Rollout } from "../../../src/shared/scope.js";
import { excludeLabelQualifier, reviewedByQualifier, roundRobinByAuthor, searchCandidates, type Candidate } from "../../../src/shared/candidates.js";

type Octokit = ReturnType<typeof github.getOctokit>;

export interface ScopeResult {
  inScope: boolean;
  /** Undefined when it was not asked for. */
  agentWritten?: boolean;
  run: boolean;
  reason: string;
}

export async function decide(
  octokit: Octokit,
  opts: { owner: string; repo: string; number: number; rollout?: Rollout; botLogin?: string; requireAgentWritten: boolean; branchPrefix?: string },
): Promise<ScopeResult> {
  const { owner, repo, number, botLogin } = opts;
  let pr;
  try {
    pr = (await octokit.rest.pulls.get({ owner, repo, pull_number: number })).data;
  } catch (e) {
    return { inScope: false, run: false, reason: `could not read PR #${number} (${(e as Error).message}) — not running on a PR whose scope is unknown` };
  }
  const author = pr.user?.login;
  // The commonest way for a new harness to do nothing at all: identity.bot_login
  // names one account and the pipeline posts as another (under PAT auth it posts
  // as the PAT's owner). Its own PRs then look like a stranger's. Say so, on the
  // one signal available — an agent-named branch opened by someone else.
  const looksLikeAgentPr =
    !!opts.branchPrefix && !!pr.head?.ref?.startsWith(opts.branchPrefix) && !!author && !sameLogin(author, botLogin);
  const hint = looksLikeAgentPr
    ? ` — note: its branch '${pr.head.ref}' has the agent prefix but ${author} opened it; if the pipeline did, identity.bot_login should be '${author}', not '${botLogin ?? "(unset)"}'`
    : "";
  const scope = inScope(
    { authorLogin: author, authorType: pr.user?.type, draft: pr.draft, labels: pr.labels.map((l) => l.name ?? "").filter(Boolean) },
    opts.rollout,
    botLogin,
  );
  if (!scope.inScope) {
    const explain = scope.reason === "not-in-rollout" || scope.reason === "other-bot" ? hint : "";
    return { inScope: false, run: false, reason: scope.detail + explain };
  }
  if (!opts.requireAgentWritten) return { inScope: true, run: true, reason: scope.detail };

  // Commits are only worth reading for a PR the bot opened; anything else is
  // human-written whatever its commits say.
  let commits: { authorLogin?: string | null }[] | undefined;
  if (sameLogin(author, botLogin)) {
    try {
      commits = (await octokit.paginate(octokit.rest.pulls.listCommits, { owner, repo, pull_number: number, per_page: 100 })).map((c) => ({
        authorLogin: c.author?.login,
      }));
    } catch {
      commits = undefined; // isAgentWritten answers "no" for commits it could not read
    }
  }
  const writer = isAgentWritten({ authorLogin: author }, commits, botLogin);
  return {
    inScope: true,
    agentWritten: writer.agentWritten,
    run: writer.agentWritten,
    reason: writer.agentWritten ? writer.detail : `this lane only acts on PRs the pipeline wrote: ${writer.detail}${hint}`,
  };
}

/** One open PR a sweep may consider: what its select job needs to carry on. */
export interface ScopedPr {
  number: number;
  sha: string;
  base: string;
  /** Pending review requests (people and teams). */
  requested: number;
  /** Seconds since the PR last changed. */
  quiet: number;
}

/**
 * Every open PR on `baseBranch` that is in scope, oldest first. Returns
 * undefined when the listing failed twice: the API has a bad minute now and
 * then (a truncated page reads as "unexpected end of JSON input"), and a sweep
 * that could not even list has nothing to be red about — the next tick lists again.
 */
export async function listInScope(
  octokit: Octokit,
  opts: { owner: string; repo: string; baseBranch?: string; rollout?: Rollout; botLogin?: string; nowMs?: number; retryDelayMs?: number; reviewedBy?: string },
): Promise<ScopedPr[] | undefined> {
  const { owner, repo } = opts;
  const now = opts.nowMs ?? Date.now();
  const toScoped = (c: Candidate): ScopedPr => ({
    number: c.number,
    sha: c.sha,
    base: c.base,
    requested: c.requested,
    quiet: Math.max(0, Math.floor((now - c.updatedAt) / 1000)),
  });
  const keep = (c: Candidate) => {
    const scope = inScope({ authorLogin: c.author, authorType: c.authorType, draft: c.draft, labels: c.labels }, opts.rollout, opts.botLogin);
    if (!scope.inScope) core.info(`#${c.number}: out of scope — ${scope.detail}`);
    return scope.inScope;
  };

  // Only PRs the bot has reviewed: one search, retried once.
  if (opts.reviewedBy) {
    const search = () =>
      searchCandidates((q, v) => octokit.graphql(q, v), {
        owner,
        repo,
        base: opts.baseBranch,
        // The skip label is left out by the search too; `keep` still decides scope.
        qualifiers: [[reviewedByQualifier(opts.reviewedBy!), ...excludeLabelQualifier(opts.rollout?.skipLabel)].join(" ")],
      });
    let found: Candidate[];
    try {
      found = await search();
    } catch (first) {
      core.info(`searching for reviewed pull requests failed (${(first as Error).message}); retrying once`);
      await new Promise((r) => setTimeout(r, opts.retryDelayMs ?? 5000));
      try {
        found = await search();
      } catch (second) {
        core.warning(`could not search for reviewed pull requests: ${(second as Error).message}`);
        return undefined;
      }
    }
    // Scope first, then the round-robin: an author's out-of-scope PRs take no place in it.
    return roundRobinByAuthor(found.filter(keep)).map(toScoped);
  }
  const list = () =>
    octokit.paginate(octokit.rest.pulls.list, {
      owner,
      repo,
      state: "open",
      ...(opts.baseBranch ? { base: opts.baseBranch } : {}),
      sort: "created",
      direction: "asc",
      per_page: 100,
    });
  let prs: Awaited<ReturnType<typeof list>>;
  try {
    prs = await list();
  } catch (first) {
    core.info(`listing open pull requests failed (${(first as Error).message}); retrying once`);
    await new Promise((r) => setTimeout(r, opts.retryDelayMs ?? 5000));
    try {
      prs = await list();
    } catch (second) {
      core.warning(`could not list open pull requests: ${(second as Error).message}`);
      return undefined;
    }
  }
  const cands: Candidate[] = prs.map((p) => ({
    number: p.number,
    sha: p.head.sha,
    base: p.base.ref,
    author: p.user?.login ?? "",
    authorType: p.user?.type ?? "",
    draft: !!p.draft,
    labels: p.labels.map((l) => l.name ?? "").filter(Boolean),
    requested: (p.requested_reviewers?.length ?? 0) + (p.requested_teams?.length ?? 0),
    updatedAt: Date.parse(p.updated_at) || 0,
  }));
  // Without the reviewed-by search: oldest first, as before.
  return cands.filter(keep).map(toScoped);
}

export async function run(): Promise<void> {
  try {
    const rolloutEarly = core.getInput("rollout").trim();
    if (core.getInput("list").trim() === "true") {
      let rollout: Rollout | undefined;
      if (rolloutEarly) {
        try {
          rollout = JSON.parse(rolloutEarly) as Rollout;
        } catch {
          throw new Error("rollout must be the JSON the compiler writes — run `gp-foundry build`");
        }
      }
      const { owner, repo } = github.context.repo;
      const prs = await listInScope(github.getOctokit(core.getInput("token", { required: true })), {
        owner,
        repo,
        baseBranch: core.getInput("base-branch").trim() || undefined,
        rollout,
        botLogin: core.getInput("bot-login").trim() || undefined,
        reviewedBy: core.getInput("reviewed-by").trim() || undefined,
      });
      core.setOutput("listed", String(prs !== undefined));
      core.setOutput("prs", JSON.stringify(prs ?? []));
      core.info(prs ? `${prs.length} pull request(s) in scope` : "the open pull requests could not be listed this tick");
      return;
    }
    const number = parseInt(core.getInput("number", { required: true }), 10);
    if (Number.isNaN(number)) throw new Error(`number must be an integer, got "${core.getInput("number")}"`);
    const rolloutInput = core.getInput("rollout").trim();
    let rollout: Rollout | undefined;
    if (rolloutInput) {
      try {
        rollout = JSON.parse(rolloutInput) as Rollout;
      } catch {
        throw new Error("rollout must be the JSON the compiler writes — run `gp-foundry build`");
      }
    }
    const { owner, repo } = github.context.repo;
    const result = await decide(github.getOctokit(core.getInput("token", { required: true })), {
      owner,
      repo,
      number,
      rollout,
      botLogin: core.getInput("bot-login").trim() || undefined,
      requireAgentWritten: core.getInput("require-agent-written").trim() === "true",
      branchPrefix: core.getInput("branch-prefix").trim() || undefined,
    });
    core.setOutput("in-scope", String(result.inScope));
    core.setOutput("agent-written", result.agentWritten === undefined ? "" : String(result.agentWritten));
    core.setOutput("run", String(result.run));
    core.setOutput("reason", result.reason);
    if (result.run) core.info(`PR #${number}: running — ${result.reason}`);
    else if (result.reason.startsWith("could not read")) core.warning(`PR #${number}: ${result.reason}`);
    else core.notice(`PR #${number}: skipping — ${result.reason}`);
  } catch (err) {
    // A malformed input is a build problem, not a PR's: fail closed AND loudly.
    core.setOutput("run", "false");
    core.setFailed((err as Error).message);
  }
}

// Imported by the tests, which call decide() themselves.
if (!process.env.VITEST) void run();
