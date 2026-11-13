/**
 * Pre-jobs: the deterministic (agent-less) job that runs ahead of a review lane
 * and decides whether — or for which pull requests — the lane's own job runs.
 *
 *   skip="…"        → `<node>_guard`:  one PR, from the triggering event; outputs
 *                     run=true|false (+ the diff hash the review is stamped with).
 *   select="sweep"  → `<node>_select`: every open PR, on the node's cron; outputs
 *                     the list of heads that are ready for a decision.
 *
 * Both read with GITHUB_TOKEN under an explicit read-only `permissions:` block:
 * they need no write, and check-runs cannot be read with a fine-grained PAT at all.
 * Untrusted values never reach the script text — everything arrives via `env:`.
 */
import type { EmitContext, WorkflowJobFragment } from "../ir/types.js";
import { VERDICT_MARKER, diffMarkerPrefix, hasSkipGuard, isSweep, preJobId, skipOf } from "./attrs.js";
import { runStep } from "./steps.js";

const PR_NUMBER = "${{ github.event.pull_request.number }}";

/** How many PRs one sweep hands to the lane; the rest are picked up next tick. */
export const SWEEP_LIMIT = 10;

export function emitPreJob(ctx: EmitContext): WorkflowJobFragment | null {
  if (isSweep(ctx.node)) return emitSweepSelect(ctx);
  if (hasSkipGuard(ctx.node)) return emitSkipGuard(ctx);
  return null;
}

// ── skip= guard ──────────────────────────────────────────────────────────────

function emitSkipGuard(ctx: EmitContext): WorkflowJobFragment {
  const node = ctx.node;
  const conds = skipOf(node);
  const env: Record<string, string> = {
    GH_TOKEN: "${{ github.token }}",
    PR: PR_NUMBER,
    NODE: node.id,
    BOT_LOGIN: ctx.config.identity?.bot_login ?? "",
  };
  const lines = [
    `# Decide whether this lane should run for the PR. Every read here fails OPEN:`,
    `# a lane that runs once too often costs a run, one that is wrongly skipped`,
    `# costs a review nobody knows is missing.`,
    `RUN=true; REASON=""; HEAD_SHA=""; DIFF_HASH=""`,
    `finish() {`,
    `  { echo "run=$RUN"; echo "reason=$REASON"; echo "head_sha=$HEAD_SHA"; echo "diff_hash=$DIFF_HASH"; } >> "$GITHUB_OUTPUT"`,
    `  if [ "$RUN" = "true" ]; then echo "Running $NODE."; else echo "::notice::Skipping $NODE: $REASON"; fi`,
    `  exit 0`,
    `}`,
    `skip() { RUN=false; REASON="$1"; finish; }`,
    ``,
    `# Live PR state, not the event payload: the run may have queued for a while.`,
    `PR_JSON=$(gh api "repos/$GITHUB_REPOSITORY/pulls/$PR" 2>/dev/null) || PR_JSON=""`,
    `if [ -z "$PR_JSON" ]; then`,
    `  echo "::warning::could not read PR #$PR — not skipping"`,
    `  finish`,
    `fi`,
    `HEAD_SHA=$(jq -r '.head.sha // ""' <<< "$PR_JSON")`,
  ];

  let labelIndex = 0;
  for (const c of conds) {
    lines.push(``);
    if (c.kind === "draft") {
      lines.push(
        `# draft`,
        `if [ "$(jq -r '.draft' <<< "$PR_JSON")" = "true" ]; then skip "the PR is a draft"; fi`,
      );
    } else if (c.kind === "bot-author") {
      lines.push(
        `# bot-author: a PR opened by a bot (dependabot, renovate, …). The harness's`,
        `# own bot is exempt — its PRs are the ones this lane exists to review.`,
        `AUTHOR=$(jq -r '.user.login // ""' <<< "$PR_JSON")`,
        `AUTHOR_TYPE=$(jq -r '.user.type // ""' <<< "$PR_JSON")`,
        `if [ "$AUTHOR" != "$BOT_LOGIN" ]; then`,
        `  case "$AUTHOR_TYPE:$AUTHOR" in`,
        `    Bot:*|*"[bot]") skip "authored by the bot $AUTHOR" ;;`,
        `  esac`,
        `fi`,
      );
    } else if (c.kind === "label") {
      labelIndex += 1;
      const name = `SKIP_LABEL_${labelIndex}`;
      // Semantic key -> the repo's actual label, like every other label guard.
      env[name] = ctx.config.labels?.[c.label] ?? c.label;
      lines.push(
        `# label:${c.label}`,
        `if jq -e --arg l "$${name}" 'any(.labels[]?; .name == $l)' <<< "$PR_JSON" >/dev/null; then`,
        `  skip "the PR carries the label $${name}"`,
        `fi`,
      );
    } else {
      env.MARKER_PREFIX = diffMarkerPrefix(node);
      env.EVENT_ACTION = "${{ github.event.action }}";
      lines.push(
        `# unchanged-diff: hash the PR's merge-base diff and compare it with the hash`,
        `# stamped into this bot's last review. Blob ids and hunk positions are`,
        `# dropped first, so a rebase or a merge from the base branch that leaves the`,
        `# change itself untouched hashes the same. Only a push (synchronize) is`,
        `# ever skipped this way: a label, a ready-for-review or a re-request is`,
        `# someone asking for a review, and "nothing changed" is no answer to that.`,
        `BASE_SHA=$(jq -r '.base.sha // ""' <<< "$PR_JSON")`,
        `if [ -n "$HEAD_SHA" ] && [ -n "$BASE_SHA" ] \\`,
        `  && DIFF=$(gh api "repos/$GITHUB_REPOSITORY/compare/$BASE_SHA...$HEAD_SHA" -H "Accept: application/vnd.github.diff" 2>/dev/null) \\`,
        `  && [ -n "$DIFF" ]; then`,
        `  DIFF_HASH=$(printf '%s\\n' "$DIFF" \\`,
        `    | sed -E -e '/^index [0-9a-f]+\\.\\.[0-9a-f]+/d' -e 's/^@@ -[0-9,]+ \\+[0-9,]+ @@/@@/' \\`,
        `    | sha256sum | cut -d' ' -f1)`,
        `  LAST=$(gh api "repos/$GITHUB_REPOSITORY/pulls/$PR/reviews" --paginate --jq '`,
        `    .[] | select(.user.login == env.BOT_LOGIN) | (.body // "")`,
        `    | select(contains(env.MARKER_PREFIX)) | split(env.MARKER_PREFIX) | last | .[0:64]' 2>/dev/null | tail -n 1) || LAST=""`,
        `  if [ "$EVENT_ACTION" = "synchronize" ] && [ -n "$LAST" ] && [ "$LAST" = "$DIFF_HASH" ]; then`,
        `    skip "the diff is unchanged since the last review"`,
        `  fi`,
        `else`,
        `  echo "::warning::could not hash the diff of PR #$PR — not skipping on unchanged-diff"`,
        `fi`,
      );
    }
  }
  lines.push(``, `finish`);

  return {
    jobId: preJobId(node),
    name: `${node.id} skip guard`,
    permissions: { contents: "read", "pull-requests": "read" },
    timeoutMinutes: 5,
    outputs: {
      run: "${{ steps.decide.outputs.run }}",
      reason: "${{ steps.decide.outputs.reason }}",
      head_sha: "${{ steps.decide.outputs.head_sha }}",
      diff_hash: "${{ steps.decide.outputs.diff_hash }}",
    },
    steps: [runStep({ id: "decide", name: "Decide whether to run", env, run: lines.join("\n") })],
  };
}

// ── select="sweep" selector ──────────────────────────────────────────────────

function emitSweepSelect(ctx: EmitContext): WorkflowJobFragment {
  const node = ctx.node;
  const run = [
    `# Pick the PR heads that are ready for a decision. Selection is a pure`,
    `# function of repo state — no agent, no randomness — and every read fails`,
    `# CLOSED: a head whose state cannot be read is left for the next sweep.`,
    `#`,
    `#   candidate   open, not a draft, on a harness branch`,
    `#   reviews in  no review is still being waited on (no pending review request)`,
    `#   checks in   every check-run on the head is completed, no commit status pending`,
    `#   undecided   no verdict review on this exact head yet`,
    `LIST=$(gh api "repos/$GITHUB_REPOSITORY/pulls?state=open&sort=created&direction=asc&per_page=100" --paginate --jq '`,
    `  .[] | select(.draft | not)`,
    `  | select(.head.ref | startswith(env.PREFIX))`,
    `  | "\\(.number) \\(.head.sha) \\((.requested_reviewers | length) + (.requested_teams | length))"') || {`,
    `  echo "::error::could not list open pull requests"`,
    `  exit 1`,
    `}`,
    `SELECTED='[]'`,
    `while read -r NUM SHA REQUESTED; do`,
    `  [ -n "$NUM" ] || continue`,
    `  if [ "$REQUESTED" != "0" ]; then echo "#$NUM: $REQUESTED review request(s) outstanding"; continue; fi`,
    `  RUNNING=$(gh api "repos/$GITHUB_REPOSITORY/commits/$SHA/check-runs?per_page=100" --paginate --jq '`,
    `    [.check_runs[] | select(.status != "completed")] | length' | awk '{s+=$1} END {print s+0}') || { echo "#$NUM: could not read check-runs"; continue; }`,
    `  if [ "$RUNNING" != "0" ]; then echo "#$NUM: $RUNNING check-run(s) still running"; continue; fi`,
    `  STATUS=$(gh api "repos/$GITHUB_REPOSITORY/commits/$SHA/status" --jq '`,
    `    if .total_count == 0 then "none" else .state end') || { echo "#$NUM: could not read commit status"; continue; }`,
    `  if [ "$STATUS" = "pending" ]; then echo "#$NUM: a commit status is pending"; continue; fi`,
    `  DECIDED=$(SHA="$SHA" gh api "repos/$GITHUB_REPOSITORY/pulls/$NUM/reviews?per_page=100" --paginate --jq '`,
    `    [ .[] | select(.commit_id == env.SHA)`,
    `      | select(env.BOT_LOGIN == "" or .user.login == env.BOT_LOGIN)`,
    `      | select((.body // "") | contains(env.VERDICT_MARKER)) ] | length' | awk '{s+=$1} END {print s+0}') || { echo "#$NUM: could not read reviews"; continue; }`,
    `  if [ "$DECIDED" != "0" ]; then echo "#$NUM: already decided at $SHA"; continue; fi`,
    `  echo "#$NUM: selected at $SHA"`,
    `  SELECTED=$(jq -c --argjson n "$NUM" --arg s "$SHA" '. + [{number: $n, sha: $s}]' <<< "$SELECTED")`,
    `  if [ "$(jq 'length' <<< "$SELECTED")" -ge "$LIMIT" ]; then`,
    `    echo "limit of $LIMIT reached — the rest wait for the next sweep"`,
    `    break`,
    `  fi`,
    `done <<< "$LIST"`,
    `{ echo "prs=$SELECTED"; echo "count=$(jq 'length' <<< "$SELECTED")"; } >> "$GITHUB_OUTPUT"`,
  ].join("\n");

  return {
    jobId: preJobId(node),
    name: `${node.id} sweep select`,
    permissions: { contents: "read", "pull-requests": "read", checks: "read", statuses: "read" },
    timeoutMinutes: 10,
    outputs: {
      prs: "${{ steps.select.outputs.prs }}",
      count: "${{ steps.select.outputs.count }}",
    },
    steps: [
      runStep({
        id: "select",
        name: "Select pull requests ready for a decision",
        env: {
          GH_TOKEN: "${{ github.token }}",
          PREFIX: ctx.config.repo.branch_prefix,
          BOT_LOGIN: ctx.config.identity?.bot_login ?? "",
          VERDICT_MARKER,
          LIMIT: String(SWEEP_LIMIT),
        },
        run,
      }),
    ],
  };
}
