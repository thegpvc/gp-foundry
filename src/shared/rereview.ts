/**
 * The re-review label (`labels.re_review` in foundry.config.yaml): a person asks
 * for a FRESH review and a FRESH verdict on the head as it stands.
 *
 * Everything keys off one moment — when the label was added. Reviews, verdicts
 * and the sweep's own records from before it do not count:
 *
 *   - the reviewer posts again on the same head (its idempotency looks only past it);
 *   - the approver treats the head as undecided until a verdict newer than it;
 *   - the gate holds its result at "in progress" (never passing, never merging)
 *     until that fresh verdict exists, then removes the label and judges as usual.
 *
 * One rule, used by every component (the bash/jq copies in post-review.ts and
 * prejob.ts say the same):
 *
 *   - the request time is the label's last `labeled` event, and only while that
 *     is the label's latest event — removed by hand, there is no request;
 *   - "fresh" is strictly after it. GitHub's timestamps are whole seconds in UTC
 *     ("…:SSZ"), so they compare as strings; a record from the label's own second
 *     is not fresh (a real review takes far longer than that);
 *   - a request that cannot be dated (the label is on, but its latest event is not
 *     a labeled one) is answered by no verdict: the gate holds and says to re-add
 *     the label — usually a moment's lag in the events API, cleared on the next run.
 *
 * What a component does when the label history cannot be READ is its own,
 * fail-safe choice (the gate holds, the sweep waits a tick, the post step posts).
 *
 * Pure: the actions fetch the issue's events and hand them in.
 */

export interface LabelEvent {
  event?: string | null;
  label?: { name?: string | null } | null;
  created_at?: string | null;
}

/** When the re-review was requested: `label`'s last `labeled` event, if it is still on. */
export function requestedAt(events: LabelEvent[], label: string): string | undefined {
  let last: LabelEvent | undefined;
  for (const e of events) {
    if ((e.event === "labeled" || e.event === "unlabeled") && e.label?.name === label && e.created_at) {
      if (!last || e.created_at >= last.created_at!) last = e;
    }
  }
  return last?.event === "labeled" ? last.created_at! : undefined;
}

/** Is a record at `at` fresh after a re-review request at `since`? (No request: always.) */
export function isFresh(at: string | null | undefined, since: string | undefined): boolean {
  return !since || (!!at && at > since);
}

/**
 * The same rule as requestedAt, as a jq program over an issue-events page array
 * (gh --paginate --jq runs once per page, so the caller takes the latest line).
 * Prints "<created_at> <labeled|unlabeled>" for the label's events.
 */
export const LABEL_EVENTS_JQ = `.[] | select((.event == "labeled" or .event == "unlabeled") and .label.name == env.REREVIEW_LABEL) | "\\(.created_at) \\(.event)"`;
