# The `gp-foundry` CLI — what the skill shells out to

The CLI (component B8) is the **deterministic engine**. The skill (you) is a Socratic
wrapper over it: you never parse DOT, run the model-check, or emit YAML yourself. Every
structural operation goes through these subcommands. The same CLI runs in CI's drift-check,
so behavior is identical for agent and human.

All commands run from the consumer repo root and operate on `.github/harness.dot` and the
sibling spec files unless a path is given. Add `--json` where noted for machine-readable
output you can parse. Non-zero exit = failure; read stderr and surface diagnostics verbatim.

## `gp-foundry init [--profile <name>]`
Scaffold the canonical spec layout (`harness.dot`, `roles/`, `prompts/`, `policy/`,
`scope.yaml`, `foundry.config.yaml`, and a no-op `.github/agent-setup/action.yml`). Run
this once at the start of setup, then fill in the drafted spec. Idempotent — won't clobber
existing files (it reports what it skipped).

## `gp-foundry validate [--json]`
Static checks over the spec: config schema (`schema/config.schema.json`), referential
integrity (every `role`/`prompt`/`policy` path exists), **role handoffs == out-edges**,
and human-gate-has-environment. Prints `Diagnostic[]` with `level`, `code`, `message`,
`where.file:line`, and `hint`. Run before every build. Exit non-zero on any `error`.

## `gp-foundry graph [--json] [-o HARNESS.md]`
Render the topology. Default prints a human-readable graph and writes/refreshes
`HARNESS.md` (the diagram). `--json` emits the parsed IR (nodes, edges, config) — use this
to load current topology at the start of an *evolve* session. Also runs the model-checker
and reports topology diagnostics (unreachable nodes, unbounded loops, label races).

## `gp-foundry build [--check] [--dry-run] [--json]`
Compile `harness.dot` + spec → `.github/workflows/*.yml`.
- **`--dry-run`** — compile and print the diff, write **nothing**. Always do this first and
  explain the diff before a real build.
- (default) — write the generated workflows (each carries `# GENERATED FROM harness.dot —
  DO NOT EDIT`). Managed regions in consumer-owned files are updated in place; a hand edit
  inside a managed region is reported as a conflict rather than clobbered (reconcile it —
  see SKILL.md "Reconciling").
- **`--check`** — compile in memory and `git diff --exit-code` against committed workflows.
  This is the CI drift gate; exit non-zero means the committed YAML is stale. You rarely run
  this yourself, but explain it to users as the guarantee that the graph and the YAML agree.

## `gp-foundry add <name> --type <node-type> [--role roles/<name>.md]`
Scaffold a new role/node: creates `roles/<name>.md` from the type's template (with a
`handoffs` block to fill in) and inserts the node into `harness.dot`. You still edit the
edges + handoffs so they agree, then `validate` → `build`. This is the mechanical half of
evolve-as-PR (E3).

## `gp-foundry explain <node> [--json]`
Show what a single node compiles to: its permission set, trigger surface (`on:`), `if:`
guard, which runtime-core action(s) it calls, and its steps. Use it to answer "what does the
builder actually do?" and to justify a diff before writing.

## Typical sequences

**First-time setup (after the interview):**
```bash
gp-foundry init
# …draft harness.dot, roles/*.md, policy/*.yaml, scope.yaml, foundry.config.yaml…
gp-foundry validate
gp-foundry graph            # show the diagram; iterate on the DOT with the user
gp-foundry build --dry-run  # explain the diff
gp-foundry build            # write workflows; commit spec + workflows together
```

**Evolve (add a role / tighten a gate) — as a PR:**
```bash
git checkout -b harness/add-copywriter
gp-foundry graph --json                  # understand current topology
gp-foundry add copywriter --type producer
# …edit harness.dot edges + roles/copywriter.md handoffs to agree…
gp-foundry validate && gp-foundry build --dry-run   # explain diff
gp-foundry build
git add -A && git commit && gh pr create             # review-gated topology change
```

**Interpreting failures:** on any non-zero exit, quote the diagnostic's `file:line`,
`message`, and `hint`, then propose the spec fix. Never work around a diagnostic by editing
generated YAML.
