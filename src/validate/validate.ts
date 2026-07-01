/**
 * B2 — Validator. IR → Diagnostic[] for referential integrity, node requirements,
 * file existence, and the role-handoff ↔ out-edge cross-check.
 *
 * Pure: file existence and role specs are injected so this stays testable.
 */
import type { Diagnostic, Harness, HarnessNode, RoleSpec } from "../ir/types.js";
import { AGENT_TYPES } from "../ir/types.js";
import { resolveAuth } from "../auth/auth.js";

export interface ValidateDeps {
  /** returns true if a consumer-repo-relative path exists. Omit to skip file checks. */
  fileExists?: (relPath: string) => boolean;
  /** parsed role specs keyed by node id. Omit to skip the handoff cross-check. */
  roles?: Map<string, RoleSpec>;
}

const AGENT = new Set(AGENT_TYPES);

export function validate(ir: Harness, deps: ValidateDeps = {}): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const byId = new Map(ir.nodes.map((n) => [n.id, n] as const));

  // Referential: every edge endpoint must be a declared node.
  for (const n of ir.nodes) {
    if (!n.declared) {
      diags.push({
        level: "error",
        code: "node.undeclared",
        message: `node '${n.id}' is referenced in an edge but never declared`,
        where: { node: n.id, line: n.line },
        hint: `add a node statement, e.g. ${n.id} [type=...]`,
      });
    }
  }

  // Per-node requirements.
  for (const n of ir.nodes) {
    if (AGENT.has(n.type) && !n.files.role) {
      diags.push({
        level: "error",
        code: "node.missing-role",
        message: `agent node '${n.id}' (type ${n.type}) needs a role="..." job description`,
        where: { node: n.id, line: n.line },
      });
    }
    if (n.type === "human-gate" && n.attrs.environment === undefined) {
      diags.push({
        level: "error",
        code: "node.human-gate-no-environment",
        message: `human-gate '${n.id}' must set environment=<name> (maps to a protected GitHub Environment)`,
        where: { node: n.id, line: n.line },
      });
    }
    if (n.type === "merge-gate" && !n.files.policy) {
      diags.push({
        level: "warning",
        code: "node.merge-gate-no-policy",
        message: `merge-gate '${n.id}' has no policy="..."; default merge policy will be used`,
        where: { node: n.id, line: n.line },
      });
    }
  }

  // File existence.
  if (deps.fileExists) {
    for (const n of ir.nodes) {
      for (const key of ["role", "policy", "prompt", "tools"] as const) {
        const rel = n.files[key];
        if (rel && !deps.fileExists(rel)) {
          diags.push({
            level: "error",
            code: "file.missing",
            message: `node '${n.id}' references ${key}="${rel}" which does not exist`,
            where: { node: n.id, line: n.line, file: rel },
          });
        }
      }
    }
  }

  // Role handoffs ↔ out-edges cross-check.
  if (deps.roles) {
    const outByNode = new Map<string, HarnessNode[]>();
    for (const n of ir.nodes) outByNode.set(n.id, []);
    for (const e of ir.edges) {
      const to = byId.get(e.to);
      if (to) outByNode.get(e.from)?.push(to);
    }
    const nameOf = (n: HarnessNode) =>
      (deps.roles?.get(n.id)?.role ?? n.id).toLowerCase();

    for (const n of ir.nodes) {
      const spec = deps.roles.get(n.id);
      if (!spec?.handoffs) continue;
      const outTargets = outByNode.get(n.id) ?? [];
      const outNames = new Set(outTargets.flatMap((t) => [t.id.toLowerCase(), nameOf(t)]));
      const handoffNames = new Set(spec.handoffs.map((h) => String(h.to).toLowerCase()));

      for (const h of spec.handoffs) {
        if (!outNames.has(String(h.to).toLowerCase())) {
          diags.push({
            level: "warning",
            code: "role.handoff-no-edge",
            message: `role '${spec.role}' (node '${n.id}') declares a handoff to '${h.to}' but there is no matching out-edge`,
            where: { node: n.id },
            hint: "add the edge, or remove the handoff so the job description matches the graph",
          });
        }
      }
      for (const t of outTargets) {
        if (t.type === "exit") continue;
        if (!handoffNames.has(t.id.toLowerCase()) && !handoffNames.has(nameOf(t))) {
          diags.push({
            level: "warning",
            code: "role.edge-no-handoff",
            message: `node '${n.id}' has an out-edge to '${t.id}' not declared as a handoff in role '${spec.role}'`,
            where: { node: n.id, edge: [n.id, t.id] },
            hint: "document the handoff in the role, or remove the edge",
          });
        }
      }
    }
  }

  // Auth: github-token cannot trigger downstream workflows, so event-cascade
  // edges (a PR/push produced by one agent that should fire the next) won't run.
  if (resolveAuth(ir.config).mode === "github-token") {
    const cascades = ir.edges.filter((e) =>
      /^(pull_request\.opened|pull_request\.synchronize|push)/.test(e.on ?? ""),
    );
    if (cascades.length) {
      diags.push({
        level: "warning",
        code: "auth.github-token-no-cascade",
        message:
          "auth mode 'github-token': commits/PRs made with GITHUB_TOKEN do not trigger other workflows, so " +
          `${cascades.length} event-cascade edge(s) (pull_request.opened/synchronize/push) will not fire and the harness will stall`,
        hint: "use auth.mode 'app' or 'pat' (a fine-grained PAT secret), or drive those stages via explicit dispatch",
      });
    }
  }

  // At least one entry.
  const hasEntry = ir.nodes.some(
    (n) => n.type === "start" || n.attrs.schedule !== undefined || n.type === "merge-gate",
  );
  if (!hasEntry) {
    diags.push({
      level: "warning",
      code: "graph.no-entry",
      message: "harness has no entry node (a start node or a scheduled node) — nothing will trigger it",
    });
  }

  return diags;
}
