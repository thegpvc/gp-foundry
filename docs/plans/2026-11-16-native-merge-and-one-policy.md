# Native merge, one policy

**Date:** 2026-11-16 · **Status:** Draft for review · Amends §"merge-gate" of the
[system design](./2026-07-01-gp-foundry-system-design.md).

## Problem

Releases 0.2.10–0.2.14 and PR #24 added `authors=`, `opt_in_label=`, `skip=`,
`select="sweep"`, the swept / sweep-failed / sweep-idle check-runs, `requires_review=`,
the also-head marker and `mode="evaluate"`. Each fixed a real problem, and each release
also fixed an interaction created by the one before. Three causes:

1. **Two products, one safety assumption.** The factory (agents write PRs on
   `repo.branch_prefix` branches) and the reviewer (an agent reviews human PRs) share one
   branch prefix. Reviewing human PRs means widening it, which also widens what the fixer
   pushes to and what the merge gate merges.
2. **Each rule has several implementations.** "Is this PR in scope" is a job `if:`, a guard
   script, a sweep selector and merge-gate code. "Is this a verdict" is a workflow
   expression, a jq filter and a regex. The bugs found in review were these disagreeing.
3. **Logic lives in generated shell.** Selection and marking are bash and jq inside YAML,
   testable only by running the compiled script against a stub `gh`.

## Decision

### 1. GitHub merges; gp-foundry publishes one check

- The **producer** enables GitHub's native auto-merge on the PR it opens
  (`gh pr merge --auto`). That is the only place "an agent wrote this" is decided, and the
  producer knows it first-hand.
- Branch protection on the base branch requires CI and **one check**:
  `gp-foundry/approval`. GitHub merges an agent PR when that check is green.
- Nobody enables auto-merge on a human PR, so a human merges it — after the same check.
- `merge-gate` in `mode="merge"` is deprecated: no cron that merges, no merge-time author
  or branch test. `mode="evaluate"` (PR #24) becomes the gate.

"Human PRs are human-merged, agent PRs auto-merge when approved" then needs no rule in
gp-foundry at all: it is a consequence of who enabled auto-merge.

### 2. One policy, one implementation

- Scope and policy move out of DOT attributes into the policy file: `authors`,
  `opt_in_label`, `skip`, the verdict markers, thread and review-request clauses.
- One pure TypeScript function, in the merge-gate action, answers for a PR:
  `{ inScope, reason, verdict, conclusion }`. It already exists in part (`gate.ts`).
- The guard job, the sweep selector and the evaluate check **call it** (a small action,
  not generated shell). The workflow `if:` keeps only the cheap prefilter that avoids
  starting a runner, generated from the same policy.
- DOT keeps topology: nodes, edges, schedules. Attributes that are policy are accepted for
  one release with a deprecation warning, then become `attr.unknown` errors.

### 3. Two presets instead of one widened prefix

`factory` (agents author, `branch_prefix` enforced on every write lane) and `reviewer`
(read-only lanes on any branch, scope from the policy file). A harness may use both; the
prefix then constrains only lanes that push.

## What this removes

The merge-mode sweep, merge-time candidate selection, the bash select/mark scripts and
their three counting check-runs (replaced by state the policy function derives from
reviews and checks it already reads), and roughly ten node attributes.

## What it does not fix

- **The check is forgeable.** Any workflow in the repo, including one added on a same-repo
  PR branch, can publish `gp-foundry/approval` as `github-actions`. Candidate fix: an
  organization ruleset that requires a specific workflow from a pinned ref, which a PR
  branch cannot replace. That needs the gate to run on `pull_request` / `merge_group`
  rather than only on a schedule. **Unverified.**
- **A human can push to an agent PR** and it still auto-merges. If that matters, the policy
  needs "every commit on the head is the bot's", or auto-merge must be disabled on a
  non-bot push.

## Open questions

1. Does the consumer's base branch have protection a required check can be added to, and
   is "Allow auto-merge" enabled on the repo?
2. Are the reviewer and the PR author separate bot identities? If so a native approving
   review may replace the `**Verdict:**` line convention.
3. Is the schedule-driven evaluate gate fast enough as a merge gate (worst case one tick
   after the last check concludes), or must it also run on PR and check events?
4. Auto-merge enabled with `GITHUB_TOKEN` does not trigger downstream workflows on merge.
   Confirm the producer enables it with the harness token.

## Order of work

1. Land the bug fixes from PR #24 on their own (check-run `filter=all`, the visible-body
   verdict rule, the idle cap). Hold evaluate mode, also-head and `requires_review`.
2. Answer the open questions against a real consumer repo.
3. Evaluate mode as the gate, driven by the policy function; producer enables auto-merge.
4. Move guard and sweep selection onto the policy function; deprecate the attributes.
5. Deprecate `mode="merge"`.
