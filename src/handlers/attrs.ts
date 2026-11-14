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
}

/**
 * `gates="ci.yml, lint / eslint, e2e (chromium)?90"`. An entry that names a
 * workflow file waits on that workflow's runs; any other entry is a check-run
 * name. A trailing `?N` is the grace, in seconds, for a target that may never
 * appear on this head (a path-filtered or conditional check).
 */
export function parseGates(node: HarnessNode): GateSpec[] {
  const raw = node.attrs.gates;
  if (raw === undefined) return [];
  if (typeof raw !== "string") {
    throw new Error(`node '${node.id}': gates= must be a string like "ci.yml" or "lint?90"`);
  }
  const out: GateSpec[] = [];
  for (const entry of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^(.*?)(?:\?([^?]*))?$/.exec(entry)!;
    const name = m[1]!.trim();
    const grace = m[2];
    if (!name) {
      throw new Error(`node '${node.id}': gates= entry '${entry}' names no workflow or check`);
    }
    const spec: GateSpec = { name, kind: /\.ya?ml$/i.test(name) ? "workflow" : "check" };
    if (grace !== undefined) {
      if (!/^[1-9]\d*$/.test(grace.trim())) {
        throw new Error(
          `node '${node.id}': gates= entry '${entry}' has a bad grace suffix — expected '?<seconds>' with a whole number >= 1, e.g. "${name}?90"`,
        );
      }
      spec.graceSeconds = Number(grace.trim());
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

/** The node types an author allowlist can bind: lanes handed one pull request. */
export function takesAuthors(node: HarnessNode): boolean {
  return node.type === "pr-fix" || ((node.type === "pr-review" || node.type === "analyst") && hasPrContext(node));
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

/** `github.event.pull_request.user.login == 'a' || … ` — GitHub compares strings case-insensitively. */
export function authorClause(authors: string[]): string {
  const terms = authors.map((a) => `github.event.pull_request.user.login == '${a}'`);
  return terms.length === 1 ? terms[0]! : `(${terms.join(" || ")})`;
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
