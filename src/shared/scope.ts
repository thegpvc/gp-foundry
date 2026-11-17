/**
 * Which pull requests the pipeline looks at, and which of them it wrote — in one
 * place. The guard, the sweep and the gate all ask these two questions, and each
 * used to answer them with its own copy of the rule (a job `if:`, a jq filter, a
 * TypeScript filter). The copies disagreed; this is the one answer.
 *
 * Two independent questions:
 *
 *   inScope        does the pipeline look at this PR at all?   (the rollout dial)
 *   isAgentWritten may a WRITING lane act on it?               (fixer, merge)
 *
 * Reading lanes (review, approve, the gate's check) run on any PR in scope.
 * Writing lanes run only on agent-written ones. See
 * docs/plans/2026-11-16-hybrid-pipeline.md.
 *
 * Pure and dependency-free: the actions bundle it too.
 */

/** `rollout:` in foundry.config.yaml — a dial for bringing the pipeline to a repo gradually. */
export interface Rollout {
  /** Human PRs by these logins are in scope (lower-cased). */
  authors?: string[];
  /** …or any PR carrying this label. */
  optInLabel?: string;
  /** Never a PR carrying this label. */
  skipLabel?: string;
}

/** What the scope rule needs to know about a pull request. */
export interface ScopePr {
  authorLogin?: string | null;
  /** GitHub's `user.type` ("User", "Bot", …). */
  authorType?: string | null;
  draft?: boolean | null;
  labels: string[];
}

export type ScopeReason =
  | "draft"
  | "skip-label"
  | "harness-bot"
  | "other-bot"
  | "no-rollout"
  | "author"
  | "opt-in-label"
  | "not-in-rollout";

export interface ScopeDecision {
  inScope: boolean;
  /** Machine-stable reason, for logs and tests. */
  reason: ScopeReason;
  /** One line a person can read in a job log. */
  detail: string;
}

/** A GitHub login (`alice`, `dependabot[bot]`). Strict: logins end up in expressions and env. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\[bot\])?$/;

/** Logins compare case-insensitively. */
export function sameLogin(a?: string | null, b?: string | null): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

function isBot(pr: ScopePr): boolean {
  return (pr.authorType ?? "").toLowerCase() === "bot" || (pr.authorLogin ?? "").toLowerCase().endsWith("[bot]");
}

function label(raw: unknown, key: string): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string" || !raw.trim()) throw new Error(`rollout.${key} must be a non-empty label name`);
  if (/[\r\n]/.test(raw)) throw new Error(`rollout.${key} must be a single line`);
  return raw.trim();
}

/**
 * Parse and validate the `rollout:` block. Undefined (no block) means no dial at
 * all: every PR is in scope. Malformed input throws — a dial that silently
 * means "everyone" or "no one" is worse than a build error.
 *
 * `labels` maps semantic keys to the repo's real label names (config.labels),
 * the way every other label reference in the harness resolves.
 */
export function parseRollout(raw: unknown, labels: Record<string, string> = {}): Rollout | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("rollout must be a mapping with authors, opt_in_label and/or skip_label");
  }
  const r = raw as Record<string, unknown>;
  const known = new Set(["authors", "opt_in_label", "skip_label"]);
  for (const k of Object.keys(r)) {
    if (!known.has(k)) throw new Error(`rollout: unknown key '${k}' — expected authors, opt_in_label or skip_label`);
  }
  const out: Rollout = {};
  if (r.authors !== undefined && r.authors !== null) {
    if (!Array.isArray(r.authors)) throw new Error("rollout.authors must be a list of GitHub logins");
    const authors: string[] = [];
    for (const a of r.authors) {
      const login = String(a).trim();
      if (!LOGIN.test(login)) throw new Error(`rollout.authors: '${login}' is not a GitHub login`);
      if (!authors.includes(login.toLowerCase())) authors.push(login.toLowerCase());
    }
    // An empty list is a valid, deliberate state: nobody by name yet (the opt-in
    // label may still admit PRs). It is NOT the same as leaving the key out.
    out.authors = authors;
  }
  const resolve = (key: "opt_in_label" | "skip_label") => {
    const v = label(r[key], key);
    return v === undefined ? undefined : (labels[v] ?? v);
  };
  const optIn = resolve("opt_in_label");
  const skip = resolve("skip_label");
  if (optIn !== undefined) out.optInLabel = optIn;
  if (skip !== undefined) out.skipLabel = skip;
  if (optIn !== undefined && optIn === skip) {
    throw new Error(`rollout: opt_in_label and skip_label are the same label ('${optIn}')`);
  }
  return out;
}

/**
 * Does the pipeline look at this PR?
 *
 * In order:
 *   1. A draft is never in scope.
 *   2. A PR carrying the skip label is never in scope — it is the off switch a
 *      person holds, so it outranks everything below, the pipeline's own PRs included.
 *   3. A PR the harness bot opened is always in scope: the pipeline made it.
 *      The dial is about whose work the pipeline reviews, not about its own.
 *   4. Another bot's PR is out, unless that bot is named in `authors`.
 *   5. With no rollout block — or one that names neither `authors` nor
 *      `opt_in_label`, i.e. only a skip label — every remaining PR is in scope.
 *      That is the end of a rollout: nothing left to admit by, only the off switch.
 *   6. Otherwise: an author on the list, or the opt-in label. (`authors: []` is an
 *      admission rule that admits nobody by name; it is not the same as no rule.)
 */
export function inScope(pr: ScopePr, rollout: Rollout | undefined, botLogin?: string | null): ScopeDecision {
  const author = pr.authorLogin ?? "";
  if (pr.draft) return { inScope: false, reason: "draft", detail: "the PR is a draft" };
  if (rollout?.skipLabel && pr.labels.includes(rollout.skipLabel)) {
    return { inScope: false, reason: "skip-label", detail: `the PR carries the label ${rollout.skipLabel}` };
  }
  if (sameLogin(author, botLogin)) {
    return { inScope: true, reason: "harness-bot", detail: "the pipeline opened this PR" };
  }
  const listed = (rollout?.authors ?? []).some((a) => sameLogin(a, author));
  if (isBot(pr) && !listed) {
    return { inScope: false, reason: "other-bot", detail: `opened by the bot ${author || "?"}, which rollout.authors does not name` };
  }
  if (!rollout || (rollout.authors === undefined && rollout.optInLabel === undefined)) {
    return { inScope: true, reason: "no-rollout", detail: "the rollout names no authors or opt-in label: every PR is in scope" };
  }
  if (listed) return { inScope: true, reason: "author", detail: `${author} is in rollout.authors` };
  if (rollout.optInLabel && pr.labels.includes(rollout.optInLabel)) {
    return { inScope: true, reason: "opt-in-label", detail: `the PR carries the label ${rollout.optInLabel}` };
  }
  return {
    inScope: false,
    reason: "not-in-rollout",
    detail: `${author || "the author"} is not in rollout.authors${rollout.optInLabel ? ` and the PR has no ${rollout.optInLabel} label` : ""}`,
  };
}

/** A commit on the PR's head, reduced to who GitHub attributes it to. */
export interface CommitAuthor {
  /** The GitHub account the commit's author maps to; null/undefined when it maps to none. */
  authorLogin?: string | null;
}

export interface AgentWritten {
  agentWritten: boolean;
  detail: string;
}

/**
 * Did the pipeline write this PR? Opened by the harness bot AND every commit on
 * its head authored by the bot. One commit by anyone else — a teammate's fix-up,
 * or a commit GitHub cannot attribute to an account at all — makes it
 * human-written, and a human-written PR is merged by a human.
 *
 * Fails closed throughout: no bot login configured, no commits read, or an
 * unattributed commit all answer "not agent-written".
 *
 * Commit authorship is whatever the pusher wrote into the commit, so this is a
 * guardrail against accidents, not a security boundary.
 */
export function isAgentWritten(
  pr: { authorLogin?: string | null },
  commits: CommitAuthor[] | undefined,
  botLogin?: string | null,
): AgentWritten {
  if (!botLogin) return { agentWritten: false, detail: "identity.bot_login is not set, so no PR can be attributed to the pipeline" };
  if (!sameLogin(pr.authorLogin, botLogin)) {
    return { agentWritten: false, detail: `opened by ${pr.authorLogin || "an unknown author"}, not by ${botLogin}` };
  }
  if (!commits || commits.length === 0) {
    return { agentWritten: false, detail: "the PR's commits could not be read" };
  }
  const others = new Set<string>();
  for (const c of commits) {
    if (!sameLogin(c.authorLogin, botLogin)) others.add(c.authorLogin || "an unattributed author");
  }
  if (others.size > 0) {
    return { agentWritten: false, detail: `has commits by ${[...others].sort().join(", ")}` };
  }
  return { agentWritten: true, detail: `opened by ${botLogin}, and every commit is its own` };
}
