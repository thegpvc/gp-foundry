/**
 * Parsers for the structured node attributes (`gates=`, `skip=`, `select=`,
 * `checkout=`). Shared by the handlers, the wiring and validate(), so the three
 * cannot disagree about what a value means. Each parser throws on a malformed
 * value; validate() turns that into an error diagnostic, and the emitters catch
 * it and fall back to "attribute absent" so assemble stays non-throwing.
 */
import type { FoundryConfig, HarnessEdge, HarnessNode } from "../ir/types.js";
import { parseRollout, type Rollout } from "../shared/scope.js";
import { parseVerdictWords, verdictLine, verdictLinesEnv } from "../shared/verdicts.js";

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
  "title", "harness_ref", "persist_credentials", "repo_guides", "runs_on", "opt_in_label",
  "mode", "merge", "check_name", "requires_review", "post", "post_marker", "quiet_verdicts", "verdict_check", "no_changes_comment", "comment_target", "dispatch",
  "hold_on_review_requests", "explain_on", "bot_schedule", "merge_bots",
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

export type MergeSetting = "off" | "agent-only";

/**
 * `merge=` on a merge-gate: the single gate. It publishes its result as a check
 * on every PR in scope, and
 *   "off"         never merges;
 *   "agent-only"  also merges the PRs the pipeline wrote, when they are ready.
 * An enumeration, so a later value can be added without changing these two.
 * Undefined when the attribute is absent (the gate then runs as it always has:
 * `mode=`, or the original merging gate). Throws on any other value.
 */
export function parseMergeSetting(node: HarnessNode): MergeSetting | undefined {
  const raw = node.attrs.merge;
  if (raw === undefined) return undefined;
  if (raw === "off" || raw === "agent-only") return raw;
  throw new Error(`node '${node.id}': merge= must be "off" or "agent-only", got ${JSON.stringify(raw)}`);
}

/**
 * parseMergeSetting for emitters. A malformed value is validate()'s to report,
 * and must not compile to a gate that merges: it reads as "off".
 */
export function mergeSettingOf(node: HarnessNode): MergeSetting | undefined {
  if (node.type !== "merge-gate" || node.attrs.merge === undefined) return undefined;
  try {
    return parseMergeSetting(node);
  } catch {
    return "off";
  }
}

/** Does this gate publish a check? An evaluate gate, or any gate with `merge=`. */
export function publishesCheck(node: HarnessNode): boolean {
  return isEvaluateGate(node) || mergeSettingOf(node) !== undefined;
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
 * `requires_review=true` on a sweep: a head is a candidate only once a review by
 * the bot covers it (on the head, or marked `also-head` for it) — for a lane that
 * acts on an upstream review, so it does not spend a run on heads still waiting.
 */
export function sweepRequiresReview(node: HarnessNode): boolean {
  return isSweep(node) && node.attrs.requires_review === true;
}

/**
 * Does the sweep pass over a head while a review request is pending? Yes by
 * default; `hold_on_review_requests=false` lets it decide anyway (many requests
 * are FYIs — the role's context still lists them). The gate's own clause is
 * the policy's `require_no_review_requests`.
 */
export function sweepHoldsOnReviewRequests(node: HarnessNode): boolean {
  return node.attrs.hold_on_review_requests !== false;
}

/** The also-head marker for any node, as a regex prefix: a sweep does not know which lane wrote it. */
export const ALSO_HEAD_ANY_NODE_PATTERN = "<!-- gp-foundry:also-head:[^:\\s]+:";

// ── post="review" ────────────────────────────────────────────────────────────

/**
 * `post="review"` on a pr-review / PR-context analyst: the agent PRINTS its review
 * as a fenced json block and a compiled step posts it with the lane's token. The
 * agent gets no GitHub token and needs no `gh` — a shell under dontAsk denies the
 * quoting a real review body needs, and an agent reading untrusted PR text should
 * not hold a token anyway. True only for a node it applies to.
 */
export function postsReview(node: HarnessNode): boolean {
  return node.attrs.post === "review" && (node.type === "pr-review" || node.type === "analyst") && hasPrContext(node);
}

// ── no_changes_comment= ─────────────────────────────────────────────────────

/**
 * `no_changes_comment="…"` on a producer: when its run ends with nothing
 * committed (no branch pushed, no PR), say so on the issue — otherwise a green
 * run with an empty diff leaves no trace. `true` posts a default message naming
 * the lane and linking the run. `comment_target=issue|pr` (default `issue`: on
 * the zero-commit path there is no PR to find). Undefined: off.
 */
export function noChangesCommentOf(node: HarnessNode): { body: string; target: "issue" | "pr" } | undefined {
  const raw = node.attrs.no_changes_comment;
  if (raw === undefined || raw === false || raw === "false" || raw === "") return undefined;
  const body =
    raw === true || raw === "true"
      ? `### 🛠️ ${node.id}: no changes\n\nThe \`${node.id}\` run ended without committing anything, so no branch or pull request was opened — either there was nothing to change, or the run stopped early (its log says which). Run: \${{ github.server_url }}/\${{ github.repository }}/actions/runs/\${{ github.run_id }}`
      : String(raw);
  return { body, target: node.attrs.comment_target === "pr" ? "pr" : "issue" };
}

// ── quiet_verdicts= ─────────────────────────────────────────────────────────

/**
 * `quiet_verdicts="APPROVE"` on a verdict lane (a sweep with post="review"): a
 * verdict that needs nothing from the author is delivered as a completed check
 * run on the head, owned by the harness App, instead of a review — no timeline
 * entry, no notification. Every other verdict still posts a review.
 *
 * The check: name `verdict_check=` (default `gp-foundry/verdict (<node>)`),
 * conclusion `success`, title `Verdict: <WORD>`, summary the review's body
 * without its verdict line, external_id `gp-foundry:verdict:<node>:<sha>`.
 * Only a check whose app is the harness App counts as a verdict (the App's slug
 * is identity.bot_login without `[bot]`).
 *
 * Only the approve word may be quiet: the others ask something of the author.
 */
export interface QuietVerdicts {
  /** The verdict words delivered as a check (today: the approve word only). */
  words: string[];
  /** Their exact verdict lines, newline-joined (what the post step compares). */
  lines: string;
  /** The check run's name. */
  check: string;
  /** The harness App's slug: the only app whose check counts. */
  app: string;
}

export function quietVerdictsRaw(node: HarnessNode): string[] {
  const raw = node.attrs.quiet_verdicts;
  if (raw === undefined || raw === null || raw === "") return [];
  return String(raw).split(",").map((w) => w.trim()).filter(Boolean);
}

export function verdictCheckName(node: HarnessNode): string {
  const raw = node.attrs.verdict_check;
  return typeof raw === "string" && raw.trim() ? raw.trim() : `gp-foundry/verdict (${node.id})`;
}

/** The harness App's slug, from identity.bot_login (`my-app[bot]` → `my-app`). */
export function botAppSlug(cfg: FoundryConfig): string | undefined {
  const login = cfg.identity?.bot_login ?? "";
  return login.endsWith("[bot]") ? login.slice(0, -"[bot]".length) : undefined;
}

/** A node's quiet verdicts, when it has any that apply; validate() reports the rest. */
export function quietVerdictsOf(node: HarnessNode, cfg: FoundryConfig): QuietVerdicts | undefined {
  const words = quietVerdictsRaw(node);
  const app = botAppSlug(cfg);
  if (!words.length || !app || !postsReview(node) || !isSweep(node)) return undefined;
  let approve: string;
  try {
    approve = parseVerdictWords(cfg.verdicts).approve;
  } catch {
    approve = parseVerdictWords(undefined).approve;
  }
  const quiet = words.filter((w) => w === approve);
  if (!quiet.length) return undefined;
  return { words: quiet, lines: quiet.map(verdictLine).join("\n"), check: verdictCheckName(node), app };
}

/** Every quiet verdict check in the graph — what the gate and the context read. */
export function verdictChecksOf(nodes: HarnessNode[], cfg: FoundryConfig): { checks: string[]; app: string } | undefined {
  const qs = nodes.map((n) => quietVerdictsOf(n, cfg)).filter((q): q is QuietVerdicts => !!q);
  return qs.length ? { checks: [...new Set(qs.map((q) => q.check))], app: qs[0]!.app } : undefined;
}

/**
 * The single gates (merge=) a quiet verdict nudges. A verdict review starts the
 * gate through its pull_request_review event; a check run created by the App
 * starts nothing, so the post step dispatches each of these for the PR instead.
 * Empty when the graph has no quiet verdicts.
 */
export function quietNudgedGatesOf(nodes: HarnessNode[], cfg: FoundryConfig): HarnessNode[] {
  if (!verdictChecksOf(nodes, cfg)) return [];
  // dispatchTargetKind's rule: only a scheduled gate's workflow can be dispatched.
  return nodes.filter((n) => n.type === "merge-gate" && dispatchTargetKind(n) === "pr");
}

/**
 * The single gates that take a PR as a dispatch input (`pr`): those a quiet
 * verdict nudges, and those named by some node's dispatch=. Empty: nothing about
 * the gates changes.
 */
export function nudgedGatesOf(nodes: HarnessNode[], cfg: FoundryConfig): HarnessNode[] {
  const named = new Set(nodes.flatMap((n) => dispatchRaw(n)));
  const quiet = new Set(quietNudgedGatesOf(nodes, cfg).map((g) => g.id));
  const explained = new Set(explainedGatesOf(nodes).map((g) => g.id));
  return nodes.filter((n) => n.type === "merge-gate" && mergeSettingOf(n) !== undefined && (quiet.has(n.id) || named.has(n.id) || explained.has(n.id)));
}

/**
 * `explain_on="<gate>"` on a sweep (#52): while a head has no verdict, the
 * gate's check on it is held in progress with the reason the sweep's select job
 * gave for it ("approver is deciding", "Waiting: 2 check(s) still running") —
 * the reasons come from the sweep's own selection, so the two cannot disagree.
 * The sweep hands a changed reason to the gate by dispatch; the gate writes it,
 * and only on a head with no verdict. Undefined: off (or invalid: validate()).
 */
export function explainGateOf(node: HarnessNode, nodes: HarnessNode[]): HarnessNode | undefined {
  const id = node.attrs.explain_on;
  if (typeof id !== "string" || !isSweep(node)) return undefined;
  const gate = nodes.find((n) => n.id === id);
  return gate && gate.type === "merge-gate" && dispatchTargetKind(gate) === "pr" ? gate : undefined;
}

/** The single gates some sweep explains on: each takes a `reason` with its `pr`. */
export function explainedGatesOf(nodes: HarnessNode[]): HarnessNode[] {
  const ids = new Set(nodes.map((n) => explainGateOf(n, nodes)?.id).filter(Boolean));
  return nodes.filter((n) => ids.has(n.id));
}

/**
 * The sweeps some node's dispatch= names: each takes the PR as a `pr` dispatch
 * input and evaluates just that PR, in a concurrency slot of its own (#51).
 * Empty: nothing about the sweeps changes.
 */
export function dispatchedSweepsOf(nodes: HarnessNode[]): HarnessNode[] {
  const named = new Set(nodes.flatMap((n) => dispatchRaw(n)));
  return nodes.filter((n) => isSweep(n) && named.has(n.id));
}

// ── dispatch= ────────────────────────────────────────────────────────────────

/**
 * `dispatch="approver, formal-approval.yml"`: wake other workflows the moment
 * this node has delivered, instead of leaving them to their cron. On a lane with
 * post="review", after the review is posted (or the quiet verdict delivered); on
 * a single gate (merge=), after it publishes a changed result, once per PR.
 *
 * A target is a node id or a workflow file:
 *   - a scheduled node: dispatched with no inputs — it makes its own pass, which
 *     picks up whatever is now eligible;
 *   - a sweep (select="sweep") or a single gate: dispatched with the PR (`pr`),
 *     evaluating just that PR under the same rules, in a slot of its own;
 *   - `<file>.yml` (a workflow of the repo's own): dispatched with the PR as its
 *     `pr` input, which that workflow must declare under workflow_dispatch.
 *
 * Dispatched with the job's own GITHUB_TOKEN (`actions: write`): workflow_dispatch
 * is the one event that token can start. Best effort — a failed dispatch is a
 * warning; the target's own schedule still covers it.
 */
export function dispatchRaw(node: HarnessNode): string[] {
  const raw = node.attrs.dispatch;
  if (raw === undefined || raw === null || raw === "") return [];
  return String(raw).split(",").map((t) => t.trim()).filter(Boolean);
}

export const WORKFLOW_FILE_RE = /^[A-Za-z0-9_.-]+\.ya?ml$/;

/** Can this node be woken by dispatch, and does it take the PR? Undefined: not a target. */
export function dispatchTargetKind(target: HarnessNode | undefined): "pass" | "pr" | undefined {
  // Only a scheduled node's workflow has a workflow_dispatch trigger at all.
  if (!target || target.attrs.schedule === undefined) return undefined;
  // A single gate and a sweep evaluate just the PR they are started for.
  return (target.type === "merge-gate" && mergeSettingOf(target) !== undefined) || isSweep(target) ? "pr" : "pass";
}

/**
 * The workflows a node dispatches, as `<file> <pr|->` lines for the shell (pr:
 * pass the PR number as the `pr` input). Unresolvable targets are dropped here;
 * validate() reports them.
 */
export function dispatchTargetsOf(node: HarnessNode, nodes: HarnessNode[]): { workflow: string; withPr: boolean; sweep?: boolean }[] {
  const out: { workflow: string; withPr: boolean; sweep?: boolean }[] = [];
  for (const t of new Set(dispatchRaw(node))) {
    if (WORKFLOW_FILE_RE.test(t)) {
      out.push({ workflow: t, withPr: true });
      continue;
    }
    const target = nodes.find((n) => n.id === t);
    const kind = dispatchTargetKind(target);
    if (kind) out.push({ workflow: `${t}.yml`, withPr: kind === "pr", ...(target && isSweep(target) ? { sweep: true } : {}) });
  }
  return out;
}

/** Default heading the post step puts on line 1 of the review: placeholders `<n>` and `<sha>`. */
export const DEFAULT_POST_MARKER = "PR #<n> head <sha>";

/** `post_marker="…"`, else the default. Throws on a malformed value. */
export function parsePostMarker(node: HarnessNode): string {
  const raw = node.attrs.post_marker;
  if (raw === undefined) return DEFAULT_POST_MARKER;
  if (typeof raw !== "string" || !raw.trim() || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw new Error(`node '${node.id}': post_marker= must be a non-empty single line, e.g. "PR #<n> head <sha>"`);
  }
  return raw.trim();
}

/**
 * A guard job is emitted for an event-driven PR analyst (never a sweep) that
 * has something to guard on: a `skip=` condition or an author allowlist.
 */
export function hasSkipGuard(node: HarnessNode, cfg: FoundryConfig): boolean {
  // A hybrid harness guards every lane handed a pull request by an event: the
  // rollout decides whose PRs it looks at, and a writing lane which it may touch.
  if (isHybrid(cfg)) return node.attrs.schedule === undefined && (isReadingPrLane(node) || isWritingPrLane(node));
  return (
    (node.type === "pr-review" || node.type === "analyst") &&
    hasPrContext(node) &&
    node.attrs.schedule === undefined &&
    (skipOf(node).length > 0 || authorsOf(node, cfg) !== undefined)
  );
}

// ── runs_on= / runtime.runs_on ───────────────────────────────────────────────

export const DEFAULT_RUNNER = "ubuntu-latest";

/** One runner label. Strict: it is written into `runs-on:` as is. */
const RUNNER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Throws unless `raw` is a single runner label (`ubuntu-latest`, `blacksmith-4vcpu-ubuntu-2404`). */
export function parseRunner(raw: unknown, where: string): string {
  if (typeof raw !== "string" || !RUNNER.test(raw)) {
    throw new Error(`${where} must be one runner label like "ubuntu-latest", got ${JSON.stringify(raw)}`);
  }
  return raw;
}

/**
 * The runner a node's jobs use: its own `runs_on=`, else `runtime.runs_on`, else
 * ubuntu-latest. A malformed value is validate()'s to report and falls through.
 */
export function runnerOf(node: HarnessNode | undefined, cfg: FoundryConfig): string {
  for (const [raw, where] of [
    [node?.attrs.runs_on, "runs_on="],
    [cfg.runtime?.runs_on, "runtime.runs_on"],
  ] as const) {
    if (raw === undefined) continue;
    try {
      return parseRunner(raw, where);
    } catch {
      // fall through to the next source
    }
  }
  return DEFAULT_RUNNER;
}

// ── the hybrid harness: rollout scope, reading and writing lanes ─────────────

/**
 * A harness is hybrid — people and agents both open pull requests in it — when
 * its config has a `rollout` block, even an empty one (`rollout: {}` = every PR).
 * That one key is the opt-in: scope then comes from the rollout dial for every
 * lane and the gate, instead of from `repo.branch_prefix` and per-node attrs.
 * Without the key, every lane compiles exactly as it did before.
 */
export function isHybrid(cfg: FoundryConfig): boolean {
  return cfg.rollout !== undefined && cfg.rollout !== null;
}

/**
 * The parsed rollout for emitters. A malformed block is validate()'s to report
 * and must not compile to "everyone": it admits nobody by name.
 */
export function rolloutOf(cfg: FoundryConfig): Rollout | undefined {
  if (!isHybrid(cfg)) return undefined;
  try {
    return parseRollout(cfg.rollout, cfg.labels) ?? {};
  } catch {
    return { authors: [] };
  }
}

/**
 * The re-review label (`labels.re_review`), in a hybrid harness: a person asks
 * for a fresh review and verdict on the head as it stands. Undefined: off.
 * See src/shared/rereview.ts.
 */
export function rereviewLabelOf(cfg: FoundryConfig): string | undefined {
  const l = cfg.labels?.re_review;
  return isHybrid(cfg) && typeof l === "string" && l.trim() ? l.trim() : undefined;
}

/** A lane that reads a pull request and advises: it runs on any PR in scope. */
export function isReadingPrLane(node: HarnessNode): boolean {
  return (node.type === "pr-review" || node.type === "analyst") && hasPrContext(node);
}

/** A lane that pushes to a pull request: it runs only on PRs the pipeline wrote. */
export function isWritingPrLane(node: HarnessNode): boolean {
  return node.type === "pr-fix";
}

const PR = "github.event.pull_request";

/**
 * The job-level `if:` for a hybrid PR lane: a cheap test on the event payload
 * that keeps a runner from starting for a PR plainly out of scope. It is a
 * prefilter, not the decision — the lane's guard runs the real rule (pr-scope)
 * against the live PR — so where the two could differ it errs towards letting
 * the event through (another bot's PR, which only the guard turns away).
 */
export function scopePrefilter(rollout: Rollout, botLogin: string | undefined, writing: boolean, admitBotAuthors = true): string {
  const clauses = [`${PR}.draft == false`];
  if (rollout.skipLabel) clauses.push(`!contains(${PR}.labels.*.name, ${exprString(rollout.skipLabel)})`);
  const by = (login: string) => `${PR}.user.login == ${exprString(login)}`;
  if (writing) {
    // Only the pipeline's own PRs; with no bot login there are none (validate errors).
    clauses.push(by(botLogin ?? NO_AUTHOR));
  } else if (rollout.authors !== undefined || rollout.optInLabel !== undefined) {
    // rollout.bot_authors' events reach a guard, which hands the PR to the lane's
    // bot pass and says so; a lane with no guard (a review panel) leaves them out.
    const admit = [
      ...(botLogin ? [by(botLogin)] : []),
      ...(rollout.authors ?? []).map(by),
      ...(admitBotAuthors ? (rollout.botAuthors ?? []).map(by) : []),
    ];
    if (rollout.optInLabel) admit.push(`contains(${PR}.labels.*.name, ${exprString(rollout.optInLabel)})`);
    clauses.push(admit.length === 1 ? admit[0]! : `(${admit.length ? admit.join(" || ") : by(NO_AUTHOR)})`);
  }
  // A lane with no guard (a review panel) has no bot pass: it leaves the listed
  // bots' PRs alone, whose own events would fail its token mint.
  if (!writing && !admitBotAuthors) {
    for (const b of rollout.botAuthors ?? []) clauses.push(`${PR}.user.login != ${exprString(b)}`);
  }
  return clauses.join(" && ");
}

/**
 * The single gate's job-level test for a pull-request event: the reading-lane
 * prefilter (not a draft, no skip label, an admitted author or label), and not
 * another bot's PR. Without it a person's label or review on a Dependabot,
 * draft or skipped PR starts a run that mints the App token only to find the PR
 * out of scope. Another bot's PR runs only when `rollout.authors` names it, as
 * the scope rule says; the policy's Dependabot lane (runtime content the
 * compiler does not read) is served by the scheduled pass, which is where
 * Dependabot's own events already go.
 */
export function singleGatePrefilter(rollout: Rollout, botLogin: string | undefined): string {
  const by = (login: string) => `${PR}.user.login == ${exprString(login)}`;
  // rollout.bot_authors too: an event on their PR from a person or the harness
  // (a label, the approver's verdict) runs with secrets. Their own events are
  // turned away by the gate's `github.actor` clause, as Dependabot's always were.
  const bots = [...(botLogin ? [botLogin] : []), ...(rollout.authors ?? []), ...(rollout.botAuthors ?? [])].filter((a, i, all) => all.indexOf(a) === i);
  const scope = scopePrefilter(rollout, botLogin, false);
  // Admission by login alone (authors, no opt-in label) already names every
  // author it lets in, bots included: nothing to add.
  if (rollout.authors !== undefined && rollout.optInLabel === undefined) return scope;
  const notOtherBot = `(${[`${PR}.user.type != 'Bot'`, ...bots.map(by)].join(" || ")})`;
  return `${scope} && ${notOtherBot}`;
}

// ── rollout.bot_authors: the scheduled bot pass ─────────────────────────────

/**
 * merge_bots="dependabot[bot],…" on a single gate: the bots whose own PRs it
 * merges once ready (lower-cased; each must be in rollout.bot_authors). A grant
 * separate from merge="agent-only". Throws on a malformed list (validate reports it).
 */
export function parseMergeBots(node: HarnessNode): string[] {
  const raw = node.attrs.merge_bots;
  if (raw === undefined) return [];
  if (typeof raw !== "string") throw new Error(`merge_bots= on '${node.id}' must be a comma-separated list of bot logins`);
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const login = part.trim().toLowerCase();
    if (!login) continue;
    if (!LOGIN.test(login) || !login.endsWith("[bot]")) throw new Error(`merge_bots= on '${node.id}': '${login}' is not a bot login (a bot's login ends in [bot])`);
    if (!out.includes(login)) out.push(login);
  }
  return out;
}

/** merge_bots=, or none when malformed (validate reports it): a gate never merges on a list it could not read. */
export function mergeBotsOf(node: HarnessNode): string[] {
  try {
    return parseMergeBots(node);
  } catch {
    return [];
  }
}

/** How often a lane's bot pass runs when the node names no bot_schedule=. */
export const DEFAULT_BOT_SCHEDULE = "*/15 * * * *";

/** The entry events after which a lane reviews a PR's new head (`push` reaches a PR lane as synchronize). */
const BOT_PASS_EVENTS = new Set(["pull_request", "pull_request.opened", "pull_request.synchronize", "pull_request.ready_for_review", "push"]);

function entryEvents(inEdges: HarnessEdge[]): string[] {
  return inEdges.flatMap((e) => (e.on ?? "").split(",").map((s) => s.trim()).filter(Boolean));
}

/**
 * Does this lane get a scheduled bot pass? An event-driven reading PR lane of a
 * hybrid harness whose rollout names bot_authors, entered when a PR opens or
 * its head moves. Those bots' own PR events carry none of the repo's secrets
 * (Dependabot's never do), so the lane's guard hands their PRs over (pr-scope)
 * and the pass reviews their heads on a schedule, or when dispatched for one
 * PR. A lane entered on anything else (a review, a label) would never have
 * reviewed a head unprompted, so it gets none; nor does a sweep, already
 * scheduled. The compiler, the wiring and validate() all ask this.
 */
export function botPassOf(node: HarnessNode, cfg: FoundryConfig, inEdges: HarnessEdge[]): boolean {
  return (
    !!rolloutOf(cfg)?.botAuthors?.length &&
    isReadingPrLane(node) &&
    !isSweep(node) &&
    hasSkipGuard(node, cfg) &&
    entryEvents(inEdges).some((ev) => BOT_PASS_EVENTS.has(ev))
  );
}

/** Is the lane started by hand too (`on="workflow_dispatch"`)? Its bot pass then runs on dispatch only for a `pr`. */
export function listensToDispatch(inEdges: HarnessEdge[]): boolean {
  return entryEvents(inEdges).some((ev) => ev === "workflow_dispatch" || ev.startsWith("workflow_dispatch."));
}

/** The bot pass's cron: bot_schedule=, else DEFAULT_BOT_SCHEDULE. */
export function botScheduleOf(node: HarnessNode): string {
  const s = node.attrs.bot_schedule;
  return typeof s === "string" && s.trim() ? s.trim() : DEFAULT_BOT_SCHEDULE;
}

/** The bot pass's job ids: select, the lane (a matrix), and its record of the heads it covered. */
export function botPassJobIds(node: HarnessNode): { select: string; lane: string; mark: string } {
  return { select: `${node.id}_bots_select`, lane: `${node.id}_bots`, mark: `${node.id}_bots_mark` };
}

/** The bot pass's matrix jobs are named per PR, so its mark job can tell which succeeded. */
export function botPassJobNamePrefix(node: HarnessNode): string {
  return `${node.id} bots #`;
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
 * The check-run a sweep publishes for each run on a head that SUCCEEDED but
 * left no verdict there. A lane cannot fail its job on purpose, so "nothing to
 * decide yet" looks like success; it is retried, but not without limit.
 */
export function sweepIdleCheckName(node: HarnessNode): string {
  return `gp-foundry/sweep-idle (${node.id})`;
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

/**
 * `<!-- gp-foundry:also-head:<node>:` — the prefix of the marker appended to a
 * review, one per head, when the guard skips a push whose diff that review
 * already covers: the review stands for the new head too. A downstream sweep
 * (`requires_review=true`) reads it as "reviewed" for that head.
 */
export function alsoHeadMarkerPrefix(node: HarnessNode): string {
  return `<!-- gp-foundry:also-head:${node.id}:`;
}

/**
 * `<!-- gp-foundry:posted:` — the prefix of the marker a post="review" step
 * appends to the review it posts, completed as `<node>:<head sha> -->`. It is
 * the lane's own record of "I posted this, for this head", and what makes a
 * re-run idempotent.
 *
 * Idempotency has to be keyed on WHO posted, not on what the review looks like.
 * Several lanes post as one bot, often under one heading, and neither the
 * heading nor "does it end in a verdict line" says which lane a review came
 * from: an event reviewer may post a verdict of its own, exactly like a sweep.
 */
export const POSTED_MARKER_PREFIX = "<!-- gp-foundry:posted:";

/**
 * jq predicate over one review: is it a verdict? A verdict is a review whose LAST
 * VISIBLE line — HTML comments removed (the harness's own stamps), lines trimmed,
 * blanks dropped — is exactly one of the verdict lines (src/shared/verdicts.ts)
 * — a substring match would let a lane posting as the same bot decide a head just by
 * quoting the marker, and a prefix match would accept `**Verdict:** APPROVE (once
 * gates pass)`, which the merge gate never reads as an approval. Shared by the
 * sweep's select and mark jobs and by every step that edits a review (the diff
 * stamp, the also-head marker). Reads
 * `env.VERDICT_LINES` (newline-separated; see verdictLinesOf).
 */
export const IS_VERDICT_JQ =
  `(((.body // "") | gsub("<!--[\\\\s\\\\S]*?-->"; "") | split("\\n")` +
  ` | map(gsub("^\\\\s+|\\\\s+$"; "")) | map(select(length > 0)) | (last // "")) as $line` +
  ` | env.VERDICT_LINES | split("\\n") | any(.[]; . == $line))`;

/**
 * The exact verdict lines for `env.VERDICT_LINES`, from `verdicts:` in
 * foundry.config.yaml. A malformed list is validate()'s to report and compiles
 * to the defaults.
 */
export function verdictLinesOf(cfg: FoundryConfig): string {
  try {
    return verdictLinesEnv(parseVerdictWords(cfg.verdicts));
  } catch {
    return verdictLinesEnv(parseVerdictWords(undefined));
  }
}
