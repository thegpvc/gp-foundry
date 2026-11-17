# merge-gate (C7)

A GitHub Action that decides whether a single PR may be auto-merged, and — when
it may not — routes it to the right agent via a label. It is a generalized,
**testable** port of the gp-dixie "Shipper" (`agent-merger.yml`), whose merge
rules previously lived in a fragile ~200-line bash script.

The gating rules are a **pure function**, `evaluateMergeGate(pr, policy) ->
{ action, code, reason, label? }`, defined in [`src/gate.ts`](./src/gate.ts) and
exhaustively unit-tested in [`src/gate.test.ts`](./src/gate.test.ts). The action
wrapper ([`src/index.ts`](./src/index.ts)) does the GitHub I/O around it: gather
facts → evaluate → merge / label / skip.

## Gates (in order)

The gate returns the **first** failing check. Ordering is cheapest / most
disqualifying first:

1. **Blocking labels** — PR carries any `blockingLabels` (e.g. `needs-human`,
   `rebase-needed`) → `skip`.
2. **Branch prefix** — head branch must start with `branchPrefix` (if set).
3. **Approval present and trusted** — `approvedAt` must be set (the wrapper
   derives it from an `APPROVED` review, or a `COMMENTED` review whose body
   matches `approvalBodyRegex`). See [Who can approve](#who-can-approve).
4. **Approval delay** — at least `approvalDelayMinutes` must have elapsed.
5. **CI passing** — the check-run rollup for the head SHA must be `passing`
   (unless `requireCi: false`).
6. **Required checks** — every entry in `requiredChecks` must have reported on
   the head SHA with conclusion `success`. A check that never ran blocks the
   merge; the CI rollup above cannot do that, since it only judges the checks
   that happen to exist.

   An entry may pin the **author** as well as the name, as `<name>@<app-slug>`.
   Do that for any check that stands in for a human decision: a check-run's name
   is public, so without the pin anything able to write checks — including the
   App installation token every agent lane carries, which a job's `permissions:`
   block does *not* constrain — can publish its own approval. `gp-foundry build`
   emits the human-gate's check pinned to `@github-actions`, the app GITHUB_TOKEN
   writes as. Leave third-party CI checks unpinned.
7. **Review requests** (opt-in, `requireNoReviewRequests: true`) — no pending
   requested reviewer or team, else `review-requested`.
8. **Open review threads** (opt-in, `requireNoOpenThreads: true`) — no open
   thread, else `open-threads`. See [Open threads](#open-threads).
   Between those two, opt-in: **standing change requests**
   (`requireNoHumanChangesRequested: true`) — no person whose latest deciding
   review is "changes requested", else `changes-requested`. Without it the latest
   verdict wins, so the bot's later approval overrides a teammate's block.

An **escalation label** (`escalationLabels: [...]`) is checked first, right after
blocking labels and in both lanes: a PR carrying one is never merged (`escalated`),
and in evaluate mode its check is `action_required` whether or not the approver
has given a verdict.
9. **Hand-written additions** — additions of non-`excludeGlobs` files must be
   `<= maxAdditions`, else apply `labels.needsHuman`.
10. **Protected paths** — no changed file may match `protectedPaths`, else apply
   `labels.needsHuman`.
11. **Clean rebase** — the branch must rebase cleanly onto the base branch
   (unless `requireCleanRebase: false`), else apply `labels.rebaseNeeded`.

If all pass, the action is `merge` — of the **exact head SHA that was scored**,
passed to GitHub as the merge's `sha` guard. If the head moved in between (the
janitor's rebase sweep runs on the same cadence as this poller), GitHub rejects
the call, the PR is labeled for a rebase, and the next poll re-scores the new
head. The gate never merges a commit it did not evaluate.

Outcomes: `merge` (merge it), `label` (apply `label` and stop), `skip` (no-op).

## Who can approve

An approval is an instruction to push code to the base branch, so the gate only
counts verdicts it can attribute:

- **Formal reviews** by the bot (`botLogin` / the `bot-login` input), or by an
  author whose `author_association` is in `trustedAuthorAssociations` (default
  `OWNER`, `MEMBER`, `COLLABORATOR` — i.e. write access). A review approval is
  additionally bound to the head SHA: approve, then push, and the approval no
  longer counts.
- **Plain issue comments** are not an approval channel unless
  `allowCommentApprovals: true`. Even then they must come from a trusted author,
  and because a comment carries no SHA the only binding available is that it
  postdates the head commit — weaker than a review. Prefer leaving it off.
- **Rejections** (`CHANGES_REQUESTED`, or a body matching `rejectionBodyRegex`)
  are counted from any formal review regardless of author: a rejection can only
  ever hold a merge back, so accepting more of them is the safe direction. The
  comment channel is on or off as a whole, so a drive-by comment cannot stall
  the factory when comment approvals are disabled.

The latest verdict wins: a newer rejection invalidates an earlier approval.

## Open threads

With `requireNoOpenThreads: true` the wrapper reads the PR's review threads
(GraphQL `reviewThreads`: resolution, every comment's author, reactions on the
first comment). A thread is **open** when all of these hold:

- it is unresolved;
- its first comment is not by the PR author (a note to self never blocks);
- no later comment is by the PR author, and the author has not reacted to the
  first comment — a reply or a reaction is the author's answer, and the next
  review judges it;
- if a login in `botLogins` (e.g. `greptile-apps[bot]`, `cursor[bot]`) opened
  it, its first comment matches `botThreadBlockingRegex` (default
  `P1|High Severity`). A review bot's lower-severity thread never blocks.

Logins compare case-insensitively and with or without the `[bot]` suffix
(GraphQL drops it). A failed thread read fails closed: the PR is not evaluated
that run.

## The single gate (`merge`)

`merge: off | agent-only` is one gate for a repo where people and agents both
open pull requests. Each tick, for every PR in scope:

1. the result is worked out against the policy;
2. it is published as the check `check-name` on the PR's head;
3. with `agent-only`, a PR the pipeline **wrote** — opened by `bot-login`, every
   commit its own — is acted on: merged when ready, labelled per the policy when
   not. One merge per run.

A human-written PR gets the check and nothing else: no merge, no label, no
comment. With `agent-only` the check's text says who merges the PR and, for a
PR that is not agent-written, why not.

Scope comes from the `rollout` input (the dial in `foundry.config.yaml`), not
from a branch prefix: a draft never, a PR with the skip label never, a PR
`bot-login` opened always, another bot only if named in `authors`, then a listed
author or the opt-in label. With no rollout, every remaining PR. The policy's
`branchPrefix` clause is not applied. If the policy enables the dependabot lane,
dependabot's PRs are judged and merged on that lane as before.

`check-app` names the app whose runs the gate adopts. Leave it empty when the
check is published with `GITHUB_TOKEN`; pass the harness App's slug when
`checks-token` is that App's token, so a check published by any other workflow
is never taken for the gate's.

Which app owns the check matters twice over. A `GITHUB_TOKEN` check belongs to
`github-actions`, so any workflow in the repo can publish one under the same
name — it cannot safely be a required check — and GitHub files it under whatever
Actions check suite is already on the commit, so it can show up beneath an
unrelated workflow's name. A check written with the harness's App token belongs
to that App alone. Anything that requires it downstream (another gate's
`required-checks`, a ruleset) should name it pinned to the App:
`<check name>@<app slug>`.

`mode` (below) is the older interface and is unchanged; `merge` and `mode`
cannot both be set.

## Evaluate mode

`mode: evaluate` never merges, labels or comments. It evaluates the policy for
every open, non-draft PR on a `branchPrefix` branch (narrowed by `authors`,
`opt-in-label`, `skip-labels` and `skip-bot-authors` when given; or just
`pr-number`) and publishes the result as one check run per head, named
`check-name`:

| conclusion | when |
| --- | --- |
| `success` | the gate's decision is `merge` |
| `action_required` | the trusted reviewer's latest verdict on the head is an escalation (`**Verdict:** ESCALATE`, or `escalationBodyRegex`) |
| `neutral` | `noVerdictConclusion: neutral` and the trusted approver has given no verdict (approve, reject or escalate) on the head yet ("Awaiting the approver"), whatever else fails; `output.summary` lists every other clause still failing (CI counts, unanswered threads, review requests, size, protected paths) |
| `failure` | anything else (a rejected head, an approved head with a clause failing, or any unverdicted head without `noVerdictConclusion: neutral`); `output.summary` carries the gate's first failing `code` and `reason` |

`output.text` lists the open threads, the checks not passing and the pending
review requests. The run is written with `checks-token` (GITHUB_TOKEN) and is
idempotent per head: an existing run of that name from `github-actions` is
updated in place, and when its conclusion, summary and text already match,
nothing is written. Gate state that changes without a push (a thread answered,
CI finished, a review request dropped) therefore flips the check on the next
run, at no model cost, and the check can be made required.

In this mode the gate leaves its own check out of the CI rollup (a failing
verdict would otherwise hold itself failing), and `requireCleanRebase` defaults
to `false` — mergeability is only settled by a merge attempt, which this mode
never makes. The token needs only `checks: write`, `pull-requests: read` and
`contents: read`.

## Verdict markers

Review bodies are matched as a reader sees them: HTML comments removed (the
harness appends its own after the verdict line — the unchanged-diff stamp, the
also-head marker) and trailing whitespace trimmed.

A review is a verdict when that visible body's last non-empty line, trimmed, is
exactly `**Verdict:** <word>`, with the words given by the `verdicts` input
(default `APPROVE,REQUEST_CHANGES,ESCALATE`: approve, request changes, escalate).
The approval and escalation markers default to those exact lines, which is the
grammar the sweep's select and mark jobs use (`src/shared/verdicts.ts`), so a head
the sweep counts as decided is one the gate can read.
`**Verdict:** APPROVE (once gates pass)` is not a verdict.

The rejection marker defaults to the loose `Verdict.*<request-changes word>`, on
purpose: a rejection the gate fails to recognize leaves an earlier approval
standing and the PR merges, while one it recognizes too eagerly only holds a merge
back. The approval marker is tested first, so an approval that mentions the
earlier request in prose is still an approval. `approvalBodyRegex`,
`rejectionBodyRegex` and `escalationBodyRegex` override a marker, but an override
can drift from the sweep; leave them unset.

## Whose approval counts

An approval counts when it comes from `botLogin` or from an author whose
association is in `trustedAuthorAssociations` — and **never from the pull
request's own author**, unless that author is `botLogin`. GitHub refuses a formal
`APPROVED` review from a PR's author but allows a `COMMENTED` one, and a comment
review ending in the approval line is how the gate reads an approval; without
this rule a trusted collaborator could open a PR and approve it themselves. The
harness bot is the deliberate exception: it writes and reviews agent PRs under
one identity. A rejection counts from anyone, including the author.

## Inputs

| input         | required | description |
| ------------- | -------- | ----------- |
| `pr-number`   | yes      | PR to evaluate. |
| `token`       | yes      | Token with `contents:write` + `pull-requests:write` (use an App installation token so merges are attributed to the bot). |
| `policy-path` | yes      | Path to the policy file (YAML or JSON). |
| `bot-login`   | no       | Login of the reviewer bot whose verdicts are trusted; overrides the policy's `bot_login`. |
| `required-checks` | no   | Comma/newline-separated check-run names that must be present and green on the head SHA; overrides the policy's `required_checks`. |
| `clean-rebase`| no       | Override the rebase check with `"true"`/`"false"`; inferred from mergeable state otherwise. |
| `checks-token` | no      | Token for reading (and, in evaluate mode, writing) check runs; pass GITHUB_TOKEN. |
| `verdicts`    | no       | The verdict words, approve / request changes / escalate (default `APPROVE,REQUEST_CHANGES,ESCALATE`). |
| `mode`        | no       | `merge` (default) or `evaluate` (publish a check run per head, never merge). |
| `check-name`  | evaluate | The check run evaluate mode publishes. |
| `authors`, `opt-in-label`, `skip-labels`, `skip-bot-authors` | no | Evaluate-mode PR selection (comma-separated logins / labels; `"true"`). |
| `dry-run`     | no       | `"true"` to evaluate + emit outputs without mutating. |

## Outputs

`action`, `code`, `reason`, `label` (when labeling), and `merged` (`"true"` if
this run merged the PR). Evaluate mode sets `evaluated` and `checks-written`.

## Policy file

All gp-dixie hardcodes are parameterized here. Example reproducing the original
Shipper behaviour:

```yaml
branchPrefix: "agent/"
approvalDelayMinutes: 30
maxAdditions: 1200
excludeGlobs:
  - "gen/**"
protectedPaths:
  - "db/migrations/"
  - ".github/workflows/"
  - "terraform/"
  - "CLAUDE.md"
  - "scope.yaml"
blockingLabels:
  - "needs-human"
  - "rebase-needed"
requireCi: true
requireCleanRebase: true
requiredChecks:                          # must be PRESENT and green on the head SHA
  - "gp-foundry/human-approval (production)@github-actions"   # @app pins the author
  - "ci/build"                                               # unpinned: any author
labels:
  needsHuman: "needs-human"
  rebaseNeeded: "rebase-needed"
  awaitingApproval: "awaiting-approval"  # optional: label a ready-but-unapproved PR
                                         # instead of skipping it silently. Must NOT
                                         # be in blockingLabels; removed on approval.

# Dependabot lane (optional). PRs authored by `dependabot[bot]` (verified by
# author, not branch name) are scored separately: no human approval, but only
# the listed semver levels auto-merge, and only with green CI and no protected
# paths. Major / unparseable / failing / protected-path updates get needsHuman.
# Omit the block to leave dependabot PRs untouched.
dependabot:
  autoMerge: ["patch", "minor"]

# who may approve (see "Who can approve"):
botLogin: "my-agent[bot]"
trustedAuthorAssociations: ["OWNER", "MEMBER", "COLLABORATOR"]
allowCommentApprovals: false             # plain issue comments are NOT approvals

# wrapper-only (I/O) knobs:
# approvalBodyRegex / rejectionBodyRegex / escalationBodyRegex: overrides only;
# by default each is the exact verdict line (see "Verdict markers").

# evaluate-mode clauses (off by default; also apply in merge mode when set):
requireNoOpenThreads: true
botLogins: ["greptile-apps[bot]", "cursor[bot]"]
botThreadBlockingRegex: "P1|High Severity"
requireNoReviewRequests: true
ciIgnoreCheckNames: ["review", "fix", "sweep", "merge"]
mergeMethod: "rebase"                    # merge | squash | rebase
deleteBranchOnMerge: true
```

Every field is optional; defaults are safe (`requireCi`/`requireCleanRebase`
default to `true`, `maxAdditions` defaults to unlimited, delay to `0`).

## Usage

```yaml
- uses: actions/checkout@v5
- id: gate
  uses: <owner>/<repo>/actions/merge-gate@<ref>
  with:
    pr-number: ${{ github.event.pull_request.number }}
    token: ${{ steps.app-token.outputs.token }}
    policy-path: .github/merge-policy.yml
- run: echo "Gate said ${{ steps.gate.outputs.action }}: ${{ steps.gate.outputs.reason }}"
```

## Development

```bash
npm test -- actions/merge-gate       # run the unit tests
npm run build:actions                # bundle src/index.ts -> dist/index.js
```

The wrapper is bundled to `dist/index.js` by the repo's action build; do not
edit `dist/` by hand.
