/**
 * post="review": the step that posts the review an agent PRINTED. The agent ends
 * its final message with one fenced json block; this step extracts the last one,
 * validates it, prepends the idempotency heading, sets commit_id to the head and
 * POSTs it with the lane's token. Generated from one script so the compiled
 * workflow and the tests run the same text.
 */
import type { EmitContext, StepSpec } from "../ir/types.js";
import { IS_VERDICT_JQ, parsePostMarker, DEFAULT_POST_MARKER, verdictLinesOf } from "./attrs.js";
import { runStep, tokenExpr } from "./steps.js";

const SCRIPT = `set -euo pipefail
# post="review": the agent printed its review; this step posts it with the lane's
# token. The agent's output is DATA — nothing here evaluates it, and it reaches gh
# only as a JSON file built by jq.
preview() { head -c 200 "$STDOUT_FILE" | tr '\\n\\r' '  '; }
if [ -z "\${STDOUT_FILE:-}" ] || [ ! -s "$STDOUT_FILE" ]; then
  echo "::warning::the agent printed nothing — no review posted"
  exit 0
fi

# The LAST fenced json block in the output. A json string cannot hold a raw
# newline, so a fence inside the review's own markdown never closes this block.
BLOCK=$(awk '
  /^[ \\t]*\`\`\`[ \\t]*json[ \\t]*$/ { inb = 1; buf = ""; next }
  inb && /^[ \\t]*\`\`\`[ \\t]*$/ { inb = 0; last = buf; found = 1; next }
  inb { buf = buf $0 "\\n" }
  END { if (found) printf "%s", last }' "$STDOUT_FILE")
if [ -z "$BLOCK" ]; then
  echo "::warning::no fenced json review block in the agent's output — nothing posted. It began: $(preview)"
  exit 0
fi

ERR=$(mktemp)
if ! REVIEW=$(jq -c '
  def fail(m): error(m);
  if type != "object" then fail("the block is not a JSON object") else . end
  | if ((.body | type) != "string") or ((.body | length) == 0) then fail("body must be a non-empty string") else . end
  | if (.event // "COMMENT") != "COMMENT" then fail("event must be COMMENT") else . end
  | (.comments // []) as $c
  | if ($c | type) != "array" then fail("comments must be an array") else . end
  | if any($c[]; (type != "object") or ((.path | type) != "string") or ((.line | type) != "number")
        or (.line != (.line | floor)) or (.line < 1) or ((.body | type) != "string"))
    then fail("each comment needs a string path, a positive integer line and a string body") else . end
  | {body, event: "COMMENT", comments: [$c[] | {path, line, side: (if .side == "LEFT" then "LEFT" else "RIGHT" end), body}]}
' <<< "$BLOCK" 2> "$ERR"); then
  echo "::warning::the review block is not a valid review — nothing posted: $(head -c 300 "$ERR" | tr '\\n\\r' '  ')"
  exit 0
fi

# A verdict lane's review IS its verdict: the last visible line must be one of
# the exact verdict lines, or the sweep and the gate would read it differently.
if [ "$REQUIRE_VERDICT" = "true" ] && ! jq -e '__IS_VERDICT_JQ__' <<< "$REVIEW" > /dev/null; then
  echo "::warning::the review's last line is not one of the verdict lines ($(tr '\\n' '|' <<< "$VERDICT_LINES")) — nothing posted"
  exit 0
fi

# Line 1 of the posted body: the heading that makes a re-run idempotent. The
# check is keyed by verdict-ness, the way the sweep tells decided from reviewed:
# a verdict lane counts only its own kind (reviews ending in a verdict line), a
# plain lane only reviews without one. So an event reviewer and a verdict sweep
# can share a bot login and a marker without one's review silencing the other.
MARKER="\${POST_MARKER//<n>/$PR}"
MARKER="\${MARKER//<sha>/$HEAD_SHA}"
export MARKER
if ! EXISTING=$(gh api "repos/$GITHUB_REPOSITORY/pulls/$PR/reviews?per_page=100" --paginate --jq '
  [.[] | select(.user.login == env.BOT_LOGIN and .commit_id == env.HEAD_SHA)
   | select((((.body // "") | split("\\n") | .[0]) // "" | gsub("^\\\\s+|\\\\s+$"; "")) == env.MARKER)
   | select(__IS_VERDICT_JQ__ == (env.REQUIRE_VERDICT == "true"))] | length' \\
  | awk '{s+=$1} END {print s+0}'); then
  echo "::error::could not read the PR's reviews — not posting, so a re-run cannot post the review twice"
  exit 1
fi
if [ "$EXISTING" != "0" ]; then
  echo "a $([ "$REQUIRE_VERDICT" = "true" ] && echo "verdict" || echo "non-verdict") review headed '$MARKER' by $BOT_LOGIN is already on $HEAD_SHA — not posting it again"
  exit 0
fi

PAYLOAD=$(mktemp)
jq -c --arg sha "$HEAD_SHA" --arg head "$MARKER" \\
  '{commit_id: $sha, event, body: ($head + "\\n\\n" + .body), comments}' <<< "$REVIEW" > "$PAYLOAD"
post() { gh api --method POST "repos/$GITHUB_REPOSITORY/pulls/$PR/reviews" --input "$1" > /dev/null 2> "$ERR"; }
if post "$PAYLOAD"; then
  echo "posted the review on $HEAD_SHA"
  exit 0
fi

# GitHub rejects the whole review when one inline comment is on a line outside
# the diff, and does not say which. Retry once with every inline finding moved
# into the body (before the verdict line, on a verdict lane).
if grep -q "422" "$ERR" && grep -qiE "line|diff|position|resolve" "$ERR" && [ "$(jq '.comments | length' "$PAYLOAD")" != "0" ]; then
  echo "::warning::GitHub rejected an inline comment ($(head -c 200 "$ERR" | tr '\\n\\r' '  ')) — posting the findings in the body instead"
  jq -c --argjson rv "$([ "$REQUIRE_VERDICT" = "true" ] && echo true || echo false)" '
    ("### Findings on unchanged lines\\n\\n" + ([.comments[] | "- \`\\(.path):\\(.line)\` — \\(.body | gsub("\\n"; " "))"] | join("\\n"))) as $f
    | (.body | sub("\\\\s+$"; "") | split("\\n")) as $l
    | .body = ((if $rv then ($l[:-1] + [$f, ""] + $l[-1:]) else ($l + ["", $f]) end) | join("\\n"))
    | .comments = []' "$PAYLOAD" > "$PAYLOAD.flat"
  if post "$PAYLOAD.flat"; then
    echo "posted the review on $HEAD_SHA, with its inline findings in the body"
    exit 0
  fi
fi
echo "::error::could not post the review: $(head -c 500 "$ERR" | tr '\\n\\r' '  ')"
exit 1
`;

/** The post step: after run-agent (`id: agent`), only when the agent succeeded. */
export function postReviewStep(
  ctx: EmitContext,
  opts: { prNumber: string; headSha: string; verdictLane: boolean },
): StepSpec {
  let marker = DEFAULT_POST_MARKER;
  try {
    marker = parsePostMarker(ctx.node);
  } catch {
    // malformed: validate() reports it; the default keeps the step idempotent
  }
  return runStep({
    name: "Post the review",
    if: "${{ success() }}",
    env: {
      GH_TOKEN: tokenExpr(ctx),
      PR: opts.prNumber,
      HEAD_SHA: opts.headSha,
      STDOUT_FILE: "${{ steps.agent.outputs.stdout-file }}",
      BOT_LOGIN: ctx.config.identity?.bot_login ?? "",
      POST_MARKER: marker,
      REQUIRE_VERDICT: String(opts.verdictLane),
      VERDICT_LINES: verdictLinesOf(ctx.config),
    },
    run: SCRIPT.replaceAll("__IS_VERDICT_JQ__", () => IS_VERDICT_JQ),
  });
}

/** What the agent is told about handing back its review (run-agent's output-contract). */
export function reviewOutputContract(ctx: EmitContext, verdictLane: boolean): string {
  const lines = verdictLinesOf(ctx.config).split("\n");
  return [
    "Do not post anything to GitHub yourself, and do not run `gh`: a workflow step posts your review for you.",
    "End your final message with exactly one fenced code block tagged `json` holding one object:",
    "",
    "```json",
    '{"body": "<the whole review, in markdown>", "comments": [{"path": "src/file.ts", "line": 42, "side": "RIGHT", "body": "<one finding>"}], "event": "COMMENT"}',
    "```",
    "",
    "- `body`: the review. Do not add a heading with the PR number or commit; the step adds it.",
    "- `comments`: optional inline findings, each on a line of the diff (`side` RIGHT is the new file, LEFT the old). Use `[]` for none.",
    '- `event`: always `"COMMENT"`. Do not include a `commit_id`; the step sets it to the head you reviewed.',
    ...(verdictLane
      ? [`- The LAST line of \`body\` must be exactly one of: ${lines.map((l) => `\`${l}\``).join(", ")}. Anything else, and nothing is posted.`]
      : []),
    "If the block is missing or is not valid JSON, nothing is posted.",
  ].join("\n");
}
