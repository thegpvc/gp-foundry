# gp-foundry

**Compile a directed graph into an autonomous GitHub Actions agent harness.**

gp-foundry turns an autonomous agent pipeline — *issues in → reviewed, auto-merged
PRs out* — into something you **declare once as a graph and compile** into a repo.
A single `harness.dot` (Graphviz DOT) is the source of truth for the harness
*topology*; a deterministic compiler emits plain GitHub Actions workflows from it.
**GitHub stays the executor** (native events, per-job least-privilege, Environment
approvals, secrets, scheduling); a small, pinned **runtime core** of actions are the
node handlers; and roles/prompts/policy are **externalized content**, edited freely
(and by the harness itself), never baked into the generated YAML.

Nothing here is code-specific: a node's mechanical *type* (a GitHub interaction) is
separate from its *role* (the job description), so the same pipeline that ships Go
code can ship marketing copy, docs, or config.

## The DOT → Actions model

```
harness.dot ──▶ parse ──▶ validate ──▶ model-check ──▶ assemble ──▶ .github/workflows/*.yml
 (topology)      IR         schema      reachability     fragments      (GENERATED,
                                        + cycle bounds   + wiring        drift-checked)
```

- **Nodes are roles.** Each node has a `type` (mechanical: `issue-agent`,
  `producer`, `pr-review`, `pr-fix`, `merge-gate`, `human-gate`, plus `start`/`exit`)
  and a `role="roles/<name>.md"` that carries the domain-specific job description.
- **Edges are transitions.** Expressed only in GitHub-observable primitives
  (`on="issues.opened"`, `when="label=agent"`, `when="verdict=approve"`), so the
  platform — not a bespoke engine — drives the loop.
- **Generated workflows are a build artifact.** Every emitted `.yml` carries a
  `# GENERATED FROM harness.dot — DO NOT EDIT` header and is drift-checked in CI.
  You evolve a harness by editing the spec and rebuilding in a PR, never by hand.
- **Content is runtime-loaded.** Editing a prompt or role needs no rebuild; only
  topology/policy changes recompile.

A minimal spec:

```dot
digraph harness {
  start     [type=start]
  scout     [type=issue-agent, role="roles/scout.md"]
  builder   [type=producer,    role="roles/builder.md"]
  reviewer  [type=pr-review,   role="roles/reviewer.md"]
  fixer     [type=pr-fix,      role="roles/fixer.md", max_attempts=2]
  gate      [type=merge-gate]

  start    -> scout    [on="issues.opened"]
  scout    -> builder  [when="label=agent"]
  builder  -> reviewer [on="pull_request.opened"]
  reviewer -> gate     [when="verdict=approve"]
  reviewer -> fixer    [when="verdict=request_changes"]
  fixer    -> reviewer [on="push"]
}
```

## Quickstart

There are **two first-class front doors over one engine** — a Claude skill for
discovery and setup, and a CLI for power users, scripting, and CI's drift-check.
Both drive the same deterministic compiler.

### Via the Claude skill (Socratic setup)

Inside a target repo, invoke the packaged skill. It interviews you about your
pipeline, scaffolds `harness.dot` + roles + config, then compiles and explains the
diff. It shells out to the CLI under the hood, so results are identical to a manual
build — and it can reconcile against local edits when you regenerate.

### Via the CLI

```bash
gp-foundry init                # scaffold harness.dot + foundry.config.yaml + roles/
gp-foundry validate            # schema + reachability + bounded-cycle checks
gp-foundry build               # compile harness.dot → .github/workflows/*.yml
gp-foundry build --check       # drift gate: fail if generated YAML is out of date
gp-foundry build --dry-run     # preview the diff without writing
gp-foundry graph               # render / inspect the topology
gp-foundry explain <node>      # show what a node compiles to
```

Add `--json` to any command for machine/agent-consumable output. Diagnostics report
`file:line` with fix hints.

**Consumer repo layout after `gp-foundry build`:**

```
.github/
  workflows/*.yml         # GENERATED — drift-checked, do not edit
  harness.dot             # source of truth (topology)
  roles/*.md              # job descriptions (content; runtime-loaded)
  prompts/*.md            # optional extra prompt bodies (content)
  policy/*.yaml           # merge policy, size gates, protected paths
  foundry.config.yaml     # identity, model, labels, branch prefix, build profile
```

## Repository layout

| Path | Contents |
|------|----------|
| `src/`        | the compiler — parser, IR types, validate, model-check, role & step handlers |
| `actions/`    | the pinned runtime core (JS + composite actions the generated workflows call) |
| `examples/`   | example harness specs (e.g. `examples/dixie/harness.dot`) and their generated output |
| `schema/`     | JSON Schemas for `foundry.config.yaml` and related content |
| `docs/plans/` | dated, append-only design specs |

## Docs

- **[docs/plans/](./docs/plans/)** — dated design specs (start with the
  [system design](./docs/plans/2026-07-01-gp-foundry-system-design.md)).
- Each runtime-core action documents its contract in `actions/<name>/README.md`.

## Development

```bash
npm ci
npm run typecheck      # tsc --noEmit
npm test               # vitest run
npm run build:actions  # bundle the runtime-core actions to actions/*/dist/
npm run check:dist     # fail if bundled dist drifts from source
```

CI (`.github/workflows/ci.yml`) runs the above, plus `actionlint` + `zizmor` over
this repo's workflows and every generated example harness, and guards that no
generated workflow uses a local action path or splices `${{ github.event.* }}` into
a shell.
