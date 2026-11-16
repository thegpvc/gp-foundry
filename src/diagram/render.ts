/** B7 — render the harness graph to HARNESS.md (a Mermaid flowchart, generated from the IR). */
import type { Harness, HarnessNode, WiringPlan } from "../ir/types.js";
import { isEvaluateGate, parseEvaluateCheckName } from "../handlers/attrs.js";

/** A workflow's compiled `on:` block in words: "pull_request: opened, synchronize · workflow_dispatch". */
function triggerSummary(triggers: Record<string, unknown>): string {
  return Object.entries(triggers)
    .map(([event, spec]) => {
      if (event === "schedule" && Array.isArray(spec)) {
        return `schedule: ${spec.map((s) => `\`${(s as { cron?: string }).cron ?? "?"}\``).join(", ")}`;
      }
      const types = (spec as { types?: string[] } | null)?.types;
      return types?.length ? `${event}: ${types.join(", ")}` : event;
    })
    .join(" · ");
}

function shape(n: HarnessNode): [string, string] {
  switch (n.type) {
    case "start":
    case "exit":
      return ["([", "])"];
    case "human-gate":
      return ["{{", "}}"];
    case "merge-gate":
      return ["[/", "/]"];
    case "parallel":
    case "fan_in":
      // fork/join bars: virtual nodes — the diamond compiles into the fan_in's
      // single workflow, so neither gets a standalone file.
      return ["[[", "]]"];
    default:
      return ["[", "]"];
  }
}

function label(n: HarnessNode): string {
  const role = n.files.role?.replace(/^.*\//, "").replace(/\.md$/, "");
  const sub = role && role !== n.id ? `${role} · ${n.type}` : n.type;
  return `${n.id}<br/><small>${sub}${gateNote(n)}</small>`;
}

/** An evaluate gate never merges; say so, and name the check it publishes instead. */
function gateNote(n: HarnessNode): string {
  if (!isEvaluateGate(n)) return "";
  let check: string;
  try {
    check = parseEvaluateCheckName(n);
  } catch {
    return " · evaluate";
  }
  // Mermaid labels are double-quoted; keep the name from closing one.
  return ` · evaluate → check ${check.replace(/"/g, "'")}`;
}

export function renderDiagram(ir: Harness, wiring?: WiringPlan): string {
  const lines: string[] = ["```mermaid", "flowchart TD"];
  for (const n of ir.nodes) {
    const [l, r] = shape(n);
    lines.push(`  ${n.id}${l}"${label(n)}"${r}`);
  }
  for (const e of ir.edges) {
    const cond = [e.on, e.when].filter(Boolean).join(" · ");
    lines.push(cond ? `  ${e.from} -->|"${cond}"| ${e.to}` : `  ${e.from} --> ${e.to}`);
  }
  lines.push("```", "");
  // The graph shows the edges as written. What a workflow actually LISTENS for
  // can be more than that — skip="draft" adds ready_for_review, a schedule adds
  // manual dispatch — so the compiled triggers are listed as compiled.
  const rows = Object.values(wiring?.perNode ?? {}).filter((nw) => Object.keys(nw.triggers).length);
  if (rows.length) {
    lines.push("## Triggers", "", "| Workflow | Runs on |", "|----------|---------|");
    for (const nw of rows) lines.push(`| \`${nw.nodeId}\` | ${triggerSummary(nw.triggers)} |`);
    lines.push("");
  }
  return `<!-- GENERATED FROM harness.dot — DO NOT EDIT. Run \`gp-foundry build\`. -->\n\n# ${ir.config?.name && ir.config.name !== "harness" ? ir.config.name : ir.name} — agent harness\n\n${lines.join("\n")}`;
}
