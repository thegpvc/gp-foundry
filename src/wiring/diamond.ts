/**
 * Diamond detection for parallel/fan_in (v1: the "clean diamond" restriction).
 *
 *   A -> P [on=E]        P [type=parallel]
 *   P -> L1, P -> L2     legs: agent nodes, exactly one in (from P), one out (to F)
 *   L1 -> F, L2 -> F     F [type=fan_in]
 *
 * A well-formed diamond compiles into ONE workflow: the legs as sibling jobs plus
 * the fan_in job joined with GitHub's native `needs:` — no marker ledger, no extra
 * triggers, no join state. (Non-diamond joins are a documented v2 concern.)
 */
import type { Harness, HarnessEdge } from "../ir/types.js";
import { AGENT_TYPES } from "../ir/types.js";

const AGENT = new Set<string>(AGENT_TYPES);

export interface Diamond {
  parallelId: string;
  /** The single edge INTO the parallel node — carries the whole diamond's trigger. */
  entryEdge: HarnessEdge;
  legIds: string[];
  faninId: string;
}

export interface DiamondPlan {
  byFanin: Map<string, Diamond>;
  /** parallel + leg node ids consumed by a well-formed diamond (no standalone workflow). */
  memberIds: Set<string>;
}

export function detectDiamonds(ir: Harness): DiamondPlan {
  const byId = new Map(ir.nodes.map((n) => [n.id, n] as const));
  const inEdges = new Map<string, HarnessEdge[]>();
  const outEdges = new Map<string, HarnessEdge[]>();
  for (const n of ir.nodes) {
    inEdges.set(n.id, []);
    outEdges.set(n.id, []);
  }
  for (const e of ir.edges) {
    inEdges.get(e.to)?.push(e);
    outEdges.get(e.from)?.push(e);
  }

  const byFanin = new Map<string, Diamond>();
  const memberIds = new Set<string>();

  for (const f of ir.nodes) {
    if (f.type !== "fan_in") continue;
    const legEdges = inEdges.get(f.id) ?? [];
    if (legEdges.length < 2) continue;

    const legIds: string[] = [];
    let parallelId: string | undefined;
    let ok = true;
    for (const le of legEdges) {
      const leg = byId.get(le.from);
      if (!leg || !AGENT.has(leg.type)) { ok = false; break; }
      const legIn = inEdges.get(leg.id) ?? [];
      const legOut = outEdges.get(leg.id) ?? [];
      // clean diamond: leg has exactly one in (from a shared parallel), one out (to F)
      if (legIn.length !== 1 || legOut.length !== 1 || legOut[0]!.to !== f.id) { ok = false; break; }
      const p = byId.get(legIn[0]!.from);
      if (!p || p.type !== "parallel") { ok = false; break; }
      // P -> leg edges must be bare; the trigger lives on the entry edge
      if (legIn[0]!.on || legIn[0]!.when) { ok = false; break; }
      if (parallelId === undefined) parallelId = p.id;
      else if (parallelId !== p.id) { ok = false; break; }
      legIds.push(leg.id);
    }
    if (!ok || parallelId === undefined) continue;

    // the parallel node: exactly one in-edge (with on=), and ALL its successors are F's legs
    const pIn = inEdges.get(parallelId) ?? [];
    const pOut = outEdges.get(parallelId) ?? [];
    if (pIn.length !== 1 || !pIn[0]!.on) continue;
    const legSet = new Set(legIds);
    if (!pOut.every((e) => legSet.has(e.to)) || pOut.length !== legIds.length) continue;

    byFanin.set(f.id, { parallelId, entryEdge: pIn[0]!, legIds, faninId: f.id });
    memberIds.add(parallelId);
    for (const l of legIds) memberIds.add(l);
  }

  return { byFanin, memberIds };
}
