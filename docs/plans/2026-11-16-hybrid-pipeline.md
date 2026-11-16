# Hybrid pipeline (0.3.0)

**Date:** 2026-11-16 · **Status:** Design settled; not yet built · Supersedes [Native merge, one policy](./2026-11-16-native-merge-and-one-policy.md).

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
   which human PRs the pipeline looks at. Every lane and the gate use it; there are no
   per-lane overrides. Its end state is "every PR", so it is cheap to widen and easy to
   delete:

   ```yaml
   rollout:
     authors: [alice, bob]        # human PRs by these people are reviewed
     opt_in_label: agent-review   # ...or any PR carrying this label
     skip_label: no-agent-review  # never these
   ```

   - **No `rollout` block means every PR is in scope.** Finishing the rollout is deleting it.
   - **Agent-written PRs are always in scope**, whatever the dial says: the pipeline made
     them. What it does with its own work is governed elsewhere — by which issues are
     labelled for the builder, and by the gate's `merge=`.
   - **Drafts and other bots' PRs are always skipped**, with no setting. A bot's PR is
     reviewed only if that bot is named in `authors`. (The merge gate's existing dependabot
     lane is separate, opt-in in the policy file, and unchanged.)
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

A hybrid graph then carries no scope attributes at all:

```dot
reviewer [type=pr-review, role="agents/roles/reviewer.md", context="pr-diff"]
approver [type=pr-review, role="agents/roles/approver.md", select="sweep", schedule="*/10 * * * *"]
gate     [type=merge-gate, policy="agents/policy/merge.yaml", schedule="*/10 * * * *", merge="off"]
```

## Releases and refs

Consumers are typically **vendored**: `up` copies the actions and rebuilds the workflows
together, so the two cannot drift. Compatibility is therefore a property of the compiler's
output.

For pinned harnesses, the same property is restored by tagging:

- Every release gets an exact git tag (`v0.3.0`). None has been cut since 0.1.2.
- The compiler writes that exact tag into pinned workflows when the config names no ref,
  instead of `@v1`. A pinned harness then upgrades its actions only when it rebuilds, which
  is also when its workflows are regenerated to match.
- `doctor` warns when a harness is still on `v1`.
- The `v1` tag itself is left where it is (0.1.2). Moving it would put today's actions
  under workflows compiled months ago.

## Shipping

One release, 0.3.0, built on `release/0.3.0` across several reviewable PRs into that
branch. `main` stays at 0.2.16 and publishable until 0.3.0 is complete; there are no
further 0.2.x releases. Fixes that arrive meanwhile are folded into the branch.

## Open

1. A regression check for the compatibility rule: compile real consumer harnesses with
   0.2.16 and with 0.3.0 and compare the output.
2. The gate's check can still be published by any workflow in the repo. Unchanged from
   0.2.15, and less pressing while a person is the last step on human PRs.
3. Whether a human may opt a PR in to the fixer. Not built until asked for; if built, the
   PR stays human-written and human-merged.

## Build order

Each step is its own PR into `release/0.3.0`, and each leaves the branch releasable.

1. **The policy function.** Scope, agent-written and result as one tested function in the
   merge-gate action, with the `rollout` config block. No workflow changes yet.
2. **One gate.** `merge="off" | "agent-only"`; `mode=` becomes an alias; the gate publishes
   the check in both settings and merges through the policy function.
3. **Lanes read or write.** The guard and the sweep call the policy function; the fixer
   and the merge are limited to agent-written PRs when a harness opts in; per-node
   `authors=`, `opt_in_label=` and `skip=` become aliases for the rollout block.
4. **Refs.** Exact tags, the compiler's pinned default, the `doctor` warning.
5. **Compatibility pass.** The regression check above, `init` writing `merge="off"`,
   docs, the starter example.
