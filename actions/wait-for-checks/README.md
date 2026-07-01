# wait-for-checks (C9)

A JavaScript GitHub Action that polls a named CI **workflow** (by file name) or a
named **check-run** for a given head SHA until it reaches a terminal conclusion
or a timeout is hit. It emits a single `conclusion` output that downstream jobs
gate on.

This generalizes the "Wait for CI" step in gp-dixie's `agent-review` workflow:
the workflow file, poll count, and interval are no longer hardcoded — they are
inputs.

## Usage

```yaml
- name: Wait for CI
  id: ci-gate
  uses: <owner>/<repo>/actions/wait-for-checks@<ref>
  with:
    sha: ${{ github.event.pull_request.head.sha }}
    token: ${{ steps.app-token.outputs.token }}
    workflow-name: ci.yml
    timeout-seconds: "900"
    poll-interval: "20"

- name: Review PR
  if: steps.ci-gate.outputs.conclusion == 'success'
  run: ./review.sh
```

Wait on a specific check-run instead of a whole workflow:

```yaml
- uses: <owner>/<repo>/actions/wait-for-checks@<ref>
  with:
    sha: ${{ github.event.pull_request.head.sha }}
    token: ${{ secrets.GITHUB_TOKEN }}
    check-name: "build"
```

## Inputs

| Input             | Required | Default | Description |
| ----------------- | -------- | ------- | ----------- |
| `sha`             | yes      | —       | Head commit SHA to wait on. |
| `token`           | yes      | —       | Token used to query the checks/actions API. |
| `workflow-name`   | one of   | `""`    | Workflow **file name** (e.g. `ci.yml`). |
| `check-name`      | one of   | `""`    | Check-run name. |
| `timeout-seconds` | no       | `900`   | Max wait before returning `timeout`. |
| `poll-interval`   | no       | `20`    | Seconds between polls. |
| `owner`           | no       | current | Repo owner override. |
| `repo`            | no       | current | Repo name override. |

Provide **exactly one** of `workflow-name` / `check-name`; the action fails fast
if neither is set.

## Output

| Output       | Description |
| ------------ | ----------- |
| `conclusion` | `success` \| `failure` \| `cancelled` \| `skipped` \| `timed_out` \| `neutral` \| `not_found` \| `timeout` |

`timeout` is emitted when the deadline passes before any terminal result. Note
the action itself does **not** fail on `failure`/`timeout` — it reports the
status and lets the calling job decide (mirroring the dixie gate, which skips the
review rather than erroring).

## Decision logic

The pass/fail decision is a pure function in [`src/status.ts`](./src/status.ts),
unit-tested in [`src/status.test.ts`](./src/status.test.ts):

- **Empty run list** → `not_found` (non-terminal; keep waiting until timeout).
- **Any run still in-flight** (`queued` / `in_progress` / `waiting` / `pending`
  / `requested`, or unknown status) → `pending` (keep waiting).
- **All runs terminal** → the most **severe** conclusion wins, so a single
  failing check fails the gate (`failure` > `timed_out` > `action_required` >
  `cancelled` > `stale` > `neutral` > `skipped` > `success`).

Because `pending` and `not_found` are the only non-terminal values, the poll
loop only stops early on a real result; otherwise it runs until `timeout`.

## Build

Authored in TypeScript at `src/index.ts`; bundled to `dist/index.js` by the
repo-level `build:actions` script (do not edit `dist/` by hand).

## Test

```bash
npm test -- actions/wait-for-checks
```
