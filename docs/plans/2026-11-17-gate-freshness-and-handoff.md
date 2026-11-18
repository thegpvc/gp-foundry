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

### Design (revised 2026-11-17, after review of the first version)

1. **A targeted run per PR on the events above** — reviews (the approver's verdict
   included), labels, review requests, new commits, ready for review — evaluating that
   one PR. One concurrency slot per PR, newest wins. Fork and Dependabot-triggered events,
   closed PRs and labels the harness applied itself do nothing. This is what gets a
   verdicted head its result: within seconds of the verdict, not a tick later.
2. **No result without a verdict.** A head the approver has not decided gets no check.
   GitHub counts `success`, `neutral` and `skipped` as passing a required status check,
   so the earlier "awaiting the approver" neutral would let an undecided PR through one;
   a missing required check blocks. A dismissed verdict sends the head's result back to
   in progress. (`no_verdict_conclusion: neutral` on the older evaluate mode is left as
   it is, with a runtime warning.)
3. **Candidates come from one search: open PRs the bot has reviewed.** A verdict is a
   review by the bot, so nothing else can have a result. One GraphQL search returns the
   head SHA, author and labels too. In a busy repo this cuts ~800 open PRs to the ~80 the
   bot has reviewed. Dependabot's PRs are searched too when the policy runs that lane.
   The approver's select job uses the same search when it has `requires_review=true`, and
   takes candidates **round-robin by author** (each author's newest PR first, the
   longest-waiting author first in each round), so one author's flood cannot take every
   slot.
4. **A rotating window of 20 per tick** for the gate's pass, advanced once per schedule
   period from the clock (a run counter would also be advanced by event runs): every
   candidate within ⌈candidates ÷ 20⌉ regular ticks, no stored state, nothing extra read
   to order it. Stops within a time budget derived from the job's timeout.
5. **Search failure is a quiet tick.** A failed or truncated (over 1,000 results) search
   evaluates nothing and says so; it does not fall back to walking every open PR.
   Verdicts still arrive through the review event.

The first version ordered the pass by "least recently evaluated", which needed a read
per open PR and a timestamp written into every result, and published a neutral result on
every in-scope PR. Both are gone.

### Measured (stub API)

A repo with 800 open PRs, 83 reviewed by the bot: one search page, then 20 evaluations —
111 API calls per tick (~1,330 an hour at a 5-minute cron), 7 per targeted run. A
verdicted head gets its result from the review event; one whose CI finishes later is
reached by the pass within ⌈84 ÷ 20⌉ ticks. Every reviewed head is reached within
⌈83 ÷ 20⌉ ticks from any starting point, interrupted ticks included.

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
  person with a trusted association (by default write access: OWNER, MEMBER,
  COLLABORATOR), or another bot. The pipeline already declined; its own approval cannot clear
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
