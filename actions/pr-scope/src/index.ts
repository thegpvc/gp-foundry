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
import { commitAuthorOf, inScope, isAgentWritten, isBotWritten, sameLogin, type Rollout } from "../../../src/shared/scope.js";
import { parseDependabotUpdateType, type DependabotBump } from "../../../src/shared/dependabot.js";
import { excludeLabelQualifier, reviewedByQualifier, roundRobinByAuthor, searchCandidates, type Candidate } from "../../../src/shared/candidates.js";
import { requestedAt, type LabelEvent } from "../../../src/shared/rereview.js";

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
  // rollout.bot_authors: the bot's own PR events carry none of the repo's
  // secrets (Dependabot's never do), so a lane cannot mint its token on them.
  // Every guard is an event's, so it hands the PR to the lane's scheduled bot
  // pass, which runs with secrets and checks that every commit is the bot's.
  if (scope.reason === "bot-author" && !opts.requireAgentWritten) {
    return {
      inScope: true,
      run: false,
      reason: `${scope.detail} — its events carry no secrets, so this lane reviews it from its scheduled bot pass, not from this event`,
    };
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
  /** When a re-review was requested (the re-review label last added), if the PR carries it. */
  since?: string;
  /**
   * The update's semver level when one can be told, as context for the agent:
   * for a bot's own PR (rollout.bot_authors) only, from its commits'
   * `updated-dependencies` block and its title. Never for anyone else's: a
   * title is its author's claim, and only the bot's is taken at its word.
   */
  bump?: Exclude<DependabotBump, "unknown">;
}

/**
 * Every open PR on `baseBranch` that is in scope, oldest first. Returns
 * undefined when the listing failed twice: the API has a bad minute now and
 * then (a truncated page reads as "unexpected end of JSON input"), and a sweep
 * that could not even list has nothing to be red about — the next tick lists again.
 */
export async function listInScope(
  octokit: Octokit,
  opts: { owner: string; repo: string; baseBranch?: string; rollout?: Rollout; botLogin?: string; nowMs?: number; retryDelayMs?: number; reviewedBy?: string; rereviewLabel?: string; only?: number; botAuthorsOnly?: boolean },
): Promise<ScopedPr[] | undefined> {
  const out = await listCandidates(octokit, opts);
  if (!out || !opts.rereviewLabel) return out?.map(({ labels: _l, ...p }) => p);
  // A PR carrying the re-review label: when it was added (one read per such PR;
  // the rule is src/shared/rereview.ts). If that cannot be read, the PR is left
  // out of this tick — neither judged on records the request made stale, nor on
  // a guessed time — and the next tick tries again.
  const result: ScopedPr[] = [];
  for (const { labels, ...p } of out) {
    if (!labels.includes(opts.rereviewLabel)) {
      result.push(p);
      continue;
    }
    let events: LabelEvent[];
    try {
      events = (await octokit.paginate(octokit.rest.issues.listEvents, { owner: opts.owner, repo: opts.repo, issue_number: p.number, per_page: 100 })) as LabelEvent[];
    } catch (e) {
      core.warning(`#${p.number}: could not read when \`${opts.rereviewLabel}\` was added (${(e as Error).message}) — left for the next tick`);
      continue;
    }
    const since = requestedAt(events, opts.rereviewLabel);
    result.push(since ? { ...p, since } : p);
  }
  return result;
}

async function listCandidates(
  octokit: Octokit,
  opts: { owner: string; repo: string; baseBranch?: string; rollout?: Rollout; botLogin?: string; nowMs?: number; retryDelayMs?: number; reviewedBy?: string; only?: number; botAuthorsOnly?: boolean },
): Promise<(ScopedPr & { labels: string[] })[] | undefined> {
  const listed = await listScoped(octokit, opts);
  if (!listed) return undefined;
  // rollout.bot_authors: a bot's PR stays a candidate only while every commit on
  // it is the bot's (one read per such PR). A person's push, or commits that
  // cannot be read, leave it out — fail closed; the next tick reads again.
  const out: (ScopedPr & { labels: string[] })[] = [];
  for (const { botAuthor, author, title, ...p } of listed) {
    if (!botAuthor) {
      if (!opts.botAuthorsOnly) out.push(p);
      continue;
    }
    let commits: ReturnType<typeof commitAuthorOf>[];
    try {
      commits = (await octokit.paginate(octokit.rest.pulls.listCommits, { owner: opts.owner, repo: opts.repo, pull_number: p.number, per_page: 100 })).map(commitAuthorOf);
    } catch (e) {
      core.warning(`#${p.number}: could not read its commits (${(e as Error).message}) — left for the next tick`);
      continue;
    }
    // The commits listed must be the listed head's: a push in between is judged next tick.
    if (commits.length && commits[commits.length - 1]!.sha !== p.sha) {
      core.info(`#${p.number}: its head moved while it was being read — left for the next tick`);
      continue;
    }
    const written = isBotWritten({ authorLogin: author }, commits, opts.rollout);
    if (!written.botWritten) {
      core.info(`#${p.number}: out of scope — ${written.detail}; rollout.bot_authors admits a bot's PR only while every commit is its own, made by GitHub`);
      continue;
    }
    const bump = parseDependabotUpdateType(commits.map((c) => c.message), title);
    out.push({ ...p, ...(bump !== "unknown" ? { bump } : {}) });
  }
  return out;
}

async function listScoped(
  octokit: Octokit,
  opts: { owner: string; repo: string; baseBranch?: string; rollout?: Rollout; botLogin?: string; nowMs?: number; retryDelayMs?: number; reviewedBy?: string; only?: number; botAuthorsOnly?: boolean },
): Promise<(ScopedPr & { labels: string[]; botAuthor: boolean; author: string; title: string })[] | undefined> {
  const { owner, repo } = opts;
  const now = opts.nowMs ?? Date.now();
  const toScoped = (c: Candidate): ScopedPr & { labels: string[]; botAuthor: boolean; author: string; title: string } => ({
    number: c.number,
    sha: c.sha,
    base: c.base,
    requested: c.requested,
    quiet: Math.max(0, Math.floor((now - c.updatedAt) / 1000)),
    labels: c.labels,
    botAuthor: inScope({ authorLogin: c.author, authorType: c.authorType, draft: c.draft, labels: c.labels }, opts.rollout, opts.botLogin).reason === "bot-author",
    author: c.author,
    title: c.title ?? "",
  });
  const keep = (c: Candidate) => {
    const scope = inScope({ authorLogin: c.author, authorType: c.authorType, draft: c.draft, labels: c.labels }, opts.rollout, opts.botLogin);
    if (!scope.inScope) core.info(`#${c.number}: out of scope — ${scope.detail}`);
    else if (opts.botAuthorsOnly && scope.reason !== "bot-author") return false;
    return scope.inScope;
  };

  // One PR (a sweep started for it): read it directly, under the same scope rule.
  // Not through the search, whose index lags a review that was only just posted.
  if (opts.only !== undefined) {
    let p;
    try {
      p = (await octokit.rest.pulls.get({ owner, repo, pull_number: opts.only })).data;
    } catch (e) {
      core.warning(`could not read #${opts.only}: ${(e as Error).message}`);
      return undefined;
    }
    if (p.state !== "open") {
      core.info(`#${p.number}: ${p.state} — not a candidate`);
      return [];
    }
    if (opts.baseBranch && p.base.ref !== opts.baseBranch) {
      core.info(`#${p.number}: targets ${p.base.ref}, not ${opts.baseBranch} — not a candidate`);
      return [];
    }
    return [candidateOf(p)].filter(keep).map(toScoped);
  }

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
  // Without the reviewed-by search: oldest first, as before.
  return prs.map(candidateOf).filter(keep).map(toScoped);
}

type PullLike = {
  number: number;
  head: { sha: string };
  base: { ref: string };
  user?: { login?: string; type?: string } | null;
  draft?: boolean | null;
  labels: { name?: string | null }[];
  requested_reviewers?: unknown[] | null;
  requested_teams?: unknown[] | null;
  updated_at: string;
  title?: string;
};
function candidateOf(p: PullLike): Candidate {
  return {
    number: p.number,
    sha: p.head.sha,
    base: p.base.ref,
    author: p.user?.login ?? "",
    authorType: p.user?.type ?? "",
    draft: !!p.draft,
    labels: p.labels.map((l) => l.name ?? "").filter((l): l is string => !!l),
    requested: (p.requested_reviewers?.length ?? 0) + (p.requested_teams?.length ?? 0),
    updatedAt: Date.parse(p.updated_at) || 0,
    title: p.title,
  };
}

/** The `only` input: empty, or a PR number (a malformed one is a build problem). */
function onlyInput(raw: string): number | undefined {
  const t = raw.trim();
  if (!t) return undefined;
  if (!/^[0-9]+$/.test(t)) throw new Error(`only must be a PR number, got "${t}"`);
  return parseInt(t, 10);
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
        rereviewLabel: core.getInput("rereview-label").trim() || undefined,
        only: onlyInput(core.getInput("only")),
        botAuthorsOnly: core.getInput("bot-authors-only").trim() === "true",
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
