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
3. **Bot-approval present** — `approvedAt` must be set (the wrapper derives it
   from an `APPROVED` review, or a `COMMENTED` review whose body matches
   `approvalBodyRegex`).
4. **Approval delay** — at least `approvalDelayMinutes` must have elapsed.
5. **CI passing** — the check-run rollup for the head SHA must be `passing`
   (unless `requireCi: false`).
6. **Hand-written additions** — additions of non-`excludeGlobs` files must be
   `<= maxAdditions`, else apply `labels.needsHuman`.
7. **Protected paths** — no changed file may match `protectedPaths`, else apply
   `labels.needsHuman`.
8. **Clean rebase** — the branch must rebase cleanly onto the base branch
   (unless `requireCleanRebase: false`), else apply `labels.rebaseNeeded`.

If all pass, the action is `merge`.

Outcomes: `merge` (merge it), `label` (apply `label` and stop), `skip` (no-op).

## Inputs

| input         | required | description |
| ------------- | -------- | ----------- |
| `pr-number`   | yes      | PR to evaluate. |
| `token`       | yes      | Token with `contents:write` + `pull-requests:write` (use an App installation token so merges are attributed to the bot). |
| `policy-path` | yes      | Path to the policy file (YAML or JSON). |
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
labels:
  needsHuman: "needs-human"
  rebaseNeeded: "rebase-needed"

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
