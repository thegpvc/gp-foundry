// Cap diff output at ~100KB to stay well within an LLM's context window budget
// while still providing meaningful code review context.
const DIFF_LIMIT = 100_000;

/** A GitHub user reference, as returned by the REST API. */
export interface GitHubUser {
  login: string;
}

/** A label attached to an issue. */
export interface IssueLabel {
  name: string;
}

/** An issue as consumed by the formatters. */
export interface IssueData {
  title: string;
  body: string | null;
  labels?: Array<IssueLabel | string>;
}

/** A pull request as consumed by the formatters. */
export interface PullRequestData {
  title: string;
  body: string | null;
  changed_files: number;
  additions: number;
  deletions: number;
  base?: { ref?: string } | null;
}

/** A timeline / issue comment. */
export interface CommentData {
  user: GitHubUser | null;
  created_at: string;
  body: string | null;
}

/** A pull request review. */
export interface ReviewData {
  user: GitHubUser | null;
  state: string;
  submitted_at?: string;
  body: string | null;
}

/** An inline pull request review comment. */
export interface InlineCommentData {
  user: GitHubUser | null;
  path: string;
  line: number | null;
  body: string | null;
}

/** The union of all shapes {@link formatContext} may receive. */
export interface ContextData {
  issue?: IssueData;
  pr?: PullRequestData;
  comments?: CommentData[];
  reviews?: ReviewData[];
  inlineComments?: InlineCommentData[];
  diff?: string | null;
}

/** Context type discriminator. */
export type ContextType = "issue" | "pr-diff" | "pr-review" | "pr-full";

/** Options controlling how a context is formatted. */
export interface FormatOptions {
  type: ContextType;
  number: number;
  triggeringComment?: string;
}

/** Indent each line of text by two spaces. */
function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

/** Normalize a label (which may be a string or an object) to its name. */
function labelName(label: IssueLabel | string): string {
  return typeof label === "string" ? label : label.name;
}

/** Format the issue header section. */
function formatIssueHeader(issue: IssueData, number: number): string {
  const lines = [`=== ISSUE #${number} ===`, `Title: ${issue.title}`];
  if (issue.labels && issue.labels.length > 0) {
    lines.push(`Labels: ${issue.labels.map(labelName).join(", ")}`);
  }
  lines.push("Body:");
  lines.push(indent(issue.body || ""));
  return lines.join("\n");
}

/** Format the PR header section. */
function formatPRHeader(pr: PullRequestData, number: number): string {
  const lines = [
    `=== PR #${number} ===`,
    `Title: ${pr.title}`,
    `Files: ${pr.changed_files} changed, +${pr.additions} -${pr.deletions}`,
    "Body:",
    indent(pr.body || ""),
  ];
  return lines.join("\n");
}

/** Format the comments section. Returns empty string if no comments. */
function formatComments(comments: CommentData[] | undefined): string {
  if (!comments || comments.length === 0) return "";
  const header = `=== COMMENTS (${comments.length}) ===`;
  const entries = comments.map(
    (c) => `[${c.user?.login ?? "unknown"}] ${c.created_at}\n${indent(c.body || "")}`
  );
  return [header, ...entries].join("\n");
}

/** Format the reviews section. Returns empty string if no reviews. */
function formatReviews(reviews: ReviewData[] | undefined): string {
  if (!reviews || reviews.length === 0) return "";
  const header = `=== REVIEWS (${reviews.length}) ===`;
  const entries = reviews.map((r) => {
    const bodyText = r.body ? indent(r.body) : "  (no body)";
    return `[${r.user?.login ?? "unknown"}] ${r.state} ${r.submitted_at ?? ""}\n${bodyText}`;
  });
  return [header, ...entries].join("\n");
}

/** Format the inline review comments section. Returns empty string if none. */
function formatInlineComments(inlineComments: InlineCommentData[] | undefined): string {
  if (!inlineComments || inlineComments.length === 0) return "";
  const header = `=== INLINE REVIEW COMMENTS (${inlineComments.length}) ===`;
  const entries = inlineComments.map(
    (c) => `[${c.user?.login ?? "unknown"}] ${c.path}:${c.line}\n${indent(c.body || "")}`
  );
  return [header, ...entries].join("\n");
}

/**
 * Format the diff section. Returns empty string if no diff.
 * Truncates at 100,000 bytes with a warning message.
 */
function formatDiff(diff: string | null | undefined): string {
  if (!diff) return "";
  let displayDiff = diff;
  let truncated = false;
  if (Buffer.byteLength(diff, "utf8") > DIFF_LIMIT) {
    // Truncate to DIFF_LIMIT bytes (approximate by slicing chars, then trim).
    displayDiff = diff.slice(0, DIFF_LIMIT);
    truncated = true;
  }
  const content = truncated
    ? `${displayDiff}\n\n[Diff truncated at 100KB. Use Read tool to examine full files.]`
    : displayDiff;
  return `=== DIFF ===\n${content}`;
}

/** Format the triggering comment section. */
function formatTriggeringComment(body: string): string {
  return `=== TRIGGERING COMMENT ===\n${indent(body)}`;
}

/**
 * Format fetched context data into labeled plaintext sections.
 */
export function formatContext(data: ContextData, opts: FormatOptions): string {
  const { type, number, triggeringComment } = opts;
  const sections: string[] = [];

  if (type === "issue") {
    if (data.issue) sections.push(formatIssueHeader(data.issue, number));
    const comments = formatComments(data.comments);
    if (comments) sections.push(comments);
  } else if (type === "pr-diff") {
    if (data.pr) sections.push(formatPRHeader(data.pr, number));
    const diff = formatDiff(data.diff);
    if (diff) sections.push(diff);
  } else if (type === "pr-review" || type === "pr-full") {
    if (data.pr) sections.push(formatPRHeader(data.pr, number));
    const comments = formatComments(data.comments);
    if (comments) sections.push(comments);
    const reviews = formatReviews(data.reviews);
    if (reviews) sections.push(reviews);
    const inlineComments = formatInlineComments(data.inlineComments);
    if (inlineComments) sections.push(inlineComments);
    const diff = formatDiff(data.diff);
    if (diff) sections.push(diff);
  }

  if (triggeringComment) {
    sections.push(formatTriggeringComment(triggeringComment));
  }

  return sections.join("\n\n");
}
