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
| `human-gate` | pauses for a human via a GitHub **Environment** approval (brand/deploy sign-off), then publishes that approval as a check-run on the PR head SHA, written with `GITHUB_TOKEN` so the merge gate can pin its author | `checks: write` | none | no |
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

This table is the whole vocabulary. An attribute that is not in it — a typo, or one
from a newer gp-foundry — is a **build error** (`attr.unknown`), on nodes and edges
alike: it would otherwise compile cleanly and do nothing, which is the worst possible
outcome for an attribute meant to *restrict* a lane.

| attr | on types | meaning |
|------|----------|---------|
| `type=` | all | the node type (required) |
| `role="agents/roles/x.md"` | agent types | job-description file (referenced, never inlined) |
| `on_complete_label=` | fan_in | label applied on join completion (resolves via config.labels) |
| `context=` | agent types | `issue` \| `pr-diff` \| `pr-review` \| `codebase` \| `none` |
| `output=` | `analyst` | `comment` \| `doc:<path-glob>` (docs-only write allowlist) |
| `gates="ci.yml, lint / eslint, e2e?90"` | `pr-review` | the CI the review depends on; each conclusion is put in front of the reviewer, and the job timeout grows to cover the waits. An entry ending in `.yml`/`.yaml` waits on that **workflow**; any other entry is a **check-run name** — the way to gate on one job of a larger workflow, or on a check Actions did not produce (external CI, a status app). Check-runs are read with `GITHUB_TOKEN` (the job gains `checks: read`), since a fine-grained PAT cannot hold the Checks permission. A trailing `?N` is the grace, in seconds, to wait for the target to *appear* before concluding `skipped` (default 90) — raise it for a slow-starting check, lower it for one that only runs on some heads. Names cannot contain a comma |
| `skip="draft,bot-author,label:<key>,unchanged-diff"` | `pr-review` / PR-context `analyst` | PRs this lane does **not** review. Compiles to a `<node>_guard` job (read-only, no agent, no checkout) the lane's job is `needs:`-chained behind. `draft` — a draft PR (the lane also listens for `ready_for_review`, so it runs the moment the draft is marked ready). `bot-author` — opened by a bot (dependabot, renovate…); the harness's own `identity.bot_login` is exempt. `label:<key>` — carries the label `labels.<key>` resolves to (re-evaluated on the next event, not when the label is removed). `unchanged-diff` — a **push** whose merge-base diff hashes the same as the one this bot last reviewed, i.e. a rebase or a merge from base that left the change itself untouched; the workflow stamps the hash into the review as `<!-- gp-foundry:diff:<node>:<sha256> -->` after the agent posts it. Needs `identity.bot_login`. Every guard read fails **open** — an unreadable PR is reviewed, never silently skipped. Not available on diamond legs or sweep lanes |
| `authors="dpup, octocat"` | `pr-review`, `pr-fix`, PR-context `analyst` | an allowlist: the lane runs only on pull requests **opened by** these logins (case-insensitive). Enforced twice — as a job-level `if:` on the event payload, so no runner is spent on anyone else's PR, and again in the `<node>_guard` job against the live PR, where it **fails closed** (an author that cannot be verified is skipped; every other guard check fails open). A sweep applies the same filter in its select job. Set `repo.authors: [dpup]` in `foundry.config.yaml` to bind every PR lane (and review panels) at once; the node attribute overrides it for that lane. Without either, a PR lane runs on every PR whose branch matches `repo.branch_prefix` |
| `select="sweep"` | `pr-review` (with `schedule=`) | the **approver** pattern: instead of reacting to one PR's event, the lane runs on its cron and a `<node>_select` job deterministically picks the heads ready for a decision, then fans the lane out over them as a matrix. A head is selected when the PR is open, not a draft, on a `repo.branch_prefix` branch, **and** no review request is outstanding, **and** every check-run on the head is completed with no commit status pending, **and** no review by `identity.bot_login` carrying `**Verdict:**` exists on that exact head SHA, **and** the lane has not already run there. That last condition is the sweep's own record: after the lane succeeds on a head, a `<node>_mark` job publishes the check-run `gp-foundry/swept (<node>)` on it (neutral, written with `GITHUB_TOKEN`), so a role that posts nothing — a shadow run, an abstention — is not handed the same head again every tick. A lane that fails leaves the head unmarked and is retried. Oldest first, at most 10 per tick; a head whose state cannot be read is left for the next tick. "Concluded" is not "green" — a failed check is an answer the role must weigh — and a head with no checks at all counts as concluded. The lanes ahead of a sweep must post analyses, never `**Verdict:**`: the first verdict on a head is the decision. Requires `context="pr-diff"` or `"pr-review"` |
| `cancel_in_progress=true\|false` | agent types | whether a newer event for the same issue/PR **cancels** the run in flight rather than queueing behind it. Default `false` (`true` for `issue-agent`). Good for a reviewer — a review of a superseded head is waste. On a lane that writes code (producer, pr-fix, committing scheduled-agent) the validator warns: cancellation skips the commit/push salvage, so unpushed work is lost |
| `checkout="partial"` | any node that checks out | a blob-less clone with full history (`fetch-depth: 0` + `filter: blob:none`): every commit and tree, file contents on demand. `git log`, `git blame` and merge-base diffs work as in a full clone without paying for every version of every file — for big repos where the reviewer needs history |
| `max_attempts=N` | `pr-fix` | fix↔review **loop** bound; pairs with an `attempts>=N` escape edge. Counted from the reviewer's submitted request-changes reviews, which cannot be deleted. Unrelated to `agent_attempts=` below — this counts trips round the loop, that counts CLI invocations within one run |
| `paths="memory/"` | `scheduled-agent` | optional allowlist of prefixes this lane may write; anything else is reverted before the push |
| `commit="none\|pr\|direct"` | `scheduled-agent` | how the lane persists output: `direct` (default) commits to base; `pr` opens a reviewed PR; `none` no commit/push (read-only lane) |
| `secrets="A,B"` | agent types | extra Actions secrets exposed to THIS lane's env (unioned with global `agent.secrets`); least-privilege scoping, e.g. a Sentry token only on the sweeper |
| `permissions="id-token: write"` | any job-emitting type | extra GitHub token scopes merged into the job's `permissions:` block (the attr wins on conflict); comma-separated `<scope>: read\|write\|none`. The generic opt-in for GitHub-native capabilities — e.g. `id-token: write` lets a consumer-owned setup step mint an OIDC token and federate into a cloud provider, with all provider specifics in consumer-owned composites |
| `timeout=N` | agent types | job `timeout-minutes` (default 35 producer/pr-fix, 20 scheduled-agent). For lanes that run an agent with a salvage epilogue (producer, pr-fix, scheduled-agent) the agent's own step cap is derived as `N − 10`: the 10-min margin lets a cold-cache toolchain setup (~7 min) run and the commit/push/open-PR salvage finish within the job cap, so an over-running agent fails its STEP (salvage still runs) instead of being job-cancelled (#12545/#12611). Raise `N` to give the agent more working time; the margin stays 10 |
| `agent_attempts=N` | agent types | how many times run-agent invokes the CLI when it fails **transiently** (5xx, overloaded, dropped connection); default 3, backing off 15s and doubling. A real agent error and a usage-limit wall are never retried either way. Set `1` on a lane whose role has an **unconditional** side effect — e.g. the Herald posts a Slack digest with no dedup, so a retry after a partial run would post it twice. Roles that read current state first (the Sentry sweeper's `<!-- sentry:<id> -->` marker, the Supervisor skipping prior escalations) are safe to retry. Distinct from `max_attempts=` above |
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
- **Point a human-gate at the merge gate (`human_gate -> merge_gate`) if approval must
  actually block the merge.** The gate publishes `gp-foundry/human-approval (<env>)` on the
  head SHA and the compiler makes the merge gate require that exact check **pinned to the
  app that wrote it** (`…@github-actions`), so an approval binds to the commit it approved
  and cannot be forged by a lane holding the harness token — push again and the merge waits
  for a new one. A human-gate that leads nowhere still pauses its own lane, but nothing
  downstream depends on it.

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
