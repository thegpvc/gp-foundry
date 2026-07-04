/** B7 — render the harness graph to HARNESS.md (a Mermaid flowchart, generated from the IR). */
import type { Harness, HarnessNode } from "../ir/types.js";

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
  return `${n.id}<br/><small>${sub}</small>`;
}

export function renderDiagram(ir: Harness): string {
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
  return `<!-- GENERATED FROM harness.dot — DO NOT EDIT. Run \`gp-foundry build\`. -->\n\n# ${ir.config?.name && ir.config.name !== "harness" ? ir.config.name : ir.name} — agent harness\n\n${lines.join("\n")}`;
}
