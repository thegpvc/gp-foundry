# Starter role packs (E4) — adapt, don't invent from scratch

Once the interview reveals the domain (Q1), adapt from the matching pack so you propose a
sensible default graph instead of a blank one. A pack's roles are designed so their
`handoffs` form a valid graph out of the box. You then rename, drop, and re-wire to fit the
repo, and fill each role's repo-specific overlay. Types are domain-neutral; only the roles,
gates, and invariants change between packs.

## Software pack (code repos)

The canonical "issues in → reviewed, auto-merged PRs out" pipeline.

| role | type | one-line job |
|------|------|--------------|
| Scout | `issue-agent` | triage an incoming issue; label it for a lane |
| Planner | `analyst` (output=comment) | for big/ambiguous issues, post a plan before building |
| Builder | `producer` | turn a labeled issue into a small, tested, shippable PR |
| Reviewer | `pr-review` | read the diff, run gates, post an approve/request-changes verdict |
| Fixer | `pr-fix` (max_attempts=3) | apply review feedback; bounded retry loop with Reviewer |
| merge-gate | `merge-gate` | enforce merge policy; auto-merge or label for a human (a gate, not a persona) |
| Janitor | `scheduled-agent` | rebase PRs the gate flagged `needs-rebase` so they can merge |
| Supervisor | `scheduled-agent` | sweep for stranded issues/PRs and re-drive them; escalate to `needs-human` after repeated nudges |
| Retro | `scheduled-agent` | mine the record for recurring lessons; write them to memory |

Default graph: `start → Scout → {Planner|Builder} → Reviewer ↔ Fixer → merge-gate`,
with `Fixer → needs_human [when="attempts>=3"]`, plus scheduled `Janitor` (rebase sweep),
`Supervisor` (self-healing re-drive), and `Retro` (learning). This is the shape in the
default `templates/harness.dot`.

## Content / marketing pack (proves domain-generality)

Same node types, same compiler, same runtime core — only roles, gates, and validation
change. The `human-gate` matters *more* here (brand risk), which is why it's first-class.

| role | type | one-line job |
|------|------|--------------|
| Brief-Triager | `issue-agent` | shape a content request into a brief |
| Copywriter | `producer` | draft copy in a PR |
| Brand-Critic | `pr-review` (gates="linkcheck.yml,spellcheck.yml") | check voice, links, spelling |
| Editor | `pr-fix` (max_attempts=2) | apply edit notes; bounded loop with Brand-Critic |
| Publish | `human-gate` (environment=production) | brand sign-off before go-live |

Default graph: `start → Brief-Triager → Copywriter → Brand-Critic ↔ Editor → Publish`.
Note the terminal is a **human-gate**, not an automated merge — the brand approval is the point.

## Docs pack

| role | type | one-line job |
|------|------|--------------|
| Docs-Triager | `issue-agent` | shape a docs request |
| Writer | `producer` | draft/update docs in a PR |
| Doc-Reviewer | `pr-review` (gates="linkcheck.yml") | accuracy + style verdict |
| Doc-Fixer | `pr-fix` (max_attempts=2) | apply review notes |
| Doc-Shipper | `merge-gate` | merge on green |

## Analyst-only / advisory pack (lowest privilege)

For repos that want Q&A, research, planning, or design-docs with **no code writes at all**.
Everything stays `contents: read`; the only output is a comment or a docs-path commit.

| role | type | one-line job |
|------|------|--------------|
| Answerer | `analyst` (context=codebase, output=comment) | answer questions about the repo |
| Planner | `analyst` (context=issue, output=doc:docs/plans/*) | draft a plan/spec as a committed doc |

Default graph: `start → {Answerer|Planner}`, no `producer`, no merge-gate — the safest harness.

## Adapting a pack

1. Pick the pack from Q1's domain answer.
2. Rename roles to the repo's vocabulary; drop lanes the repo doesn't need (e.g. no Planner
   if issues are always small).
3. Re-wire edges to the handoffs the user described in Q3, keeping every loop bounded.
4. Fill each `roles/<name>.md` repo-specific overlay (stack commands, conventions) — that
   overlay is the only per-repo delta; the front-matter contract stays intact.
5. Set the gates and `scope.yaml` invariants from Q2. For content/docs, a `human-gate` before
   publish is usually correct; for code, a `merge-gate` policy usually is.
