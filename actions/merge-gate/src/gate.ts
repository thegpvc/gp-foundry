/**
 * merge-gate core logic (C7) — a pure, testable port of the "Shipper" gating
 * rules from gp-dixie's agent-merger.yml.
 *
 * The original was a fragile ~200-line bash script; this replaces it with a
 * single pure function `evaluateMergeGate(pr, policy)` that returns a decision
 * plus a human-readable reason. All I/O (querying the GitHub API, mutating
 * labels, actually merging) lives in the action wrapper (index.ts). This file
 * has NO side effects and NO dependency on @actions/*, so it is exhaustively
 * unit-testable.
 *
 * Every gp-dixie hardcode has been generalized into `MergePolicy`:
 *   - protected paths, exclude globs, size limit, approval delay, the set of
 *     labels that disqualify a PR, and the labels applied on each skip reason
 *     are all policy-driven.
 */

// ────────────────────────────────────────────────────────────────────────────
// Inputs
// ────────────────────────────────────────────────────────────────────────────

/** CI rollup as computed from check-runs / statuses by the caller. */
export type CiStatus = "passing" | "failing" | "pending" | "unknown";

/** A single reviewed file's diff stats + path. */
export interface PrFile {
  path: string;
  additions: number;
  deletions?: number;
}

/** A check-run observed on the head SHA, as summarized by the caller. */
export interface CheckRunFact {
  name: string;
  /** GitHub check-run status: "queued" | "in_progress" | "completed". */
  status?: string | null;
  /** GitHub check-run conclusion, set once status is "completed". */
  conclusion?: string | null;
  /** Slug of the GitHub App that created the run (e.g. "github-actions"). */
  appSlug?: string | null;
}

/**
 * The PR facts the gate reasons over. This is deliberately a plain data
 * snapshot: the wrapper collects it from the GitHub API and hands it in.
 */
export interface PullRequestFacts {
  number: number;
  title?: string;
  /**
   * The head commit the facts were gathered against. Passed to `pulls.merge` so
   * GitHub rejects the call if the head moved while the gate was scoring (the
   * janitor's rebase sweep runs on the same cadence as the merge poller).
   */
  headSha?: string;
  /** Check-runs on the head SHA, for the `requiredChecks` gate. */
  checkRuns?: CheckRunFact[];
  /** Head branch name, e.g. "agent/foo". */
  headRefName: string;
  /**
   * The PR author's login. The dependabot lane keys off this being exactly
   * `dependabot[bot]` — the branch name (`dependabot/…`) is not trusted, since
   * anyone can push a branch by that name.
   */
  authorLogin?: string;
  /**
   * For a dependabot PR, the semver level of the bump parsed from the title
   * (see parseDependabotBump). `undefined` for non-dependabot PRs.
   */
  dependabotUpdateType?: DependabotBump;
  /** Base branch name, e.g. "main" (used in operator-facing messages). */
  baseRefName?: string;
  /** Labels currently on the PR (names only). */
  labels: string[];
  /** CI rollup for the head SHA. */
  ciStatus: CiStatus;
  /**
   * Timestamp (ISO 8601 or epoch ms) of the most recent qualifying approval,
   * or null/undefined if the PR is not bot-approved.
   */
  approvedAt?: string | number | null;
  /** Changed files with additions; used for the size + protected-path gates. */
  files: PrFile[];
  /**
   * Whether the branch rebases cleanly onto the base branch. `true` = clean,
   * `false` = conflicts, `undefined`/null = not yet evaluated (treated as a
   * blocker so the caller performs the rebase check before merging).
   */
  cleanRebase?: boolean | null;
  /**
   * Review threads, for `requireNoOpenThreads`. The wrapper fetches them (GraphQL)
   * only when that clause is on; undefined means "not gathered".
   */
  reviewThreads?: ReviewThreadFact[];
  /** Pending review requests: user logins and `team:<slug>` entries. */
  requestedReviewers?: string[];
  /**
   * People whose review of this PR currently stands at "changes requested" (see
   * standingChangeRequests). Supplied by the caller; read only when the policy
   * sets `requireNoHumanChangesRequested`.
   */
  changesRequestedBy?: string[];
  /**
   * Whether the trusted reviewer's LATEST verdict on the head is an escalation
   * (see latestHeadVerdictIsEscalation). Read only by `checkConclusion`.
   */
  escalated?: boolean;
  /** The trusted reviewer's latest verdict on the head, if any (see latestHeadVerdict). */
  headVerdict?: HeadVerdict;
  /**
   * A sign-off on a policy handoff: a standing formal APPROVED review on this
   * exact head from someone other than the harness's identity, with GitHub's own
   * review decision met. Gathered only when the policy has handoff_clauses.
   */
  signoff?: { reviewer: string; sha: string };
  /** Why a sign-off that looked present could not be accepted (shown on the check). */
  signoffUnavailable?: string;
  /**
   * The re-review label is on the PR, added at this time: only reviews from after
   * it count towards the head's verdict (see src/shared/rereview.ts).
   */
  rereviewSince?: string;
}

export type HeadVerdict = "approve" | "reject" | "escalate";

/** One review thread, as the wrapper summarizes it from GraphQL `reviewThreads`. */
export interface ReviewThreadFact {
  isResolved: boolean;
  path?: string | null;
  line?: number | null;
  /** Every comment in order; `[0]` is the comment that opened the thread. */
  comments: { author?: string | null; body?: string | null }[];
  /** Reactions on the FIRST comment. */
  firstCommentReactions?: { content?: string | null; user?: string | null }[];
}

export interface MergePolicy {
  /**
   * Optional required prefix for the head branch (e.g. "agent/"). When set, a
   * PR whose branch does not start with this prefix is skipped. Omit to accept
   * any branch.
   */
  branchPrefix?: string;
  /** Minutes that must elapse after approval before auto-merge. Default 0. */
  approvalDelayMinutes?: number;
  /** Max hand-written additions (after exclude globs). Default Infinity. */
  maxAdditions?: number;
  /**
   * Globs whose matching files are excluded from the additions count
   * (generated code, lockfiles, …). e.g. ["gen/**", "**\/*.pb.go"].
   */
  excludeGlobs?: string[];
  /**
   * Path prefixes/globs that, if touched, require a human. e.g.
   * ["db/migrations/", ".github/workflows/", "terraform/**"].
   */
  protectedPaths?: string[];
  /**
   * Labels that disqualify a PR outright (e.g. ["needs-human",
   * "rebase-needed"]). A PR carrying any of these is skipped.
   */
  blockingLabels?: string[];
  /** Whether a passing CI rollup is required. Default true. */
  requireCi?: boolean;
  /**
   * Check-runs that must be PRESENT and successful on the head SHA before a
   * merge. The CI rollup only judges the checks that happen to exist, so a check
   * that never ran cannot block it; these must exist. This is what lets a
   * human-gate job (which reports its Environment approval as a check-run on the
   * head SHA) be a real precondition of the merge rather than an incidental
   * pending-check side effect.
   *
   * An entry may pin the AUTHOR as well as the name, as `<name>@<app-slug>`. Do
   * that for any check that stands in for a human decision: a name is public, so
   * without the author pin anything able to write checks — including the App
   * token every agent lane carries — can publish its own approval. Plain names
   * stay unpinned, which is right for third-party CI.
   */
  requiredChecks?: string[];
  /** Whether a clean rebase is required before merge. Default true. */
  requireCleanRebase?: boolean;
  /**
   * Block while any review thread is open (see `isOpenThread`). Default false.
   * Needs `reviewThreads` in the facts; a missing list is treated as none open.
   */
  requireNoOpenThreads?: boolean;
  /**
   * Review bots (e.g. `greptile-apps[bot]`, `cursor[bot]`). A thread one of these
   * opened blocks only when its first comment matches `botThreadBlockingRegex`.
   */
  botLogins?: string[];
  /** Severity marker that makes a review bot's thread blocking. Default `P1|High Severity`. */
  botThreadBlockingRegex?: string;
  /** Block while the PR has pending requested reviewers or teams. Default false. */
  requireNoReviewRequests?: boolean;
  /**
   * Block while any person's review stands at "changes requested". Default false.
   * Without it the latest verdict wins, so a later approval from the bot overrides
   * a teammate's block; with it, that block holds until the teammate approves or
   * the review is dismissed.
   */
  requireNoHumanChangesRequested?: boolean;
  /**
   * Labels that hand a PR to a person outright. A PR carrying one is never
   * merged, and in evaluate mode its check is `action_required` — whether or not
   * the approver has given a verdict. Distinct from `blockingLabels`, which only
   * hold a merge back: this one says who decides.
   */
  escalationLabels?: string[];
  /**
   * Evaluate mode: the check's conclusion for a head the approver has given no
   * verdict on yet. `failure` (default) or `neutral` ("awaiting the approver"),
   * which keeps a red X off every PR the approver has not decided, whatever else
   * still fails on it (the check's text lists those clauses).
   */
  noVerdictConclusion?: "failure" | "neutral";
  /**
   * Evaluate mode, opt-in: the policy clauses that hand a change to a person
   * instead of failing it. While one is outstanding the check is
   * `action_required`; a standing formal approval on the head from someone other
   * than the harness's identity, with GitHub's own review decision met, signs it
   * off in the check (see PullRequestFacts.signoff). Never affects merging.
   */
  handoffClauses?: HandoffClause[];
  /**
   * Labels to apply for a given skip outcome. Lets a consumer route skips to
   * the right agent (e.g. needsHuman -> "needs-human", rebase -> "rebase-needed").
   */
  labels?: {
    /** Applied when the PR is too large or touches a protected path. */
    needsHuman?: string;
    /** Applied when the rebase is not clean. */
    rebaseNeeded?: string;
    /**
     * Applied when the PR clears every automated check but is only waiting on a
     * human approval — the "ready, someone please look" state that was otherwise
     * a silent skip (#12559). MUST NOT appear in blockingLabels, or the PR it
     * marks could never merge; the gate removes it again once the PR is approved
     * or another reason applies.
     */
    awaitingApproval?: string;
  };
  /**
   * Dependabot lane. When configured, PRs authored by `dependabot[bot]` are
   * evaluated on a separate track from agent PRs: no human approval is required,
   * but the bump must be a semver level in `autoMerge`, CI must pass, and no
   * protected path may be touched. Anything else is routed to a human via the
   * needsHuman label. Omit the block to leave dependabot PRs untouched.
   */
  dependabot?: {
    /** Semver levels to auto-merge without a human, e.g. ["patch", "minor"]. */
    autoMerge?: DependabotBump[];
  };
}

/** Semver level of a dependabot bump; "unknown" when the title can't be parsed. */
/**
 * Keep only the LATEST attempt of each check (same name, same publishing app).
 *
 * `checks.listForRef` dedupes only WITHIN a check suite. A SHA that carries two suites
 * for one workflow — a `workflow_dispatch` re-run alongside the original `pull_request`
 * run — returns both attempts of the same check. A superseded conclusion is history,
 * not current state: without this, one dead attempt pins the rollup to "failing" and
 * no re-run of the live attempt can clear it (range-labs/mono#12952, an approved PR
 * wedged for 5 cycles while GitHub's own rollup read SUCCESS). Check-run ids are
 * monotonic, so the highest id is the newest attempt.
 */
export function latestAttemptPerCheck<T extends { id?: number | null; name?: string | null; app?: { slug?: string | null } | null }>(
  checkRuns: T[],
): T[] {
  const latest = new Map<string, T>();
  for (const c of checkRuns) {
    const key = `${c.app?.slug ?? ""}\u0000${c.name ?? ""}`;
    const prev = latest.get(key);
    if (!prev || (c.id ?? 0) > (prev.id ?? 0)) latest.set(key, c);
  }
  return [...latest.values()];
}

export type DependabotBump = "patch" | "minor" | "major" | "unknown";

/** The exact author login a genuine dependabot PR carries. */
export const DEPENDABOT_LOGIN = "dependabot[bot]";

/**
 * Classify a dependabot PR title ("Bump X from 1.2.3 to 1.3.0") by semver level.
 * Group/monorepo updates and non-semver versions yield "unknown", which the lane
 * treats as needs-a-human — the safe default.
 */
export function parseDependabotBump(title?: string): DependabotBump {
  if (!title) return "unknown";
  const m = /\bfrom\s+v?(\d+)\.(\d+)\.(\d+)[^\s]*\s+to\s+v?(\d+)\.(\d+)\.(\d+)/i.exec(title);
  if (!m) return "unknown";
  const from = [Number(m[1]), Number(m[2]), Number(m[3])];
  const to = [Number(m[4]), Number(m[5]), Number(m[6])];
  if (to[0] !== from[0]) return "major";
  if (to[1] !== from[1]) return "minor";
  return "patch";
}

// ────────────────────────────────────────────────────────────────────────────
// Output
// ────────────────────────────────────────────────────────────────────────────

export type MergeAction = "merge" | "skip" | "label";

/** A stable machine code for each decision, for logging/auditing/tests. */
export type MergeReasonCode =
  | "ready-to-merge"
  | "blocking-label"
  | "wrong-branch"
  | "not-approved"
  | "approval-delay"
  | "ci-not-passing"
  | "required-check-missing"
  | "too-large"
  | "protected-path"
  | "rebase-needed"
  | "open-threads"
  | "review-requested"
  | "changes-requested"
  | "escalated"
  // dependabot lane
  | "dependabot-ready"
  | "dependabot-review"
  | "dependabot-disabled";

export interface MergeDecision {
  action: MergeAction;
  /** Machine-stable reason code. */
  code: MergeReasonCode;
  /** Human-readable explanation (used in the audit log). */
  reason: string;
  /** For `label` actions, the label to apply. Undefined for merge/skip. */
  label?: string;
  /** Diagnostic detail surfaced for merge decisions / audit entries. */
  detail?: {
    handAdditions?: number;
    minutesSinceApproval?: number;
    protectedPath?: string;
    /** For `required-check-missing`: the check that is absent or not yet green. */
    requiredCheck?: string;
    /** For the dependabot lane: the parsed semver level of the bump. */
    updateType?: DependabotBump;
    /** For `open-threads`: how many threads block. */
    openThreads?: number;
    /** For `review-requested`: who is still asked to review. */
    requestedReviewers?: string[];
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers (pure)
// ────────────────────────────────────────────────────────────────────────────

/** Parse an ISO-8601 string or epoch-ms number into epoch milliseconds. */
export function parseTimestamp(ts: string | number): number {
  if (typeof ts === "number") return ts;
  const asNum = Number(ts);
  // A bare numeric string is treated as epoch ms (matches typeof number path).
  if (ts.trim() !== "" && !Number.isNaN(asNum) && /^\d+$/.test(ts.trim())) {
    return asNum;
  }
  const parsed = Date.parse(ts);
  return Number.isNaN(parsed) ? NaN : parsed;
}

/**
 * Minimal, dependency-free glob matcher covering the shapes used by merge
 * policies: literal segments, `*` (within a segment), `**` (across segments),
 * `?`, and a trailing `/` prefix (dir match). Anchored to the full path.
 *
 * Also matches a bare directory prefix like "db/migrations/" against any file
 * under it (parity with the original bash `startswith`).
 */
export function globMatch(pattern: string, path: string): boolean {
  // Bare directory-prefix form ("foo/" or "foo/bar/"): prefix match.
  if (pattern.endsWith("/") && !/[*?]/.test(pattern)) {
    return path === pattern.slice(0, -1) || path.startsWith(pattern);
  }
  // A pattern with no glob metachars: treat as a prefix match too, so
  // "CLAUDE.md" matches "CLAUDE.md" and "scope.yaml" matches exactly. This
  // mirrors the original `startswith($p)` semantics.
  if (!/[*?]/.test(pattern)) {
    return path === pattern || path.startsWith(pattern);
  }
  const re = globToRegExp(pattern);
  return re.test(path);
}

function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**` — match across path separators.
        i++;
        // consume an optional following slash so `**/x` matches `x` too.
        if (pattern[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        // `*` — match within a segment (no slash).
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp("^" + re + "$");
}

function anyGlobMatches(globs: string[] | undefined, path: string): boolean {
  if (!globs || globs.length === 0) return false;
  return globs.some((g) => globMatch(g, path));
}

/**
 * Turn a permission failure on the check-runs endpoint into an answer.
 *
 * `GET /commits/{sha}/check-runs` needs the **Checks** permission, and that is a
 * GitHub App permission only: a fine-grained PAT cannot be granted it — GitHub's
 * permission list has no Checks entry to tick. So the gate reads check-runs with
 * GITHUB_TOKEN (an App installation token) via the `checks-token` input, while
 * the merge itself keeps using the harness token. A 403 here means that wiring is
 * missing — almost always a consumer whose generated workflow predates it.
 *
 * Worth the specificity: GitHub answers with a flat "Resource not accessible by
 * personal access token", the gate is a cron job, so the failure lands in the
 * Actions tab where nobody looks while every approved PR sits unmerged.
 */
export function describeCheckRunsFailure(err: { status?: number; message?: string }): string {
  const base = err.message ?? "unknown error";
  if (err.status !== 403 && err.status !== 404) {
    return `could not read check-runs for the head commit: ${base}`;
  }
  return [
    `could not read check-runs for the head commit (HTTP ${err.status}): ${base}.`,
    `Reading check-runs needs the Checks permission, which only a GitHub App token has —`,
    `a fine-grained PAT cannot be granted it. The merge-gate job should pass GITHUB_TOKEN as`,
    `\`checks-token\` and declare \`checks: read\`; if this workflow does neither, it was`,
    "generated before that fix — run `gp-foundry build` and commit the result. Alternatively",
    "set `require_ci: false` in the merge policy if this repo has no CI to wait for.",
  ].join(" ");
}

/** Split a `requiredChecks` entry into its name and optional required author. */
export function parseRequiredCheck(entry: string): { name: string; appSlug?: string } {
  const at = entry.lastIndexOf("@");
  if (at <= 0) return { name: entry };
  return { name: entry.slice(0, at), appSlug: entry.slice(at + 1) };
}

/**
 * The first required check that is missing from the head SHA, written by the
 * wrong app, or not successful — or undefined when every one of them is green.
 *
 * Absence blocks: a check-run that was never created (e.g. nobody approved the
 * Environment) is the exact case the CI rollup cannot see. So does the wrong
 * author, when the entry pins one: a check-run's name proves nothing about who
 * wrote it, and the whole point of requiring a human-approval check is that the
 * agents cannot write it themselves.
 */
export function firstUnsatisfiedCheck(
  checkRuns: CheckRunFact[] | undefined,
  requiredChecks: string[] | undefined,
): { name: string; reason: "missing" | "wrong-author" | "not-successful" } | undefined {
  if (!requiredChecks || requiredChecks.length === 0) return undefined;
  const runs = checkRuns ?? [];
  for (const entry of requiredChecks) {
    const { name, appSlug } = parseRequiredCheck(entry);
    const byName = runs.filter((r) => r.name === name);
    if (byName.length === 0) return { name, reason: "missing" };
    const matches = appSlug
      ? byName.filter((r) => (r.appSlug ?? "").toLowerCase() === appSlug.toLowerCase())
      : byName;
    // A check published under the right name by the wrong app is an impostor, not
    // a missing check — say so, because the two need different responses.
    if (matches.length === 0) return { name, reason: "wrong-author" };
    // A check reported more than once (re-runs): the newest wins, and callers
    // hand these in newest-last, so require the LAST one to be green.
    const latest = matches[matches.length - 1]!;
    if (latest.status !== "completed" || latest.conclusion !== "success") {
      return { name, reason: "not-successful" };
    }
  }
  return undefined;
}

/** Sum additions for files not excluded by the policy's exclude globs. */
export function handWrittenAdditions(files: PrFile[], excludeGlobs?: string[]): number {
  return files.reduce((sum, f) => {
    if (anyGlobMatches(excludeGlobs, f.path)) return sum;
    return sum + (f.additions || 0);
  }, 0);
}

/** First protected path a changed file touches, or undefined. */
export function firstProtectedPath(files: PrFile[], protectedPaths?: string[]): string | undefined {
  if (!protectedPaths || protectedPaths.length === 0) return undefined;
  for (const pattern of protectedPaths) {
    if (files.some((f) => globMatch(pattern, f.path))) return pattern;
  }
  return undefined;
}

// ────────────────────────────────────────────────────────────────────────────
// Poller helpers (pure, testable)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Recursively convert snake_case object keys to camelCase, so policy files can
 * use the same snake_case convention as foundry.config.yaml while the TS stays
 * idiomatic. Already-camelCase keys pass through unchanged.
 */
export function normalizePolicyKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalizePolicyKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase())] = normalizePolicyKeys(val);
    }
    return out;
  }
  return v;
}

/** Filter open PRs to candidate numbers by head-branch prefix (oldest-first order preserved). */
export function filterCandidateNumbers(
  prs: { number: number; headRefName: string }[],
  branchPrefix?: string,
  includeDependabot = false,
): number[] {
  return prs
    .filter(
      (p) =>
        !branchPrefix ||
        p.headRefName.startsWith(branchPrefix) ||
        // Cheap candidate widening only — the dependabot lane still verifies the
        // real author before acting, so a spoofed `dependabot/` branch that isn't
        // actually from dependabot[bot] falls through to the agent lane and is
        // rejected as a wrong-branch PR.
        (includeDependabot && p.headRefName.startsWith("dependabot/")),
    )
    .map((p) => p.number);
}

/** What an evaluate-mode sweep needs to know about an open PR to select it. */
export interface CandidatePr {
  number: number;
  headRefName: string;
  draft?: boolean;
  authorLogin?: string | null;
  authorType?: string | null;
  labels: string[];
}

/** The evaluate-mode PR selection beyond the branch prefix (all optional). */
export interface CandidateSelection {
  /** Only PRs by these logins (lower-cased)… */
  authors?: string[];
  /** …or carrying this label. */
  optInLabel?: string;
  /** Never PRs carrying any of these. */
  skipLabels?: string[];
  /** Never PRs opened by a bot, except `botLogin`'s own. */
  skipBotAuthors?: boolean;
  botLogin?: string;
}

/**
 * Evaluate-mode candidates: the merge sweep's selection (open — the caller lists
 * only open PRs — on a branch-prefix branch, plus dependabot's when its lane is
 * on), minus drafts, narrowed by the node's author allowlist, opt-in label and
 * skip= exclusions. Order preserved.
 */
export function filterEvaluateCandidates(
  prs: CandidatePr[],
  branchPrefix: string | undefined,
  includeDependabot: boolean,
  sel: CandidateSelection = {},
): number[] {
  const inPrefix = new Set(filterCandidateNumbers(prs, branchPrefix, includeDependabot));
  return prs
    .filter((p) => inPrefix.has(p.number) && !p.draft)
    .filter(
      (p) =>
        !sel.authors ||
        sel.authors.some((a) => sameLogin(a, p.authorLogin)) ||
        (!!sel.optInLabel && p.labels.includes(sel.optInLabel)),
    )
    .filter((p) => !(sel.skipLabels ?? []).some((l) => p.labels.includes(l)))
    .filter(
      (p) =>
        !sel.skipBotAuthors ||
        sameLogin(p.authorLogin, sel.botLogin) ||
        !(p.authorType === "Bot" || (p.authorLogin ?? "").endsWith("[bot]")),
    )
    .map((p) => p.number);
}

/** Does a review/comment body match the approval regex (e.g. "Verdict.*APPROVE")? */
export function isApprovalBody(body: string | null | undefined, regexSource?: string): boolean {
  if (!regexSource || !body) return false;
  return new RegExp(regexSource).test(body);
}

/** One verdict-bearing event on a PR (a review or a marker comment), in time order. */
export interface VerdictEvent {
  /** ISO timestamp of the review submission / comment creation. */
  at: string;
  kind: "approve" | "reject";
  /** The commit the review was submitted against (undefined for comments). */
  sha?: string | null;
  /** Login of the author who submitted the review / wrote the comment. */
  author?: string | null;
  /** GitHub `author_association` (OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE, …). */
  authorAssociation?: string | null;
  /** Which channel carried the verdict — a formal review, or a plain issue comment. */
  source?: "review" | "comment";
}

/**
 * Who is allowed to hand this gate a verdict. Without it, "approval" is just a
 * string anyone who can comment on the PR could type — and with CI green the
 * poller would merge it to the base branch.
 */
export interface VerdictTrustPolicy {
  /** The reviewer bot's login. Its verdicts always count. */
  botLogin?: string;
  /**
   * `author_association` values trusted to approve besides the bot. Defaults to
   * people with write access to the repo.
   */
  trustedAuthorAssociations?: string[];
  /**
   * Whether a plain issue comment can carry an approval at all. Off by default:
   * comment approvals cannot be bound to a head SHA, only to a timestamp.
   */
  allowCommentApprovals?: boolean;
}

/** Repo-write associations — the default set trusted to approve. */
export const DEFAULT_TRUSTED_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"];

/**
 * Is this event allowed to count?
 *
 * Approvals are the privileged direction, so they need a trusted author (the bot
 * itself, or someone with write access) on an allowed channel. Rejections are
 * fail-safe — they can only ever hold a merge back — so any formal review can
 * carry one, whoever wrote it. The comment channel is on or off as a whole:
 * when comment approvals are disabled, comment rejections are ignored too, so a
 * drive-by comment cannot stall the factory either.
 */
export function isCountableVerdict(e: VerdictEvent, trust: VerdictTrustPolicy = {}): boolean {
  const source = e.source ?? "review";
  if (source === "comment" && !trust.allowCommentApprovals) return false;
  if (e.kind === "reject") return true;
  if (trust.botLogin && e.author && e.author.toLowerCase() === trust.botLogin.toLowerCase()) return true;
  const trusted = (trust.trustedAuthorAssociations ?? DEFAULT_TRUSTED_ASSOCIATIONS).map((a) =>
    a.toUpperCase(),
  );
  return !!e.authorAssociation && trusted.includes(e.authorAssociation.toUpperCase());
}

/** Drop the verdicts this gate must not act on, preserving order. */
export function filterCountableVerdicts(
  events: VerdictEvent[],
  trust: VerdictTrustPolicy = {},
): VerdictEvent[] {
  return events.filter((e) => isCountableVerdict(e, trust));
}

/**
 * The approval integrity rule: the LATEST verdict wins (a newer REQUEST_CHANGES
 * invalidates any earlier APPROVE), and an approval only counts for the CURRENT
 * head — a review must carry the head SHA; a marker comment (no SHA) must be
 * newer than the head commit itself. Returns the qualifying approval timestamp,
 * or null. This is what stops a cron poller from merging code that was approved
 * three pushes ago or explicitly rejected since.
 */
export function latestValidApproval(
  events: VerdictEvent[],
  headSha: string,
  headCommittedAt?: string | number | null,
): string | null {
  if (events.length === 0) return null;
  const sorted = [...events].sort((a, b) => parseTimestamp(a.at) - parseTimestamp(b.at));
  const last = sorted[sorted.length - 1]!;
  if (last.kind === "reject") return null;
  if (last.sha) return last.sha === headSha ? last.at : null;
  // Comment verdict: no SHA to compare — require it to postdate the head commit.
  if (headCommittedAt !== undefined && headCommittedAt !== null) {
    return parseTimestamp(last.at) > parseTimestamp(headCommittedAt) ? last.at : null;
  }
  return last.at;
}

// ────────────────────────────────────────────────────────────────────────────
// Review threads, verdicts and the evaluate-mode check (pure)
// ────────────────────────────────────────────────────────────────────────────

/** Default for `botThreadBlockingRegex`: the severities the review bots mark as must-fix. */
export const DEFAULT_BOT_THREAD_BLOCKING_REGEX = "P1|High Severity";

/**
 * Same account? GraphQL names a GitHub App's account `my-app` where REST says
 * `my-app[bot]`, and logins are case-insensitive, so compare without either.
 */
export function sameLogin(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  const norm = (s: string) => s.toLowerCase().replace(/\[bot\]$/, "");
  return norm(a) === norm(b);
}

/**
 * Is this review thread still waiting on the PR author?
 *
 * Not when it is resolved, or the author opened it (a note to self), replied in
 * it, or reacted to its first comment — a reply or a reaction is the author's
 * answer, and the reviewer's next pass judges it. A thread a review bot opened
 * (`botLogins`) blocks only at the severity `botThreadBlockingRegex` names: a
 * bot's P2 nit never holds a PR.
 */
export function isOpenThread(thread: ReviewThreadFact, prAuthor: string | undefined, policy: MergePolicy = {}): boolean {
  if (thread.isResolved) return false;
  const first = thread.comments[0];
  if (!first) return false;
  if (sameLogin(first.author, prAuthor)) return false;
  if (thread.comments.slice(1).some((c) => sameLogin(c.author, prAuthor))) return false;
  if ((thread.firstCommentReactions ?? []).some((r) => sameLogin(r.user, prAuthor))) return false;
  if ((policy.botLogins ?? []).some((b) => sameLogin(b, first.author))) {
    const re = new RegExp(policy.botThreadBlockingRegex ?? DEFAULT_BOT_THREAD_BLOCKING_REGEX);
    return re.test(first.body ?? "");
  }
  return true;
}

/** The threads that hold this PR under `requireNoOpenThreads`. */
export function openThreads(pr: PullRequestFacts, policy: MergePolicy = {}): ReviewThreadFact[] {
  return (pr.reviewThreads ?? []).filter((t) => isOpenThread(t, pr.authorLogin, policy));
}

/** A formal review, reduced to what the escalation test reads. */
export interface ReviewFact {
  at: string;
  sha?: string | null;
  author?: string | null;
  authorAssociation?: string | null;
  body?: string | null;
}

/**
 * The trusted reviewer's LATEST verdict on this head: approve, reject or escalate.
 *
 * Only reviews on the exact head count, only from an author trusted to approve
 * (an escalation stands in for the reviewer's decision, so an outsider must not
 * be able to post one), and only reviews whose body is a verdict: approval,
 * rejection or escalation. Bodies are tested with trailing whitespace trimmed,
 * so an anchored `…$` marker matches a verdict line followed by a newline.
 */
/**
 * A review or comment body as a reader sees it: HTML comments removed, trailing
 * whitespace trimmed. Every verdict marker is matched against THIS, never the
 * raw body.
 *
 * The harness appends machine markers after the verdict line — the
 * unchanged-diff stamp (`<!-- gp-foundry:diff:… -->`) and the also-head marker.
 * Against the raw body an anchored marker (`\*\*Verdict:\*\* REQUEST_CHANGES$`)
 * then matches nothing, and for a REJECTION that fails open: the gate does not
 * see the request for changes and an earlier approval stands. Text hidden in a
 * comment is not part of what the reviewer said either way, so it can neither
 * supply a verdict nor hide one.
 */
export function visibleBody(body: string | null | undefined): string {
  return (body ?? "").replace(/<!--[\s\S]*?-->/g, "").trimEnd();
}

export function latestHeadVerdict(
  reviews: ReviewFact[],
  headSha: string | undefined,
  trust: VerdictTrustPolicy,
  markers: { approval?: RegExp; rejection?: RegExp; escalation: RegExp },
): HeadVerdict | undefined {
  if (!headSha) return undefined;
  const verdicts = reviews
    .filter((r) => r.sha === headSha && r.body)
    .filter((r) => isCountableVerdict({ at: r.at, kind: "approve", author: r.author, authorAssociation: r.authorAssociation, source: "review" }, trust))
    .map((r) => ({ at: r.at, body: visibleBody(r.body) }))
    .filter((r) => [markers.approval, markers.rejection, markers.escalation].some((re) => re?.test(r.body)))
    .sort((a, b) => parseTimestamp(a.at) - parseTimestamp(b.at));
  const last = verdicts[verdicts.length - 1];
  if (!last) return undefined;
  if (markers.escalation.test(last.body)) return "escalate";
  if (markers.approval?.test(last.body)) return "approve";
  return "reject";
}

/** Is the trusted reviewer's latest verdict on this head an escalation? */
export function latestHeadVerdictIsEscalation(...args: Parameters<typeof latestHeadVerdict>): boolean {
  return latestHeadVerdict(...args) === "escalate";
}

/**
 * Is this head awaiting the approver, and what else holds it?
 *
 * Awaiting means the trusted approver has given no verdict on this head (no
 * approve, reject or escalate) and the approval clause is failing. Then the
 * answer is the OTHER failing clauses, in gate order (empty when the missing
 * approval is all that holds it), so the check can say "awaiting the approver"
 * and still name the CI run, the thread or the size limit the author will need
 * to clear. `undefined` when the head is not awaiting: the reviewer rejected or
 * escalated it, or it is approved (through a channel the verdict markers do not
 * cover) and something else fails.
 */
export function awaitingApprover(
  pr: PullRequestFacts,
  policy: MergePolicy = {},
  nowMs: number = Date.now(),
): MergeDecision[] | undefined {
  if (pr.headVerdict || pr.escalated) return undefined;
  const failing = failingClauses(pr, policy, nowMs);
  if (!failing.some((d) => d.code === "not-approved")) return undefined;
  return failing.filter((d) => d.code !== "not-approved");
}

export type CheckConclusion = "success" | "failure" | "action_required" | "neutral";

/** The only clauses a policy may make a handoff: they say a person should look, not that something is broken. */
export const HANDOFF_CLAUSES = ["protected-path", "too-large"] as const;
export type HandoffClause = (typeof HANDOFF_CLAUSES)[number];

/** Throws on a `handoff_clauses` entry that is not a handoff clause. */
export function validateHandoffClauses(raw: unknown): HandoffClause[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new Error(`handoff_clauses must be a list, e.g. [protected-path, too-large]`);
  for (const c of raw) {
    if (!(HANDOFF_CLAUSES as readonly string[]).includes(String(c))) {
      throw new Error(`handoff_clauses: '${String(c)}' cannot be a handoff — only ${HANDOFF_CLAUSES.join(" and ")} can`);
    }
  }
  return raw as HandoffClause[];
}

/** What the evaluate check reports for a head: the result with any policy handoff taken into account. */
export interface CheckVerdict {
  /** The clause the check names: the first still failing, or ready. */
  decision: MergeDecision;
  conclusion: CheckConclusion;
  /** Handoff clauses failing on this head with no sign-off: a person decides. */
  outstanding: MergeDecision[];
  /** Handoff clauses failing on this head that a sign-off has cleared. */
  signedOff: MergeDecision[];
  /** For a neutral check: the other clauses still failing (see awaitingApprover). */
  alsoFailing?: MergeDecision[];
}

/**
 * The evaluate check's verdict on a head. Without `handoffClauses` in the policy
 * this is exactly the original rule (checkConclusion over evaluateMergeGate).
 *
 * With it: a handoff clause failing on its own is `action_required` (a person
 * decides), not `failure`; a sign-off clears ONLY the handoff clauses, and the
 * check then reports whatever else the policy says. An escalation from the
 * agent, or an escalation label, is a judgment call or an explicit hold and is
 * never cleared by a sign-off. Merging never reads this: see evaluateMergeGate.
 */
export function checkVerdict(pr: PullRequestFacts, policy: MergePolicy = {}, nowMs: number = Date.now()): CheckVerdict {
  const handoff = new Set<string>(policy.handoffClauses ?? []);
  const failing = failingClauses(pr, policy, nowMs);
  const handoffs = failing.filter((d) => handoff.has(d.code));
  const signedOff = pr.signoff ? handoffs : [];
  const outstanding = pr.signoff ? [] : handoffs;
  const remaining = failing.filter((d) => !signedOff.includes(d));
  const decision: MergeDecision = signedOff.length
    ? (remaining[0] ?? { action: "merge", code: "ready-to-merge", reason: "every clause passes, the policy handoff signed off" })
    : evaluateMergeGate(pr, policy, nowMs);
  const awaiting =
    policy.noVerdictConclusion === "neutral" ? awaitingApprover(pr, policy, nowMs)?.filter((d) => !signedOff.includes(d)) : undefined;

  let conclusion: CheckConclusion;
  if (pr.escalated) conclusion = "action_required";
  else if (remaining.length === 0) conclusion = "success";
  else if (outstanding.length && remaining.every((d) => handoff.has(d.code))) conclusion = "action_required";
  else conclusion = awaiting !== undefined ? "neutral" : "failure";
  return { decision, conclusion, outstanding, signedOff, ...(awaiting !== undefined ? { alsoFailing: awaiting } : {}) };
}

/**
 * The evaluate-mode check run's conclusion: `action_required` when the reviewer
 * escalated this head (a human decides, whatever else holds), `success` when the
 * gate would merge, `neutral` for a head awaiting the approver's verdict when
 * the policy asks for it (`awaitingApprover`, see awaitingApprover) whatever
 * else fails, `failure` otherwise.
 */
export function checkConclusion(
  decision: MergeDecision,
  facts: Pick<PullRequestFacts, "escalated">,
  opts: { awaitingApprover?: boolean } = {},
): CheckConclusion {
  if (facts.escalated) return "action_required";
  if (decision.action === "merge") return "success";
  return opts.awaitingApprover ? "neutral" : "failure";
}

// ────────────────────────────────────────────────────────────────────────────
// The gate
// ────────────────────────────────────────────────────────────────────────────

/**
 * Evaluate the merge gate for a single PR against a policy.
 *
 * The dependabot lane. Reached only for PRs whose author is exactly
 * dependabot[bot] (verified upstream). No human approval — the trust comes from
 * the update being a safe semver level with green CI and no protected paths.
 * Order: config present → update type → size → protected paths → CI → rebase →
 * merge. Anything not auto-mergeable is routed to a human via needsHuman;
 * a still-pending CI waits (plain skip) rather than escalating.
 */
function evaluateDependabotLane(
  pr: PullRequestFacts,
  policy: MergePolicy,
  needsHumanLabel: string | undefined,
  rebaseNeededLabel: string | undefined,
): MergeDecision {
  const autoMerge = policy.dependabot?.autoMerge ?? [];
  const requireCi = policy.requireCi ?? true;
  const requireCleanRebase = policy.requireCleanRebase ?? true;
  const maxAdditions = policy.maxAdditions ?? Number.POSITIVE_INFINITY;
  const bump = pr.dependabotUpdateType ?? "unknown";

  // Feature off unless a consumer opted in.
  if (autoMerge.length === 0) {
    return {
      action: "skip",
      code: "dependabot-disabled",
      reason: `dependabot auto-merge is not configured`,
    };
  }

  // Only the configured semver levels auto-merge. Major and unparseable
  // (group/monorepo/non-semver) updates go to a human — the risky ones.
  if (bump === "major" || bump === "unknown" || !autoMerge.includes(bump)) {
    return {
      action: needsHumanLabel ? "label" : "skip",
      code: "dependabot-review",
      reason: `dependabot \`${bump}\` update needs a human (auto-merge covers ${autoMerge.join(" / ") || "nothing"})`,
      label: needsHumanLabel,
      detail: { updateType: bump },
    };
  }

  // A dependency bump is manifest + lockfile only; real source or protected-path
  // changes are off-pattern for dependabot, so hand them to a human.
  const handAdditions = handWrittenAdditions(pr.files, policy.excludeGlobs);
  if (handAdditions > maxAdditions) {
    return {
      action: needsHumanLabel ? "label" : "skip",
      code: "too-large",
      reason: `dependabot diff too large (+${handAdditions} hand-written additions, limit +${maxAdditions})`,
      label: needsHumanLabel,
      detail: { handAdditions },
    };
  }
  const protectedPath = firstProtectedPath(pr.files, policy.protectedPaths);
  if (protectedPath) {
    return {
      action: needsHumanLabel ? "label" : "skip",
      code: "protected-path",
      reason: `dependabot PR touches protected path \`${protectedPath}\``,
      label: needsHumanLabel,
      detail: { protectedPath },
    };
  }

  // CI: a definite failure is a human's problem; a pending/unknown rollup just
  // waits for the next poll rather than escalating a transient state.
  if (requireCi && pr.ciStatus !== "passing") {
    if (pr.ciStatus === "failing") {
      return {
        action: needsHumanLabel ? "label" : "skip",
        code: "ci-not-passing",
        reason: `dependabot PR CI is \`failing\``,
        label: needsHumanLabel,
      };
    }
    return {
      action: "skip",
      code: "ci-not-passing",
      reason: `dependabot PR CI is \`${pr.ciStatus}\` (waiting)`,
    };
  }

  // Clean rebase (reuses the janitor rebase-label path).
  if (requireCleanRebase && pr.cleanRebase !== true) {
    return {
      action: rebaseNeededLabel ? "label" : "skip",
      code: "rebase-needed",
      reason: pr.cleanRebase === false ? `rebase conflicts with base branch` : `rebase status not yet verified`,
      label: rebaseNeededLabel,
    };
  }

  return {
    action: "merge",
    code: "dependabot-ready",
    reason: `dependabot \`${bump}\` update, CI passing, no protected paths — auto-merging (no human review required)`,
    detail: { handAdditions, updateType: bump },
  };
}

/** One clause of the agent lane: its failing decision, or undefined when it passes. */
type Clause = (pr: PullRequestFacts, policy: MergePolicy, nowMs: number) => MergeDecision | undefined;

const hasApproval = (pr: PullRequestFacts) =>
  !(pr.approvedAt === undefined || pr.approvedAt === null || pr.approvedAt === "");

function minutesSince(approvedAt: string | number, nowMs: number): number {
  return Math.floor((nowMs - parseTimestamp(approvedAt)) / 60000);
}

/**
 * The agent lane's clauses, in gate order. Each one is independent of the
 * others, so `failingClauses` can run them all; `evaluateMergeGate` stops at the
 * first one that fails.
 */
const AGENT_LANE_CLAUSES: Clause[] = [
  // 2) Branch prefix
  (pr, policy) => {
    if (policy.branchPrefix && !pr.headRefName.startsWith(policy.branchPrefix)) {
      return {
        action: "skip",
        code: "wrong-branch",
        reason: `branch \`${pr.headRefName}\` does not start with \`${policy.branchPrefix}\``,
      };
    }
    return undefined;
  },

  // 3) Bot-approval present. A ready-but-unapproved PR becomes a visible
  //    `awaiting-approval` label when one is configured (else a silent skip, as
  //    before) so it can be found and approved instead of sitting unseen (#12559).
  (pr, policy) => {
    const awaitingApprovalLabel = policy.labels?.awaitingApproval;
    if (!hasApproval(pr)) {
      return {
        action: awaitingApprovalLabel ? "label" : "skip",
        code: "not-approved",
        label: awaitingApprovalLabel,
        reason: `PR #${pr.number} has no qualifying approval`,
      };
    }
    if (Number.isNaN(parseTimestamp(pr.approvedAt!))) {
      return {
        action: awaitingApprovalLabel ? "label" : "skip",
        code: "not-approved",
        label: awaitingApprovalLabel,
        reason: `PR #${pr.number} has an unparseable approval timestamp`,
      };
    }
    return undefined;
  },

  // 4) Approval delay. Only meaningful once there is a valid approval; a missing
  //    one is the clause above, never "approved too recently".
  (pr, policy, nowMs) => {
    const approvalDelayMinutes = policy.approvalDelayMinutes ?? 0;
    if (!hasApproval(pr) || Number.isNaN(parseTimestamp(pr.approvedAt!))) return undefined;
    const minutesSinceApproval = minutesSince(pr.approvedAt!, nowMs);
    if (minutesSinceApproval < approvalDelayMinutes) {
      return {
        action: "skip",
        code: "approval-delay",
        reason: `approved ${minutesSinceApproval}m ago (need ${approvalDelayMinutes}m)`,
        detail: { minutesSinceApproval },
      };
    }
    return undefined;
  },

  // 5) CI passing
  (pr, policy) => {
    if ((policy.requireCi ?? true) && pr.ciStatus !== "passing") {
      return {
        action: "skip",
        code: "ci-not-passing",
        reason: `CI status is \`${pr.ciStatus}\` (need \`passing\`)`,
      };
    }
    return undefined;
  },

  // 5b) Required checks present AND green on the head SHA.
  (pr, policy) => {
    const unsatisfied = firstUnsatisfiedCheck(pr.checkRuns, policy.requiredChecks);
    if (!unsatisfied) return undefined;
    return {
      action: "skip",
      code: "required-check-missing",
      reason:
        unsatisfied.reason === "missing"
          ? `required check \`${unsatisfied.name}\` has not reported on the head commit`
          : unsatisfied.reason === "wrong-author"
            ? `required check \`${unsatisfied.name}\` was published by the wrong app — ignoring it`
            : `required check \`${unsatisfied.name}\` is not successful`,
      detail: { requiredCheck: unsatisfied.name },
    };
  },

  // 5c) No pending review requests (opt-in).
  (pr, policy) => {
    if (policy.requireNoReviewRequests && (pr.requestedReviewers?.length ?? 0) > 0) {
      const who = pr.requestedReviewers!;
      return {
        action: "skip",
        code: "review-requested",
        reason: `review requested from ${who.map((w) => `\`${w}\``).join(", ")}`,
        detail: { requestedReviewers: who },
      };
    }
    return undefined;
  },

  // 5c') No person's review standing at "changes requested" (opt-in).
  (pr, policy) => {
    const who = pr.changesRequestedBy ?? [];
    if (!policy.requireNoHumanChangesRequested || who.length === 0) return undefined;
    return {
      action: "skip",
      code: "changes-requested",
      reason: `changes requested by ${who.map((w) => `\`${w}\``).join(", ")}`,
    };
  },

  // 5d) No open review threads (opt-in).
  (pr, policy) => {
    if (!policy.requireNoOpenThreads) return undefined;
    const open = openThreads(pr, policy);
    if (open.length === 0) return undefined;
    return {
      action: "skip",
      code: "open-threads",
      reason: `${open.length} open review thread${open.length === 1 ? "" : "s"} awaiting the author`,
      detail: { openThreads: open.length },
    };
  },

  // 6) Hand-written additions under the limit
  (pr, policy) => {
    const maxAdditions = policy.maxAdditions ?? Number.POSITIVE_INFINITY;
    const needsHumanLabel = policy.labels?.needsHuman;
    const handAdditions = handWrittenAdditions(pr.files, policy.excludeGlobs);
    if (handAdditions <= maxAdditions) return undefined;
    return {
      action: needsHumanLabel ? "label" : "skip",
      code: "too-large",
      reason: `diff too large (+${handAdditions} hand-written additions, limit +${maxAdditions})`,
      label: needsHumanLabel,
      detail: { handAdditions },
    };
  },

  // 7) Protected paths untouched
  (pr, policy) => {
    const needsHumanLabel = policy.labels?.needsHuman;
    const protectedPath = firstProtectedPath(pr.files, policy.protectedPaths);
    if (!protectedPath) return undefined;
    return {
      action: needsHumanLabel ? "label" : "skip",
      code: "protected-path",
      reason: `touches protected path \`${protectedPath}\``,
      label: needsHumanLabel,
      detail: { protectedPath },
    };
  },

  // 8) Clean rebase
  (pr, policy) => {
    const rebaseNeededLabel = policy.labels?.rebaseNeeded;
    // false or unknown -> not clean.
    if (!(policy.requireCleanRebase ?? true) || pr.cleanRebase === true) return undefined;
    return {
      action: rebaseNeededLabel ? "label" : "skip",
      code: "rebase-needed",
      reason:
        pr.cleanRebase === false
          ? `rebase conflicts with base branch`
          : `rebase status not yet verified`,
      label: rebaseNeededLabel,
    };
  },
];

/** 1) Blocking labels (needs-human / rebase-needed / …) — shared by both lanes. */
/** The escalation label a PR carries, if any (see MergePolicy.escalationLabels). */
export function escalationLabel(pr: Pick<PullRequestFacts, "labels">, policy: MergePolicy): string | undefined {
  return (policy.escalationLabels ?? []).find((l) => pr.labels.includes(l));
}

/** An escalation label stops both lanes: a person decides, whatever else holds. */
function escalationLabelClause(pr: PullRequestFacts, policy: MergePolicy): MergeDecision | undefined {
  const label = escalationLabel(pr, policy);
  if (!label) return undefined;
  return {
    action: "skip",
    code: "escalated",
    reason: `PR #${pr.number} carries escalation label \`${label}\` — a person decides`,
  };
}

/** A formal review, reduced to what the standing-state rule reads. */
export interface ReviewState {
  at: string;
  author?: string | null;
  /** GitHub's review state: APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED, PENDING. */
  state?: string | null;
}

/**
 * Who currently stands at "changes requested" on a PR, the way GitHub's own
 * merge box counts it: per reviewer, the latest review that carries a decision
 * (APPROVED, CHANGES_REQUESTED or DISMISSED — a COMMENTED review does not change
 * a reviewer's standing). The harness bot is left out: its request for changes
 * is a verdict, handled by the verdict rule, and it clears by a later verdict.
 */
export function standingChangeRequests(reviews: ReviewState[], botLogin?: string): string[] {
  const latest = new Map<string, { at: number; state: string; login: string }>();
  for (const r of reviews) {
    const state = (r.state ?? "").toUpperCase();
    if (!r.author || !["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(state)) continue;
    if (sameLogin(r.author, botLogin)) continue;
    const at = parseTimestamp(r.at);
    const key = r.author.toLowerCase();
    const prev = latest.get(key);
    if (!prev || at >= prev.at) latest.set(key, { at, state, login: r.author });
  }
  return [...latest.values()].filter((v) => v.state === "CHANGES_REQUESTED").map((v) => v.login).sort();
}

function blockingLabelClause(pr: PullRequestFacts, policy: MergePolicy): MergeDecision | undefined {
  const offendingLabel = (policy.blockingLabels ?? []).find((l) => pr.labels.includes(l));
  if (!offendingLabel) return undefined;
  return {
    action: "skip",
    code: "blocking-label",
    reason: `PR #${pr.number} carries blocking label \`${offendingLabel}\``,
  };
}

/**
 * Ordering mirrors the original Shipper (cheapest / most-disqualifying checks
 * first): blocking labels → branch → approval → approval delay → CI → required
 * checks → review requests → open threads → size → protected paths → rebase →
 * merge. Review requests and open threads apply only when the policy opts in. Returns the FIRST failing
 * gate (see `failingClauses` for all of them). Callers
 * that want the merge to actually happen should treat `action === "merge"` as
 * the go-ahead and everything else as a no-merge (with `label` carrying a label
 * to apply and `skip` being a pure no-op).
 *
 * @param nowMs current time in epoch ms; injected for deterministic tests.
 */
export function evaluateMergeGate(
  pr: PullRequestFacts,
  policy: MergePolicy = {},
  nowMs: number = Date.now(),
): MergeDecision {
  const blocked = blockingLabelClause(pr, policy);
  if (blocked) return blocked;
  const escalated = escalationLabelClause(pr, policy);
  if (escalated) return escalated;

  // Lane split: a genuine dependabot PR is scored on its own track (no human
  // approval, but only safe semver bumps). Author, not branch name, is the gate.
  if (pr.authorLogin === DEPENDABOT_LOGIN) {
    return evaluateDependabotLane(pr, policy, policy.labels?.needsHuman, policy.labels?.rebaseNeeded);
  }

  for (const clause of AGENT_LANE_CLAUSES) {
    const failed = clause(pr, policy, nowMs);
    if (failed) return failed;
  }

  // All gates passed.
  const handAdditions = handWrittenAdditions(pr.files, policy.excludeGlobs);
  const minutesSinceApproval = minutesSince(pr.approvedAt!, nowMs);
  return {
    action: "merge",
    code: "ready-to-merge",
    reason: `all checks passed (+${handAdditions} hand-written, approved ${minutesSinceApproval}m ago, CI passing)`,
    detail: { handAdditions, minutesSinceApproval },
  };
}

/**
 * EVERY clause that fails on this head, in gate order — `evaluateMergeGate`
 * returns only the first. Each clause is judged on its own, so a missing
 * approval does not hide a running CI or an open thread. Empty when the gate
 * would merge. The dependabot lane is scored as a unit (its order is part of its
 * meaning), so it contributes at most its one decision.
 */
export function failingClauses(
  pr: PullRequestFacts,
  policy: MergePolicy = {},
  nowMs: number = Date.now(),
): MergeDecision[] {
  const failing: MergeDecision[] = [];
  const blocked = blockingLabelClause(pr, policy);
  if (blocked) failing.push(blocked);
  const escalated = escalationLabelClause(pr, policy);
  if (escalated) failing.push(escalated);
  if (pr.authorLogin === DEPENDABOT_LOGIN) {
    const d = evaluateDependabotLane(pr, policy, policy.labels?.needsHuman, policy.labels?.rebaseNeeded);
    if (d.action !== "merge") failing.push(d);
    return failing;
  }
  for (const clause of AGENT_LANE_CLAUSES) {
    const failed = clause(pr, policy, nowMs);
    if (failed) failing.push(failed);
  }
  return failing;
}
