/**
 * The verdict grammar, in one place: the sweep's select and mark jobs, the steps
 * that must never edit a verdict, and the merge gate's approval / rejection /
 * escalation markers all derive from it, so a verdict one of them accepts is a
 * verdict to all of them.
 *
 * A review is a verdict when its LAST non-empty line, trimmed, is exactly
 * `**Verdict:** <WORD>` for one of the configured words. Anything after the word
 * (`**Verdict:** APPROVE (once gates pass)`) makes it not a verdict at all —
 * otherwise a sweep would count the head as decided while the gate never saw an
 * approval, and the head would be stuck.
 *
 * Pure and dependency-free: the merge-gate action bundles it too.
 */

export const VERDICT_PREFIX = "**Verdict:**";

/** The configurable words, in a fixed order: approve, request changes, escalate. */
export const DEFAULT_VERDICT_WORDS: readonly [string, string, string] = ["APPROVE", "REQUEST_CHANGES", "ESCALATE"];

export interface VerdictWords {
  approve: string;
  requestChanges: string;
  escalate: string;
}

const WORD = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * `verdicts: [APPROVE, REQUEST_CHANGES, ESCALATE]` (foundry.config.yaml, or the
 * merge-gate's `verdicts` input as a comma list) — three distinct words, read in
 * that order. Undefined gives the defaults; anything malformed throws.
 */
export function parseVerdictWords(raw: unknown): VerdictWords {
  if (raw === undefined || raw === null || raw === "") {
    const [approve, requestChanges, escalate] = DEFAULT_VERDICT_WORDS;
    return { approve, requestChanges, escalate };
  }
  const list = typeof raw === "string" ? raw.split(",").map((s) => s.trim()) : raw;
  if (!Array.isArray(list) || list.length !== 3) {
    throw new Error("verdicts must list exactly three words: approve, request changes, escalate (e.g. [APPROVE, REQUEST_CHANGES, ESCALATE])");
  }
  const words = list.map((w) => String(w).trim());
  for (const w of words) {
    if (!WORD.test(w)) throw new Error(`verdicts: '${w}' is not a verdict word (letters, digits, _ and -)`);
  }
  if (new Set(words).size !== 3) throw new Error("verdicts: the three words must be distinct");
  return { approve: words[0]!, requestChanges: words[1]!, escalate: words[2]! };
}

/** `**Verdict:** <WORD>` — the exact line. */
export function verdictLine(word: string): string {
  return `${VERDICT_PREFIX} ${word}`;
}

/** The three exact verdict lines, newline-joined: what the sweep's jq compares against. */
export function verdictLinesEnv(words: VerdictWords): string {
  return [words.approve, words.requestChanges, words.escalate].map(verdictLine).join("\n");
}

/**
 * A regex source matching a body whose last non-empty line, trimmed, is exactly
 * this verdict line. Test it against the body with trailing whitespace trimmed.
 */
export function verdictRegexSource(word: string): string {
  const escaped = verdictLine(word).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `(?:^|\\n)[ \\t]*${escaped}[ \\t]*$`;
}

/** Which verdict a body carries on its last non-empty line, if any. */
export function bodyVerdict(body: string | null | undefined, words: VerdictWords): "approve" | "request_changes" | "escalate" | undefined {
  const last = (body ?? "").split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
  if (last === verdictLine(words.approve)) return "approve";
  if (last === verdictLine(words.requestChanges)) return "request_changes";
  if (last === verdictLine(words.escalate)) return "escalate";
  return undefined;
}
