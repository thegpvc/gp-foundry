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

/**
 * The PR facts the gate reasons over. This is deliberately a plain data
 * snapshot: the wrapper collects it from the GitHub API and hands it in.
 */
export interface PullRequestFacts {
  number: number;
  title?: string;
  /** Head branch name, e.g. "agent/foo". */
  headRefName: string;
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
  /** Whether a clean rebase is required before merge. Default true. */
  requireCleanRebase?: boolean;
  /**
   * Labels to apply for a given skip outcome. Lets a consumer route skips to
   * the right agent (e.g. needsHuman -> "needs-human", rebase -> "rebase-needed").
   */
  labels?: {
    /** Applied when the PR is too large or touches a protected path. */
    needsHuman?: string;
    /** Applied when the rebase is not clean. */
    rebaseNeeded?: string;
  };
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
  | "too-large"
  | "protected-path"
  | "rebase-needed";

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
): number[] {
  return prs.filter((p) => !branchPrefix || p.headRefName.startsWith(branchPrefix)).map((p) => p.number);
}

/** Does a review/comment body match the approval regex (e.g. "Verdict.*APPROVE")? */
export function isApprovalBody(body: string | null | undefined, regexSource?: string): boolean {
  if (!regexSource || !body) return false;
  return new RegExp(regexSource).test(body);
}

// ────────────────────────────────────────────────────────────────────────────
// The gate
// ────────────────────────────────────────────────────────────────────────────

/**
 * Evaluate the merge gate for a single PR against a policy.
 *
 * Ordering mirrors the original Shipper (cheapest / most-disqualifying checks
 * first): blocking labels → branch → approval → approval delay → CI → size →
 * protected paths → rebase → merge. Returns the FIRST failing gate. Callers
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
  const blockingLabels = policy.blockingLabels ?? [];
  const requireCi = policy.requireCi ?? true;
  const requireCleanRebase = policy.requireCleanRebase ?? true;
  const approvalDelayMinutes = policy.approvalDelayMinutes ?? 0;
  const maxAdditions = policy.maxAdditions ?? Number.POSITIVE_INFINITY;
  const needsHumanLabel = policy.labels?.needsHuman;
  const rebaseNeededLabel = policy.labels?.rebaseNeeded;

  // 1) Blocking labels (needs-human / rebase-needed / …)
  const offendingLabel = blockingLabels.find((l) => pr.labels.includes(l));
  if (offendingLabel) {
    return {
      action: "skip",
      code: "blocking-label",
      reason: `PR #${pr.number} carries blocking label \`${offendingLabel}\``,
    };
  }

  // 2) Branch prefix
  if (policy.branchPrefix && !pr.headRefName.startsWith(policy.branchPrefix)) {
    return {
      action: "skip",
      code: "wrong-branch",
      reason: `branch \`${pr.headRefName}\` does not start with \`${policy.branchPrefix}\``,
    };
  }

  // 3) Bot-approval present
  if (pr.approvedAt === undefined || pr.approvedAt === null || pr.approvedAt === "") {
    return {
      action: "skip",
      code: "not-approved",
      reason: `PR #${pr.number} has no qualifying approval`,
    };
  }

  // 4) Approval delay
  const approvedMs = parseTimestamp(pr.approvedAt);
  if (Number.isNaN(approvedMs)) {
    return {
      action: "skip",
      code: "not-approved",
      reason: `PR #${pr.number} has an unparseable approval timestamp`,
    };
  }
  const minutesSinceApproval = Math.floor((nowMs - approvedMs) / 60000);
  if (minutesSinceApproval < approvalDelayMinutes) {
    return {
      action: "skip",
      code: "approval-delay",
      reason: `approved ${minutesSinceApproval}m ago (need ${approvalDelayMinutes}m)`,
      detail: { minutesSinceApproval },
    };
  }

  // 5) CI passing
  if (requireCi && pr.ciStatus !== "passing") {
    return {
      action: "skip",
      code: "ci-not-passing",
      reason: `CI status is \`${pr.ciStatus}\` (need \`passing\`)`,
    };
  }

  // 6) Hand-written additions under the limit
  const handAdditions = handWrittenAdditions(pr.files, policy.excludeGlobs);
  if (handAdditions > maxAdditions) {
    return {
      action: needsHumanLabel ? "label" : "skip",
      code: "too-large",
      reason: `diff too large (+${handAdditions} hand-written additions, limit +${maxAdditions})`,
      label: needsHumanLabel,
      detail: { handAdditions },
    };
  }

  // 7) Protected paths untouched
  const protectedPath = firstProtectedPath(pr.files, policy.protectedPaths);
  if (protectedPath) {
    return {
      action: needsHumanLabel ? "label" : "skip",
      code: "protected-path",
      reason: `touches protected path \`${protectedPath}\``,
      label: needsHumanLabel,
      detail: { protectedPath },
    };
  }

  // 8) Clean rebase
  if (requireCleanRebase && pr.cleanRebase !== true) {
    // false or unknown -> not clean.
    return {
      action: rebaseNeededLabel ? "label" : "skip",
      code: "rebase-needed",
      reason:
        pr.cleanRebase === false
          ? `rebase conflicts with base branch`
          : `rebase status not yet verified`,
      label: rebaseNeededLabel,
    };
  }

  // All gates passed.
  return {
    action: "merge",
    code: "ready-to-merge",
    reason: `all checks passed (+${handAdditions} hand-written, approved ${minutesSinceApproval}m ago, CI passing)`,
    detail: { handAdditions, minutesSinceApproval },
  };
}
