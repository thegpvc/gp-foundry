# Hybrid pipeline (0.3.0)

**Date:** 2026-11-16 · **Status:** In design — decisions below are settled, open items are
not · Supersedes [Native merge, one policy](./2026-11-16-native-merge-and-one-policy.md).

## What changed from the earlier plan

That plan made GitHub's native auto-merge and branch protection the foundation. We cannot
depend on either being available in a consumer repo, so gp-foundry's own gate stays the
thing that merges. Native merge may return later as an optional mode. The second half of
that plan — one policy, one implementation — carries over unchanged.

## The model

Humans and agents work in the same repo. Every pull request is one of two kinds, and every
lane is one of two kinds.

**A PR is agent-written** when it was opened by `identity.bot_login` **and** every commit
on its head is authored by the bot. Anything else is human-written. One human commit on an
agent branch makes the PR human-written. (Commit authorship can be forged by anyone with
push access; this is a guardrail against accidents, not a security boundary.)

**A lane either reads or writes.** Reading lanes (reviewer, approver, the gate's check)
run on any PR in scope. Writing lanes (fixer, the gate's merge) run only on agent-written
PRs. No lane pushes to a human's PR by default.

The branch prefix stops being what separates the two populations. It remains a naming
convention for agent branches; nothing's safety rests on it in a harness that opts in.

## Decisions

1. **Verdicts drive everything.** `APPROVE` on an agent-written PR merges it, when CI is
   green and the policy limits pass. `ESCALATE` hands it to a person. `REQUEST_CHANGES`
   sends it to the fixer. On a human-written PR the same verdicts are advice and a person
   merges.
2. **One gate.** Each tick, for every PR in scope: compute the result (ready, not ready
   with a reason, escalated), publish it as the check on the PR, and — if the gate is set
   to merge — merge a PR that is ready and agent-written. The check a person reads is the
   decision that merges an agent's PR.
3. **`merge=` on the gate**: `"off"` publishes the check and never merges; `"agent-only"`
   also merges ready agent-written PRs. An enumeration, so a later value can be added
   without changing these two.
4. **Scope is a rollout dial, not access control.** One repo-wide block in the config says
   which PRs the pipeline looks at (these authors, or an opt-in label; minus drafts, bots
   and a skip label). Every lane and the gate use it. Its end state is "every PR", so it is
   cheap to widen, easy to delete, and has no per-lane overrides.
5. **One implementation.** "Is this PR in scope", "is it agent-written" and "what is the
   result" are one tested TypeScript function, called by the guard, the sweep and the gate.
   Generated workflows stop carrying that logic in shell.

## Compatibility

gp-foundry runs in several repos. The rule for 0.3.0:

> An existing `harness.dot` and config, unchanged, compiles to workflows that behave as
> they did under 0.2.16. New behaviour appears only when a harness opts in.

- A gate with **no `merge=`** merges, by the branch-prefix test, exactly as today. The
  validator notes that the attribute should be made explicit; it is not an error.
- `gp-foundry init` writes **`merge="off"`** into new harnesses: a new setup starts with
  merging off and turns it on as a deliberate step.
- Only an explicit `merge="agent-only"` uses the agent-written test.
- `mode="evaluate"` and `mode="merge"`, and the per-node `authors=`, `opt_in_label=` and
  `skip=`, keep working as aliases with a deprecation note. They are not removed in 0.3.0.

## Shipping

One release, 0.3.0, built on `release/0.3.0` across several reviewable PRs into that
branch. `main` stays at 0.2.16 and publishable until 0.3.0 is complete; there are no
further 0.2.x feature releases.

## Open

1. How each existing consumer takes updates (vendored via `up`, or pinned to a ref), and
   whether the `v1` tag — still pointing at 0.1.2 — should move. Pinned consumers on the
   default ref are running July's actions.
2. A regression check for the compatibility rule: compile real consumer harnesses with
   0.2.16 and with 0.3.0 and compare the output.
3. Names: the config key for the rollout scope, and whether "agent-only" is the final
   spelling.
4. The gate's check can still be published by any workflow in the repo. Unchanged from
   0.2.15, and less pressing while a person is the last step on human PRs.
5. Whether a human may opt a PR in to the fixer. Not built until asked for; if built, the
   PR stays human-written and human-merged.
