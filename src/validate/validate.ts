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

  // Unfilled <placeholders> in config compile into workflows GitHub rejects at
  // parse time (or that reference nonexistent secrets/repos) — with exit 0.
  // Catch them here so a naive init+build cannot ship a broken factory.
  const scanPlaceholders = (v: unknown, path: string): void => {
    if (typeof v === "string") {
      const m = v.match(/<[A-Za-z][^<>]{0,80}>/);
      if (m) {
        diags.push({
          level: "error",
          code: "config.placeholder",
          message: `config value ${path} still contains the placeholder ${m[0]} — fill it in foundry.config.yaml`,
          hint: "generated workflows would be broken until every <placeholder> is replaced",
        });
      }
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => scanPlaceholders(x, `${path}[${i}]`));
    } else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) scanPlaceholders(x, path ? `${path}.${k}` : k);
    }
  };
  scanPlaceholders(ir.config, "");

  // Vendored runtime: the generated `uses: ./.github/actions/<n>` refs (and the
  // consumer-owned ./.github/agent-setup shim) must actually exist in the repo.
  if (deps.fileExists && (ir.config.runtime?.mode ?? "pinned") === "vendored") {
    const needed = new Set<string>();
    let hasAgent = false;
    for (const n of ir.nodes) {
      if (AGENT.has(n.type)) { hasAgent = true; needed.add("run-agent"); }
      if (AGENT.has(n.type) && n.type !== "scheduled-agent") needed.add("agent-context");
      if (n.type === "producer") needed.add("agent-fallback");
      if (n.type === "merge-gate") needed.add("merge-gate");
      if (n.type === "pr-review" && n.attrs.gates !== undefined) needed.add("wait-for-checks");
    }
    for (const a of needed) {
      if (!deps.fileExists(`actions/${a}/action.yml`)) {
        diags.push({
          level: "warning",
          code: "runtime.action-not-vendored",
          message: `runtime.mode is 'vendored' but .github/actions/${a}/ is missing`,
          hint: "run `gp-foundry vendor` to copy the runtime actions into the repo",
        });
      }
    }
    if (hasAgent && !deps.fileExists("agent-setup/action.yml")) {
      diags.push({
        level: "warning",
        code: "runtime.agent-setup-missing",
        message: "generated agent jobs use ./.github/agent-setup, which does not exist",
        hint: "run `gp-foundry vendor` (or `gp-foundry init`) to scaffold the agent-setup shim",
      });
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
        // Explicitly configured github-token with chained stages ships a factory
        // that green-stalls after the first stage: ERROR. When auth is merely
        // absent (mode defaulted), warn — the user hasn't made a choice yet.
        level: ir.config.auth?.mode === "github-token" ? "error" : "warning",
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
