# The `gp-foundry` CLI — what the skill shells out to

The CLI (component B8) is the **deterministic engine**. The skill (you) is a Socratic
wrapper over it: you never parse DOT, run the model-check, or emit YAML yourself. Every
structural operation goes through these subcommands. The same CLI runs in CI's drift-check,
so behavior is identical for agent and human.

All commands run from the consumer repo root and operate on `.github/harness.dot` and the
sibling spec files unless a path is given. Add `--json` to any command for machine-readable
output you can parse. Non-zero exit = failure; read stderr and surface diagnostics verbatim.

## `gp-foundry init [--dir <path>] [--force]`
Scaffold the canonical spec layout (`harness.dot`, `foundry.config.yaml`, `scope.yaml`,
`policy/merge.yaml`, `communication.md`, one `roles/<name>.md` per role the graph
references, and a no-op `.github/agent-setup/action.yml`). Run this once at the start of
setup, then fill in the drafted spec. Idempotent — it skips files that already exist (and
reports them) unless you pass `--force`.

## `gp-foundry validate [--json]`
Static checks over the spec: structural integrity, referential integrity (every
`role`/`prompt`/`policy` path exists), **role handoffs == out-edges**, human-gate-has-
environment, and the topology model-check (reachability, bounded loops, label races,
placeholder/vendored-action checks). Prints `Diagnostic[]` with `level`, `code`, `message`,
`where.file:line`, and `hint`. Run before every build. Exit non-zero on any `error`.

## `gp-foundry graph [--json]`
Render the topology. Default prints a **Mermaid flowchart** to stdout — the same diagram
the compiler writes to `.github/HARNESS.md` on `build`, so you can show the graph before any
YAML exists. `--json` emits the parsed IR (`name`, `nodes`, `edges`) — use this to load
current topology at the start of an *evolve* session.

## `gp-foundry build [--check] [--dry-run] [--out <dir>] [--force] [--json]`
Compile `harness.dot` + spec → `.github/workflows/*.yml` (plus `.github/HARNESS.md`).
- **`--dry-run`** — compile and print the generated files, write **nothing**. Always do this
  first and explain the diff before a real build.
- (default) — write the generated workflows (each carries `# GENERATED FROM harness.dot —
  DO NOT EDIT`). Generated files are fully compiler-owned: `build` overwrites them, so a
  hand edit to a generated `.yml` is simply replaced (that is the point; `--check` catches
  the drift in CI). If there are error diagnostics, `build` refuses to write unless `--force`.
- **`--check`** — compile in memory and compare against the files on disk; exit non-zero if
  any generated file is out of date. This is the CI drift gate. You rarely run it yourself,
  but explain it to users as the guarantee that the graph and the YAML agree.
- **`--out <dir>`** — write to a different repo root (default: the dir of `harness.dot`).

## `gp-foundry explain <node> [--json]`
Show the workflow a single node compiles to (its permission set, trigger surface `on:`, `if:`
guard, which runtime-core action(s) it calls, and its steps). Use it to answer "what does the
builder actually do?" and to justify a diff before writing.

## Ops commands — bring-up and day-2

These wrap the factory lifecycle around `build`. Everything gh-dependent degrades to a clean
"skip" (with a hint) when `gh` is missing or unauthenticated, so they also work offline.

### `gp-foundry vendor [--dir <path>]`
Copy the packaged runtime-core actions into `.github/actions/` (the self-contained,
`runtime.mode: vendored` layout the generated workflows reference by local path). Scaffolds
`.github/agent-setup/action.yml` if absent, never overwriting it. Commit `.github/actions/`.

### `gp-foundry up`
One command from `init` to a runnable factory: create the repo labels
(`build`/`plan`/`needs-human`/`needs-rebase`), vendor the runtime actions (in vendored mode),
`build` the workflows, then run `doctor`. Prints the doctor checks and the next steps
(set secrets, commit `.github/`, push, file an issue).

### `gp-foundry doctor`
Preflight: config validity, workflow drift, vendored actions present, `agent-setup` shim
present, `gh` auth, GitHub repo, required labels, required secrets, and whether `.github/`
is committed. Exit non-zero if any check fails. The repo-side checks (labels/secrets/commit)
skip cleanly when `gh` is unavailable or there's no GitHub remote.

### `gp-foundry status`
Operator dashboard (needs `gh` + a GitHub repo): open work per lane (plan/build/needs-human),
agent PRs with mergeability + labels, stalled items (issues with no PR, idle PRs), and failed
workflow runs in the last 24h.

## Typical sequences

**First-time setup (after the interview):**
```bash
gp-foundry init
# …draft harness.dot, roles/*.md, policy/*.yaml, scope.yaml, foundry.config.yaml…
gp-foundry validate
gp-foundry graph            # show the Mermaid diagram; iterate on the DOT with the user
gp-foundry build --dry-run  # explain the diff
gp-foundry up               # labels + vendor + build + doctor
# set secrets, commit spec + workflows together, push
```

**Evolve (add a role / tighten a gate) — as a PR:**
```bash
git checkout -b harness/add-copywriter
gp-foundry graph --json                  # understand current topology
# …edit harness.dot (add the node + edges) and create roles/copywriter.md with matching handoffs…
gp-foundry validate && gp-foundry build --dry-run   # explain diff
gp-foundry build
git add -A && git commit && gh pr create             # review-gated topology change
```

**Interpreting failures:** on any non-zero exit, quote the diagnostic's `file:line`,
`message`, and `hint`, then propose the spec fix. Never work around a diagnostic by editing
generated YAML.
