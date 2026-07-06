# starter — the default software harness

This is a complete, committed copy of what **`gp-foundry init`** scaffolds: the
software-pack "dark factory" that takes an issue from triage to auto-merged PR, with
self-healing and self-improving lanes. It's here so you can read a real one end to end.

Generated with `gp-foundry build` — the workflows under `.github/workflows/` are **build
artifacts** (`# GENERATED FROM harness.dot — DO NOT EDIT`). You edit the spec and rebuild.

## The flow

```
issues.opened
   │
 🕵️ scout ──label=plan──▶ 📋 planner ─┐        (triage → route to a lane)
   │                                   │
   └────────── label=build ──▶ 👷 builder ◀── label=build
                                   │ opens a PR
                                   ▼
                              ⚖️ reviewer ──verdict=approve──▶ 🔀 merge_gate
                                   │  ▲                          (policy: CI green,
                          request_changes│ push                  size, protected paths)
                                   ▼  │
                              🔧 fixer ──attempts≥3──▶ 🙋 needs_human
```

Plus three scheduled lanes that keep it alive without a human babysitting it:
**🧹 janitor** (rebases PRs that fell behind), **🧭 supervisor** (re-drives stranded
issues/PRs, escalates after 2 nudges), **♻️ retro** (mines merged PRs/reviews for recurring
lessons → team memory that every agent reads before working).

## Layout

| Path | What it is |
|------|-----------|
| `.github/harness.dot` | the topology — **the one file you edit** for structure |
| `.github/agents/roles/*.md` | each agent's job description (runtime content; no rebuild to change) |
| `.github/agents/policy/merge.yaml` | the merge gate's rules |
| `.github/agents/scope.yaml` | invariants agents must never touch |
| `.github/agents/foundry.config.yaml` | identity, model, labels, runtime mode |
| `.github/agent-setup/action.yml` | **you own this** — add your project's toolchain here |
| `.github/workflows/*.yml` | generated — never hand-edit |

## Notes on this copy

- **Runtime mode is `pinned`** (`uses: thegpvc/gp-foundry/actions/<n>@v1`) so the example
  stays small. `gp-foundry init` defaults to **`vendored`**, which copies the runtime
  actions into `.github/actions/` for a self-contained repo. Everything else is the default.
- To stand your own up: `npm i -g @thegpvc/gp-foundry && gp-foundry init && gp-foundry up`
  (or point any coding agent at `https://unpkg.com/@thegpvc/gp-foundry/AGENTS.md`).

## Variant: a parallel review **panel**

Swap the single `reviewer` for a fan-out **diamond** — independent lanes that a `fan_in`
job joins into one verdict (this is what the reference deployment runs live):

```dot
builder      -> split       [on="pull_request.opened, pull_request.synchronize"]
split        [type=parallel]
split        -> lane_correct   // [type=analyst, context="pr-diff"] posts an analysis
split        -> lane_style     //   (a lane never posts a verdict — the panel does)
lane_correct -> panel
lane_style   -> panel
panel        [type=fan_in, role="agents/roles/panel.md"]  // synthesizes the lanes → THE verdict
panel        -> merge_gate  [when="verdict=approve"]
panel        -> fixer       [when="verdict=request_changes"]
```

The clean diamond compiles to **one workflow**: the lanes run as parallel jobs and the panel
job `needs:` them — a failed lane is a red run, not a silent stall. No orchestrator involved.
