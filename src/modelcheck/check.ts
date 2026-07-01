/**
 * B3 — Graph model-checker. Pure graph theory over the IR (no GitHub/Claude knowledge).
 *
 * Catches the topology bugs that map to real production incidents:
 *  - unreachable nodes
 *  - dead ends (a non-sink node with nowhere to go)
 *  - unbounded loops (a cycle with no escape edge) — the dixie fixer↔merger livelock class
 *  - loop escapes with no bounded-looking guard (softer warning)
 *  - ambiguous routing (two identical (on,when) edges from one node to different targets)
 */
import type { Diagnostic, Harness, HarnessNode } from "../ir/types.js";

/** Types that are legitimate terminals (no outgoing edge required). */
const SINK_TYPES = new Set(["exit", "merge-gate", "human-gate", "scheduled-agent"]);
const ENTRY_TYPES = new Set(["start"]);

export function modelCheck(ir: Harness): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const ids = new Set(ir.nodes.map((n) => n.id));
  const byId = new Map(ir.nodes.map((n) => [n.id, n] as const));
  const out = new Map<string, string[]>();
  for (const id of ids) out.set(id, []);
  for (const e of ir.edges) {
    if (ids.has(e.from) && ids.has(e.to)) out.get(e.from)!.push(e.to);
  }

  const entries = ir.nodes.filter(
    (n) => ENTRY_TYPES.has(n.type) || n.attrs.schedule !== undefined || n.type === "merge-gate",
  );

  // ── Reachability from entries ──
  const seen = new Set<string>();
  const stack = entries.map((n) => n.id);
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const t of out.get(id) ?? []) stack.push(t);
  }
  for (const n of ir.nodes) {
    if (!seen.has(n.id) && !ENTRY_TYPES.has(n.type)) {
      diags.push({
        level: "warning",
        code: "graph.unreachable",
        message: `node '${n.id}' is unreachable from any entry (start/scheduled) node`,
        where: { node: n.id, line: n.line },
        hint: "add an incoming edge, a schedule=, or a start node that leads here",
      });
    }
  }

  // ── Dead ends ──
  for (const n of ir.nodes) {
    const deg = (out.get(n.id) ?? []).length;
    if (deg === 0 && !SINK_TYPES.has(n.type)) {
      diags.push({
        level: "warning",
        code: "graph.dead-end",
        message: `node '${n.id}' (type ${n.type}) has no outgoing edge and is not a sink (exit/merge-gate/human-gate)`,
        where: { node: n.id, line: n.line },
        hint: "route it to a next node, or make it an exit",
      });
    }
  }

  // ── Cycles via Tarjan SCC, then unbounded-loop check ──
  for (const scc of tarjanSCCs(ids, out)) {
    const isCycle = scc.length > 1 || (out.get(scc[0]!) ?? []).includes(scc[0]!);
    if (!isCycle) continue;
    const inScc = new Set(scc);
    const escapes: { from: string; to: string }[] = [];
    for (const id of scc) {
      for (const t of out.get(id) ?? []) {
        if (!inScc.has(t)) escapes.push({ from: id, to: t });
      }
    }
    if (escapes.length === 0) {
      diags.push({
        level: "error",
        code: "graph.unbounded-loop",
        message: `cycle {${scc.join(" → ")}} has no escape edge — this is a livelock`,
        where: { node: scc[0] },
        hint: "add a bounded escape edge (e.g. when=\"attempts>=N\" → needs-human/exit)",
      });
    } else if (!escapes.some((e) => guardLooksBounded(cycleEscapeGuard(ir, e.from, e.to)))) {
      diags.push({
        level: "warning",
        code: "graph.loop-escape-unbounded",
        message: `cycle {${scc.join(" → ")}} escapes, but no escape guard looks bounded (no >=, attempts, max, count, limit)`,
        where: { node: scc[0] },
        hint: "guard the escape with an explicit bound so the loop provably terminates",
      });
    }
  }

  // ── Ambiguous routing ──
  const bySource = new Map<string, Map<string, Set<string>>>();
  for (const e of ir.edges) {
    const key = `${e.on ?? ""}|${e.when ?? ""}`;
    if (!bySource.has(e.from)) bySource.set(e.from, new Map());
    const m = bySource.get(e.from)!;
    if (!m.has(key)) m.set(key, new Set());
    m.get(key)!.add(e.to);
  }
  for (const [from, m] of bySource) {
    for (const [key, targets] of m) {
      if (targets.size > 1 && key !== "|") {
        diags.push({
          level: "warning",
          code: "graph.ambiguous-routing",
          message: `node '${from}' has multiple edges with identical trigger/guard (${key}) to different targets: ${[...targets].join(", ")}`,
          where: { node: from },
          hint: "distinguish the guards, or the transition is nondeterministic",
        });
      }
    }
  }

  void byId;
  return diags;
}

function cycleEscapeGuard(ir: Harness, from: string, to: string): string | undefined {
  return ir.edges.find((e) => e.from === from && e.to === to)?.when;
}

function guardLooksBounded(when: string | undefined): boolean {
  if (!when) return false;
  return /(>=|>|attempts|max|count|limit)/i.test(when);
}

/** Tarjan's strongly-connected-components. */
function tarjanSCCs(ids: Set<string>, out: Map<string, string[]>): string[][] {
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stk: string[] = [];
  const result: string[][] = [];

  const strongconnect = (v: string) => {
    idx.set(v, index);
    low.set(v, index);
    index++;
    stk.push(v);
    onStack.add(v);
    for (const w of out.get(v) ?? []) {
      if (!idx.has(w)) {
        strongconnect(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, idx.get(w)!));
      }
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = [];
      let w: string;
      do {
        w = stk.pop()!;
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      result.push(comp.reverse());
    }
  };

  for (const v of ids) if (!idx.has(v)) strongconnect(v);
  return result;
}
