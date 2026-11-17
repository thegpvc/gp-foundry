/**
 * B5 — Wiring compiler. Turns incoming edges (+ node attrs) into the `on:` block,
 * the job-level `if:` guard, and a concurrency group for each node's workflow.
 *
 * Edge conditions must be expressible in GitHub-observable primitives (events,
 * labels, review state, schedules). Rich runtime conditions are represented as
 * label/state writes by a prior node, exactly as dixie already coordinates.
 */
import type { FoundryConfig, Harness, HarnessEdge, HarnessNode, NodeWiring, WiringPlan } from "../ir/types.js";
import { AGENT_TYPES } from "../ir/types.js";
import {
  mergeSettingOf,
  isReadingPrLane,
  isWritingPrLane,
  rolloutOf,
  scopePrefilter,
  authorClause,
  authorsOf,
  exprString,
  hasSkipGuard,
  optInLabelOf,
  parseConfigAuthors,
  skipOf,
  NO_AUTHOR,
} from "../handlers/attrs.js";
import { detectDiamonds } from "./diamond.js";

const AGENT = new Set(AGENT_TYPES);
const PR_CONTEXT_TYPES = new Set(["pr-review", "pr-fix"]);

/**
 * Resolve a semantic label key through config.labels (identity when unmapped).
 * `when="label=build"` guards on the label the CONSUMER's repo actually uses.
 */
function resolveLabel(key: string, cfg: FoundryConfig): string {
  return cfg.labels?.[key] ?? key;
}

function targetIsPr(node: HarnessNode): boolean {
  return (
    PR_CONTEXT_TYPES.has(node.type) ||
    node.context === "pr-diff" ||
    node.context === "pr-review"
  );
}

function mergeEvent(triggers: Record<string, any>, event: string, target: HarnessNode): void {
  const addType = (key: string, type: string) => {
    triggers[key] ??= {};
    triggers[key].types ??= [];
    if (!triggers[key].types.includes(type)) triggers[key].types.push(type);
  };
  switch (event) {
    case "issues.opened": return addType("issues", "opened");
    case "issues.labeled": return addType("issues", "labeled");
    case "issue_comment.created": return addType("issue_comment", "created");
    case "pull_request.opened": return addType("pull_request", "opened");
    case "pull_request.synchronize": return addType("pull_request", "synchronize");
    case "pull_request.labeled": return addType("pull_request", "labeled");
    case "pull_request.closed": return addType("pull_request", "closed");
    case "pull_request.ready_for_review": return addType("pull_request", "ready_for_review");
    case "pull_request_review.submitted": return addType("pull_request_review", "submitted");
    case "push":
      // a push into a pr-review node means "re-review after the branch moved"
      if (targetIsPr(target)) return addType("pull_request", "synchronize");
      triggers.push ??= {};
      return;
    case "workflow_dispatch":
      triggers.workflow_dispatch ??= {};
      return;
    default:
      // pass-through unknown events as a best-effort top-level key
      triggers[event] ??= {};
  }
}

interface EdgeWire {
  events: string[];
  guard?: string;
}

/**
 * The event a workflow ACTUALLY receives for a declared edge event — mirrors
 * mergeEvent's remapping (a `push` into a PR-target node is delivered as
 * `pull_request.synchronize`). Discriminator clauses must be computed from THIS,
 * or they test an event name that never arrives and silently suppress the edge.
 */
function effectiveEvent(event: string, target: HarnessNode): string {
  if (event === "push" && targetIsPr(target)) return "pull_request.synchronize";
  return event;
}

/**
 * A GitHub-expression discriminator for one event, so an UNGUARDED edge can still
 * contribute an OR-clause when a sibling edge is guarded. Without this, a node with
 * a guarded edge (e.g. `label=x`) plus an unguarded edge on a different event would
 * apply the guard to BOTH events and silently suppress the unguarded one.
 */
function eventClause(event: string): string {
  const [name, action] = event.split(".");
  if (!action) return `github.event_name == '${name}'`;
  return `(github.event_name == '${name}' && github.event.action == '${action}')`;
}

function wireEdge(edge: HarnessEdge, target: HarnessNode, cfg: FoundryConfig): EdgeWire | undefined {
  if (edge.on) {
    // `on` may list several events, e.g. "pull_request.opened, pull_request.synchronize".
    const events = edge.on.split(",").map((s) => s.trim()).filter(Boolean);
    const delivered = events.map((ev) => effectiveEvent(ev, target));
    return { events, guard: edge.when ? guardFor(edge.when, delivered, cfg) : undefined };
  }
  if (!edge.when) return undefined;
  const w = edge.when;
  if (w.startsWith("label=")) {
    const events = [targetIsPr(target) ? "pull_request.labeled" : "issues.labeled"];
    return { events, guard: guardFor(w, events, cfg) };
  }
  if (w.startsWith("verdict=")) {
    const events = ["pull_request_review.submitted"];
    return { events, guard: guardFor(w, events, cfg) };
  }
  // internal-only transitions (attempts>=N, ci=...) are not triggers for this node
  return undefined;
}

function guardFor(when: string, events: string[], cfg: FoundryConfig): string | undefined {
  if (when.startsWith("label=")) {
    // semantic key -> actual repo label via config.labels (identity by default)
    const label = `github.event.label.name == '${resolveLabel(when.slice("label=".length), cfg)}'`;
    const state = openStateClause(events);
    return state ? `${label} && ${state}` : label;
  }
  // A bot cannot APPROVE/REQUEST_CHANGES its own PR, so the Critic submits a
  // COMMENTED review with the verdict in the body; guard on the body marker.
  // The marker alone is not a gate — any user can submit a review containing it —
  // so the reviewing ACTOR is checked alongside it whenever a bot login is known.
  const verdict =
    when === "verdict=approve"
      ? "APPROVE"
      : when === "verdict=request_changes"
        ? "REQUEST_CHANGES"
        : undefined;
  if (verdict) {
    const marker = `contains(github.event.review.body, '**Verdict:** ${verdict}')`;
    const actor = reviewActorClause(cfg);
    return actor ? `${marker} && ${actor}` : marker;
  }
  return undefined;
}

/**
 * `github.event.<issue|pull_request>.state == 'open'` for a label-triggered edge.
 * GitHub delivers `labeled` for closed issues and PRs too, and a lane label usually
 * survives the close (auto-close on merge never strips it), so without this a label
 * toggle on a closed item re-drives a whole agent lane against work already on the
 * base branch. The payload path is taken from the events the edge actually receives;
 * when they don't agree on one subject the clause is omitted rather than guessed,
 * since a path that isn't in the payload would silently suppress the edge.
 */
function openStateClause(events: string[]): string | undefined {
  if (events.length && events.every((e) => e.split(".")[0] === "issues")) {
    return "github.event.issue.state == 'open'";
  }
  if (events.length && events.every((e) => e.split(".")[0] === "pull_request")) {
    return "github.event.pull_request.state == 'open'";
  }
  return undefined;
}

/**
 * `github.event.review.user.login == '<bot>'` — the actor half of a verdict
 * guard. Omitted when the config names no bot: there is nothing to compare
 * against, and validate() warns about the resulting hole.
 */
export function reviewActorClause(cfg: FoundryConfig): string | undefined {
  const bot = cfg.identity?.bot_login;
  return bot ? `github.event.review.user.login == '${bot}'` : undefined;
}

/** Events whose payload carries `pull_request` (so a head-ref guard can read it). */
function carriesPrPayload(event: string): boolean {
  return /^(pull_request|pull_request_review|pull_request_target)\b/.test(event);
}

/**
 * `startsWith(github.event.pull_request.head.ref, '<prefix>')` — the guard that
 * keeps agent lanes off human branches. Without it a `pull_request` trigger
 * fires the reviewer on EVERY PR in the repo, and a request-changes verdict
 * sends the fixer to push commits onto someone's own branch.
 */
export function branchPrefixClause(cfg: FoundryConfig): string | undefined {
  const prefix = cfg.repo?.branch_prefix;
  return prefix ? `startsWith(github.event.pull_request.head.ref, '${prefix}')` : undefined;
}

/**
 * AND the branch-prefix guard onto a workflow that PR events can reach, so an
 * agent lane never runs against a human's branch.
 *
 * The existing guard is an OR of edge conditions, so it has to be parenthesized
 * before the AND — `a || b && prefix` would only constrain `b`. When the node
 * also listens to non-PR events (an issue lane that a PR event can re-enter),
 * the prefix is required only of the PR events: for an issue event the
 * event-name clause is already true and the OR short-circuits.
 */
function applyBranchPrefix(
  guard: string | undefined,
  events: Set<string>,
  cfg: FoundryConfig,
): string | undefined {
  return andForPrEvents(guard, events, branchPrefixClause(cfg));
}

/**
 * AND the author allowlist onto a workflow PR events can reach. The same
 * allowlist is re-checked against live PR state in the guard job; this copy is
 * what keeps a runner from being spent on a PR the lane will never touch.
 */
function applyAuthors(
  guard: string | undefined,
  events: Set<string>,
  authors: string[] | undefined,
  optInLabel?: string,
): string | undefined {
  return andForPrEvents(guard, events, authors ? authorClause(authors, optInLabel) : undefined);
}

function andForPrEvents(
  guard: string | undefined,
  events: Set<string>,
  branch: string | undefined,
): string | undefined {
  const prEvents = [...events].filter(carriesPrPayload);
  if (!branch || prEvents.length === 0) return guard;

  const otherEvents = [...events].filter((e) => !carriesPrPayload(e));
  const clause = otherEvents.length
    ? `(${otherEvents.map(eventClause).join(" || ")} || ${branch})`
    : branch;
  return guard ? `(${guard}) && ${clause}` : clause;
}

/**
 * `cancel_in_progress=true|false` on an agent node overrides the lane's default
 * (on for issue-agent, off everywhere else): a newer event for the same unit
 * cancels the run already in flight instead of queueing behind it. Anything but
 * a boolean on an agent node is validate()'s to report; the default stands.
 */
function cancelInProgress(node: HarnessNode, dflt: boolean): boolean {
  const v = node.attrs.cancel_in_progress;
  return typeof v === "boolean" && AGENT.has(node.type) ? v : dflt;
}

/**
 * `optInLabel` is set when the lane hears `pull_request.labeled` only for its
 * opt-in label. Every other label event still starts a run (GitHub has no label
 * filter on `on:`); its jobs are skipped by the `if:`, but a run in the PR's
 * group would cancel an in-flight review (or replace a pending one) and then do
 * nothing. Such events get a throwaway per-run group instead; the opt-in label
 * itself stays in the PR's group like a push.
 */
function concurrencyKey(
  node: HarnessNode,
  optInLabel?: string,
): { group: string; "cancel-in-progress": boolean } {
  if (node.attrs.schedule !== undefined) {
    return { group: node.id, "cancel-in-progress": cancelInProgress(node, false) };
  }
  // human-gate approvals ride PR events (verdict edges → pull_request_review), whose
  // payload has pull_request.number, not issue.number — an issue-scoped key would
  // render empty and collapse every gate into one concurrency slot.
  const prScoped = targetIsPr(node) || node.type === "human-gate";
  const num = prScoped
    ? "${{ github.event.pull_request.number }}"
    : "${{ github.event.issue.number }}";
  const cancel = cancelInProgress(node, node.type === "issue-agent");
  if (optInLabel !== undefined && prScoped) {
    const group =
      `\${{ github.event.action == 'labeled' && github.event.label.name != ${exprString(optInLabel)}` +
      ` && format(${exprString(`${node.id}-noop-{0}`)}, github.run_id)` +
      ` || format(${exprString(`${node.id}-{0}`)}, github.event.pull_request.number) }}`;
    return { group, "cancel-in-progress": cancel };
  }
  return { group: `${node.id}-${num}`, "cancel-in-progress": cancel };
}

/** The pull_request events that change what the single gate would decide. */
const GATE_PR_EVENTS = ["synchronize", "reopened", "ready_for_review", "labeled", "unlabeled", "review_requested", "review_request_removed"] as const;

/**
 * Which runs of a single-gate workflow do anything. Scheduled and manual runs
 * always (the pass). An event run only for an open PR from this repository not
 * triggered by Dependabot: a fork or Dependabot event gets no secrets and a
 * read-only token, so it could neither mint the App token nor write the check —
 * the scheduled pass covers those PRs. Labels the harness itself applies are
 * ignored too: re-evaluating on the gate's own label adds a run and nothing else.
 * Scope (the rollout) is decided inside the gate, against the live PR.
 */
function singleGateGuard(botLogin: string | undefined): string {
  const pr = "github.event.pull_request";
  const event = [
    `${pr}.state == 'open'`,
    `${pr}.head.repo.full_name == github.repository`,
    `github.actor != 'dependabot[bot]'`,
    ...(botLogin
      ? [`!((github.event.action == 'labeled' || github.event.action == 'unlabeled') && github.event.sender.login == ${exprString(botLogin)})`]
      : []),
  ].join(" && ");
  return `github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' || (${event})`;
}

export function wire(ir: Harness): WiringPlan {
  const perNode: Record<string, NodeWiring> = {};
  const byId = new Map(ir.nodes.map((n) => [n.id, n] as const));
  const incoming = new Map<string, HarnessEdge[]>();
  for (const n of ir.nodes) incoming.set(n.id, []);
  for (const e of ir.edges) incoming.get(e.to)?.push(e);

  // parallel→legs→fan_in diamonds compile to ONE workflow (the fan_in's), triggered
  // by the diamond's entry edge; the members get no standalone wiring.
  const diamonds = detectDiamonds(ir);
  // A hybrid harness (config has `rollout:`) scopes its PR lanes by the rollout
  // dial instead of by branch prefix and per-node attributes.
  const rollout = rolloutOf(ir.config);
  const botLogin = ir.config.identity?.bot_login;

  for (const node of ir.nodes) {
    if (node.type === "start" || node.type === "exit") continue;
    if (diamonds.memberIds.has(node.id)) continue;
    const diamond = diamonds.byFanin.get(node.id);
    if (diamond) {
      const entry = diamond.entryEdge;
      const firstLeg = byId.get(diamond.legIds[0]!)!;
      const triggers: Record<string, any> = {};
      const events = (entry.on ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      for (const ev of events) mergeEvent(triggers, ev, firstLeg);
      const nw: NodeWiring = { nodeId: node.id, triggers, dispatches: [] };
      // The diamond's guard goes through the same branch-prefix treatment as a
      // single node's. A review panel is still an agent lane: without this it
      // would run on every human PR, which is the hole the guard exists to close.
      const effEvents = new Set(events.map((ev) => effectiveEvent(ev, firstLeg)));
      // A diamond has no single node to carry authors=, so it is bound by the
      // config-wide allowlist (malformed → nobody, as for a single lane).
      let panelAuthors: string[] | undefined;
      try {
        panelAuthors = parseConfigAuthors(ir.config);
      } catch {
        panelAuthors = [NO_AUTHOR];
      }
      const entryGuard = entry.when ? guardFor(entry.when, [...effEvents], ir.config) : undefined;
      const g = rollout
        ? // A review panel reads: any PR in scope. It has no guard job of its own,
          // so here the prefilter is all there is (and another bot's PR gets through).
          andForPrEvents(entryGuard, effEvents, scopePrefilter(rollout, botLogin, false))
        : applyAuthors(applyBranchPrefix(entryGuard, effEvents, ir.config), effEvents, panelAuthors);
      if (g) nw.guard = g;
      // Unit scope follows the entry event; convention `<node-id>-<num>`, never cancel
      // a mid-synthesis join.
      const prScoped = events.some((ev) => effectiveEvent(ev, firstLeg).startsWith("pull_request"));
      const num = prScoped ? "${{ github.event.pull_request.number }}" : "${{ github.event.issue.number }}";
      nw.concurrency = { group: `${node.id}-${num}`, "cancel-in-progress": false };
      perNode[node.id] = nw;
      continue;
    }
    if (node.type === "parallel" || node.type === "fan_in") continue; // malformed: validation flags it

    const triggers: Record<string, any> = {};
    const guards = new Set<string>();
    const unguardedEvents = new Set<string>();
    const allEvents = new Set<string>();
    const dispatches: { toNode: string; when?: string }[] = [];
    // A gate with merge= (which validate() holds to a hybrid harness).
    const singleGate = node.type === "merge-gate" && mergeSettingOf(node) !== undefined;
    const hybridLane = rollout !== undefined && (isReadingPrLane(node) || isWritingPrLane(node));
    // The label that admits a PR by itself: the rollout's, for a hybrid reading
    // lane (a writing lane is never opted in by label); else the node's own.
    const optIn = rollout ? (isReadingPrLane(node) ? rollout.optInLabel : undefined) : optInLabelOf(node, ir.config);
    let gateLabelEvents = false;

    // scheduled nodes (e.g. merge-gate) are driven by cron + manual dispatch only
    if (node.attrs.schedule !== undefined) {
      triggers.schedule = [{ cron: String(node.attrs.schedule) }];
      triggers.workflow_dispatch = {};
      if (singleGate) {
        // The single gate also evaluates ONE PR the moment something that decides
        // it changes: a review, a label, a review request, a new commit. CI
        // finishing and threads resolving have no usable event; the scheduled
        // pass (least recently evaluated first) picks those up.
        triggers.pull_request = { types: [...GATE_PR_EVENTS] };
        triggers.pull_request_review = { types: ["submitted", "dismissed"] };
      }
    } else {
      for (const e of incoming.get(node.id) ?? []) {
        const w = wireEdge(e, node, ir.config);
        if (!w) continue;
        for (const ev of w.events) mergeEvent(triggers, ev, node);
        for (const ev of w.events) allEvents.add(effectiveEvent(ev, node));
        if (w.guard) guards.add(w.guard);
        else for (const ev of w.events) unguardedEvents.add(effectiveEvent(ev, node));
      }
      // skip="draft" turns a draft PR's events into no-ops, so the lane must hear
      // the moment the draft is marked ready — otherwise a PR opened as a draft
      // is never reviewed until someone happens to push to it again.
      if (
        triggers.pull_request &&
        hasSkipGuard(node, ir.config) &&
        // A hybrid harness never looks at a draft, so its lanes always listen.
        (hybridLane || skipOf(node).some((c) => c.kind === "draft"))
      ) {
        mergeEvent(triggers, "pull_request.ready_for_review", node);
        allEvents.add("pull_request.ready_for_review");
        unguardedEvents.add("pull_request.ready_for_review");
      }
      // opt_in_label= lets a PR outside the allowlist in by its label, so the
      // lane must hear the label being added — but only THAT label: any other
      // label event is turned away by the action clause ANDed on below.
      if (optIn && triggers.pull_request && hasSkipGuard(node, ir.config)) {
        if (!allEvents.has("pull_request.labeled")) {
          mergeEvent(triggers, "pull_request.labeled", node);
          allEvents.add("pull_request.labeled");
          unguardedEvents.add("pull_request.labeled");
          gateLabelEvents = true;
        } else if (!unguardedEvents.has("pull_request.labeled")) {
          // An edge already listens for labels behind its own guard (`label=x`);
          // an action clause would block that label, so admit the opt-in one
          // beside it instead. (An unguarded labeled edge already admits it.)
          guards.add(`(${eventClause("pull_request.labeled")} && github.event.label.name == ${exprString(optIn)})`);
        }
      }
      // Mixed guarded + unguarded edges: the unguarded events must still pass the
      // job-level `if`, so they contribute an event-discriminator OR-clause.
      if (guards.size && unguardedEvents.size) {
        for (const ev of unguardedEvents) guards.add(eventClause(ev));
      }
    }

    // outgoing internal dispatches (e.g. a maintenance node kicking a fixer)
    for (const e of ir.edges) {
      if (e.from === node.id && e.do) {
        dispatches.push({ toNode: e.to, when: e.when });
      }
    }

    const edgeGuard = guards.size ? [...guards].join(" || ") : undefined;
    let guard = hybridLane
      ? andForPrEvents(edgeGuard, allEvents, scopePrefilter(rollout!, botLogin, isWritingPrLane(node)))
      : applyAuthors(applyBranchPrefix(edgeGuard, allEvents, ir.config), allEvents, authorsOf(node, ir.config), optIn);
    if (gateLabelEvents && optIn) {
      guard = andForPrEvents(
        guard,
        allEvents,
        `(github.event.action != 'labeled' || github.event.label.name == ${exprString(optIn)})`,
      );
    }
    const nw: NodeWiring = {
      nodeId: node.id,
      triggers,
      dispatches,
    };
    if (guard) nw.guard = guard;
    if (Object.keys(triggers).length) nw.concurrency = concurrencyKey(node, gateLabelEvents ? optIn : undefined);
    if (singleGate) {
      nw.guard = singleGateGuard(botLogin);
      // One slot per PR for event runs, newest wins: a burst of events on a PR
      // collapses to one evaluation of its latest state. The scheduled pass has
      // its own slot and is never cancelled by an event.
      nw.concurrency = {
        group: `\${{ github.event.pull_request.number && format('${node.id}-pr-{0}', github.event.pull_request.number) || '${node.id}' }}`,
        "cancel-in-progress": "${{ github.event.pull_request.number != null }}",
      };
    }
    perNode[node.id] = nw;
  }

  void byId;
  return { perNode };
}
