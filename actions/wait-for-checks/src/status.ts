/**
 * Pure decision logic for wait-for-checks (C9).
 *
 * Given the raw check-runs / workflow-runs returned by the GitHub API for a
 * single head SHA, decide whether we are done waiting and, if so, with what
 * conclusion. This module is deliberately free of any I/O or GitHub SDK
 * dependency so it can be unit-tested in isolation.
 */

/**
 * The terminal decision emitted as the action's `conclusion` output.
 *
 * `pending` is NOT terminal — it signals the poll loop to sleep and retry.
 * `timeout` is produced by the loop (not this module) when the deadline passes.
 */
export type Conclusion =
  | "success"
  | "failure"
  | "cancelled"
  | "skipped"
  | "timed_out"
  | "action_required"
  | "neutral"
  | "stale"
  | "startup_failure"
  | "not_found"
  | "pending"
  | "timeout";

/**
 * The subset of a GitHub check-run / workflow-run we care about. Both the
 * "check-runs" API (`.check_runs[]`) and the "workflow runs" API
 * (`.workflow_runs[]`) expose a `status` and a nullable `conclusion`, so a
 * single shape covers either source.
 */
export interface CheckRunLike {
  /** queued | in_progress | completed | waiting | pending | requested | … */
  status?: string | null;
  /** success | failure | cancelled | skipped | … ; null until completed. */
  conclusion?: string | null;
}

/** Status values that mean "still running — keep polling". */
const IN_FLIGHT_STATUSES = new Set([
  "queued",
  "in_progress",
  "waiting",
  "pending",
  "requested",
]);

/**
 * Rank of terminal conclusions when aggregating multiple runs. A lower number
 * "wins" (is reported) when several runs have completed. Failures dominate so a
 * single failed check fails the gate even if others passed.
 */
const CONCLUSION_SEVERITY: Record<string, number> = {
  failure: 0,
  timed_out: 1,
  startup_failure: 1,
  action_required: 2,
  cancelled: 3,
  stale: 4,
  neutral: 5,
  skipped: 6,
  success: 7,
};

/**
 * Reduce a single run's raw (status, conclusion) pair to a {@link Conclusion}.
 *
 * - A run reporting an in-flight status (or no status at all) → `pending`.
 * - A completed run surfaces its `conclusion` (defaulting to `neutral` if the
 *   API somehow reports completed with a null conclusion).
 * - Any unrecognised status is treated conservatively as `pending` so we wait
 *   rather than declare a false result.
 */
export function classifyRun(run: CheckRunLike): Conclusion {
  const status = (run.status ?? "").toLowerCase();
  const conclusion = (run.conclusion ?? "").toLowerCase();

  // A non-null conclusion is authoritative regardless of status.
  if (conclusion) {
    return (conclusion as Conclusion) ?? "neutral";
  }

  if (status === "completed") {
    // Completed but no conclusion reported — treat as neutral (non-blocking).
    return "neutral";
  }

  if (IN_FLIGHT_STATUSES.has(status) || status === "") {
    return "pending";
  }

  // Unknown/unexpected status: keep waiting rather than guess.
  return "pending";
}

/**
 * Aggregate a list of check-runs (all for the same SHA/workflow) into a single
 * status decision.
 *
 * Semantics:
 * - Empty list → `not_found` (nothing has been reported yet). The poll loop
 *   treats `not_found` as non-terminal and keeps waiting until timeout.
 * - If ANY run is still `pending`, the aggregate is `pending` (we wait for the
 *   whole set to settle before concluding).
 * - Once all runs are terminal, the most severe conclusion is returned
 *   (failure-dominant — see {@link CONCLUSION_SEVERITY}).
 */
export function aggregate(runs: CheckRunLike[]): Conclusion {
  if (!runs || runs.length === 0) {
    return "not_found";
  }

  const classified = runs.map(classifyRun);

  if (classified.some((c) => c === "pending")) {
    return "pending";
  }

  let winner: Conclusion = classified[0]!;
  let best = severityOf(winner);
  for (const c of classified.slice(1)) {
    const s = severityOf(c);
    if (s < best) {
      best = s;
      winner = c;
    }
  }
  return winner;
}

function severityOf(c: Conclusion): number {
  const s = CONCLUSION_SEVERITY[c];
  return s === undefined ? 5 : s; // unknown terminal → mid severity (neutral-ish)
}

/**
 * Whether a {@link Conclusion} is terminal — i.e. the poll loop should stop and
 * report it. `pending` and `not_found` are the only non-terminal values (the
 * loop keeps waiting until either they settle or the deadline forces `timeout`).
 */
export function isTerminal(c: Conclusion): boolean {
  return c !== "pending" && c !== "not_found";
}

/**
 * Whether a terminal conclusion should be considered a "pass" by a consumer
 * that only wants a boolean gate. `success` and `skipped`/`neutral` pass;
 * everything else (including `timeout`, `not_found`) does not.
 */
export function isPassing(c: Conclusion): boolean {
  return c === "success" || c === "skipped" || c === "neutral";
}
