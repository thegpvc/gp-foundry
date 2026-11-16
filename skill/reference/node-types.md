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
| `merge-gate` | evaluates merge policy (approval delay, CI green, size, protected paths, clean rebase; optionally open review threads and pending review requests) → merge / skip / label. With `mode="evaluate"`: never merges or labels, publishes the result as a check run on each head instead | `contents: write` + PR write; evaluate mode: `GITHUB_TOKEN` only, `checks: write`, `pull-requests: read`, `contents: read` | none | no (merges; evaluate mode writes only the check) |
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
| `title="Fletch"` | any job-emitting type | the workflow's `name:`, so a PR check reads `Fletch / reviewer` instead of `reviewer / reviewer`. Guard, select and mark jobs follow (`Fletch / reviewer guard`). Defaults to the node id (the older spelling `name=` still works). Changing it renames the check — update any branch-protection rule that names it |
| `harness_ref="head"` | `pr-review`, `pr-fix`, PR-context `analyst`, `fan_in` | opt **out** of the default. By default every lane handed a pull request reads its harness files — role, prompt, `scope.yaml`, `communication.md`, the `agent-setup` composite, and in vendored mode the runtime actions — from the PR's **base ref**, via a second sparse checkout into `.gp-foundry/harness/` (git-excluded, so a lane that commits never sweeps it in). The PR head stays the working tree. Read from the head, a branch cut before the harness merged has no role file, and a PR that edits `.github/agents/` is judged by its own edit, by an agent holding secrets. `"head"` restores the old behaviour for testing a harness change in its own PR; the validator warns |
| `persist_credentials=true\|false` | `analyst`, `issue-agent`, `pr-review`, `fan_in` | whether the checkout leaves its token in `.git/config`. Default **false** on these read-and-advise lanes (they never push, and an agent with a shell can read it there) — except with `checkout="partial"`, whose on-demand blob fetches need it. `false` together with `checkout="partial"` is a build error. Lanes that push always keep it |
| `repo_guides=false` | agent types | stop the CLI auto-loading the repo's own `CLAUDE.md` / `AGENTS.md` into every turn (run-agent passes `--settings` with `claudeMdExcludes` for the workspace). The role, conventions and scope are then the agent's whole standing brief. Worth it when the repo guide is large: it is paid for on every turn |
| `gates="ci.yml, lint / eslint, e2e?90"` | `pr-review` | the CI the review depends on; each conclusion is put in front of the reviewer, and the job timeout grows to cover the waits. An entry ending in `.yml`/`.yaml` waits on that **workflow**; any other entry is a **check-run name** — the way to gate on one job of a larger workflow, or on a check Actions did not produce (external CI, a status app). Check-runs are read with `GITHUB_TOKEN` (the job gains `checks: read`), since a fine-grained PAT cannot hold the Checks permission. Options follow the name, each introduced by `?`: `?N` is the grace, in seconds, to wait for the target to *appear* before concluding `skipped` (default 90) — raise it for a slow-starting check, lower it for one that only runs on some heads; `?info` marks the gate **advisory** (a review bot, say): its result is listed for the reviewer under "Informational checks", where `skipped` is normal and a `failure` is input to weigh, instead of under the rule that anything but `success` blocks. They combine: `bugbot?info?30`. Names cannot contain a comma or `?` |
| `skip="draft,bot-author,label:<key>,unchanged-diff"` | `pr-review` / PR-context `analyst` | PRs this lane does **not** review. Compiles to a `<node>_guard` job (read-only, no agent, no checkout) the lane's job is `needs:`-chained behind. `draft` — a draft PR (the lane also listens for `ready_for_review`, so it runs the moment the draft is marked ready). `bot-author` — opened by a bot (dependabot, renovate…); the harness's own `identity.bot_login` is exempt. `label:<key>` — carries the label `labels.<key>` resolves to (re-evaluated on the next event, not when the label is removed). `unchanged-diff` — a **push** whose merge-base diff hashes the same as the one this bot last reviewed, i.e. a rebase or a merge from base that left the change itself untouched; the workflow stamps the hash into the review as `<!-- gp-foundry:diff:<node>:<sha256> -->` after the agent posts it. The stamp only ever lands on a review **this run** posted (submitted after the `<node>_guard` job ran, its `started_at` output): another lane posting as the same bot — an approver's verdict on the same head, when a label event re-runs the reviewer — is not this lane's review, and the guard would otherwise compare against and mark it. The stamp and the also-head marker are HTML comments, which every verdict test ignores, so a stamped verdict is still a verdict. When the guard skips a push this way, it appends `<!-- gp-foundry:also-head:<node>:<new head sha> -->` to that review (one per skipped head, appended after any existing markers, with the same token as the stamp; under App auth the guard mints one scoped to pull requests, under `github-token` auth the guard gets `pull-requests: write`), so the review is on record as covering the new head too — a downstream lane cannot tell that from a `skipped` reviewer check, which the guard also produces for labels, drafts, bot authors and unreadable PRs. The guard skips only once that marker is on the review (already there, or the edit succeeded): a `requires_review=true` sweep selects a head only on a review that covers it, so if reading or editing the review fails, the guard prints a notice and the lane runs again rather than leave the head unreviewed. Needs `identity.bot_login`. Every guard read fails **open** — an unreadable PR is reviewed, never silently skipped. Not available on diamond legs. On a sweep lane (`select="sweep"`) the select job applies `bot-author` and `label:<key>` to the PRs it picks (`draft` is implicit there); `unchanged-diff` is rejected. An evaluate-mode `merge-gate` applies them the same way to the PRs it publishes a check on |
| `authors="dpup, octocat"` | `pr-review`, `pr-fix`, PR-context `analyst`, evaluate-mode `merge-gate` | an allowlist: the lane runs only on pull requests **opened by** these logins (case-insensitive). Enforced twice — as a job-level `if:` on the event payload, so no runner is spent on anyone else's PR, and again in the `<node>_guard` job against the live PR, where it **fails closed** (an author that cannot be verified is skipped; every other guard check fails open). A sweep applies the same filter in its select job. Set `repo.authors: [dpup]` in `foundry.config.yaml` to bind every PR lane (and review panels) at once; the node attribute overrides it for that lane. Without either, a PR lane runs on every PR whose branch matches `repo.branch_prefix` |
| `opt_in_label="<key>"` | wherever `authors=` binds | widens the allowlist: the lane also runs on a PR that carries this label, whoever opened it (`authors=` ∪ label). The key resolves through `labels.<key>` in `foundry.config.yaml`, like `skip="label:<key>"` (used literally when unmapped). Compiles to an OR in the job-level `if:`, a `pull_request.labeled` trigger that admits only this label's event (other label events on an allowlisted PR do not start a run; the run GitHub still creates for them gets its own `<node>-noop-<run id>` concurrency group, so it cannot cancel or displace a review of that PR, while the opt-in label's own event joins the PR's group like a push), and the same OR in the `<node>_guard` job's fail-closed author check against the live PR (`OPT_IN_LABEL` env) and in a sweep's select job. `repo.branch_prefix` still applies. A fixer gets the `if:` widening but no `labeled` trigger. Needs an allowlist (`authors=` or `repo.authors`); without one `validate` errors (`node.opt-in-without-authors`) |
| `select="sweep"` | `pr-review` (with `schedule=`) | the **approver** pattern: instead of reacting to one PR's event, the lane runs on its cron and a `<node>_select` job deterministically picks the heads ready for a decision, then fans the lane out over them as a matrix. A head is selected when the PR is open, not a draft, on a `repo.branch_prefix` branch, **and** no review request is outstanding, **and** every check-run on the head is completed with no commit status pending (a head with **no** check-run at all waits until the PR has been quiet for 10 minutes, so a decision is never made in the gap before CI registers), **and** no verdict review by `identity.bot_login` exists on that exact head SHA, **and** the lane has not already delivered there. A **verdict** is a review whose last line, as a reader sees it, is **exactly** one of `**Verdict:** APPROVE`, `**Verdict:** REQUEST_CHANGES` or `**Verdict:** ESCALATE`: HTML comments are ignored (the harness appends its own after the verdict — the unchanged-diff stamp, the also-head marker), as are blank lines and leading or trailing whitespace. The marker anywhere else in the body (quoted, mid-sentence) does not count, and neither does a qualified line such as `**Verdict:** APPROVE (once gates pass)` — the merge gate would never read that as an approval, so a sweep that counted it as decided would leave the head stuck. The three words are `verdicts: [APPROVE, REQUEST_CHANGES, ESCALATE]` in `foundry.config.yaml` (approve, request changes, escalate, in that order); the select and mark jobs read them as `VERDICT_LINES`, and both merge-gate modes get them as the `verdicts` input and derive their markers from them (approval and escalation exact; rejection deliberately loose, `Verdict.*<word>`, since a missed rejection would let an earlier approval stand), so the sweep and the gate cannot disagree about what a verdict is. The merge gate reads review bodies the same way. Check-runs are read with `filter=all`, so every run counts, not just the newest per name. That last condition is the sweep's own record: after the lane succeeds on a head **and** the bot's verdict is on it, a `<node>_mark` job publishes the check-run `gp-foundry/swept (<node>)` on it (neutral, written with `GITHUB_TOKEN`). A successful run that posts **no** verdict is a holding state, not a decision: the role may have had nothing to decide yet (the head moved, a check was still running), so the head is not marked and not counted as a failure, and the next tick sweeps it again — up to **3** such runs per head. Each is recorded as a neutral `gp-foundry/sweep-idle (<node>)` check-run; on the third the mark job also publishes `gp-foundry/sweep-failed (<node>)` ("gave up after 3 runs without a verdict"), where a failed head shows, and the sweep stops selecting that head until a new commit is pushed, so a role that never posts a verdict (a shadow run, an abstention, a verdict in a shape the rule above does not recognize) costs three runs, not one every tick. A lane that fails leaves the head unmarked and is retried — up to **3** failed runs per head: each one is recorded as a neutral `gp-foundry/sweep-failed (<node>)` check-run, and after the third the sweep stops selecting that head until a new commit is pushed. A cancelled run is not counted. Oldest first, at most 10 per tick; a head whose state cannot be read is left for the next tick. "Concluded" is not "green" — a failed check is an answer the role must weigh — and a head with no checks at all counts as concluded. The lanes ahead of a sweep must post analyses, never `**Verdict:**`: the first verdict on a head is the decision. Requires `context="pr-diff"` or `"pr-review"` |
| `requires_review=true` | `select="sweep"` lanes | a head is a candidate only once a review by `identity.bot_login` covers it — submitted on the head (`commit_id`), or carrying the `<!-- gp-foundry:also-head:<node>:<head sha> -->` marker a guard adds when it skips that head as an unchanged diff — and that review is not itself a verdict (its last non-empty line does not start with `**Verdict:**`). For a sweep that acts on an upstream review: without it the lane starts a paid agent run on every tick for heads that are only waiting for that review. Checked in the select job's single reviews read (`REQUIRES_REVIEW` env); `validate` rejects it anywhere but a sweep |
| `post="review"` | `pr-review`, PR-context `analyst` (sweeps too) | the agent **prints** its review and a compiled `Post the review` step posts it with the lane's token; `run-agent` is given **no** `github-token`, whatever the role's `tools:` say (`validate` warns, `node.post-review-gh-tools`, when the role still lists gh: the post step posts; drop gh from tools). A shell under `--permission-mode dontAsk` denies the quoting a real review body needs (backticks, escaped quotes in a heredoc or `-f body=`), and an agent reading untrusted PR text should not hold a token anyway. **Output contract** (also appended to the prompt as its last section, `## Output`): the final message ends with one fenced code block tagged `json` holding one object, `{"body": "<markdown>", "comments": [{"path": "...", "line": N, "side": "RIGHT", "body": "..."}], "event": "COMMENT"}`. `comments` is optional (`[]` for none); `event` must be `COMMENT`; `commit_id` is set by the step to the head, never by the agent. The step takes the **last** such block from run-agent's captured stdout (`stdout-file` output), validates it (object, string `body`, each comment a string `path`, positive integer `line` and string `body`), prepends the heading line `PR #<n> head <sha>` (`post_marker=`) and POSTs `pulls/{n}/reviews`. With no fenced block it falls back to a bare object at the end of the output (the last line ending in `}`, back to the latest line beginning with `{` from which the rest parses as one object with a string `body`); a fenced block always wins. No review in either form, or a malformed one: nothing is posted and the step warns with the first 200 characters of the output. A 422 for an inline comment off the diff (GitHub does not say which): one retry with every inline finding moved into the body under "Findings on unchanged lines" (before the verdict line on a verdict lane). Idempotent, keyed on the lane: every review the step posts ends with a hidden marker, `<!-- gp-foundry:posted:<node>:<head sha> -->`, and a review by `identity.bot_login` on the head carrying this node's marker means the step posts nothing. So lanes can share a bot login and a heading — a reviewer's review does not stop an approver's verdict, nor the reverse — and a reviewer that posts a verdict of its own still recognizes it on a re-run. (A review posted before the marker existed is matched the old way, by its heading; on a verdict lane only if it is itself a verdict.) The marker is an HTML comment, which every verdict test ignores. On a sweep (`select="sweep"`) the review is the verdict: the body's last line must be one of the exact verdict lines, or nothing is posted. The diff stamp and the also-head marker work on the posted review |
| `post_marker="PR #<n> head <sha>"` | with `post="review"` | the heading the post step puts on the review's first line; `<n>` and `<sha>` are replaced. Single line. It is for the reader — idempotency is keyed on the hidden posted marker, so lanes posting as one bot may share a heading |
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
| `mode="merge\|evaluate"` | `merge-gate` | `merge` (default) merges the first qualifying PR or labels it. `evaluate` never merges, labels or comments: every tick it evaluates the policy for every open, non-draft PR on a `repo.branch_prefix` branch (narrowed by `authors=` / `repo.authors`, `opt_in_label=` and `skip="bot-author,label:<key>"` when set; `unchanged-diff` is rejected) and publishes one check run per head. Conclusion: `success` when the gate would merge; `action_required` when the trusted reviewer's latest verdict on the head is `**Verdict:** ESCALATE` (or the configured escalate word); `neutral` ("awaiting the approver") instead of `failure` for a head with no verdict yet whose only failing clause is the missing approval, when the policy sets `no_verdict_conclusion: neutral` (default `failure`); `failure` otherwise, with the gate's code and reason in the summary and the open threads, failing checks and pending review requests in the text. The run is updated in place (one current result per head) and not written at all when nothing changed, so a reply or resolve flips it on the next tick with no model spend, and it can be made a required check. The job runs on `GITHUB_TOKEN` alone (`checks: write`, `pull-requests: read`, `contents: read`, no App token); the gate leaves its own check out of the CI rollup, and `require_clean_rebase` is off unless the policy sets it. A graph may carry a merge gate and an evaluate gate side by side |
| `check_name="fletch/approval"` | `merge-gate` with `mode="evaluate"` | the check run it publishes; default `gp-foundry/approval (<node>)`. Two evaluate gates may not share one (`node.duplicate-check-name`); on a merge-mode gate it is an error (`node.check-name-without-evaluate`) |
| `schedule="*/30 * * * *"` | `merge-gate`, sweeps | cron cadence |
| `environment=NAME` | `human-gate` | GitHub Environment gating approval (**required** on human-gate) |

### What each lane's credentials can do

- **App token (`auth.mode: app`)** is minted per job with `permission-*` inputs, so it carries
  only what the lane's type needs instead of everything the App was installed with:
  PR-context `analyst` / `pr-review` → `contents: read`, `pull-requests: write`, `checks: read`;
  issue lanes → `contents: read`, `issues: write`; `pr-fix` → `contents: write`,
  `pull-requests: write`, `checks: read`; `producer` → `contents: write`, `pull-requests: write`,
  `issues: write`. A node's `permissions=` attr adds to it (App permissions only). The App must
  actually hold what is requested — in particular **Checks: read** for PR lanes — or the mint
  fails. `scheduled-agent` and `merge-gate` are left on the App's full permissions: their needs
  are open-ended (re-running workflows, merging a PR that touches workflows).
- **The agent is handed a GitHub token only if its role can use one.** When the role's `tools:`
  allow neither `gh` (`Bash(gh …)`) nor unrestricted `Bash`, `github-token` is not passed to
  run-agent at all. This is the one place a role edit needs a rebuild: give a role `gh` and
  `gp-foundry build --check` reports the drift.

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
