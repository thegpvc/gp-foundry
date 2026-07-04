# gp-foundry

**Stand up a "dark factory" for your repo: issues in → reviewed, auto-merged PRs out.**

`gp-foundry` turns an autonomous agent pipeline into something you **declare once as a
directed graph and compile** into a repo. You describe the crew and the flow in a single
`harness.dot`; a deterministic compiler emits plain GitHub Actions workflows; **GitHub stays
the executor** (native events, per-job least-privilege, Environment approvals, secrets,
scheduling). The result runs with minimal effort and keeps itself alive: it is
**self-healing** (rebases conflicts, re-drives stranded work, escalates to a human only when
truly stuck) and **self-improving** (mines its own merged PRs and reviews for recurring
lessons and feeds them back to every agent). Nothing here is code-specific — the same shape
that ships a library can ship docs, marketing copy, or config.

## Why this exists (and what it deliberately isn't)

Most agent-pipeline systems ship an **orchestrator**: a long-running engine that walks the
graph, holds state, and executes agents (StrongDM's Attractor is the best-articulated
version — gp-foundry borrows its DOT-graph representation directly). That model buys rich
control flow and millisecond hops, at the price of a new stateful service you must deploy,
secure, and trust. gp-foundry makes the opposite bet: **compile the graph away and let
GitHub be the executor.** There is no server — state lives in labels, PRs, reviews, and
cron; every transition is an artifact your team already knows how to read *and override*;
and the compiler can verify the topology (bounded loops, livelock detection) before
anything runs.

The honest cost: everything must round-trip through GitHub-observable events. Hops take
minutes, not milliseconds; gates poll on cron; rich dataflow between agents is reduced to
labels and comment markers; and GitHub's event model has sharp edges the runtime works
around rather than owns. gp-foundry targets the **issue → PR → review → merge granularity**
— where hops are naturally slow and auditability matters more than latency — and covers
that case with roughly 1% of the infrastructure. If you need tight multi-agent
choreography, dynamic subgraphs, or streaming state between nodes, run an orchestrator;
this isn't one.

## Zero-install: point your coding agent at this

The fastest path — don't install anything yourself. Paste this into your coding agent
(Claude Code, Cursor, or any agent with shell access), inside the target repo:

> Fetch https://unpkg.com/@thegpvc/gp-foundry/AGENTS.md and follow it to set up an
> autonomous delivery pipeline in this repository.

[`AGENTS.md`](./AGENTS.md) walks the agent through the whole bring-up via `npx` (no global
install): scaffold, adapt the toolchain/scope/roles to the repo with you, `up`, and the
two secrets only a human can set. Claude Code agents are steered to the richer
[Socratic skill](#or-set-it-up-conversationally-the-claude-skill) instead.

## Dark factory in 6 commands

```bash
npm i -g @thegpvc/gp-foundry
gp-foundry init                          # scaffold .github/harness.dot + config + roles + scope + policy
gp-foundry up                            # labels + vendor actions + build workflows + doctor
gh secret set CLAUDE_CODE_OAUTH_TOKEN    # agent auth (paste the Claude Code OAuth token)
gh secret set AGENT_PAT                  # fine-grained PAT: Contents + Pull requests + Issues RW
git add .github && git commit -m "add agent harness" && git push
# then file an issue — the 🕵️ scout triages it and the factory takes it from there
```

`gp-foundry up` is offline-safe: it skips the `gh`-dependent steps (labels, doctor's
repo checks) cleanly when there's no GitHub remote yet, and builds the workflows regardless.

### Required secrets

| Secret | What it is | Scopes |
|--------|-----------|--------|
| `CLAUDE_CODE_OAUTH_TOKEN` | The coding agent's auth token — how each agent job authenticates to Claude Code. | n/a (agent credential) |
| `AGENT_PAT` | A fine-grained Personal Access Token used for the agents' git writes, PRs, and comments. Needed because pushes made with the built-in `GITHUB_TOKEN` do **not** trigger downstream workflows, so the pipeline couldn't cascade stage to stage. | Contents · Pull requests · Issues · Actions — **read/write**, scoped to this repo |

(`AGENT_PAT` is the default `auth.mode: pat`. You can instead run under a GitHub App
(`mode: app`, set `app_id_secret`/`app_key_secret`) or the built-in token (`mode:
github-token`, zero setup but no cascading) — see `foundry.config.yaml`.)

### Or: set it up conversationally (the Claude skill)

The package ships a **Claude skill** — a Socratic front door that interviews you about your
repo and builds the harness for you, instead of you editing the spec files by hand:

```bash
gp-foundry skill          # install into this repo (.claude/skills/gp-foundry/)
gp-foundry skill --user   # or once, for every project (~/.claude/skills/)
```

Then in Claude Code, type **`/gp-foundry`** — or just ask *"set up an agent pipeline for
this repo"*. The skill runs a five-question interview (what does this repo produce? who
approves? what must agents never touch? what roles and handoffs? what cadence and
identity?), drafts `harness.dot` + roles + policy from your answers, shows you the graph,
and then drives the same `gp-foundry` CLI — it never hand-writes workflow YAML. It also
handles **evolving** an existing harness ("add a docs lane", "tighten the merge gate").

The CLI quickstart above and the skill produce the same thing; the skill is for people who'd
rather answer questions than read `reference/node-types.md`.

## The crew

The default `init` scaffolds the **software pack** — an autonomous engineering team that
takes an issue from triage to merge, plus the lanes that keep the factory healthy.

| | Role | What it does |
|---|------|--------------|
| 🕵️ | scout | Triage an incoming issue; label it for a lane (`build` / `plan`). |
| 📋 | planner | For big/ambiguous issues, post a plan before any code is written (read-only). |
| 👷 | builder | Turn a labeled issue into a small, tested, shippable PR (the only code-writer). |
| 👩‍⚖️ | reviewer | Read the diff, run gates, post an approve / request-changes verdict. |
| 🧑‍🔧 | fixer | Apply review feedback in a bounded retry loop with the reviewer. |
| 🧹 | janitor | Scheduled sweep: rebase PRs the gate flagged `needs-rebase` so they can merge. |
| 🧑‍✈️ | supervisor | Scheduled sweep: re-drive stranded issues/PRs; escalate to `needs-human` after 2 nudges. |
| ♻️ | retro | Scheduled: mine merged PRs/reviews/CI for recurring lessons; write them to team memory. |
| 🔀 | merge_gate | **Policy gate, not a persona** — enforces merge policy (approval, CI green, size, protected paths); auto-merges or labels `needs-rebase`/`needs-human`. |

Roles are generic; a consumer repo supplies its stack (label strings, build/test commands,
size thresholds, merge policy) via config and the `roles/*.md` overlay, never baked into the
role's contract.

## The DOT → Actions model

```
harness.dot ──▶ parse ──▶ validate ──▶ model-check ──▶ assemble ──▶ .github/workflows/*.yml
 (topology)      IR         schema      reachability     fragments      (GENERATED,
                                        + cycle bounds   + wiring        drift-checked)
```

- **Nodes are roles.** Each node has a `type` (mechanical: `analyst`, `issue-agent`,
  `producer`, `pr-review`, `pr-fix`, `merge-gate`, `human-gate`, `scheduled-agent`, plus
  `start`/`exit`) and a `role="agents/roles/<name>.md"` carrying the domain-specific job
  description. The type is the GitHub interaction; the role is the behavior.
- **Edges are transitions.** Expressed only in GitHub-observable primitives
  (`on="issues.opened"`, `when="label=build"`, `when="verdict=approve"`), so the
  platform — not a bespoke engine — drives the loop.
- **Generated workflows are a build artifact.** Every emitted `.yml` (and `HARNESS.md`)
  carries a `# GENERATED FROM harness.dot — DO NOT EDIT` header and is drift-checked in CI.
  You evolve a harness by editing the spec and rebuilding in a PR, never by hand.
- **Content is runtime-loaded.** Editing a prompt, role, or merge policy needs no rebuild;
  only topology changes (`harness.dot`) recompile.

The default graph `gp-foundry init` scaffolds (`.github/harness.dot`) — a complete dark
factory with self-healing and self-improving lanes:

```dot
digraph harness {
  start       [type=start]
  scout       [type=issue-agent,     role="agents/roles/scout.md",   context=issue]
  planner     [type=analyst,         role="agents/roles/planner.md", context=issue, output=comment]
  builder     [type=producer,        role="agents/roles/builder.md", context=issue]
  reviewer    [type=pr-review,       role="agents/roles/reviewer.md", context="pr-diff"]
  fixer       [type=pr-fix,          role="agents/roles/fixer.md",   max_attempts=3]
  merge_gate  [type=merge-gate,      policy="agents/policy/merge.yaml", schedule="*/30 * * * *"]
  janitor     [type=scheduled-agent, role="agents/roles/janitor.md",    schedule="*/30 * * * *"]
  supervisor  [type=scheduled-agent, role="agents/roles/supervisor.md", schedule="17 * * * *"]
  retro       [type=scheduled-agent, role="agents/roles/retro.md",   schedule="0 7 * * 1-5"]
  needs_human [type=exit]

  start    -> scout       [on="issues.opened"]
  scout    -> planner     [when="label=plan"]
  scout    -> builder     [when="label=build"]
  planner  -> builder     [when="label=build"]
  builder  -> reviewer    [on="pull_request.opened"]
  reviewer -> merge_gate  [when="verdict=approve"]
  reviewer -> fixer       [when="verdict=request_changes"]
  fixer    -> reviewer    [on="push"]              // retry loop…
  fixer    -> needs_human [when="attempts>=3"]     // …with a bounded escape
}
```

Every cycle must keep a bounded escape edge to an `exit` node; the model-checker rejects
unbounded loops at build time. Full vocabulary in
[skill/reference/node-types.md](./skill/reference/node-types.md).

## Self-healing & self-improving

**Self-healing** — the factory does not silently stall:
- 🧹 **janitor** runs on a schedule and rebases every PR the merge gate flagged
  `needs-rebase`, so conflicts don't strand mergeable work.
- 🧑‍✈️ **supervisor** runs on a schedule, re-drives stranded issues and PRs (no PR for a
  `build`-labeled issue, idle PRs), and escalates to `needs-human` after 2 nudges.
- The **merge gate** posts a 🔀 audit comment explaining each decision and labels
  `needs-rebase` on conflicts rather than merging a broken state.
- Agent **failures are visibly red** — no green no-ops. A failing job fails the run.
- The 🧑‍🔧 **fixer** has a real attempt budget: it stamps a marker comment each attempt and,
  at `max_attempts`, labels the PR `needs-human` and stops instead of looping forever.

**Self-improving** — the factory learns from its own record:
- ♻️ **retro** mines merged PRs, reviews, and CI for lessons that recur (≥ 2 occurrences),
  and writes evidence-cited notes to `.github/agents/memory/topics/`.
- `scope.yaml` guidance makes every agent **read that memory before working**, so a lesson
  learned once shapes every subsequent run.

## Costs, security, limits

- **Cost** — every agent hop is a model call inside an Actions run: a busy factory spends
  real tokens and CI minutes. Start with the scheduled lanes at modest cadence, watch
  `gp-foundry status`, and cap intake (labels are your throttle). There are no built-in
  per-day budget caps yet.
- **Security** — agents write with `AGENT_PAT`; scope it to the one repo. On public repos,
  issue text is untrusted input to the agents: keep `scope.yaml` immutable paths tight
  (`.github/` at minimum), keep the merge gate's protected paths on, and treat the
  human-gate as mandatory for anything irreversible. The reviewer is also an LLM — the
  gate's policy (CI green, size caps, protected paths) is the non-negotiable backstop.
- **Limits** — `parallel` / `fan_in` node types are **not implemented** (declared for the
  roadmap; they compile to no workflow today). Merges are serialized one per gate sweep.
  Cross-workflow races (e.g. janitor and fixer pushing together) resolve by retry, not
  transactions — the supervisor sweep is the safety net.

## Day-2 operations

| Command | Use |
|---------|-----|
| `gp-foundry status` | Operator dashboard: work in flight per lane, agent PRs, stalled items, failed runs (last 24h). |
| `gp-foundry doctor` | Preflight: config validity, workflow drift, vendored actions, `gh` auth, labels, secrets, committed. |
| `gp-foundry build --check` | The **CI drift gate** — exit non-zero if the committed workflows are stale vs the graph. Add it to your CI. |

**Where to make a change** — three surfaces, only one of which recompiles:

| To change… | Edit | Rebuild? |
|------------|------|----------|
| An agent's **behavior** (job description, quality bar) | `agents/roles/<name>.md` | No — runtime content |
| The **merge policy** (size gates, protected paths, approvals) | `agents/policy/merge.yaml` | No — runtime content |
| The **topology** (add a role/lane, rewire handoffs, change a schedule) | `.github/harness.dot` | Yes — `gp-foundry build` |

Roles and policy are runtime-loaded, so tuning them is a content edit with no regenerated
YAML. Changing the graph is the only thing that recompiles — do it in a PR, and commit the
spec change and the regenerated workflows together so `build --check` stays green.

### Distribution: vendored vs pinned

`runtime.mode` controls how the generated workflows reference the runtime-core actions:
- **`vendored`** (default) — `gp-foundry vendor` (and `up`) copy the actions into
  `.github/actions/`, and the workflows reference them by local path. Self-contained, no
  external dependency; upgrade by re-running `vendor`.
- **`pinned`** — reference `<owner_repo>/actions/<name>@<ref>` centrally (set a SHA/tag).
  Smaller consumer repos, central upgrades — available once the actions repo is public.

## Repository layout

| Path | Contents |
|------|----------|
| `src/`      | the compiler — parser, IR types, validate, model-check, role & step handlers, CLI |
| `actions/`  | the runtime core (JS + composite actions the generated workflows call) |
| `roles/`    | generic role packs (`software/`, `content/`, `docs/`) — the job descriptions |
| `skill/`    | the packaged Claude skill: `SKILL.md`, `reference/`, and the scaffolding `templates/` |
| `schema/`   | JSON Schema for `foundry.config.yaml` |
| `examples/` | example harness specs (`examples/dixie/`, `examples/marketing/`) |
| `docs/`     | design docs (`docs/plans/`) |

## Docs

- **[docs/plans/](./docs/plans/)** — dated design specs (start with the
  [system design](./docs/plans/2026-07-01-gp-foundry-system-design.md)).
- **[skill/SKILL.md](./skill/SKILL.md)** — the Socratic setup skill and its
  [CLI](./skill/reference/cli.md), [node-type](./skill/reference/node-types.md), and
  [role-pack](./skill/reference/role-packs.md) references.
- Each runtime-core action documents its contract in `actions/<name>/`.

## Development

```bash
npm ci
npm run typecheck      # tsc --noEmit
npm test               # vitest run
npm run build          # bundle the CLI to dist/cli/index.cjs
npm run build:actions  # bundle the runtime-core actions to actions/*/dist/
npm run check:dist     # fail if bundled action dist drifts from source
```

CI runs the above, plus `actionlint` + `zizmor` over this repo's workflows and every
generated example harness, and guards that no generated workflow uses a local action path or
splices `${{ github.event.* }}` into a shell.
