# Claude Ship's config files as inputs to gp-foundry

**Date:** 2026-11-26 · **Status:** POC on `poc-claude-ship-inputs` (phase 1 only) · Source: the Claude Ship docs at `code.claude.com/docs/en/claude-ship` and the pages it links (approvals-policy, approvals-classifiers, approvals-pull-requests, approvals-setup, approvals-github-rules, code-review-customize, pr-steward-setup), read 2026-11-26.

A repo that already describes its review and approval rules for Claude Ship should not have
to describe them again for gp-foundry. This plan says which of Ship's files gp-foundry can
read, what each one maps to, what does not map, and the order to build it in.

## Premise and guiding principle

**Premise.** A repo runs one or the other. Where gp-foundry is in use, Ship is off. So this
is not about the two cooperating on one PR; it is about a repo moving between them, or a
team using both across repos, without rewriting its rules.

**Principle: the same files mean the same thing.** A repo's `REVIEW.md` and
`.claude/approvals.yml` are its statement of how changes get reviewed and who must approve.
gp-foundry reads them as written and gives the answer Ship would, as far as it can. Three
commitments follow:

1. **Ship's files are the format.** gp-foundry reads them in place and does not ask for a
   second copy in its own dialect. Its own policy file stays for what Ship has no word for
   (merging, CI, the pipeline's rollout).
2. **Where gp-foundry cannot give Ship's answer, it gives a stricter one.** A rule it cannot
   read sends its paths to a person; it is never dropped. Compatibility that is quietly
   weaker is worse than none.
3. **Every difference is stated, with its direction.** The tool marks each rule `mapped`,
   `stricter`, `looser` or not carried, so a team can see exactly where the two disagree.
   `looser` is the list of compatibility bugs: the build order below exists to empty it.

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

So a Ship policy is strictly more expressive. Reading one is a translation, and where the
translation cannot be exact it has to err on the strict side.

### The mapping (what the POC implements)

| Ship | gp-foundry | Compared with Ship |
| --- | --- | --- |
| `claude: approves`, `seats: 0` | nothing to set: the approver's APPROVE satisfies the gate | same |
| `seats ≥ 1` on `paths` (or on `**`) | `protected_paths` + `handoff_clauses: [protected-path]`; a trusted person's formal approval of the head signs it off | same, for one person |
| `if`/override `claude/code_review = pass` | the approver's APPROVE verdict | same |
| `if: "ALL pr/authors = bot:x"`, no person asked | `rollout.bot_authors: ["x[bot]"]` | same |
| `advisory: [claude/code_review]` | the reviewer lane | same |
| `locals`, `use`, `"@name"` | resolved before translating | same |
| seats without `"!pr/authors"` | a sign-off never comes from the PR's author | stricter |
| `reuse` | a verdict and a sign-off are for the exact head | stricter |
| `mode: observe` | no switch; run the gate with `merge="off"`, check not required | stricter |
| a rule or a bar-raising override conditioned on something unreadable (a classifier, `AND`/`OR`, `pr/base`, …) | its paths go to a person, always | stricter (fail closed) |
| `seats: N`, N > 1 | one sign-off | **looser**, unless GitHub's branch rules require N approvals |
| seats `from` a team or login | any person with a sign-off association | **looser**, unless CODEOWNERS review is required |
| `"!pattern"` in `paths` | `protected_path_exclude_globs`, which apply to every protected path | **looser** |
| `pr/diff_lines > N` raising the bar | `max_additions: N` + `handoff_clauses: [too-large]` (hand-written additions only) | **looser** |
| `claude: blocks` | paths go to a person + `scope.yaml` `immutable_paths` | **looser**: an approval passes what Ship would fail |

### Not carried over

- **Custom classifiers** (`repo/<name>`, `.claude/classifiers/`) are not run. Rules that read
  one fail closed, as above; a rule that only relaxes on one is left out, which asks for
  nothing less. The nearest gp-foundry thing is an analyst lane, which cannot feed the gate.
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

The order follows the principle: read the files in place first, then remove the `looser`
rows one at a time.

**Phase 1 — a read-only translator (this POC).** `gp-foundry ship [--dir] [--json]` reads
`.claude/approvals.yml` and `REVIEW.md` and prints the merge-policy keys, the config and
scope settings, and a note for every rule: mapped, stricter, looser or not carried. It
writes nothing. Code: `src/ship/approvals.ts`, `src/ship/review-md.ts`, `src/cli/ship.ts`;
tests in `src/ship/ship.test.ts` use the policy examples from Ship's docs.

**Phase 2 — `REVIEW.md` at run time.** A `pr-review` node attribute (say `review_md=true`,
default off) makes the lane's context step resolve `REVIEW.md` from the **base branch** and
append it to the role's prompt, under a short preamble that maps severity to the verdict.
Base branch only, as Ship does: a PR must not be able to rewrite the instructions it is
reviewed under. Without the attribute generated workflows stay byte-identical.

**Phase 3 — the gate reads `.claude/approvals.yml` in place.** A gate attribute (say
`ship_policy=true`) has `build` translate the file and `merge-gate` apply the result on top
of `policy/merge.yaml` at run time, from the base branch. No second copy to drift, and
`build --check` fails when a rule is `looser` unless the graph acknowledges it. This is the
point at which a Ship repo can adopt gp-foundry without writing a policy.

**Phase 4 — close the `looser` rows in the gate.** Each is a bounded change to the existing
clauses, not a second engine:

| Row | Change |
| --- | --- |
| N people | the sign-off counts distinct people (`signoffCandidates` already lists them) |
| per-rule exclusions and seats | protected paths become a list of rules, each with its own patterns, exclusions and people count |
| teams and logins | resolve a rule's people list through the teams API when gathering the sign-off |
| `claude: blocks` | a protected-path rule a sign-off cannot clear |
| `pr/diff_lines`, `pr/files_changed`, `pr/base` | computed from facts the gate already has |

**Phase 5 — classifiers (only if someone needs it).** A custom classifier is a model run
that answers a question about the change. In gp-foundry that is a lane, publishing its
answer as a check the gate reads. Until then rules that read one stay failed-closed.

---

## Decisions to make

1. **How far to go.** Phases 1–3 make a Ship repo work under gp-foundry, safely but more
   strictly than Ship. Phase 4 makes the answers agree. Recommendation: build through 3,
   then take phase 4 rows in the order real policies need them.
2. **Should `looser` block a build?** Recommendation: yes, with a per-rule acknowledgement in
   the graph. Otherwise the principle's second commitment is advisory.
3. **The other direction.** Should gp-foundry write Ship's files (`gp-foundry ship --export`)
   for a repo moving to Ship? Cheap for `REVIEW.md` (the reviewer role's guidance section),
   and for the policy keys in the mapping above. Recommendation: after phase 3, if asked for.
4. **Verdict words.** Ship's review has findings by severity; gp-foundry's ends in a verdict
   line. Is "an open Important finding = REQUEST_CHANGES" the mapping to commit to?

## Not verified

Everything about Ship here comes from its documentation, not from running it. The docs give
no explicit ordering for `claude/diff` answers and two different lists for `.severity`; the
POC reads neither. The translator has been run against the docs' example policies only.
