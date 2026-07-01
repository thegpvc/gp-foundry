/**
 * B5 — Wiring compiler. Turns incoming edges (+ node attrs) into the `on:` block,
 * the job-level `if:` guard, and a concurrency group for each node's workflow.
 *
 * Edge conditions must be expressible in GitHub-observable primitives (events,
 * labels, review state, schedules). Rich runtime conditions are represented as
 * label/state writes by a prior node, exactly as dixie already coordinates.
 */
import type { Harness, HarnessEdge, HarnessNode, NodeWiring, WiringPlan } from "../ir/types.js";

const PR_CONTEXT_TYPES = new Set(["pr-review", "pr-fix"]);

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

function wireEdge(edge: HarnessEdge, target: HarnessNode): EdgeWire | undefined {
  if (edge.on) {
    // `on` may list several events, e.g. "pull_request.opened, pull_request.synchronize".
    const events = edge.on.split(",").map((s) => s.trim()).filter(Boolean);
    return { events, guard: edge.when ? guardFor(edge.when, target) : undefined };
  }
  if (!edge.when) return undefined;
  const w = edge.when;
  if (w.startsWith("label=")) {
    return { events: [targetIsPr(target) ? "pull_request.labeled" : "issues.labeled"], guard: guardFor(w, target) };
  }
  if (w.startsWith("verdict=")) {
    return { events: ["pull_request_review.submitted"], guard: guardFor(w, target) };
  }
  // internal-only transitions (attempts>=N, ci=...) are not triggers for this node
  return undefined;
}

function guardFor(when: string, _target: HarnessNode): string | undefined {
  if (when.startsWith("label=")) {
    return `github.event.label.name == '${when.slice("label=".length)}'`;
  }
  // A bot cannot APPROVE/REQUEST_CHANGES its own PR, so the Critic submits a
  // COMMENTED review with the verdict in the body; guard on the body marker.
  if (when === "verdict=approve") return "contains(github.event.review.body, '**Verdict:** APPROVE')";
  if (when === "verdict=request_changes") return "contains(github.event.review.body, '**Verdict:** REQUEST_CHANGES')";
  return undefined;
}

function concurrencyKey(node: HarnessNode): { group: string; "cancel-in-progress": boolean } {
  if (node.attrs.schedule !== undefined) {
    return { group: node.id, "cancel-in-progress": false };
  }
  const num = targetIsPr(node)
    ? "${{ github.event.pull_request.number }}"
    : "${{ github.event.issue.number }}";
  return { group: `${node.id}-${num}`, "cancel-in-progress": node.type === "issue-agent" };
}

export function wire(ir: Harness): WiringPlan {
  const perNode: Record<string, NodeWiring> = {};
  const byId = new Map(ir.nodes.map((n) => [n.id, n] as const));
  const incoming = new Map<string, HarnessEdge[]>();
  for (const n of ir.nodes) incoming.set(n.id, []);
  for (const e of ir.edges) incoming.get(e.to)?.push(e);

  for (const node of ir.nodes) {
    if (node.type === "start" || node.type === "exit") continue;

    const triggers: Record<string, any> = {};
    const guards = new Set<string>();
    const dispatches: { toNode: string; when?: string }[] = [];

    // scheduled nodes (e.g. merge-gate) are driven by cron + manual dispatch only
    if (node.attrs.schedule !== undefined) {
      triggers.schedule = [{ cron: String(node.attrs.schedule) }];
      triggers.workflow_dispatch = {};
    } else {
      for (const e of incoming.get(node.id) ?? []) {
        const w = wireEdge(e, node);
        if (!w) continue;
        for (const ev of w.events) mergeEvent(triggers, ev, node);
        if (w.guard) guards.add(w.guard);
      }
    }

    // outgoing internal dispatches (e.g. a maintenance node kicking a fixer)
    for (const e of ir.edges) {
      if (e.from === node.id && e.do) {
        dispatches.push({ toNode: e.to, when: e.when });
      }
    }

    const guard = guards.size ? [...guards].join(" || ") : undefined;
    const nw: NodeWiring = {
      nodeId: node.id,
      triggers,
      dispatches,
    };
    if (guard) nw.guard = guard;
    if (Object.keys(triggers).length) nw.concurrency = concurrencyKey(node);
    perNode[node.id] = nw;
  }

  void byId;
  return { perNode };
}
