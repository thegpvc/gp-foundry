/**
 * The re-review label (`labels.re_review` in foundry.config.yaml): a person asks
 * for a FRESH review and a FRESH verdict on the head as it stands.
 *
 * Everything keys off one moment — when the label was last added. Reviews,
 * verdicts and the sweep's own records from before it do not count:
 *
 *   - the reviewer posts again on the same head (its idempotency looks only past it);
 *   - the approver treats the head as undecided until a verdict newer than it;
 *   - the gate holds its result at "in progress" (never passing, never merging)
 *     until that fresh verdict exists, then removes the label and judges as usual.
 *
 * Pure: the actions fetch the issue's events and hand them in.
 */

export interface LabelEvent {
  event?: string | null;
  label?: { name?: string | null } | null;
  created_at?: string | null;
}

/** When `label` was last added to the issue, as an ISO time; undefined if never. */
export function lastLabeledAt(events: LabelEvent[], label: string): string | undefined {
  let at: string | undefined;
  for (const e of events) {
    if (e.event === "labeled" && e.label?.name === label && e.created_at && (!at || e.created_at >= at)) at = e.created_at;
  }
  return at;
}

/** Is a review, verdict or record at `at` fresh enough to count after a re-review request at `since`? */
export function isFresh(at: string | null | undefined, since: string | undefined): boolean {
  return !since || (!!at && at >= since);
}
