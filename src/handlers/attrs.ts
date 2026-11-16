/**
 * Parsers for the structured node attributes (`gates=`, `skip=`, `select=`,
 * `checkout=`). Shared by the handlers, the wiring and validate(), so the three
 * cannot disagree about what a value means. Each parser throws on a malformed
 * value; validate() turns that into an error diagnostic, and the emitters catch
 * it and fall back to "attribute absent" so assemble stays non-throwing.
 */
import type { FoundryConfig, HarnessNode } from "../ir/types.js";

// ── the attribute vocabulary ─────────────────────────────────────────────────

/**
 * Every attribute a node statement may carry. An attribute outside this set is
 * an ERROR, not a no-op: the parser stores whatever it is given, so a misspelt
 * or not-yet-supported attribute used to compile cleanly and do nothing — and
 * when the attribute was a restriction (`authors=`, `skip=`), "nothing" meant
 * the lane ran on exactly the pull requests it was told to stay away from.
 */
export const KNOWN_NODE_ATTRS: ReadonlySet<string> = new Set([
  "type", "role", "prompt", "policy", "tools", "context", "name", "output",
  "gates", "skip", "select", "authors", "max_attempts", "agent_attempts",
  "schedule", "timeout", "environment", "paths", "commit", "secrets",
  "permissions", "on_complete_label", "cancel_in_progress", "checkout",
  "title", "harness_ref", "persist_credentials", "repo_guides", "opt_in_label",
  "mode", "check_name",
]);

/** Every attribute an edge may carry. */
export const KNOWN_EDGE_ATTRS: ReadonlySet<string> = new Set(["on", "when", "do"]);

/** The closest known name within two edits, for a "did you mean" hint. */
export function nearestAttr(name: string, known: ReadonlySet<string>): string | undefined {
  const distance = (a: string, b: string): number => {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let prev = row[0]!;
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const tmp = row[j]!;
        row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = tmp;
      }
    }
    return row[b.length]!;
  };
  let best: string | undefined;
  let bestD = 3;
  for (const k of known) {
    const d = distance(name.toLowerCase(), k);
    if (d < bestD) [best, bestD] = [k, d];
  }
  return best;
}

// ── gates= ───────────────────────────────────────────────────────────────────

export interface GateSpec {
  /** The workflow file name or the check-run name, without any `?N` suffix. */
  name: string;
  /** A `.yml`/`.yaml` entry waits on a workflow; anything else on a check-run. */
  kind: "workflow" | "check";
  /** `?N` — seconds to wait for the target to APPEAR before concluding `skipped`. */
  graceSeconds?: number;
  /** `?info` — advisory: its result is shown to the reviewer but is never, by itself, blocking. */
  info?: boolean;
}

/**
 * `gates="ci.yml, lint / eslint, e2e (chromium)?90, bugbot?info?30"`. An entry
 * that names a workflow file waits on that workflow's runs; any other entry is a
 * check-run name. Options follow the name, each introduced by `?`:
 *   `?N`     the grace, in seconds, for a target that may never appear on this
 *            head (a path-filtered or conditional check);
 *   `?info`  the gate is advisory — a review bot, say — so a result other than
 *            `success` is context for the reviewer, not a blocking finding.
 */
export function parseGates(node: HarnessNode): GateSpec[] {
  const raw = node.attrs.gates;
  if (raw === undefined) return [];
  if (typeof raw !== "string") {
    throw new Error(`node '${node.id}': gates= must be a string like "ci.yml" or "lint?90"`);
  }
  const out: GateSpec[] = [];
  for (const entry of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [rawName, ...options] = entry.split("?");
    const name = rawName!.trim();
    if (!name) {
      throw new Error(`node '${node.id}': gates= entry '${entry}' names no workflow or check`);
    }
    const spec: GateSpec = { name, kind: /\.ya?ml$/i.test(name) ? "workflow" : "check" };
    for (const option of options.map((o) => o.trim())) {
      if (option === "info") {
        spec.info = true;
      } else if (/^[1-9]\d*$/.test(option) && spec.graceSeconds === undefined) {
        spec.graceSeconds = Number(option);
      } else {
        throw new Error(
          `node '${node.id}': gates= entry '${entry}' has a bad '?${option}' suffix — expected '?<seconds>' (a whole number >= 1) and/or '?info', e.g. "${name}?90" or "${name}?info"`,
        );
      }
    }
    out.push(spec);
  }
  return out;
}

/** parseGates for emitters: a malformed attr is validate()'s to report. */
export function gatesOf(node: HarnessNode): GateSpec[] {
  try {
    return parseGates(node);
  } catch {
    return [];
  }
}

// ── skip= ────────────────────────────────────────────────────────────────────

export type SkipCondition =
  | { kind: "draft" }
  | { kind: "bot-author" }
  | { kind: "label"; label: string }
  | { kind: "unchanged-diff" };

/** `skip="draft,bot-author,label:no-agent-review,unchanged-diff"`. */
export function parseSkip(node: HarnessNode): SkipCondition[] {
  const raw = node.attrs.skip;
  if (raw === undefined) return [];
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error(`node '${node.id}': skip= must be a non-empty string like "draft,unchanged-diff"`);
  }
  const out: SkipCondition[] = [];
  const seen = new Set<string>();
  for (const entry of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    if (entry === "draft" || entry === "bot-author" || entry === "unchanged-diff") {
      out.push({ kind: entry });
    } else if (entry.startsWith("label:") && entry.slice("label:".length).trim()) {
      out.push({ kind: "label", label: entry.slice("label:".length).trim() });
    } else {
      throw new Error(
        `node '${node.id}': unknown skip= entry '${entry}' — expected draft, bot-author, label:<key> or unchanged-diff`,
      );
    }
  }
  if (!out.length) throw new Error(`node '${node.id}': skip= has no entries`);
  return out;
}

/** parseSkip for emitters: a malformed attr is validate()'s to report. */
export function skipOf(node: HarnessNode): SkipCondition[] {
  try {
    return parseSkip(node);
  } catch {
    return [];
  }
}

// ── authors= ─────────────────────────────────────────────────────────────────

/** A GitHub login (`dpup`, `dependabot[bot]`). Strict: the list is spliced into an `if:` expression. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\[bot\])?$/;

function normalizeAuthors(list: unknown[], where: string): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const login = String(raw).trim();
    if (!login) continue;
    if (!LOGIN.test(login)) throw new Error(`${where}: '${login}' is not a GitHub login`);
    const lower = login.toLowerCase(); // logins are case-insensitive
    if (!out.includes(lower)) out.push(lower);
  }
  if (!out.length) throw new Error(`${where}: names no login — an empty allowlist would match nobody`);
  return out;
}

/**
 * The node types an author allowlist can bind: lanes handed one pull request,
 * and an evaluate-mode merge gate, which picks the PRs it publishes a check on.
 */
export function takesAuthors(node: HarnessNode): boolean {
  return (
    node.type === "pr-fix" ||
    ((node.type === "pr-review" || node.type === "analyst") && hasPrContext(node)) ||
    isEvaluateGate(node)
  );
}

/**
 * The logins whose pull requests this lane may run on — `authors="a, b"` on the
 * node, else `repo.authors` in foundry.config.yaml; undefined when neither is
 * set (no restriction). Lower-cased. Throws on a malformed list.
 */
export function parseAuthors(node: HarnessNode, cfg: FoundryConfig): string[] | undefined {
  const attr = node.attrs.authors;
  if (attr !== undefined) {
    return normalizeAuthors(String(attr).split(","), `node '${node.id}': authors=`);
  }
  return parseConfigAuthors(cfg);
}

/** `repo.authors` alone — what a diamond, which has no single node to ask, is bound by. */
export function parseConfigAuthors(cfg: FoundryConfig): string[] | undefined {
  const list = cfg.repo?.authors;
  if (list === undefined) return undefined;
  if (!Array.isArray(list)) throw new Error("repo.authors must be a list of GitHub logins");
  return normalizeAuthors(list, "repo.authors");
}

/**
 * parseAuthors for emitters. A malformed allowlist is validate()'s to report,
 * but it must not compile to "no restriction": the sentinel matches no login
 * (a login cannot contain a space), so a broken filter admits nobody.
 */
export function authorsOf(node: HarnessNode, cfg: FoundryConfig): string[] | undefined {
  if (!takesAuthors(node)) return undefined;
  try {
    return parseAuthors(node, cfg);
  } catch {
    return [NO_AUTHOR];
  }
}
export const NO_AUTHOR = "no author matches a malformed allowlist";

/**
 * `github.event.pull_request.user.login == 'a' || … ` — GitHub compares strings
 * case-insensitively. With an opt-in label, a PR carrying that label passes too.
 */
export function authorClause(authors: string[], optInLabel?: string): string {
  const terms = authors.map((a) => `github.event.pull_request.user.login == '${a}'`);
  const clause = terms.length === 1 ? terms[0]! : `(${terms.join(" || ")})`;
  if (optInLabel === undefined) return clause;
  return `(${clause} || contains(github.event.pull_request.labels.*.name, ${exprString(optInLabel)}))`;
}

/** A string literal for a GitHub expression: single-quoted, `'` doubled. */
export function exprString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

// ── opt_in_label= ────────────────────────────────────────────────────────────

/**
 * `opt_in_label="<key>"` widens an author allowlist: the lane also runs on a PR
 * that carries this label, whoever opened it. The key resolves through
 * config.labels like `skip="label:<key>"` (identity when unmapped). Returns the
 * resolved label, undefined when absent; throws on a malformed value.
 */
export function parseOptInLabel(node: HarnessNode, cfg: FoundryConfig): string | undefined {
  const raw = node.attrs.opt_in_label;
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error(`node '${node.id}': opt_in_label= must be a label key like "agent_review"`);
  }
  const key = raw.trim();
  return cfg.labels?.[key] ?? key;
}

/**
 * parseOptInLabel for emitters: only where an allowlist is in force (the label
 * widens one; without it the lane already runs for everyone). A malformed value
 * is validate()'s to report and compiles to no widening — the allowlist alone.
 */
export function optInLabelOf(node: HarnessNode, cfg: FoundryConfig): string | undefined {
  if (authorsOf(node, cfg) === undefined) return undefined;
  try {
    return parseOptInLabel(node, cfg);
  } catch {
    return undefined;
  }
}

// ── merge-gate mode= / check_name= ───────────────────────────────────────────

export type MergeGateMode = "merge" | "evaluate";

/**
 * `mode="merge"` (the default) merges or labels; `mode="evaluate"` never does
 * either — it publishes the gate's result as a check run on each PR head.
 * Throws on any other value.
 */
export function parseMergeGateMode(node: HarnessNode): MergeGateMode {
  const raw = node.attrs.mode;
  if (raw === undefined) return "merge";
  if (raw === "merge" || raw === "evaluate") return raw;
  throw new Error(`node '${node.id}': mode= must be "merge" or "evaluate", got ${JSON.stringify(raw)}`);
}

/** A merge-gate node with `mode="evaluate"`. A malformed mode is validate()'s to report and reads as merge. */
export function isEvaluateGate(node: HarnessNode): boolean {
  if (node.type !== "merge-gate") return false;
  try {
    return parseMergeGateMode(node) === "evaluate";
  } catch {
    return false;
  }
}

/** The check run an evaluate gate publishes: `check_name=`, else `gp-foundry/approval (<node>)`. Throws on a malformed value. */
export function parseEvaluateCheckName(node: HarnessNode): string {
  const raw = node.attrs.check_name;
  if (raw === undefined) return `gp-foundry/approval (${node.id})`;
  // Passed to the action as an input and compared against check-run names, so one line of printable text.
  if (typeof raw !== "string" || !raw.trim() || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw new Error(`node '${node.id}': check_name= must be a non-empty, single-line check-run name like "fletch/approval"`);
  }
  return raw.trim();
}

// ── context / select= / checkout= ────────────────────────────────────────────

/** A node whose job is handed a pull request (the context an analyst emits for). */
export function hasPrContext(node: HarnessNode): boolean {
  return node.context === "pr-diff" || node.context === "pr-review";
}

/**
 * `select="sweep"` on a scheduled pr-review: instead of reacting to one PR's
 * event, the lane runs on its cron and picks the PRs to review itself. True only
 * for the fully-formed combination, so a half-configured node (validate() errors
 * on it) compiles exactly as it did before rather than as a broken sweep.
 */
export function isSweep(node: HarnessNode): boolean {
  return (
    node.attrs.select === "sweep" &&
    node.type === "pr-review" &&
    hasPrContext(node) &&
    node.attrs.schedule !== undefined
  );
}

/**
 * A guard job is emitted for an event-driven PR analyst (never a sweep) that
 * has something to guard on: a `skip=` condition or an author allowlist.
 */
export function hasSkipGuard(node: HarnessNode, cfg: FoundryConfig): boolean {
  return (
    (node.type === "pr-review" || node.type === "analyst") &&
    hasPrContext(node) &&
    node.attrs.schedule === undefined &&
    (skipOf(node).length > 0 || authorsOf(node, cfg) !== undefined)
  );
}

/** The job that decides whether (or for which PRs) the node's own job runs. */
export function preJobId(node: HarnessNode): string {
  return isSweep(node) ? `${node.id}_select` : `${node.id}_guard`;
}

/** A sweep lane's matrix job is NAMED per PR, so the mark job can tell which ones succeeded. */
export function sweepJobNamePrefix(node: HarnessNode): string {
  return `${node.id} #`;
}

/** The check-run a sweep publishes for each FAILED attempt on a head; enough of them and it stops retrying. */
export function sweepFailedCheckName(node: HarnessNode): string {
  return `gp-foundry/sweep-failed (${node.id})`;
}

/**
 * The check-run a sweep publishes on a head once its lane has run there — the
 * sweep's own record of "done", independent of anything the agent posts.
 */
export function sweptCheckName(node: HarnessNode): string {
  return `gp-foundry/swept (${node.id})`;
}

/**
 * `<!-- gp-foundry:diff:<node>:` — the prefix of the marker a reviewed diff's
 * hash is stamped into the review with. Node-scoped, so two review lanes that
 * post as the same bot never read each other's stamp.
 */
export function diffMarkerPrefix(node: HarnessNode): string {
  return `<!-- gp-foundry:diff:${node.id}:`;
}

/** The marker every verdict review carries; a sweep reads it as "decided". */
export const VERDICT_MARKER = "**Verdict:**";
