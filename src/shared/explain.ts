/**
 * explain_on= (#52): the reasons a sweep gives for a head it is not deciding,
 * shown as the gate's check title. Shared by the compiler (the select job) and
 * the merge gate, so each recognizes the other's titles.
 */

/** A head whose checks are still running — the sweep's reason, and the gate's once the verdict is in. */
export const WAITING_ON_CI = "Waiting: checks still running";

/** A check title's length limit, applied by both sides so the explain job's comparison holds. */
export const WAITING_TITLE_MAX = 120;
