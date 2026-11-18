/**
 * post="review": the step that posts the review an agent PRINTED. The agent ends
 * its final message with one fenced json block; this step extracts the last one
 * (or, with no fence, a bare object at the end of the output), validates it, prepends the idempotency heading, sets commit_id to the head and
 * POSTs it with the lane's token. Generated from one script so the compiled
 * workflow and the tests run the same text.
 */
import type { EmitContext, StepSpec } from "../ir/types.js";
import { IS_VERDICT_JQ, POSTED_MARKER_PREFIX, rereviewLabelOf, parsePostMarker, DEFAULT_POST_MARKER, verdictLinesOf } from "./attrs.js";
import { runStep, tokenExpr } from "./steps.js";

const SCRIPT = `set -euo pipefail
# post="review": the agent printed its review; this step posts it with the lane's
# token. The agent's output is DATA — nothing here evaluates it, and it reaches gh
# only as a JSON file built by jq.
preview() { head -c 200 "$STDOUT_FILE" | tr '\\n\\r' '  '; }
# One line in the job summary saying what became of the review, under the agent's
# output: a link to it when posted, and a plain statement when not — so nobody
# has to read the log to learn whether the text above ever reached the PR.
note() { if [ -n "\${GITHUB_STEP_SUMMARY:-}" ]; then printf '\\n%s\\n' "$1" >> "$GITHUB_STEP_SUMMARY"; fi; }
if [ -z "\${STDOUT_FILE:-}" ] || [ ! -s "$STDOUT_FILE" ]; then
  echo "::warning::the agent printed nothing — no review posted"
  note "_No review was posted: the agent printed nothing._"
  exit 0
fi

# The LAST fenced json block in the output. A json string cannot hold a raw
# newline, so a fence inside the review's own markdown never closes this block.
BLOCK=$(awk '
  /^[ \\t]*\`\`\`[ \\t]*json[ \\t]*$/ { inb = 1; buf = ""; next }
  inb && /^[ \\t]*\`\`\`[ \\t]*$/ { inb = 0; last = buf; found = 1; next }
  inb { buf = buf $0 "\\n" }
  END { if (found) printf "%s", last }' "$STDOUT_FILE")

# No fence: fall back to a BARE object at the end of the output, which models
# print often enough. It ends on the last line ending in "}" (anything after it
# is ignored) and starts on a line beginning with "{"; the start is the latest
# such line from which the slice parses as exactly one object with a string
# body. A line inside a pretty-printed object (a comment's "{") leaves the rest
# of the object behind it, so it never parses alone and the scan moves up. A
# fenced block, when there is one, always wins.
if [ -z "$BLOCK" ]; then
  END_LINE=$(awk '/}[ \\t\\r]*$/ { e = NR } END { print e + 0 }' "$STDOUT_FILE")
  if [ "$END_LINE" -gt 0 ]; then
    for START in $(awk -v e="$END_LINE" 'NR <= e && /^[ \\t]*[{]/ { print NR }' "$STDOUT_FILE" | tail -n 200 | sort -rn); do
      SLICE=$(sed -n "\${START},\${END_LINE}p" "$STDOUT_FILE")
      if jq -se 'length == 1 and (.[0] | type == "object" and (.body | type) == "string")' <<< "$SLICE" > /dev/null 2>&1; then
        BLOCK=$SLICE
        echo "::notice::no fenced json block in the agent's output — using the bare JSON object at its end"
        break
      fi
    done
  fi
fi
if [ -z "$BLOCK" ]; then
  echo "::warning::no review in the agent's output: neither a fenced json block nor a bare JSON object with a string body at its end — nothing posted. It began: $(preview)"
  note "_No review was posted: the agent's output held no review block._"
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
  note "_No review was posted: the review block was not valid._"
  exit 0
fi

# A verdict lane's review IS its verdict: the last visible line must be one of
# the exact verdict lines, or the sweep and the gate would read it differently.
if [ "$REQUIRE_VERDICT" = "true" ] && ! jq -e '__IS_VERDICT_JQ__' <<< "$REVIEW" > /dev/null; then
  echo "::warning::the review's last line is not one of the verdict lines ($(tr '\\n' '|' <<< "$VERDICT_LINES")) — nothing posted"
  note "_No review was posted: its last line is not one of the verdict lines._"
  exit 0
fi

# Idempotency: has THIS lane already posted on this head? Each review this step
# posts ends with a hidden marker naming the lane and the head, and that marker
# is what a re-run looks for. Several lanes post as one bot, often under one
# heading, so neither the heading nor the shape of the review says whose it is:
# a reviewer's review must not silence an approver, and a reviewer that posts
# its own verdict must still recognize its own review on a re-run.
#
# A review with no posted marker at all predates the marker. For those the old
# test stands in: the heading on line 1 — and, on a verdict lane, only a review
# that is itself a verdict, so a plain review under the same heading cannot
# stop the verdict being posted.
#
# A re-review request (the re-review label) asks for a FRESH review of the same
# head: a review posted before the label was last added no longer counts.
MARKER="\${POST_MARKER//<n>/$PR}"
MARKER="\${MARKER//<sha>/$HEAD_SHA}"
POSTED="$POSTED_PREFIX$NODE:$HEAD_SHA -->"
SINCE=""
if [ -n "\${REREVIEW_LABEL:-}" ]; then
  if ! SINCE=$(gh api "repos/$GITHUB_REPOSITORY/issues/$PR/events?per_page=100" --paginate --jq '
      .[] | select(.event == "labeled" and .label.name == env.REREVIEW_LABEL) | .created_at' | sort | tail -n 1); then
    echo "::error::could not read the PR's label history — not posting, so a re-run cannot post the review twice"
    exit 1
  fi
fi
export MARKER POSTED SINCE
if ! EXISTING=$(gh api "repos/$GITHUB_REPOSITORY/pulls/$PR/reviews?per_page=100" --paginate --jq '
  [.[] | select(.user.login == env.BOT_LOGIN and .commit_id == env.HEAD_SHA)
   | select(env.SINCE == "" or (.submitted_at // "") >= env.SINCE)
   | (.body // "") as $b
   | select(($b | contains(env.POSTED))
       or ((($b | contains(env.POSTED_PREFIX)) | not)
           and ((($b | split("\\n") | .[0]) // "" | gsub("^\\\\s+|\\\\s+$"; "")) == env.MARKER)
           and (env.REQUIRE_VERDICT != "true" or __IS_VERDICT_JQ__)))] | length' \\
  | awk '{s+=$1} END {print s+0}'); then
  echo "::error::could not read the PR's reviews — not posting, so a re-run cannot post the review twice"
  exit 1
fi
if [ "$EXISTING" != "0" ]; then
  echo "$NODE has already posted its review on $HEAD_SHA — not posting it again"
  note "_The review for this head was already posted; nothing new was posted._"
  exit 0
fi

PAYLOAD=$(mktemp)
jq -c --arg sha "$HEAD_SHA" --arg head "$MARKER" \\
  '{commit_id: $sha, event, body: ($head + "\\n\\n" + .body), comments}' <<< "$REVIEW" > "$PAYLOAD"
# The posted marker goes on last, after any reshaping of the body below: it is
# an HTML comment, which every verdict test ignores, so a verdict line above it
# is still the review's last visible line.
RESP=$(mktemp)
post() {
  jq -c --arg m "$POSTED" '.body += "\\n\\n" + $m' "$1" > "$1.out"
  gh api --method POST "repos/$GITHUB_REPOSITORY/pulls/$PR/reviews" --input "$1.out" > "$RESP" 2> "$ERR"
}
# Why a post failed, on one line. gh prints only "gh: <status> (HTTP <code>)" on
# stderr; GitHub's error body, with the reason, goes to stdout ($RESP).
why() {
  local detail
  detail=$(jq -r 'if type == "object" then [(.message // empty), ((.errors // [])[] | if type == "string" then . else (.message // tojson) end)] | join(" — ") else tojson end' "$RESP" 2> /dev/null) \\
    || detail=$(head -c 300 "$RESP")
  printf '%s %s' "$(head -c 200 "$ERR")" "$detail" | tr '\\n\\r' '  ' | head -c 500 || true
}
# The review's own URL, from the API's response, for the job summary.
posted_note() {
  URL=$(jq -r '.html_url // empty' "$RESP" 2> /dev/null || true)
  if [ -n "$URL" ]; then note "**Review posted:** $URL"; else note "**Review posted** on $HEAD_SHA."; fi
}
# Move inline findings into the body, as a list before the verdict line (on a
# verdict lane) or at the end. $2 is a JSON array of the paths whose comments
# stay inline, or null to move every one. Nothing to move leaves the review as it is.
flatten() {
  jq -c --argjson rv "$([ "$REQUIRE_VERDICT" = "true" ] && echo true || echo false)" --argjson keep "$2" '
    def kept: $keep != null and (.path as $p | $keep | any(. == $p));
    [.comments[] | select(kept | not)] as $moved
    | if ($moved | length) == 0 then . else
        ("### Findings on unchanged lines\\n\\n" + ([$moved[] | "- \`\\(.path):\\(.line)\` — \\(.body | gsub("\\n"; " "))"] | join("\\n"))) as $f
        | (.body | sub("\\\\s+$"; "") | split("\\n")) as $l
        | .body = ((if $rv then ($l[:-1] + [$f, ""] + $l[-1:]) else ($l + ["", $f]) end) | join("\\n"))
        | .comments = [.comments[] | select(kept)]
      end' "$1"
}

# GitHub rejects the whole review when one inline comment is on a file outside
# the PR's diff. Move those into the body before posting, from one read of the
# changed files. If that read fails, post as is: the 422 retry below still holds.
if [ "$(jq '.comments | length' "$PAYLOAD")" != "0" ]; then
  if FILES=$(gh api "repos/$GITHUB_REPOSITORY/pulls/$PR/files?per_page=100" --paginate --jq '.[].filename' 2> "$ERR" \\
      | jq -R -s -c 'split("\\n") | map(select(length > 0))'); then
    flatten "$PAYLOAD" "$FILES" > "$PAYLOAD.post"
    MOVED=$(( $(jq '.comments | length' "$PAYLOAD") - $(jq '.comments | length' "$PAYLOAD.post") ))
    if [ "$MOVED" != "0" ]; then
      echo "::notice::$MOVED inline comment(s) on files outside the PR's diff — posting them in the body instead"
    fi
  else
    echo "::warning::could not read the PR's changed files ($(head -c 200 "$ERR" | tr '\\n\\r' '  ')) — posting the inline comments as they are"
    cp "$PAYLOAD" "$PAYLOAD.post"
  fi
else
  cp "$PAYLOAD" "$PAYLOAD.post"
fi
if post "$PAYLOAD.post"; then
  echo "posted the review on $HEAD_SHA"
  posted_note
  exit 0
fi

# A comment on a changed file but a line outside its hunks still gets the whole
# review rejected with a 422, and GitHub does not say which comment. Retry once
# with every inline finding moved into the body (built from the original, so the
# body holds one list). Any 422 with inline comments retries, whatever its
# wording ("Line could not be resolved", "Path could not be resolved", "must be
# part of the diff", ...): the retry posts the same findings unanchored, so the
# worst case is one more rejected POST. A 422 with no inline comments has
# nothing to move and fails below.
if grep -qs "HTTP 422" "$ERR" "$RESP" && [ "$(jq '.comments | length' "$PAYLOAD.post")" != "0" ]; then
  echo "::warning::GitHub rejected an inline comment ($(why)) — posting the findings in the body instead"
  flatten "$PAYLOAD" null > "$PAYLOAD.flat"
  if post "$PAYLOAD.flat"; then
    echo "posted the review on $HEAD_SHA, with its inline findings in the body"
    posted_note
    exit 0
  fi
fi
echo "::error::could not post the review: $(why)"
note "_No review was posted: GitHub rejected it. See the job log._"
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
      NODE: ctx.node.id,
      POSTED_PREFIX: POSTED_MARKER_PREFIX,
      PR: opts.prNumber,
      HEAD_SHA: opts.headSha,
      STDOUT_FILE: "${{ steps.agent.outputs.stdout-file }}",
      BOT_LOGIN: ctx.config.identity?.bot_login ?? "",
      POST_MARKER: marker,
      REQUIRE_VERDICT: String(opts.verdictLane),
      VERDICT_LINES: verdictLinesOf(ctx.config),
      ...(rereviewLabelOf(ctx.config) ? { REREVIEW_LABEL: rereviewLabelOf(ctx.config)! } : {}),
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
    "The fence is required: a bare object at the very end is accepted as a fallback, but always use the fence.",
    "If the block is missing or is not valid JSON, nothing is posted.",
  ].join("\n");
}
