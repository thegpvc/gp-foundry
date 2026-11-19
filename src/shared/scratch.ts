/**
 * Root-level names an agent's scratch drafts take (a PR body or comment written
 * for `--body-file`). agent-fallback's `scratch-paths` default is this list (a
 * test keeps the two equal); the Fixer, which commits without agent-fallback,
 * drops untracked files matching it before its `git add -A`.
 */
export const SCRATCH_GLOBS = [
  ".pr-body*",
  "pr-body*",
  ".pr_body*",
  "pr_body*",
  "PR_BODY*",
  ".pr-description*",
  "pr-description*",
  ".issue-comment*",
  "issue-comment*",
  ".comment-body*",
  ".review-body*",
] as const;
