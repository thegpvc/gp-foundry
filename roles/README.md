# Roles

A **role** is a job description: the *content* a harness node runs. It answers
"what is this agent accountable for, what does good look like, and where does
the work go next?" — independent of any single repository's stack.

The harness graph (`harness.dot`) pairs each agent node with a role file via its
`role="roles/<pack>/<name>.md"` attribute. The node's `type` is the *mechanical*
GitHub interaction (issue-agent, analyst, producer, pr-review, pr-fix,
merge-gate, …); the role supplies the *domain* behavior. Keeping them separate
is what lets the same role pack drop into many repos.

Roles are grouped into **packs** (e.g. `software/`, `content/`, `docs/`). Each
pack is a coherent team for a kind of work. This directory can hold several
packs; a consumer picks the pack (or mix) its graph references.

## Generic role, consumer overlay

Role files here are deliberately **repo-neutral**. They describe the job, not
the toolchain. Anything repo-specific — concrete label strings, the scope-policy
file, build/test/lint and code-generation commands, size thresholds, framework
or data-layer conventions, protected-path lists, merge policy values — lives in
a **consumer overlay** (config + policy the harness feeds each node), *not* in
the generic role. A role that hardcoded one repo's stack could not be reused.

Read this split as: **the role says what to do and what "done" means; the
overlay says which commands and paths to use to do it.**

## File format

Each role is a Markdown file with a **YAML front-matter** block followed by a
generic prose contract. The front-matter is the machine-readable schema
(`RoleSpec` in `src/ir/types.ts`); the prose is the human/agent-readable
instructions.

```markdown
---
role: builder
type: producer
mission: >-
  One or two sentences: the outcome this role is responsible for.
accountable_for:
  - Bullet list of the concrete responsibilities this role owns.
inputs:
  - What the role is fed before it runs.
outputs:
  - What the role produces / leaves behind.
handoffs:
  - to: reviewer
    when: pull_request.opened
tools: Short description of the tools/access the role needs.
quality_bar: >-
  The definition of done — the bar a reviewer would hold the output to.
---

# Builder

<generic prose contract: input, behavior, guidelines — no repo-specific stack>
```

### Front-matter fields

| Field | Type | Meaning |
|-------|------|---------|
| `role` | string (required) | Stable role id; matches the file name and the node it backs. |
| `type` | NodeType | The mechanical node type this role is meant to run on (`issue-agent`, `analyst`, `producer`, `pr-review`, `pr-fix`, `merge-gate`, …). |
| `mission` | string | One- or two-sentence statement of the outcome the role owns. |
| `accountable_for` | string[] | The concrete responsibilities the role is on the hook for. |
| `inputs` | string[] | What the harness feeds the role before it runs. |
| `outputs` | string[] | What the role produces or leaves behind. |
| `handoffs` | `{to, when}[]` | Where work goes next, and the guard that fires each handoff. |
| `tools` | string | The tools / access the role needs. |
| `quality_bar` | string | The definition of done. |

### Handoffs mirror the graph edges

`handoffs` is the **role-level view of the graph's outgoing edges** for the node
this role backs. Every handoff MUST correspond to an edge in `harness.dot`, and
its `when` must match the edge's guard:

- An edge `A -> B [when="verdict=approve"]` becomes, in role `A`,
  `handoffs: [{ to: B, when: verdict=approve }]`.
- An edge with an event guard, `A -> B [on="pull_request.opened"]`, becomes
  `handoffs: [{ to: B, when: pull_request.opened }]`.
- A **terminal** role (a node with no outgoing edges, e.g. a merge gate) has
  `handoffs: []`.

Keeping `handoffs` in lock-step with the edges means the role file and the graph
never disagree about routing; the compiler/validator can cross-check them.

## The `software` pack

The `software` pack is the autonomous engineering team that takes an issue from
triage to merge. Its handoffs mirror the edges in
`the default `harness.dot``:

| Role | `type` | Hands off to | When |
|------|--------|--------------|------|
| `scout` | issue-agent | `planner` / `builder` | `label=plan` / `label=build` |
| `planner` | analyst | `builder` | `label=build` |
| `builder` | producer | `reviewer` | `pull_request.opened` |
| `reviewer` | pr-review | `merge_gate` / `fixer` | `verdict=approve` / `verdict=request_changes` |
| `fixer` | pr-fix | `reviewer` / `needs_human` | `push` / `attempts>=3` |
| `merge_gate` | merge-gate | — (terminal) | — |

The flow: **Scout** classifies an incoming issue and routes it to design
(**Planner**) or straight to build (**Builder**). The Builder opens a PR that
the **Reviewer** reviews; approvals go to the **merge gate** (the scheduled merge
gate), requested changes go to the **Fixer**, which loops back to the Reviewer —
until the attempt budget is exhausted, at which point the PR goes to a human.

These roles are generic. A consumer repo supplies its stack via the overlay:
the concrete label names, the scope-policy file, the build/test/lint and
code-generation commands, the size thresholds, and the merge policy (protected
paths, size ceiling, approval rules).
