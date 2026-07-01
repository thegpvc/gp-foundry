/**
 * dependency-chain — pure logic.
 *
 * Ported from gp-dixie's `.github/workflows/agent-chain.yml`, generalized so that
 * every label, marker and close-keyword is configurable. No GitHub API calls live
 * here: this module is a deterministic function over plain data, which makes it
 * exhaustively unit-testable. The thin action wrapper (src/index.ts) is the only
 * place that talks to Octokit.
 *
 * Domain recap:
 *   - An agent PR merges and (via a close keyword in its body, e.g. "Closes #12")
 *     resolves a sub-issue.
 *   - Other open issues may declare a dependency on that sub-issue with a marker
 *     comment `<!-- depends-on: #12 -->`. When their blocker closes and no *other*
 *     blocker of theirs is still open, they should be unblocked: the "blocked"
 *     label is swapped for the "ready" label.
 *   - A sub-issue may declare its parent tracking issue with `<!-- parent: #3 -->`.
 *     When the last open sub-issue of a parent closes, the parent is closed too.
 */

// ────────────────────────────────────────────────────────────────────────────
// Inputs
// ────────────────────────────────────────────────────────────────────────────

/** Minimal shape of an open issue, as fetched by the caller. */
export interface IssueSnapshot {
  number: number;
  body: string | null | undefined;
  labels: string[];
}

/** Configuration — every domain-specific string is injected here. */
export interface ChainConfig {
  /**
   * Label swapped OFF a dependent when it becomes unblocked, and used to filter
   * the candidate set. If omitted, all open issues are considered candidates and
   * no label is removed.
   */
  blockedLabel?: string;
  /**
   * Label swapped ON a dependent when it becomes unblocked. If omitted, no label
   * is added (the removal of `blockedLabel` may itself be the trigger downstream).
   */
  readyLabel?: string;
  /**
   * Marker template locating a dependency edge inside an issue body. Must contain
   * the literal token `{n}`, replaced by the closed issue number.
   * Default: `<!-- depends-on: #{n} -->`.
   */
  dependsOnMarker?: string;
  /**
   * Marker template locating the parent pointer inside a sub-issue body. Must
   * contain the literal token `{n}`.
   * Default: `<!-- parent: #{n} -->`.
   */
  parentMarker?: string;
  /**
   * Close keywords recognized in a PR body (case-insensitive).
   * Default: ["close","closes","closed","fix","fixes","fixed","resolve","resolves","resolved"].
   */
  closeKeywords?: string[];
  /** Comment posted on a parent when it is auto-closed. `{n}` → parent number. */
  parentCloseComment?: string;
}

/**
 * The full picture the pure function needs. The caller is responsible for having
 * already fetched all of this from GitHub.
 */
export interface ChainInput {
  /** Body of the merged PR (used to discover which issue(s) it closed). */
  prBody: string | null | undefined;
  /**
   * Every currently-open issue with its body + labels. Used both to find
   * dependents to unblock and to decide whether a parent has open children.
   *
   * NOTE: this snapshot is taken *before* the merged PR's own issue is closed by
   * GitHub, so the closed issue(s) may still appear here. We filter them out.
   */
  openIssues: IssueSnapshot[];
}

// ────────────────────────────────────────────────────────────────────────────
// Output ops — declarative, so the wrapper (or a dry-run) can apply/print them.
// ────────────────────────────────────────────────────────────────────────────

export type ChainOp =
  | {
      kind: "unblock";
      issue: number;
      removeLabels: string[];
      addLabels: string[];
      /** Which closed issue(s) unblocked this dependent (for logging). */
      unblockedBy: number[];
    }
  | {
      kind: "close-parent";
      issue: number;
      /** Comment to post before closing, or undefined to close silently. */
      comment?: string;
    };

export interface ChainResult {
  /** Issue numbers discovered as closed by the merged PR. */
  closedIssues: number[];
  ops: ChainOp[];
}

// ────────────────────────────────────────────────────────────────────────────
// Defaults
// ────────────────────────────────────────────────────────────────────────────

const DEFAULT_DEPENDS_ON_MARKER = "<!-- depends-on: #{n} -->";
const DEFAULT_PARENT_MARKER = "<!-- parent: #{n} -->";
const DEFAULT_CLOSE_KEYWORDS = [
  "close",
  "closes",
  "closed",
  "fix",
  "fixes",
  "fixed",
  "resolve",
  "resolves",
  "resolved",
];

// ────────────────────────────────────────────────────────────────────────────
// Marker matching
// ────────────────────────────────────────────────────────────────────────────

/** Escape a string for safe literal insertion into a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile a marker template into a RegExp that matches the marker for a specific
 * issue number, tolerant of arbitrary internal whitespace runs.
 *
 * The template's literal segments are regex-escaped; runs of whitespace in the
 * template become `\s+` (so `<!-- depends-on: #{n} -->` matches
 * `<!--depends-on:#{n}-->` and `<!--   depends-on:  #12   -->` alike); `{n}` is
 * replaced by the (escaped) target number with a `\b`-style digit guard so
 * `#12` does not match `#123`.
 */
function markerRegex(template: string, n: number): RegExp {
  const token = "{n}";
  const idx = template.indexOf(token);
  if (idx === -1) {
    throw new Error(`marker template must contain the token "${token}": ${template}`);
  }
  const before = template.slice(0, idx);
  const after = template.slice(idx + token.length);
  const src =
    whitespaceTolerant(before) +
    "(?<!\\d)" +
    escapeRegExp(String(n)) +
    "(?!\\d)" +
    whitespaceTolerant(after);
  return new RegExp(src, "i");
}

/**
 * Build a regex fragment matching a *number-agnostic* marker, capturing the issue
 * number in group 1. Used to discover parent pointers without knowing the number
 * up front.
 */
function markerCaptureRegex(template: string): RegExp {
  const token = "{n}";
  const idx = template.indexOf(token);
  if (idx === -1) {
    throw new Error(`marker template must contain the token "${token}": ${template}`);
  }
  const before = template.slice(0, idx);
  const after = template.slice(idx + token.length);
  const src = whitespaceTolerant(before) + "(\\d+)" + whitespaceTolerant(after);
  return new RegExp(src, "gi");
}

/**
 * Escape literal text but collapse each run of whitespace into `\s*` so callers
 * can be lax about exact spacing inside markers. A leading/trailing whitespace
 * run still yields `\s*` (zero-or-more) which is intentionally permissive.
 */
function whitespaceTolerant(literal: string): string {
  // Split on whitespace runs, escaping the non-space chunks, joining with \s*.
  return literal
    .split(/\s+/)
    .map((chunk) => escapeRegExp(chunk))
    .join("\\s*");
}

// ────────────────────────────────────────────────────────────────────────────
// Close-keyword parsing
// ────────────────────────────────────────────────────────────────────────────

/**
 * Extract the set of issue numbers a PR body closes, via GitHub-style close
 * keywords. Recognizes `Closes #12`, `fixes: #12`, `Resolved #12`, and the
 * cross-repo `owner/repo#12` form (repo is ignored — we only chain within-repo,
 * matching the original workflow's `gh issue` scope).
 *
 * Deduplicated, preserving first-seen order.
 */
export function extractClosedIssues(
  prBody: string | null | undefined,
  keywords: string[] = DEFAULT_CLOSE_KEYWORDS,
): number[] {
  if (!prBody) return [];
  const kw = keywords.filter((k) => k.length > 0).map(escapeRegExp);
  if (kw.length === 0) return [];
  // keyword, optional colon, whitespace, optional owner/repo, '#', digits.
  const re = new RegExp(
    `\\b(?:${kw.join("|")})\\b\\s*:?\\s+(?:[\\w.-]+\\/[\\w.-]+)?#(\\d+)`,
    "gi",
  );
  const out: number[] = [];
  const seen = new Set<number>();
  for (const m of prBody.matchAll(re)) {
    const n = Number(m[1]);
    if (!Number.isNaN(n) && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Core
// ────────────────────────────────────────────────────────────────────────────

/**
 * Compute the label/close operations triggered by a merged PR. Pure: no side
 * effects, deterministic given its inputs.
 *
 * Algorithm:
 *  1. Determine which issues the PR closed (`extractClosedIssues`).
 *  2. Candidate dependents = open issues that (a) are not themselves closed by
 *     this PR and (b), if `blockedLabel` is set, carry that label.
 *  3. For each candidate, collect which closed issues it `depends-on`. It is
 *     unblocked ONLY if it has at least one such dependency AND none of its
 *     declared dependencies remain open (i.e. every `depends-on: #X` in its body
 *     points at an issue that is either just-closed or no longer open). This is
 *     stricter — and more correct — than the original per-issue check, which
 *     could unblock an issue still waiting on a second, unrelated blocker.
 *  4. For each closed issue, find its parent via `parentMarker`. If, after this
 *     merge, no open issue (excluding the just-closed ones) still points at that
 *     parent, emit a `close-parent` op. Parents are de-duplicated.
 */
export function computeChainOps(input: ChainInput, config: ChainConfig = {}): ChainResult {
  const dependsTemplate = config.dependsOnMarker ?? DEFAULT_DEPENDS_ON_MARKER;
  const parentTemplate = config.parentMarker ?? DEFAULT_PARENT_MARKER;
  const keywords = config.closeKeywords ?? DEFAULT_CLOSE_KEYWORDS;

  const closedIssues = extractClosedIssues(input.prBody, keywords);
  const closedSet = new Set(closedIssues);

  const result: ChainResult = { closedIssues, ops: [] };
  if (closedIssues.length === 0) return result;

  // Open issues that are NOT the ones this PR just closed. GitHub may not have
  // flipped their state yet in the caller's snapshot, so exclude explicitly.
  const stillOpen = input.openIssues.filter((i) => !closedSet.has(i.number));

  // The set of issue numbers considered "open" for dependency resolution.
  const openNumbers = new Set(stillOpen.map((i) => i.number));

  // ── 1. Unblock dependents ────────────────────────────────────────────────
  const parentCapture = markerCaptureRegex(parentTemplate);
  const dependsCapture = markerCaptureRegex(dependsTemplate);

  for (const issue of stillOpen) {
    if (config.blockedLabel && !issue.labels.includes(config.blockedLabel)) {
      continue; // not a blocked issue; skip
    }
    const body = issue.body ?? "";

    // All issues this one depends on.
    const deps = allMarkerNumbers(body, dependsCapture);
    if (deps.length === 0) continue;

    // Which of its dependencies were closed by *this* PR.
    const unblockedBy = deps.filter((d) => closedSet.has(d));
    if (unblockedBy.length === 0) continue;

    // Only unblock if NONE of its dependencies remain open.
    const stillBlocked = deps.some((d) => openNumbers.has(d));
    if (stillBlocked) continue;

    const removeLabels = config.blockedLabel ? [config.blockedLabel] : [];
    const addLabels = config.readyLabel ? [config.readyLabel] : [];
    result.ops.push({
      kind: "unblock",
      issue: issue.number,
      removeLabels,
      addLabels,
      unblockedBy,
    });
  }

  // ── 2. Close parents whose sub-issues are all done ───────────────────────
  const parentsHandled = new Set<number>();
  for (const closed of closedIssues) {
    // Find the parent pointer inside the closed issue's body — but the closed
    // issue is (by definition) not in `stillOpen`. It may appear in the caller's
    // openIssues snapshot (pre-close), so look there first.
    const closedSnapshot = input.openIssues.find((i) => i.number === closed);
    const closedBody = closedSnapshot?.body ?? "";
    const parents = allMarkerNumbers(closedBody, parentCapture);

    for (const parent of parents) {
      if (parentsHandled.has(parent)) continue;
      // The parent must not be closed by this same PR, and must exist among the
      // issues we know about (open snapshot). If we never saw it, skip — we
      // cannot safely close an issue we know nothing about.
      if (closedSet.has(parent)) continue;

      // Does any STILL-open issue point at this parent?
      const parentPerIssue = markerRegex(parentTemplate, parent);
      const hasOpenChild = stillOpen.some((i) => parentPerIssue.test(i.body ?? ""));
      if (hasOpenChild) continue;

      parentsHandled.add(parent);
      const comment = config.parentCloseComment
        ? config.parentCloseComment.replace(/\{n\}/g, String(parent))
        : undefined;
      result.ops.push({ kind: "close-parent", issue: parent, comment });
    }
  }

  return result;
}

/** Collect every issue number captured by a number-agnostic marker regex. */
function allMarkerNumbers(body: string, capture: RegExp): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  // `capture` is a shared /g regex; reset lastIndex to keep calls independent.
  capture.lastIndex = 0;
  for (const m of body.matchAll(capture)) {
    const n = Number(m[1]);
    if (!Number.isNaN(n) && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}
