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
6. **Required checks** — every name in `requiredChecks` must have reported on
   the head SHA with conclusion `success`. A check that never ran blocks the
   merge; the CI rollup above cannot do that, since it only judges the checks
   that happen to exist.
7. **Hand-written additions** — additions of non-`excludeGlobs` files must be
   `<= maxAdditions`, else apply `labels.needsHuman`.
8. **Protected paths** — no changed file may match `protectedPaths`, else apply
   `labels.needsHuman`.
9. **Clean rebase** — the branch must rebase cleanly onto the base branch
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

## Inputs

| input         | required | description |
| ------------- | -------- | ----------- |
| `pr-number`   | yes      | PR to evaluate. |
| `token`       | yes      | Token with `contents:write` + `pull-requests:write` (use an App installation token so merges are attributed to the bot). |
| `policy-path` | yes      | Path to the policy file (YAML or JSON). |
| `bot-login`   | no       | Login of the reviewer bot whose verdicts are trusted; overrides the policy's `bot_login`. |
| `required-checks` | no   | Comma/newline-separated check-run names that must be present and green on the head SHA; overrides the policy's `required_checks`. |
| `clean-rebase`| no       | Override the rebase check with `"true"`/`"false"`; inferred from mergeable state otherwise. |
| `dry-run`     | no       | `"true"` to evaluate + emit outputs without mutating. |

## Outputs

`action`, `code`, `reason`, `label` (when labeling), and `merged` (`"true"` if
this run merged the PR).

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
  - "gp-foundry/human-approval (production)"
labels:
  needsHuman: "needs-human"
  rebaseNeeded: "rebase-needed"

# who may approve (see "Who can approve"):
botLogin: "my-agent[bot]"
trustedAuthorAssociations: ["OWNER", "MEMBER", "COLLABORATOR"]
allowCommentApprovals: false             # plain issue comments are NOT approvals

# wrapper-only (I/O) knobs:
approvalBodyRegex: "Verdict.*APPROVE"   # count a COMMENTED review as approval
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
