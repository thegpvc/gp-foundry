# Node types, edges, and guards — the DOT vocabulary

This is the vocabulary you draft `harness.dot` with. It mirrors the IR
(`src/ir/types.ts`) and the compiler's handler registry. A node is `type` × `role`:
the **type** is the mechanical GitHub interaction (closed set, chosen at build time);
the **role** is the behavioral identity (a `roles/<name>.md` file, open set, runtime-loaded).

## Node types

| type | what it does mechanically | permissions | context | pushes code? |
|------|---------------------------|-------------|---------|--------------|
| `start` | entry point; the intake event enters here | none | — | no |
| `exit` | terminal / escape hatch (e.g. `needs_human`) | none | — | no |
| `analyst` | **reads and advises** — deliverable is an *artifact* (comment, answer, plan, spec, draft), NOT a code change. The safest, lowest-privilege agent. | `contents: read` (+ comment perm; `output=doc:<glob>` allows committing only to that glob) | issue / pr-diff / codebase | no (or docs-only via `output=doc:`) |
| `issue-agent` | analyst specialized on an issue (triage/shape a request) | `contents: read` + issues write | issue | no |
| `pr-review` | analyst specialized on a PR diff; posts a **verdict** | `contents: read` + PR write | pr-diff | no |
| `producer` | issue → branch → tested PR (the code-writer; "code-agent" is a fine synonym) | `contents: write` + PR write | issue | **yes** |
| `pr-fix` | reads review feedback, pushes fixes to the PR branch; bounded by `max_attempts` | `contents: write` + PR write | pr-review | **yes** |
| `scheduled-agent` | a maintenance agent on `schedule=` cron + manual dispatch, NO triggering issue/PR — it gathers its own work via `gh` (janitor rebase sweep, supervisor re-drive, retro learning) and its commits push to the base branch | `contents: write` + issues/PR write + `actions: write` | none | **yes** |
| `merge-gate` | evaluates merge policy (approval delay, CI green, size, protected paths, clean rebase) → merge / skip / label | `contents: write` + PR write | none | no (merges) |
| `human-gate` | pauses for a human via a GitHub **Environment** approval (brand/deploy sign-off) | per environment | none | no |
| `parallel` | fork bar of a **clean diamond**: exactly one in-edge (carrying the trigger), ≥2 bare out-edges to agent legs. Virtual — the whole diamond compiles into the fan_in's single workflow | none (virtual) | — | no |
| `fan_in` | join of the diamond: compiles to ONE workflow with each leg as a job plus this node `needs:`-joined after them (native Actions join — no polling, no markers). Role synthesizes the lanes' comments (e.g. THE verdict); optional `on_complete_label=` cascades a label. Lane roles must post ANALYSES, never `**Verdict:**` (validator warns) | `contents: read` + PR/issues write | pr-review / issue | no |

Rules of thumb:
- **Read-and-advise vs create-a-change is the deepest split, and it IS the permission
  axis.** If the deliverable is words (a comment/plan/spec/draft), it's an `analyst`
  family node and stays `contents: read`. If it changes files, it's a `producer`/`pr-fix`
  and gets `contents: write`. Never give an advising node write-on-code.
- `issue-agent` and `pr-review` are `analyst` specialized by `context=` and output contract;
  keep them named for clarity (design D10). Use plain `analyst` for Q&A / planning / design-docs.
- Every harness has exactly one `start` and at least one `exit` (the bounded escape).

## Node attributes (DOT `[...]`)

| attr | on types | meaning |
|------|----------|---------|
| `type=` | all | the node type (required) |
| `role="agents/roles/x.md"` | agent types | job-description file (referenced, never inlined) |
| `on_complete_label=` | fan_in | label applied on join completion (resolves via config.labels) |
| `context=` | agent types | `issue` \| `pr-diff` \| `pr-review` \| `codebase` \| `none` |
| `output=` | `analyst` | `comment` \| `doc:<path-glob>` (docs-only write allowlist) |
| `gates="ci.yml,..."` | `pr-review` | named check workflows the review depends on |
| `max_attempts=N` | `pr-fix` | loop bound; pairs with an `attempts>=N` escape edge |
| `policy="policy/merge.yaml"` | `merge-gate` | merge-policy file |
| `schedule="*/30 * * * *"` | `merge-gate`, sweeps | cron cadence |
| `environment=NAME` | `human-gate` | GitHub Environment gating approval (**required** on human-gate) |

## Edges — `a -> b [on=..., when=...]`

- `on="<event>"` — the GitHub event that fires `b`'s workflow. Well-known events:
  `issues.opened`, `issues.labeled`, `issue_comment.created`, `pull_request.opened`,
  `pull_request.synchronize`, `pull_request.labeled`, `pull_request.closed`,
  `pull_request_review.submitted`, `push`, `schedule`, `workflow_dispatch`.
- `when="<guard>"` — a **GitHub-observable** guard compiled to an `if:`. Forms:
  - `label=<key>` — the label named by `labels.<key>` in config is present (never a literal).
  - `verdict=approve` / `verdict=request_changes` — parsed from a `pr-review`'s output.
  - `ci=pass` — a required check concluded success.
  - `attempts>=N` — the loop counter (the bounded-escape guard).
  - boolean combinations: `ci=pass && size<gate && !protected_paths`.

A guard MUST be expressible in GitHub-observable primitives (events, labels, check
conclusions, schedules) — because GitHub is the executor, not a custom engine.

## Invariants the model-checker enforces (design them in, don't fight them)

- **Reachability:** every node reachable from `start`; no dead ends except `exit`.
- **Bounded loops:** every cycle has a bounded escape edge to an `exit`
  (e.g. `fixer -> needs_human [when="attempts>=3"]`). This is the dixie fixer↔merger
  livelock class — caught at build time.
- **No label races:** two nodes must not trigger on the same event+guard.
- **Handoff parity:** a role's `handoffs` front-matter == that node's out-edges (both directions).
- **human-gate has an environment;** analyst nodes are `contents: read`; `output=doc:<glob>`
  means the only committed paths match `<glob>`.

## Reference example (the `starter` harness)

The complete, generated version lives in [`examples/starter/`](../../examples/starter/).

```dot
digraph harness {
  start       [type=start]
  scout       [type=issue-agent, role="roles/scout.md",     context=issue]
  planner   [type=analyst,     role="roles/planner.md", context=issue, output=comment]
  builder     [type=producer,    role="roles/builder.md",   context=issue]
  reviewer      [type=pr-review,   role="roles/reviewer.md",    context="pr-diff", gates="ci.yml"]
  fixer       [type=pr-fix,      role="roles/fixer.md",     max_attempts=3]
  merge_gate     [type=merge-gate,  policy="policy/merge.yaml", schedule="*/30 * * * *"]
  needs_human [type=exit]

  start     -> scout       [on="issues.opened"]
  scout     -> planner   [when="label=plan"]     // label name resolved via config
  scout     -> builder     [when="label=build"]
  planner -> builder     [when="label=build"]
  builder   -> reviewer      [on="pull_request.opened"]
  reviewer    -> merge_gate     [when="verdict=approve"]
  reviewer    -> fixer       [when="verdict=request_changes"]
  fixer     -> reviewer      [on="push"]                    // retry loop…
  fixer     -> needs_human [when="attempts>=3"]           // …with a bounded escape
}
```
