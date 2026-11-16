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
import {
  ALSO_HEAD_ANY_NODE_PATTERN,
  VERDICT_MARKER,
  alsoHeadMarkerPrefix,
  authorsOf,
  diffMarkerPrefix,
  hasSkipGuard,
  isSweep,
  optInLabelOf,
  preJobId,
  skipOf,
  sweepFailedCheckName,
  sweepRequiresReview,
  sweepJobNamePrefix,
  sweptCheckName,
} from "./attrs.js";
import { appTokenStep, runStep, tokenExpr } from "./steps.js";

const PR_NUMBER = "${{ github.event.pull_request.number }}";

/** How many PRs one sweep hands to the lane; the rest are picked up next tick. */
export const SWEEP_LIMIT = 10;

/** Failed lane runs on one head before the sweep stops handing it to the agent. */
export const SWEEP_MAX_FAILURES = 3;

/**
 * How long a head with NO check-runs at all is left alone. "Every check has
 * concluded" is vacuously true in the seconds after a push, before CI has
 * registered a single run — and a decision made then is made without CI.
 */
export const SWEEP_SETTLE_SECONDS = 600;

export function emitPreJob(ctx: EmitContext): WorkflowJobFragment | null {
  if (isSweep(ctx.node)) return emitSweepSelect(ctx);
  if (hasSkipGuard(ctx.node, ctx.config)) return emitSkipGuard(ctx);
  return null;
}

/** The job that runs AFTER the node's own: a sweep's record of the heads it covered. */
export function emitPostJob(ctx: EmitContext): WorkflowJobFragment | null {
  return isSweep(ctx.node) ? emitSweepMark(ctx) : null;
}

/**
 * jq filter over a reviews array: the verdict reviews on head `env.SHA` by the
 * bot. A verdict is the review's LAST non-empty line — a substring match would
 * let a lane posting as the same bot decide a head just by quoting the marker.
 * Shared by the select job ("decided") and the mark job ("the lane delivered").
 */
const BY_BOT_JQ = `(env.BOT_LOGIN == "" or .user.login == env.BOT_LOGIN)`;
const IS_VERDICT_JQ = `((.body // "") | split("\\n") | map(select(length > 0)) | (last // "") | startswith(env.VERDICT_MARKER))`;
const VERDICT_REVIEWS_JQ = [
  `[ .[] | select(.commit_id == env.SHA)`,
  `  | select(${BY_BOT_JQ})`,
  `  | select(${IS_VERDICT_JQ}) ] | length`,
];

/**
 * The select job's one read of a head's reviews, as "<decided> <reviewed>" per
 * page: verdict reviews by the bot on the head (as above), and the bot's
 * non-verdict reviews that cover the head — submitted on it, or marked
 * `also-head` for it by a guard that skipped it as an unchanged diff.
 */
const SELECT_REVIEWS_JQ = [
  `[ .[] | select(${BY_BOT_JQ}) | ${IS_VERDICT_JQ} as $verdict`,
  `  | { decided: (.commit_id == env.SHA and $verdict),`,
  `      reviewed: ((.commit_id == env.SHA or ((.body // "") | test(env.ALSO_HEAD_PATTERN + env.SHA + " -->"))) and ($verdict | not)) } ]`,
  `| [ (map(select(.decided)) | length), (map(select(.reviewed)) | length) ] | @tsv`,
];

/** The check-run author a swept marker must have: written with GITHUB_TOKEN. */
const MARK_APP = "github-actions";

// ── skip= guard ──────────────────────────────────────────────────────────────

function emitSkipGuard(ctx: EmitContext): WorkflowJobFragment {
  const node = ctx.node;
  const conds = skipOf(node);
  const authors = authorsOf(node, ctx.config);
  const optIn = optInLabelOf(node, ctx.config);
  const env: Record<string, string> = {
    GH_TOKEN: "${{ github.token }}",
    PR: PR_NUMBER,
    NODE: node.id,
    BOT_LOGIN: ctx.config.identity?.bot_login ?? "",
  };
  if (authors) env.AUTHORS = authors.join(",");
  if (optIn) env.OPT_IN_LABEL = optIn;
  const lines = [
    `# Decide whether this lane should run for the PR. The skip= reads fail OPEN:`,
    `# a lane that runs once too often costs a run, one that is wrongly skipped`,
    `# costs a review nobody knows is missing. The author allowlist is the one`,
    `# exception and fails CLOSED — it says whose PRs the lane may touch at all.`,
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
    ...(authors
      ? [`  skip "could not read PR #$PR to verify its author"`]
      : [`  echo "::warning::could not read PR #$PR — not skipping"`, `  finish`]),
    `fi`,
    `HEAD_SHA=$(jq -r '.head.sha // ""' <<< "$PR_JSON")`,
  ];
  if (authors) {
    const authorTest = `((.user.login // "" | ascii_downcase) as $a | env.AUTHORS | split(",") | index($a))`;
    lines.push(
      ``,
      `# authors: only these logins' PRs (case-insensitive)${optIn ? ", or a PR carrying the opt-in label" : ""}.`,
      `# The job-level \`if:\` already turned everyone else away from the event`,
      `# payload; this is the same test against the PR as it is now, and anything`,
      `# but a match skips.`,
      ...(optIn
        ? [
            `if ! jq -e '${authorTest} or any(.labels[]?; .name == env.OPT_IN_LABEL)' <<< "$PR_JSON" >/dev/null; then`,
            `  skip "the author $(jq -r '.user.login // "?"' <<< "$PR_JSON") is not in the allowlist and no $OPT_IN_LABEL label"`,
          ]
        : [
            `if ! jq -e '${authorTest}' <<< "$PR_JSON" >/dev/null; then`,
            `  skip "the author $(jq -r '.user.login // "?"' <<< "$PR_JSON") is not in the allowlist"`,
          ]),
      `fi`,
    );
  }

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
      env.ALSO_HEAD_PREFIX = alsoHeadMarkerPrefix(node);
      env.EVENT_ACTION = "${{ github.event.action }}";
      // The review is the bot's, so only the token that posted (and stamps) it can edit it.
      env.STAMP_TOKEN = tokenExpr(ctx);
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
        `  LAST_REVIEW=$(gh api "repos/$GITHUB_REPOSITORY/pulls/$PR/reviews" --paginate --jq '`,
        `    .[] | select(.user.login == env.BOT_LOGIN) | select((.body // "") | contains(env.MARKER_PREFIX))`,
        `    | "\\(.id) \\((.body // "") | split(env.MARKER_PREFIX) | last | .[0:64])"' 2>/dev/null | tail -n 1) || LAST_REVIEW=""`,
        `  LAST_ID=\${LAST_REVIEW%% *}; LAST=\${LAST_REVIEW#* }`,
        `  if [ "$EVENT_ACTION" = "synchronize" ] && [ -n "$LAST" ] && [ "$LAST" = "$DIFF_HASH" ]; then`,
        `    # That review covers this head too: say so in it, so a downstream lane can`,
        `    # tell "reviewed" from the other reasons this lane skips. One marker per`,
        `    # head, appended; best-effort — the skip stands either way.`,
        `    MARK="$ALSO_HEAD_PREFIX$HEAD_SHA -->"`,
        `    if BODY=$(gh api "repos/$GITHUB_REPOSITORY/pulls/$PR/reviews/$LAST_ID" --jq '.body // ""' 2>/dev/null); then`,
        `      case "$BODY" in`,
        `        *"$MARK"*) ;;`,
        `        *) GH_TOKEN="$STAMP_TOKEN" gh api --method PUT "repos/$GITHUB_REPOSITORY/pulls/$PR/reviews/$LAST_ID" \\`,
        `             -f body="$(printf '%s\\n%s' "$BODY" "$MARK")" >/dev/null \\`,
        `             || echo "::warning::could not mark review $LAST_ID as covering $HEAD_SHA" ;;`,
        `      esac`,
        `    else`,
        `      echo "::warning::could not read review $LAST_ID to mark it as covering $HEAD_SHA"`,
        `    fi`,
        `    skip "the diff is unchanged since the last review"`,
        `  fi`,
        `else`,
        `  echo "::warning::could not hash the diff of PR #$PR — not skipping on unchanged-diff"`,
        `fi`,
      );
    }
  }
  lines.push(``, `finish`);

  // unchanged-diff edits the bot's review (the also-head marker) with the stamp
  // step's token: an App token is minted for it, scoped to pull requests; with
  // github-token auth that token is GITHUB_TOKEN, so the job needs the write.
  const marks = conds.some((c) => c.kind === "unchanged-diff");
  const app = marks ? appTokenStep(ctx, { "pull-requests": "write" }) : undefined;
  const writesWithGithubToken = marks && tokenExpr(ctx) === "${{ github.token }}";
  return {
    jobId: preJobId(node),
    name: `${node.id} skip guard`,
    displayName: `${node.id} guard`,
    permissions: { contents: "read", "pull-requests": writesWithGithubToken ? "write" : "read" },
    timeoutMinutes: 5,
    outputs: {
      run: "${{ steps.decide.outputs.run }}",
      reason: "${{ steps.decide.outputs.reason }}",
      head_sha: "${{ steps.decide.outputs.head_sha }}",
      diff_hash: "${{ steps.decide.outputs.diff_hash }}",
    },
    steps: [...(app ? [app] : []), runStep({ id: "decide", name: "Decide whether to run", env, run: lines.join("\n") })],
  };
}

// ── select="sweep" selector ──────────────────────────────────────────────────

function emitSweepSelect(ctx: EmitContext): WorkflowJobFragment {
  const node = ctx.node;
  const authors = authorsOf(node, ctx.config);
  const optIn = optInLabelOf(node, ctx.config);
  const authorTest = `((.user.login // "" | ascii_downcase) as $a | env.AUTHORS | split(",") | index($a))`;
  // skip= on a sweep: the same exclusions the event-driven guard applies.
  // draft is implicit (drafts are never selected) and validate() rejects unchanged-diff.
  const conds = skipOf(node);
  const skipBots = conds.some((c) => c.kind === "bot-author");
  const skipLabels: Record<string, string> = {};
  for (const c of conds) {
    if (c.kind !== "label") continue;
    // Semantic key -> the repo's actual label, like every other label guard.
    skipLabels[`SKIP_LABEL_${Object.keys(skipLabels).length + 1}`] = ctx.config.labels?.[c.label] ?? c.label;
  }
  const run = [
    `# Pick the PR heads that are ready for a decision. Selection is a pure`,
    `# function of repo state — no agent, no randomness — and every read fails`,
    `# CLOSED: a head whose state cannot be read is left for the next sweep.`,
    `#`,
    `#   candidate   open, not a draft, on a harness branch${authors ? ", by an allowlisted author" : ""}${optIn ? " or labelled $OPT_IN_LABEL" : ""}`,
    ...(skipBots || Object.keys(skipLabels).length
      ? [`#   not skipped ${[skipBots ? "not opened by a bot (the harness's own is exempt)" : "", Object.keys(skipLabels).length ? "no skip= label" : ""].filter(Boolean).join(", ")}`]
      : []),
    `#   reviews in  no review is still being waited on (no pending review request)`,
    `#   checks in   every check-run on the head is completed, no commit status`,
    `#               pending — and at least one check-run exists, unless the PR has`,
    `#               been quiet for $SETTLE_SECONDS s (a repo with no CI still gets swept)`,
    `#   undecided   no verdict review on this exact head yet, and no earlier`,
    `#               sweep has marked it delivered (the swept check)`,
    ...(sweepRequiresReview(node)
      ? [`#   reviewed    a non-verdict review by the bot covers the head (on it, or marked also-head)`]
      : []),
    `#   not spent   fewer than $MAX_FAILURES failed lane runs on this head`,
    `LIST=$(gh api "repos/$GITHUB_REPOSITORY/pulls?state=open&sort=created&direction=asc&per_page=100" --paginate --jq '`,
    `  .[] | select(.draft | not)`,
    `  | select(.head.ref | startswith(env.PREFIX))`,
    ...(authors
      ? [
          optIn
            ? `  | select(${authorTest} or ((.labels // []) | any(.name == env.OPT_IN_LABEL)))`
            : `  | select(${authorTest})`,
        ]
      : []),
    ...(skipBots
      ? [`  | select((.user.login // "") == env.BOT_LOGIN or (((.user.type // "") != "Bot") and ((.user.login // "") | endswith("[bot]") | not)))`]
      : []),
    ...Object.keys(skipLabels).map((k) => `  | select((.labels // []) | any(.name == env.${k}) | not)`),
    `  | "\\(.number) \\(.head.sha) \\((.requested_reviewers | length) + (.requested_teams | length)) \\(now - (.updated_at | fromdateiso8601) | floor) \\(.base.ref)"') || {`,
    `  echo "::error::could not list open pull requests"`,
    `  exit 1`,
    `}`,
    `SELECTED='[]'`,
    `while read -r NUM SHA REQUESTED QUIET BASE; do`,
    `  [ -n "$NUM" ] || continue`,
    `  if [ "$REQUESTED" != "0" ]; then echo "#$NUM: $REQUESTED review request(s) outstanding"; continue; fi`,
    `  # One read of the head's check-runs answers four questions: how many exist,`,
    `  # how many are still running, has the lane already run here, how often has it failed.`,
    `  # filter=all: the default (latest) keeps only the newest run per check name, which`,
    `  # hides all but one sweep-failed record and lets a newer skipped run of a job mask`,
    `  # an older one still in progress.`,
    `  CHECKS=$(gh api "repos/$GITHUB_REPOSITORY/commits/$SHA/check-runs?per_page=100&filter=all" --paginate --jq '`,
    `    .check_runs | [ length,`,
    `      ([.[] | select(.status != "completed")] | length),`,
    `      ([.[] | select(.name == env.SWEPT_CHECK and .app.slug == env.MARK_APP)] | length),`,
    `      ([.[] | select(.name == env.FAILED_CHECK and .app.slug == env.MARK_APP)] | length) ] | @tsv' \\`,
    `    | awk '{t+=$1; r+=$2; s+=$3; f+=$4} END {print t+0, r+0, s+0, f+0}') || { echo "#$NUM: could not read check-runs"; continue; }`,
    `  read -r TOTAL RUNNING SWEPT FAILURES <<< "$CHECKS"`,
    `  if [ "$RUNNING" != "0" ]; then echo "#$NUM: $RUNNING check-run(s) still running"; continue; fi`,
    `  if [ "$TOTAL" = "0" ] && [ "$QUIET" -lt "$SETTLE_SECONDS" ]; then`,
    `    echo "#$NUM: no check-run on $SHA yet and the PR changed \${QUIET}s ago — waiting for CI to register"`,
    `    continue`,
    `  fi`,
    `  # The lane's own record that it ran here and delivered a verdict (the mark`,
    `  # job publishes it only then). Normally redundant with the verdict test below;`,
    `  # it still holds if the verdict review's body is later edited.`,
    `  if [ "$SWEPT" != "0" ]; then echo "#$NUM: already swept at $SHA"; continue; fi`,
    `  # …and a lane that keeps FAILING on a head is not retried forever either.`,
    `  if [ "$FAILURES" -ge "$MAX_FAILURES" ]; then echo "#$NUM: gave up on $SHA after $FAILURES failed runs"; continue; fi`,
    `  STATUS=$(gh api "repos/$GITHUB_REPOSITORY/commits/$SHA/status" --jq '`,
    `    if .total_count == 0 then "none" else .state end') || { echo "#$NUM: could not read commit status"; continue; }`,
    `  if [ "$STATUS" = "pending" ]; then echo "#$NUM: a commit status is pending"; continue; fi`,
    `  REVIEWS=$(SHA="$SHA" gh api "repos/$GITHUB_REPOSITORY/pulls/$NUM/reviews?per_page=100" --paginate --jq '`,
    ...SELECT_REVIEWS_JQ.map((l) => `    ${l}`),
    `  ' | awk '{d+=$1; r+=$2} END {print d+0, r+0}') || { echo "#$NUM: could not read reviews"; continue; }`,
    `  read -r DECIDED REVIEWED <<< "$REVIEWS"`,
    `  if [ "$DECIDED" != "0" ]; then echo "#$NUM: already decided at $SHA"; continue; fi`,
    `  # requires_review: the lane acts on an upstream review, so a head no review covers is still waiting.`,
    `  if [ "$REQUIRES_REVIEW" = "true" ] && [ "$REVIEWED" = "0" ]; then echo "#$NUM: no review by $BOT_LOGIN covers $SHA yet"; continue; fi`,
    `  echo "#$NUM: selected at $SHA"`,
    `  SELECTED=$(jq -c --argjson n "$NUM" --arg s "$SHA" --arg b "$BASE" '. + [{number: $n, sha: $s, base: $b}]' <<< "$SELECTED")`,
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
    displayName: `${node.id} select`,
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
          REQUIRES_REVIEW: String(sweepRequiresReview(node)),
          ALSO_HEAD_PATTERN: ALSO_HEAD_ANY_NODE_PATTERN,
          SWEPT_CHECK: sweptCheckName(node),
          FAILED_CHECK: sweepFailedCheckName(node),
          MARK_APP,
          LIMIT: String(SWEEP_LIMIT),
          MAX_FAILURES: String(SWEEP_MAX_FAILURES),
          SETTLE_SECONDS: String(SWEEP_SETTLE_SECONDS),
          ...(authors ? { AUTHORS: authors.join(",") } : {}),
          ...(optIn ? { OPT_IN_LABEL: optIn } : {}),
          ...skipLabels,
        },
        run,
      }),
    ],
  };
}

// ── select="sweep" marker ────────────────────────────────────────────────────

/**
 * `<node>_mark`: publish the swept check on every head whose lane job succeeded.
 *
 * A separate job, not a step in the lane: the Checks API needs GITHUB_TOKEN with
 * `checks: write`, and no job that runs an agent may hold that scope — it is what
 * the human-gate's approval check is written with, and the merge gate trusts a
 * check by the app that wrote it. This job runs no agent and reads no untrusted
 * input; it asks the Actions API which of this run's lane jobs concluded
 * `success`, and marks those whose head now carries the bot's verdict review.
 * A lane that succeeded without posting a verdict had nothing to decide yet
 * (the agent cannot fail its job on purpose), so that head is left unmarked
 * and uncounted — a holding state. A failed lane is counted toward the cap; a
 * cancelled one is neither marked nor counted. Either way the next sweep picks
 * the head up again.
 */
function emitSweepMark(ctx: EmitContext): WorkflowJobFragment {
  const node = ctx.node;
  const select = preJobId(node);
  return {
    jobId: `${node.id}_mark`,
    name: `${node.id} sweep mark`,
    displayName: `${node.id} mark`,
    needs: [select, node.id],
    // always(): the lanes that succeeded are marked even when a sibling failed.
    if: `\${{ always() && needs.${select}.result == 'success' && needs.${select}.outputs.count != '0' }}`,
    permissions: { checks: "write", actions: "read", "pull-requests": "read" },
    timeoutMinutes: 5,
    steps: [
      runStep({
        name: "Mark the heads this sweep covered",
        env: {
          GH_TOKEN: "${{ github.token }}",
          PRS: `\${{ needs.${select}.outputs.prs }}`,
          NODE: node.id,
          BOT_LOGIN: ctx.config.identity?.bot_login ?? "",
          VERDICT_MARKER,
          JOB_PREFIX: sweepJobNamePrefix(node),
          SWEPT_CHECK: sweptCheckName(node),
          FAILED_CHECK: sweepFailedCheckName(node),
          MAX_FAILURES: String(SWEEP_MAX_FAILURES),
          RUN_ID: "${{ github.run_id }}",
          RUN_ATTEMPT: "${{ github.run_attempt }}",
        },
        run: [
          `JOBS=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$RUN_ID/attempts/$RUN_ATTEMPT/jobs?per_page=100" --paginate --jq '`,
          `  .jobs[] | [(.conclusion // "none"), .name] | @tsv') || {`,
          `  echo "::error::could not read this run's jobs — no head marked, so the next sweep will repeat them"`,
          `  exit 1`,
          `}`,
          `publish() { # <check name> <sha> <title> <summary>`,
          `  gh api --method POST "repos/$GITHUB_REPOSITORY/check-runs" \\`,
          `    -f name="$1" -f head_sha="$2" -f status=completed -f conclusion=neutral \\`,
          `    -f "output[title]=$3" -f "output[summary]=$4" >/dev/null`,
          `}`,
          `FAILED=0`,
          `while read -r NUM SHA; do`,
          `  [ -n "$NUM" ] || continue`,
          `  RESULT=$(awk -F'\\t' -v n="$JOB_PREFIX$NUM" '$2 == n {print $1}' <<< "$JOBS" | tail -n 1)`,
          `  case "$RESULT" in`,
          `    success)`,
          `      # The lane's post-condition: the bot's verdict on this head. A run that`,
          `      # posted none had nothing to decide yet — leave it for the next sweep,`,
          `      # and do not count it as a failure.`,
          `      VERDICTS=$(SHA="$SHA" gh api "repos/$GITHUB_REPOSITORY/pulls/$NUM/reviews?per_page=100" --paginate --jq '`,
          ...VERDICT_REVIEWS_JQ.map((l) => `        ${l}`),
          `      ' | awk '{s+=$1} END {print s+0}') || VERDICTS=""`,
          `      if [ -z "$VERDICTS" ]; then`,
          `        echo "::warning::#$NUM: could not read reviews on $SHA — left for the next sweep"`,
          `      elif [ "$VERDICTS" = "0" ]; then`,
          `        echo "::notice::#$NUM: no verdict posted on $SHA; left for the next sweep"`,
          `      elif publish "$SWEPT_CHECK" "$SHA" "Swept by $NODE" "The $NODE lane ran on $SHA and posted its verdict."; then`,
          `        echo "#$NUM: marked $SHA"`,
          `      else`,
          `        echo "::error::#$NUM: could not publish the swept check on $SHA — the next sweep will repeat it"`,
          `        FAILED=1`,
          `      fi ;;`,
          `    failure|timed_out)`,
          `      # One check-run per failed attempt; the selector counts them and stops at $MAX_FAILURES.`,
          `      # filter=all, or GitHub returns only the newest one and the count never passes 1.`,
          `      PRIOR=$(gh api "repos/$GITHUB_REPOSITORY/commits/$SHA/check-runs?per_page=100&filter=all" --paginate --jq '`,
          `        [.check_runs[] | select(.name == env.FAILED_CHECK)] | length' 2>/dev/null | awk '{s+=$1} END {print s+0}') || PRIOR=0`,
          `      N=$((PRIOR + 1))`,
          `      if [ "$N" -ge "$MAX_FAILURES" ]; then`,
          `        TITLE="$NODE gave up after $N failed runs"`,
          `        SUMMARY="The $NODE lane failed $N times on $SHA and will not be run on this head again. Push a new commit, or re-run the lane by hand, to try again."`,
          `      else`,
          `        TITLE="$NODE run $N of $MAX_FAILURES failed"`,
          `        SUMMARY="The $NODE lane failed on $SHA. The next sweep retries it; after $MAX_FAILURES failures it stops."`,
          `      fi`,
          `      if publish "$FAILED_CHECK" "$SHA" "$TITLE" "$SUMMARY"; then`,
          `        echo "#$NUM: lane $RESULT — recorded failed run $N of $MAX_FAILURES on $SHA"`,
          `      else`,
          `        echo "::error::#$NUM: could not record the failed run on $SHA — its retries are not being counted"`,
          `        FAILED=1`,
          `      fi ;;`,
          `    *)`,
          `      echo "#$NUM: lane did not finish (\${RESULT:-no job}) — left for the next sweep, not counted as a failure" ;;`,
          `  esac`,
          `done < <(jq -r '.[] | "\\(.number) \\(.sha)"' <<< "$PRS")`,
          `exit "$FAILED"`,
        ].join("\n"),
      }),
    ],
  };
}
