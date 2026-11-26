# Claude Ship's config files as inputs to gp-foundry

**Date:** 2026-11-26 · **Status:** POC on `poc-claude-ship-inputs` (phase 1 only) · Source: the Claude Ship docs at `code.claude.com/docs/en/claude-ship` and the pages it links (approvals-policy, approvals-classifiers, approvals-pull-requests, approvals-setup, approvals-github-rules, code-review-customize, pr-steward-setup), read 2026-11-26.

A repo that already describes its review and approval rules for Claude Ship should not have
to describe them again for gp-foundry. This plan says which of Ship's files gp-foundry can
read, what each one maps to, what does not map, and the order to build it in.

---

## What Claude Ship is, and which files it reads

Ship is three hosted agents on GitHub pull requests. Only two of them read files in the repo.

| Agent | What it does | Repo files |
| --- | --- | --- |
| Code Review | Reviews the change, posts findings by severity (Important, Nit). | `REVIEW.md` at the root, with `@file` include lines for sibling files and `.claude/skills/<name>/SKILL.md`; `REVIEW.md` in subdirectories; `CLAUDE.md` as context. Freeform Markdown. |
| PR Steward | Fixes failing checks, conflicts and review comments. Never approves or merges. | None. Its settings (when it starts, which authors) are in the organization's admin UI. |
| Claude Approvals | Publishes a `Claude Approvals` check saying who still has to approve. | `.claude/approvals.yml` (schema `version: 1`), one per directory; custom classifiers in `.claude/classifiers/<name>/def.yml` (+ `prompt.md`). |

Ship never merges. Merging follows the branch's GitHub rules.

### The lanes line up

| Ship | gp-foundry | Config that could be shared |
| --- | --- | --- |
| Code Review | `pr-review` lanes (reviewer, approver) | `REVIEW.md` → the reviewer role's repo-specific guidance |
| PR Steward | `pr-fix` lane (fixer), janitor | nothing in the repo to read |
| Claude Approvals | the single gate (`merge-gate`, `merge=`) and its policy | `.claude/approvals.yml` → `policy/merge.yaml`, `rollout`, `scope.yaml` |

---

## `.claude/approvals.yml` → the merge policy

### The two models

Ship decides **per changed file**. Each rule has `paths`, an optional `if`, and a `verdict`:
whether Claude may approve (`approves` / `comments` / `blocks`) and how many people must
(`seats`, optionally from named teams). `override` swaps the verdict while a condition holds.
Conditions read facts (`pr/diff_lines`, `pr/authors`, `pr/base`) and classifier answers
(`claude/code_review = pass`, `repo/change_risk <= medium`). The PR gets the strictest verdict
across its files, and every applicable rule's seats must be filled.

gp-foundry decides **per PR**, with a fixed set of clauses: the approver's verdict
(APPROVE / REQUEST_CHANGES / ESCALATE), CI, size (`max_additions`), protected paths, open
threads, and a person's sign-off on a handoff clause or an escalation.

So a Ship policy is strictly more expressive. Reading one is a translation with losses.

### The mapping (what the POC implements)

| Ship | gp-foundry | Fidelity |
| --- | --- | --- |
| `claude: approves`, `seats: 0` | nothing to set: the approver's APPROVE satisfies the gate | exact |
| `seats ≥ 1` on `paths` | `protected_paths` + `handoff_clauses: [protected-path]`; a trusted person's formal approval of the head signs it off | exact for one person |
| `seats ≥ 1` on `**` | `protected_paths: ["**"]` — every PR needs a person | exact for one person |
| `"!pattern"` in `paths` | `protected_path_exclude_globs` | lossy: global, not per rule |
| `seats: N`, N > 1 | one sign-off; require N approvals in GitHub's branch rules (the sign-off waits for GitHub's review decision) | lossy |
| seats `from` a team or login | `signoff_author_associations` is by association only; point at CODEOWNERS | lossy |
| seats without `"!pr/authors"` | a sign-off never comes from the PR's author | lossy (stricter) |
| `if`/override `claude/code_review = pass` | the approver's APPROVE verdict | exact |
| the rule's stricter fallback when the review does not pass | `not-approved`, or a trusted person's approval standing in | lossy |
| `if`/override `pr/diff_lines > N` raising the bar | `max_additions: N` + `handoff_clauses: [too-large]` | lossy: hand-written additions, whole PR |
| `if: "ALL pr/authors = bot:x"` | `rollout.bot_authors: ["x[bot]"]` | exact when the rule asks for no person |
| `claude: blocks` on paths | `scope.yaml` `immutable_paths` | lossy: stops agents, not people's PRs |
| `mode: observe` | run the gate with `merge="off"` and do not require its check | lossy: no per-file switch |
| `advisory: [claude/code_review]` | the reviewer lane | exact |
| `locals`, `use`, `"@name"` | resolved before translating | exact |

### What has no equivalent today

- **Custom classifiers** (`repo/<name>`, `.claude/classifiers/`). A rule conditioned on one is
  dropped, and the translated policy then asks for *less* than the Ship policy. The tool says
  so on each such rule. The nearest gp-foundry thing is an analyst lane, which cannot feed the gate.
- **Compound conditions** (`AND`, `OR`, parentheses), `pr/base`, `pr/files_changed`, `pr/opened_by`,
  `pr/approved_by`.
- **`reuse`** (keeping an approval across a push that does not change intent). gp-foundry is
  stricter: a verdict and a sign-off are for the exact head.
- **`findings`** (who may close a finding). Nearest: `require_no_open_threads`.
- **`max_age`**, **`nested`** and subdirectory policy files, **`run`**.
- **Fork rules** and the `@claude approve` / `approvals rerun` / `approvals resolve` comment commands.

---

## `REVIEW.md` → reviewer guidance

`REVIEW.md` is freeform instructions for a reviewer, which is exactly what the
"Repo-specific guidance" section of a `pr-review` role is. The POC resolves it the way Code
Review does (root file, `@` includes, skill bodies without frontmatter) and keeps Code
Review's limits, so both reviewers read the same text: 8 included files, 8 skills, 30,000
bytes per skill, 150,000 bytes in all, and a root file with more than 64 links is skipped.

Two things in `REVIEW.md` assume Code Review's vocabulary. Severity words ("Important",
"Nit") have no fixed meaning to a gp-foundry reviewer, which ends in a verdict line. The
natural reading is "an open Important finding means REQUEST_CHANGES", the same rule
`claude/code_review = pass` uses, and the role preamble should say so when a `REVIEW.md` is
present. Subdirectory `REVIEW.md` files (applied per changed file, on protected branches
only) are left for later.

---

## Build order

**Phase 1 — a read-only translator (this POC).** `gp-foundry ship [--dir] [--json]` reads
`.claude/approvals.yml` and `REVIEW.md` and prints the merge-policy keys, the config and
scope settings, and a note for every rule marked mapped, lossy or unsupported. It writes
nothing. Code: `src/ship/approvals.ts`, `src/ship/review-md.ts`, `src/cli/ship.ts`; tests in
`src/ship/ship.test.ts` use the policy examples from Ship's docs.

**Phase 2 — `REVIEW.md` at run time.** A `pr-review` node attribute (say `review_md=true`,
default off) makes the lane's context step resolve `REVIEW.md` from the **base branch** and
append it to the role's prompt, under a short preamble that maps severity to the verdict.
Base branch only, as Ship does: a PR must not be able to rewrite the instructions it is
reviewed under. Without the attribute generated workflows stay byte-identical.

**Phase 3 — `gp-foundry ship --write`.** Apply the proposal: merge the keys into
`policy/merge.yaml`, `foundry.config.yaml` and `scope.yaml`, preserving comments, refusing
when any rule is unsupported unless `--allow-lossy`. Add a `doctor` check that warns when
`.claude/approvals.yml` has changed since it was last translated (a hash in the policy file).

**Phase 4 — read the Ship policy natively (only if someone needs it).** A gate node with
`policy=".claude/approvals.yml"` and a per-file evaluator inside `merge-gate`: per-rule
seats counted from formal reviews, people lists resolved through the teams API, facts
computed from the PR. This removes most "lossy" rows above. It is a second policy engine
beside `evaluateMergeGate`, so it should wait for a real consumer. Custom classifiers would
still be out: they need a model run per rule, which is a lane, not a gate clause.

---

## Decisions to make

1. **Translate or evaluate?** Phases 1–3 keep one policy engine and accept the losses.
   Phase 4 is faithful and roughly doubles the gate's surface. Recommendation: stop at 3
   until a consumer's policy cannot be expressed.
2. **Which file is the source of truth** once both exist? Recommendation: the gp-foundry
   policy, with the Ship file as an input the `doctor` check keeps in step — the gate
   reads its policy from the base branch on every run and should not parse a second format there.
3. **A dropped rule makes the result weaker than the source.** Should `--write` refuse by
   default? Recommendation: yes.
4. **N-person seats.** Leave to GitHub's required approvals (today's answer), or teach the
   sign-off to count people? The second is a small change in `signoffCandidates` and would
   turn two "lossy" rows into exact ones.

## Not verified

Everything about Ship here comes from its documentation, not from running it. The docs give
no explicit ordering for `claude/diff` answers and two different lists for `.severity`; the
POC reads neither. The translator has been run against the docs' example policies only.
