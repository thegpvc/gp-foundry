# Gate freshness and human sign-off on a handoff

**Date:** 2026-11-17 · **Status:** Built; awaiting release · Follows [Hybrid pipeline (0.3.0)](./2026-11-16-hybrid-pipeline.md).

Two follow-ups to the single gate (`merge=`). Both ship in the next release together with
the guard fix already on `main` (0.3.2: the reviewer guard mints its App token only for a
PR in scope). Nothing is released until both are resolved.

---

## A. A timely gate evaluation for every ready head

### Problem

The gate runs only on its schedule. Each tick it lists open PRs oldest first and fully
evaluates every PR in scope, in order. A large backlog means a head near the tail waits for
every PR ahead of it; a tick that is cancelled or times out starts again from the oldest
PR, so the tail can be starved indefinitely. A hold cleared without a push (a label
removed, a thread resolved, a reviewer un-requested) is only seen when the pass reaches
that PR. The approver's sweep has the same shape.

The gate already supports evaluating a single PR by number (`pr-number`).

### What GitHub delivers, verified against the Actions documentation

| Change | Event a workflow can receive | Notes |
| --- | --- | --- |
| A review submitted or dismissed | `pull_request_review` (`submitted`, `dismissed`) | A review posted with the App token triggers it; one posted with `GITHUB_TOKEN` does not. |
| A label added or removed | `pull_request` (`labeled`, `unlabeled`) | Labels the gate itself applies with `GITHUB_TOKEN` trigger nothing — no loop. |
| A reviewer requested or un-requested | `pull_request` (`review_requested`, `review_request_removed`) | |
| A new commit | `pull_request` (`synchronize`) | |
| Marked ready | `pull_request` (`ready_for_review`) | |
| CI built on GitHub Actions finishes | `workflow_run` (`completed`) only | `check_run` / `check_suite` do **not** fire for suites created by GitHub Actions. `workflow_run` must name the workflows; runs on the default branch with secrets. |
| CI from an external app finishes | `check_suite` (`completed`) | Fires for the harness App's own suite too — must exclude it, or the gate's own check retriggers the gate. |
| A review thread resolved | none | `pull_request_review_thread` is not a workflow trigger. Left to the scheduled pass. |

Runs triggered by a Dependabot or fork PR get no secrets and a read-only token. A targeted
run there could neither mint the App token nor write a check, so those PRs are left to the
scheduled pass (which runs on the default branch with secrets).

### Design

1. **A targeted run per PR on the events above** — reviews, labels, review requests, new
   commits, ready for review — evaluating that one PR by number. One
   concurrency slot per PR, newest wins (`cancel-in-progress: true`): a burst of events
   collapses to one evaluation of the latest state. Skipped quietly for a Dependabot or
   fork PR, the same pattern as the guard fix.
2. **A bounded scheduled pass that makes progress across ticks**, with no stored state. It
   orders the PRs in scope least recently evaluated first — a head with no gate result yet
   (new, or its evaluation failed) before all others, then by the read time its result
   records — and evaluates at most 20 per tick (built in, no setting), stopping early
   within a time budget the compiler derives from the job's timeout. An interrupted pass
   leaves the heads it missed first in line for the next. An interrupted pass leaves the unvisited heads oldest, so the next tick
   starts there. This is the backstop for everything the events miss: CI finishing, thread resolution,
   Dependabot and fork PRs, a missed delivery, a failed read.
3. **No stale result ever replaces a fresher one.** Each published result records, in a
   hidden marker, when the facts behind it were read, and is re-stamped even when the
   result is unchanged, so it always records the latest read. A run whose read is older
   than the one already published writes nothing and does not merge. A new commit cannot
   inherit a result: results are per commit, and the merge pins the SHA it evaluated.
4. **Per-head decisions and merge policy are unchanged.** Only when and in what order the
   gate evaluates changes.

### Decided (2026-11-17)

- **No trigger for CI finishing.** `workflow_run` would need the CI workflows listed by
  name, one more list to keep in step with the repo. CI finishing is picked up by the
  scheduled pass; since that pass now visits the least recently evaluated heads first, a
  head whose CI just finished waits at most until its turn, not for a full pass over the
  backlog. External (non-Actions) CI is not special-cased either: no `check_suite`
  trigger, so no risk of the gate's own check retriggering the gate.
- **The scheduled pass evaluates a fixed, built-in number of PRs per tick**, with no
  setting, and stops early before the job's timeout. API use per tick stays bounded; a
  larger backlog takes several ticks, least recently evaluated first.

### Verification

A synthetic backlog larger than one tick's budget, against a stub API: interrupt the first
pass; add a ready head near the tail; clear a hold on an older head without a push. Both
must receive current results within a stated number of ticks; a failed read is retried; a
duplicate event or a superseded SHA never produces a stale approval. Report API calls per
tick and ticks to a published decision.

---

### Measured (synthetic backlog, stub API)

51 PRs in scope, 20 per tick. The first tick is cut short by its time budget after 9
evaluations; then a ready head is added at the tail and a hold is cleared on an older
head without a push. Both have current results by the third tick after the change
(within ⌈51 ÷ 20⌉ + 1 = 4). A full tick makes 192 API calls (1 listing, 51 reads to order
the pass, ~7 per evaluation); a targeted run makes 8. With an event (a review, a label
change), the result is published by that one targeted run, not a later tick.

Not covered by an event, so left to the pass: CI finishing, a thread resolved, and any
PR whose events come from a fork or Dependabot.

## B. Recognizing a person's sign-off on a policy handoff

### Problem

Some changes need a person: the policy says the bot must not approve them on its own —
a protected path, a change over the size limit. The gate reports that. When a person then
formally approves the PR on GitHub, the gate's check does not notice: it keeps saying a
person needs to decide. If that check is required by branch protection, the PR cannot be
merged without someone bypassing it.

### Decided (2026-11-17)

- **Which changes need a person is the gate's policy, not the agent's wording.** A new,
  opt-in policy key names the clauses that are handoffs:

  ```yaml
  handoff_clauses: [protected-path, too-large]
  ```

  Only these two clauses can be listed. A trusted `ESCALATE` verdict from the agent always
  means a judgment call, and an escalation label always means an explicit hold: neither is
  ever cleared by a sign-off. An approver role that escalated for policy reasons should
  now approve on the merits and leave the policy to the gate.
- **What a handoff looks like on the check.** When the only clauses failing on a head are
  handoff clauses, the check is `action_required` — "a person decides: protected path" —
  instead of `failure`.
- **Who can sign off.** A formal `APPROVED` review on the **exact head commit**, standing
  (that reviewer's latest decisive review: not dismissed, not followed by their own
  request for changes), from any account **other than the harness's own identity** — a
  person, or another bot. The pipeline already declined; its own approval cannot clear
  its own handoff. (GitHub already prevents an author approving their own PR.)
- **GitHub's own review decision must agree.** The PR's `reviewDecision` must be
  `APPROVED`, or empty when the branch requires no reviews. That is how branch protection,
  the required approval count and code owners are respected without the gate
  re-implementing them. If it cannot be read, the handoff stays outstanding.
- **What clearing does.** Only the handoff clauses are cleared. The check then reports
  whatever else the policy says: `success` if nothing else fails, otherwise the other
  failure — CI, open threads, review requests, change requests, holds. It names who
  signed off and on which commit, and keeps the agent's verdict visible.
- **What clearing never does.** It is the check only. The gate does not merge on a
  sign-off (`merge="agent-only"` still treats a handoff clause as failing), the pipeline
  posts no approval of its own, and the agent's verdict is not changed.
- Policies without `handoff_clauses` behave exactly as before.

### Verification

Approval before and after the agent's verdict; a dismissal; a later change request from
the same reviewer and from someone else; a new head; an approval from the harness's own
identity; another bot's approval; GitHub's review decision not met or unreadable; an agent
`ESCALATE`; an escalation label; a handoff with an independent blocker (CI red). Each
checks both the conclusion and the explanation. Merge decisions are unchanged.
