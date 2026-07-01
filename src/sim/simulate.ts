/**
 * D — deterministic plumbing simulator (Tier 2). Drives the COMPILED wiring with
 * scripted GitHub events and a mock agent (a stub `run-agent`), asserting which
 * node workflows fire and how repo state advances — with zero live GitHub / LLM.
 *
 * This tests the trickiest compiler stage (wiring: triggers + guards) end to end.
 */
import type { Harness, NodeWiring, WiringPlan } from "../ir/types.js";
import { evalGuard } from "./gh-expr.js";

export interface SimEvent {
  /** GitHub event object, e.g. "issues" / "pull_request" / "pull_request_review". */
  event: string;
  /** the event action, e.g. "opened" / "labeled" / "submitted". */
  action?: string;
  /** the event payload placed at github.event.* */
  payload: Record<string, unknown>;
}

/** A mock agent: given the firing node + event, mutate state and emit follow-on events. */
export type MockAgent = (nodeId: string, ev: SimEvent, state: SimState) => SimEvent[];

export interface SimState {
  labels: Record<number, Set<string>>;
  prs: Set<number>;
  log: string[];
}

function triggerMatches(nw: NodeWiring, ev: SimEvent): boolean {
  const t = nw.triggers[ev.event] as { types?: string[] } | undefined;
  if (!t) return false;
  if (!ev.action) return true;
  return !t.types || t.types.includes(ev.action);
}

export interface SimResult {
  fired: string[];
  state: SimState;
  steps: number;
}

export function runScenario(
  ir: Harness,
  wiring: WiringPlan,
  seed: SimEvent[],
  agents: Record<string, MockAgent>,
  opts: { maxSteps?: number } = {},
): SimResult {
  const maxSteps = opts.maxSteps ?? 100;
  const state: SimState = { labels: {}, prs: new Set(), log: [] };
  const queue = [...seed];
  const fired: string[] = [];
  let steps = 0;

  while (queue.length && steps < maxSteps) {
    steps++;
    const ev = queue.shift()!;
    const ctx = { github: { event: ev.payload } };
    for (const node of ir.nodes) {
      const nw = wiring.perNode[node.id];
      if (!nw) continue;
      if (!triggerMatches(nw, ev)) continue;
      if (!evalGuard(nw.guard, ctx)) continue;
      fired.push(node.id);
      state.log.push(`${ev.event}.${ev.action ?? ""} → ${node.id}`);
      const agent = agents[node.id];
      if (agent) queue.push(...agent(node.id, ev, state));
    }
  }
  return { fired, state, steps };
}
