/**
 * B2 — Validator. IR → Diagnostic[] for referential integrity, node requirements,
 * file existence, and the role-handoff ↔ out-edge cross-check.
 *
 * Pure: file existence and role specs are injected so this stays testable.
 */
import type { Diagnostic, Harness, HarnessEdge, HarnessNode, RoleSpec } from "../ir/types.js";
import { AGENT_TYPES } from "../ir/types.js";
import { resolveAuth } from "../auth/auth.js";
import { parsePermissionsAttr } from "../handlers/index.js";
import {
  KNOWN_EDGE_ATTRS,
  KNOWN_NODE_ATTRS,
  hasPrContext,
  nearestAttr,
  parseAuthors,
  parseConfigAuthors,
  parseGates,
  parseSkip,
  takesAuthors,
} from "../handlers/attrs.js";
import { detectDiamonds } from "../wiring/diamond.js";

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
  const diamondMembers = detectDiamonds(ir).memberIds;

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

  // Unknown attributes. The parser keeps whatever it is handed, so without this
  // a typo or an attribute from a newer gp-foundry compiles cleanly and does
  // nothing — fatal when the attribute was a restriction the user is relying on.
  const unknownAttr = (name: string, known: ReadonlySet<string>, on: string, where: Diagnostic["where"]): void => {
    const near = nearestAttr(name, known);
    diags.push({
      level: "error",
      code: "attr.unknown",
      message: `unknown attribute '${name}=' on ${on} — it would be silently ignored`,
      where,
      hint: near
        ? `did you mean '${near}='?`
        : "see reference/node-types.md for the attributes this version of gp-foundry understands",
    });
  };
  for (const n of ir.nodes) {
    for (const k of Object.keys(n.raw)) {
      if (!KNOWN_NODE_ATTRS.has(k)) unknownAttr(k, KNOWN_NODE_ATTRS, `node '${n.id}'`, { node: n.id, line: n.line });
    }
  }
  for (const e of ir.edges) {
    for (const k of Object.keys(e.raw)) {
      if (!KNOWN_EDGE_ATTRS.has(k)) {
        unknownAttr(k, KNOWN_EDGE_ATTRS, `edge '${e.from} -> ${e.to}'`, { edge: [e.from, e.to], line: e.line });
      }
    }
  }

  // repo.authors (config-wide allowlist) is checked once, not per node.
  try {
    parseConfigAuthors(ir.config);
  } catch (e) {
    diags.push({
      level: "error",
      code: "config.bad-authors",
      message: (e as Error).message,
      hint: "repo.authors is a list of GitHub logins, e.g. authors: [dpup]",
    });
  }

  // Per-node requirements.
  for (const n of ir.nodes) {
    if (n.attrs.authors !== undefined) {
      if (!takesAuthors(n) || diamondMembers.has(n.id)) {
        // An error for the same reason an unknown attribute is: an allowlist
        // that binds nothing reads, in the spec, exactly like one that does.
        diags.push({
          level: "error",
          code: "node.authors-unsupported",
          message: `authors= on '${n.id}' is not supported here — it binds a standalone pr-review / pr-fix node, or an analyst with context="pr-diff" or "pr-review"`,
          where: { node: n.id, line: n.line },
          hint: diamondMembers.has(n.id)
            ? "a diamond is bound by repo.authors in foundry.config.yaml"
            : "to restrict every PR lane at once, set repo.authors in foundry.config.yaml",
        });
      } else {
        try {
          parseAuthors(n, ir.config);
        } catch (e) {
          diags.push({
            level: "error",
            code: "node.bad-authors",
            message: (e as Error).message,
            where: { node: n.id, line: n.line },
            hint: `comma-separated GitHub logins, e.g. authors="dpup, octocat"`,
          });
        }
      }
    }
    if (AGENT.has(n.type) && !n.files.role) {
      diags.push({
        level: "error",
        code: "node.missing-role",
        message: `agent node '${n.id}' (type ${n.type}) needs a role="..." job description`,
        where: { node: n.id, line: n.line },
      });
    }
    if (n.attrs.permissions !== undefined) {
      try {
        parsePermissionsAttr(n);
      } catch (e) {
        diags.push({
          level: "error",
          code: "node.bad-permissions",
          message: (e as Error).message,
          where: { node: n.id, line: n.line },
          hint: `write scopes as '<scope>: read|write|none', comma-separated — e.g. permissions="id-token: write"`,
        });
      }
      // A scope granted on a node that emits no job would vanish silently, and the
      // user would discover it as a cryptic runtime failure (e.g. OIDC federation
      // erroring in a lane that never got id-token). Say so at build time instead.
      if (n.type === "start" || n.type === "exit" || n.type === "parallel") {
        diags.push({
          level: "warning",
          code: "node.permissions-ignored",
          message: `permissions= on '${n.id}' (type ${n.type}) is ignored — this node emits no workflow job`,
          where: { node: n.id, line: n.line },
          hint: "move permissions= to the lane (job-emitting node) that needs the scope",
        });
      }
    }
    if (n.attrs.agent_attempts !== undefined) {
      // Fail closed rather than silently coercing. A typo'd agent_attempts="3 " or
      // agent_attempts=0 would otherwise reach the runner as a retry budget nobody
      // intended — 0 would mean the CLI is never invoked at all.
      const a = n.attrs.agent_attempts;
      if (typeof a !== "number" || !Number.isInteger(a) || a < 1) {
        diags.push({
          level: "error",
          code: "node.bad-agent-attempts",
          message: `agent_attempts= on '${n.id}' must be a whole number >= 1, got ${JSON.stringify(a)}`,
          where: { node: n.id, line: n.line },
          hint: `1 disables retrying; omit the attr to use run-agent's default — e.g. agent_attempts=1`,
        });
      }
      // Only a node that emits a run-agent step has anything to retry. Set it
      // elsewhere and it vanishes at compile time, which the user would discover
      // as "my lane still retried" long after the fact.
      if (!AGENT.has(n.type)) {
        diags.push({
          level: "warning",
          code: "node.agent-attempts-ignored",
          message: `agent_attempts= on '${n.id}' (type ${n.type}) is ignored — this node runs no agent`,
          where: { node: n.id, line: n.line },
          hint: "move agent_attempts= to the agent lane whose retry budget you meant to change",
        });
      }
    }
    if (n.attrs.cancel_in_progress !== undefined) {
      if (typeof n.attrs.cancel_in_progress !== "boolean") {
        diags.push({
          level: "error",
          code: "node.bad-cancel-in-progress",
          message: `cancel_in_progress= on '${n.id}' must be true or false, got ${JSON.stringify(n.attrs.cancel_in_progress)}`,
          where: { node: n.id, line: n.line },
        });
      }
      // Concurrency is per WORKFLOW: a diamond's is the fan_in's, fixed at "never
      // cancel a join mid-synthesis", so the attr on a leg would do nothing.
      if (!AGENT.has(n.type) || diamondMembers.has(n.id)) {
        diags.push({
          level: "warning",
          code: "node.cancel-in-progress-ignored",
          message: `cancel_in_progress= on '${n.id}' is ignored — it applies to an agent node that owns its own workflow`,
          where: { node: n.id, line: n.line },
          hint: "set it on a standalone agent lane (analyst, issue-agent, producer, pr-review, pr-fix, scheduled-agent)",
        });
      } else if (
        n.attrs.cancel_in_progress === true &&
        (n.type === "producer" || n.type === "pr-fix" || (n.type === "scheduled-agent" && n.attrs.commit !== "none"))
      ) {
        // Not an error — sometimes newest-wins is exactly right — but the cost is
        // invisible until it bites: cancellation skips the `!cancelled()` salvage.
        diags.push({
          level: "warning",
          code: "node.cancel-in-progress-discards-work",
          message: `cancel_in_progress=true on '${n.id}' (type ${n.type}): a cancelled run skips the commit/push salvage, so whatever the agent had written but not yet pushed is lost`,
          where: { node: n.id, line: n.line },
          hint: "keep it for lanes where the newer event supersedes the older run's work; otherwise leave the default (queue)",
        });
      }
    }
    if (n.attrs.checkout !== undefined) {
      if (n.attrs.checkout !== "partial") {
        diags.push({
          level: "error",
          code: "node.bad-checkout",
          message: `checkout= on '${n.id}' must be "partial", got ${JSON.stringify(n.attrs.checkout)}`,
          where: { node: n.id, line: n.line },
          hint: `checkout="partial" is a blob-less clone with full history; omit the attr for the lane's default checkout`,
        });
      } else if (n.type === "start" || n.type === "exit" || n.type === "parallel" || n.type === "human-gate") {
        diags.push({
          level: "warning",
          code: "node.checkout-ignored",
          message: `checkout= on '${n.id}' (type ${n.type}) is ignored — this node checks nothing out`,
          where: { node: n.id, line: n.line },
        });
      }
    }
    if (n.attrs.gates !== undefined) {
      try {
        parseGates(n);
      } catch (e) {
        diags.push({
          level: "error",
          code: "node.bad-gates",
          message: (e as Error).message,
          where: { node: n.id, line: n.line },
          hint: `comma-separated workflow files or check-run names, each with an optional ?<seconds> grace — e.g. gates="ci.yml, e2e (chromium)?90"`,
        });
      }
    }
    if (n.attrs.skip !== undefined) {
      let conds: ReturnType<typeof parseSkip> = [];
      try {
        conds = parseSkip(n);
      } catch (e) {
        diags.push({
          level: "error",
          code: "node.bad-skip",
          message: (e as Error).message,
          where: { node: n.id, line: n.line },
          hint: `e.g. skip="draft,bot-author,label:no-agent-review,unchanged-diff"`,
        });
      }
      const eventDrivenPrLane =
        (n.type === "pr-review" || n.type === "analyst") &&
        hasPrContext(n) &&
        n.attrs.schedule === undefined &&
        !diamondMembers.has(n.id);
      if (!eventDrivenPrLane) {
        // An error, not an "ignored" warning: skip= is a promise that some PRs
        // are NOT reviewed, and silently reviewing them anyway breaks it.
        diags.push({
          level: "error",
          code: "node.skip-unsupported",
          message: `skip= on '${n.id}' is not supported here — it needs a standalone, event-driven pr-review/analyst node with context="pr-diff" or "pr-review"`,
          where: { node: n.id, line: n.line },
          hint:
            n.attrs.select !== undefined || n.attrs.schedule !== undefined
              ? "a scheduled (select=\"sweep\") lane picks its own PRs; skip= guards a lane that reacts to PR events"
              : diamondMembers.has(n.id)
                ? "a diamond leg has no guard job of its own; put the review lane outside the diamond"
                : `set context="pr-diff" on the node — skip= reads the pull request the event is about`,
        });
      }
      if (conds.some((c) => c.kind === "unchanged-diff") && !ir.config.identity?.bot_login) {
        diags.push({
          level: "error",
          code: "node.skip-needs-bot-login",
          message: `skip="unchanged-diff" on '${n.id}' compares against the bot's last review, but identity.bot_login is unset`,
          where: { node: n.id, line: n.line },
          hint: "set identity.bot_login in foundry.config.yaml to the login that posts the reviews",
        });
      }
    }
    if (n.attrs.select !== undefined) {
      if (n.attrs.select !== "sweep") {
        diags.push({
          level: "error",
          code: "node.bad-select",
          message: `select= on '${n.id}' must be "sweep", got ${JSON.stringify(n.attrs.select)}`,
          where: { node: n.id, line: n.line },
        });
      } else if (n.type !== "pr-review" || !hasPrContext(n) || diamondMembers.has(n.id)) {
        diags.push({
          level: "error",
          code: "node.select-unsupported",
          message: `select="sweep" on '${n.id}' needs a standalone pr-review node with context="pr-diff" or "pr-review"`,
          where: { node: n.id, line: n.line },
        });
      } else if (n.attrs.schedule === undefined) {
        diags.push({
          level: "error",
          code: "node.sweep-no-schedule",
          message: `select="sweep" on '${n.id}' needs schedule="<cron>" — a sweep is driven by its schedule, not by PR events`,
          where: { node: n.id, line: n.line },
          hint: `e.g. schedule="*/15 * * * *"`,
        });
      } else if (!ir.config.identity?.bot_login) {
        diags.push({
          level: "warning",
          code: "node.sweep-no-bot-login",
          message: `select="sweep" on '${n.id}': identity.bot_login is unset, so ANY review carrying a '**Verdict:**' marker counts as the decision — a user can pre-empt the lane by posting one`,
          where: { node: n.id, line: n.line },
          hint: "set identity.bot_login in foundry.config.yaml to the login that posts the verdict",
        });
      }
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
    const outByNode = new Map<string, { node: HarnessNode; edge: HarnessEdge }[]>();
    for (const n of ir.nodes) outByNode.set(n.id, []);
    for (const e of ir.edges) {
      const to = byId.get(e.to);
      if (to) outByNode.get(e.from)?.push({ node: to, edge: e });
    }
    const nameOf = (n: HarnessNode) =>
      (deps.roles?.get(n.id)?.role ?? n.id).toLowerCase();

    for (const n of ir.nodes) {
      const spec = deps.roles.get(n.id);
      if (!spec?.handoffs) continue;
      const outTargets = outByNode.get(n.id) ?? [];
      const outNames = new Set(outTargets.flatMap((t) => [t.node.id.toLowerCase(), nameOf(t.node)]));
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
      for (const { node: t, edge } of outTargets) {
        // A CONDITIONAL edge to an exit (e.g. `fixer -> needs_human
        // [when="attempts>=3"]`) is a real handoff the role must document — it's
        // the escape hatch an operator reads the role to understand. A bare,
        // unconditional edge to an exit is just the lane's terminus; exempt.
        if (t.type === "exit" && !edge.when) continue;
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
      // scheduled lanes push to the base branch through the same strip-and-push
      // composite the producer uses.
      if (n.type === "producer" || n.type === "scheduled-agent") needed.add("agent-fallback");
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

  // parallel/fan_in: v1 supports CLEAN DIAMONDS ONLY — one entry edge into the
  // parallel, ≥2 bare edges to agent legs, every leg exactly one-in-one-out into a
  // single fan_in. A well-formed diamond compiles to one workflow (legs + a
  // `needs:`-joined fan_in job); anything else is an error, not a silent no-op.
  {
    const { byFanin, memberIds } = detectDiamonds(ir);
    for (const n of ir.nodes) {
      if (n.type === "parallel" && !memberIds.has(n.id)) {
        diags.push({
          level: "error",
          code: "diamond.malformed",
          message: `parallel '${n.id}' is not part of a clean diamond (need: exactly one in-edge carrying on=, ≥2 bare out-edges to agent legs that each flow into one fan_in)`,
          where: { node: n.id, line: n.line },
          hint: "see reference/node-types.md — v1 supports clean parallel→legs→fan_in diamonds only",
        });
      }
      if (n.type === "fan_in") {
        const d = byFanin.get(n.id);
        if (!d) {
          diags.push({
            level: "error",
            code: "diamond.malformed",
            message: `fan_in '${n.id}' is not the join of a clean diamond (need ≥2 legs, each with exactly one in-edge from a shared parallel and one out-edge into this fan_in)`,
            where: { node: n.id, line: n.line },
            hint: "see reference/node-types.md — v1 supports clean parallel→legs→fan_in diamonds only",
          });
        } else {
          if (!n.files.role && n.attrs.on_complete_label === undefined) {
            diags.push({
              level: "error",
              code: "diamond.unobservable-join",
              message: `fan_in '${n.id}' has neither a role nor on_complete_label — its completion would be unobservable`,
              where: { node: n.id, line: n.line },
              hint: 'give it a role="..." (synthesize the lanes) and/or on_complete_label=<label> to cascade the next stage',
            });
          }
          // The verdict-bypass trap: a pr-review-typed LANE that posts a
          // '**Verdict:**' review would trigger the merge gate / verdict guards
          // directly, bypassing the join entirely.
          const prLegs = d.legIds.filter((id) => byId.get(id)?.type === "pr-review");
          if (prLegs.length) {
            diags.push({
              level: "warning",
              code: "diamond.lane-verdict-risk",
              message: `fan_in '${n.id}' lanes [${prLegs.join(", ")}] are pr-review typed — if a lane role posts a '**Verdict:**' review, the merge gate acts on ONE lane's opinion and the join is bypassed`,
              where: { node: n.id },
              hint: "lane roles must post ANALYSES (plain comments); only the fan_in role posts the verdict",
            });
          }
        }
      }
    }
  }

  // Auth: github-token cannot trigger downstream workflows, so event-cascade
  // edges (a PR/push produced by one agent that should fire the next) won't run.
  if (resolveAuth(ir.config).mode === "github-token") {
    const cascades = ir.edges.filter(
      (e) =>
        /^(pull_request\.opened|pull_request\.synchronize|push)/.test(e.on ?? "") ||
        // label= / verdict= guards synthesize issues.labeled / pull_request_review
        // triggers — those events are ALSO suppressed for GITHUB_TOKEN-made writes.
        /^(label=|verdict=)/.test(e.when ?? ""),
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

  // A verdict edge compiles to `contains(review.body, '**Verdict:** …')`. That
  // marker is a string any user can put in a review, so the guard also checks the
  // reviewing actor — which needs a login to compare against.
  if (!ir.config.identity?.bot_login && ir.edges.some((e) => /^verdict=/.test(e.when ?? ""))) {
    diags.push({
      level: "warning",
      code: "auth.no-bot-login",
      message:
        "identity.bot_login is unset, so verdict-triggered workflows (fixer, human-gate) guard only on the verdict marker — any user who can review the PR can fire them",
      hint: "set identity.bot_login in foundry.config.yaml to the login that posts the reviews",
    });
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
