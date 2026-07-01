# gp-foundry — System Design

**Date:** 2026-07-01 · **Status:** Draft for review · First plan of the set (see [README](./README.md)).

> **Naming (D0):** working name **`gp-foundry`** — a foundry *forges* harnesses (plural, for
> many repos). The repo is currently `gp-actions` in `moat.yaml`; renaming is a one-line change
> and is cheap now, costly once consumers pin paths. Alternative: `gp-harness` (more literal).
> Confirm before we commit the name.

---

## 0. What this is, in one paragraph

gp-foundry turns an **autonomous agent harness** — the "issues in → reviewed, auto-merged PRs
out" pipeline currently hand-wired across 14 workflows in `thegpvc/gp-dixie` — into a thing you
**declare once as a directed graph and compile** into a repo. The graph (`harness.dot`,
Graphviz DOT) is the single source of truth for the harness *topology*; a **compiler** emits
plain GitHub Actions workflows from it; **GitHub remains the executor** (native events,
per-job least-privilege, Environment approvals, secrets, scheduling); a small **pinned runtime
core** of actions are the node "handlers"; and a **Claude skill** scaffolds, regenerates, and
reconciles. Prompts/roles/policy are **externalized content**, edited freely (and by the
harness itself), never baked into the generated YAML.

**The interface is agent-shaped, and the harness is domain-general.** gp-foundry has **two
first-class front doors over one engine**: a packaged **Claude skill** that interviews you
Socratically (great for discovery and first setup) *and* an **ergonomic CLI** (`gp-foundry`) for
power users, quick edits, scripting, and CI's drift-check. Agent *and* human drive the same
deterministic compiler. And nothing here is code-specific: because a node's mechanical
*type* is separate from its *role* (job description), the same pipeline that ships Go code can
ship marketing copy, docs, or config — a landing-page repo might cast a **Copywriter** →
**Brand-Critic** → **human publish-gate**. gp-foundry generates an autonomous *work* harness;
code is just one domain.

**Prior art we borrow from — and where we diverge.** StrongDM's
[Attractor](https://github.com/strongdm/attractor) defines multi-stage AI workflows as DOT
graphs (nodes=tasks, edges=transitions, typed node handlers). We **steal its representation**
(DOT graph, node-type→handler registry, restricted DOT subset, first-class human-gate node),
**reject its execution model** (Attractor runs a graph-traversal engine; we compile to GitHub
Actions so the platform executes — critical for native per-job least-privilege on a
write-capable fleet), and **invert its config choice** (Attractor embeds prompts inline in DOT;
we reference content by path so it stays editable and runtime-loaded).

---

## 1. Principles

1. **The graph is the source of truth.** `harness.dot` defines nodes (roles), edges
   (transitions/loops), and human gates. Everything downstream is derived.
2. **Generated workflows are a build artifact.** Every emitted `.yml` carries a
   `# GENERATED FROM harness.dot — DO NOT EDIT` header and is **drift-checked** in CI
   (`gp-foundry build --check` → `git diff --exit-code`). You change the harness by editing the
   spec and running the rebuild in a PR — never by hand-editing YAML.
3. **Content is externalized and runtime-loaded.** Prompts, role job-descriptions, and policy
   live in `roles/`, `prompts/`, `policy/`. `run-agent` loads them at runtime, so editing a
   prompt needs **no regeneration** — only topology/policy changes trigger a rebuild.
4. **GitHub is the executor.** We generate native workflows; we do not build an orchestration
   runtime. Loops/conditions must be expressible in GitHub-observable primitives (events,
   labels, check conclusions, schedules) — which is exactly how dixie already coordinates.
5. **Small pinned runtime core.** The security-sensitive, invariant-bearing handlers
   (`run-agent`, `sanitize-untrusted-input`, `merge-gate`, …) are versioned actions the
   generated workflows call, so fixes propagate centrally. A `runtime: pinned | vendored` knob
   lets teams vendor them for zero external deps (shadcn-style).
6. **The agent is the only thing you can't unit-test.** Quarantine nondeterminism to one seam
   (`run-agent`) and one periodic eval suite; make everything around it deterministic and
   tested (see §7).
7. **Cleanroom decomposition.** Every component is defined by a typed **contract** and depends
   only on other components' contracts, never their internals (§5). The shared types are the
   "public headers."
8. **Two first-class front doors, one engine (agent + human).** A Socratic **skill** for
   discovery/setup *and* an **ergonomic CLI** (`gp-foundry`) for power users, scripting, and CI
   both drive the same deterministic compiler. Agent-shaped, not agent-*only* — humans get
   first-class ergonomics (clear subcommands, `--dry-run`, readable diffs, actionable errors).
9. **Domain-general.** A node's *type* is a mechanical GitHub interaction; its *role* carries the
   domain — so one harness generator ships code, marketing copy, docs, or config.

---

## 2. Architecture & data flow

```
 AUTHOR (human or the harness's own Gardener)
   edits: harness.dot · roles/*.md · prompts/*.md · policy/*.yaml · foundry.config.yaml
        │
        ▼
 ┌─────────────────────── COMPILE-TIME (deterministic, TypeScript) ───────────────────────┐
 │  B1 Parser      DOT(subset) ─────────────► Harness IR (A2, typed)                       │
 │  B2 Validator   IR + files ─────────────► Diagnostic[]  (refs, role↔edge handoffs, schema)│
 │  B3 ModelCheck  IR ──────────────────────► TopologyDiagnostic[] (reachability, deadlock, │
 │                                             unbounded loops, label races)                │
 │  B4 Handlers    per node.type ──emit────► WorkflowJobFragment    (registry)             │
 │  B5 Wiring      edges ──────────────────► triggers + if-guards + dispatches             │
 │  B6 Assembler   fragments+wiring+preamble► .github/workflows/*.yml  (GENERATED header)   │
 │  B7 Diagram     IR ──────────────────────► HARNESS.md (graph render)                     │
 │  B8 CLI `gp-foundry build [--check]` orchestrates B1..B7                                 │
 └─────────────────────────────────────────────────────────────────────────────────────────┘
        │ emits (drift-checked)
        ▼
 GENERATED WORKFLOWS  ──── on GitHub events ────►  RUNTIME (GitHub Actions executor)
        │                                              each job calls the pinned RUNTIME CORE:
        │                                              C1 setup-agent · C2 loader · C3 agent-context
        │                                              C4 run-agent · C5 sanitize · C6 fallback
        │                                              C7 merge-gate · C8 dependency-chain · C9 wait-for-checks
        ▼
 SKILL (E): interview→spec · build · reconcile-against-local-edits · evolve-as-PR
 TESTS: Tier1 structural · Tier2 model-check + mock-agent e2e · Tier3 seam/safety · Tier4 evals
```

---

## 3. The spec: `harness.dot` + externalized content

### 3.1 Node = `type` × `role` (orthogonal axes)

- **`type`** — the *mechanical handler* the compiler needs (small closed set). Decides trigger
  surface, permission set, whether it pushes code, context source, steps.
  `analyst · issue-agent · producer · pr-review · pr-fix · merge-gate · human-gate · parallel · fan_in · start · exit`.
- **`role`** — the *behavioral identity* the agent needs (open set): Builder, Critic, Scout, …
  A path to a role file (job description). Externalized content.

Builder and Gardener are different **roles** on the same **type** (`producer`); Scout and
Architect share `type=issue-agent`. This is why dixie has ~10 personas but only ~5 mechanical
shapes.

**Types are domain-neutral; roles carry the domain.** A `type` names a *mechanical interaction
with GitHub* (`producer` = issue→branch→PR; `pr-review` = read a diff, post a verdict), not a
software concept — which is what makes the harness domain-general. A marketing site casts a
**Copywriter** role on `producer`, a **Brand-Critic** on `pr-review`, and a `human-gate` before
publish; the plumbing is identical to shipping code — only the role's job description, its
allowed tools, and its definition-of-done differ, and all three are content the author supplies.

**Read-and-advise vs create-a-change is the deepest split — it *is* the permission axis.** A
first-class type **`analyst`** captures the agent that **reads and understands** (code, a PR,
the repo, or a question) and whose deliverable is an *artifact* — a comment, answer, plan, spec,
or draft — **not** a code change. It is **read-only on code** (`contents: read`); its only
writes are a comment or, via `output=doc:<path-glob>`, a document committed to an allowlisted
docs path. That makes it the safest, lowest-privilege agent — ideal for Q&A, research, planning,
and design-docs (it turns dixie's bolted-on *spike* mode into a real type), and it makes
**plan-then-build** expressible (`analyst` drafts a spec → `producer` implements → `pr-review`
checks). Mechanically, today's `issue-agent` (Scout) and `pr-review` (Critic) are just `analyst`
specialized by `context=` (issue | pr-diff | codebase) and output contract — we can collapse
them into `analyst` or keep them as named specializations (**D10**).

### 3.2 Example `harness.dot`

```dot
digraph harness {
  // ── nodes: type = handler, role = job-description (referenced, never inlined) ──
  start     [type=start]
  scout     [type=issue-agent, role="roles/scout.md"]
  architect [type=issue-agent, role="roles/architect.md"]
  builder   [type=producer,  role="roles/builder.md"]
  critic    [type=pr-review,   role="roles/critic.md",  gates="ci.yml,screenshots.yml"]
  fixer     [type=pr-fix,      role="roles/fixer.md",   max_attempts=3]
  shipper   [type=merge-gate,  policy="policy/merge.yaml", schedule="*/30 * * * *"]
  release   [type=human-gate,  environment=production]
  needs_human [type=exit]

  // ── edges: on = GitHub event, when = GitHub-observable guard ──
  start     -> scout      [on="issues.opened"]
  scout     -> architect  [when="label=agent-brainstorm"]
  scout     -> builder    [when="label=agent"]
  architect -> builder    [when="label=agent"]
  builder   -> critic     [on="pull_request.opened"]
  critic    -> shipper    [when="verdict=approve"]
  critic    -> fixer      [when="verdict=request_changes"]
  fixer     -> critic     [on="push"]                 // retry loop
  fixer     -> needs_human [when="attempts>=3"]        // bounded escape (required on every loop)
  shipper   -> release     [when="ci=pass && size<gate && !protected_paths"]
}
```

### 3.3 Role file (job description — first-class, cross-checked)

```markdown
<!-- roles/builder.md -->
---
role: Builder
type: producer
mission: Turn an `agent`-labeled issue into a small, tested, shippable PR.
accountable_for: [tests pass, stays in scope, PR ≤ size gate, independently deployable]
inputs: [issue + comments, brainstorm plan if present, scope.yaml, memory/topics]
outputs: [branch <prefix>/<n>-slug, PR closing the issue, JSON report block]
handoffs:                       # MUST match this node's out-edges in harness.dot
  - to: Critic       when: PR opened
  - to: needs-human  when: touches immutable path OR exceeds size gate
tools: "Read,Write,Edit,Glob,Grep,Bash(make:*),Bash(git:*),Bash(gh:*)"
quality_bar: never report success with failing tests; match existing patterns
---
## Repo-specific guidance
<!-- consumer overlay: stack commands, conventions — the only per-repo delta -->
```

The **`handoffs` in a role must equal the node's outgoing edges** in the graph. The validator
cross-checks both directions — the job description and the topology validate each other (a
handoff with no edge, or an edge with no declared handoff, is a build error). `run-agent`
composes the role front-matter + prose into the prompt at runtime.

### 3.4 File layout (consumer repo, after `gp-foundry build`)

```
.github/
  workflows/*.yml         # GENERATED — drift-checked, do not edit
  harness.dot             # source of truth (topology)
  roles/*.md              # job descriptions (content; runtime-loaded)
  prompts/*.md            # optional extra prompt bodies (content)
  policy/*.yaml           # merge policy, size gates, protected paths (content)
  scope.yaml              # immutable/forbidden paths (canonical, CI-enforced)
  foundry.config.yaml     # identity, model, labels, branch prefix, build profile
  agent-setup/action.yml  # consumer-owned toolchain composite (see §6)
```

### 3.5 The harness is domain-general (worked example: a marketing site)

Same six node types, same compiler, same runtime core, same tests — only the roles, gates, and
validation change. The human-gate matters *more* here (brand risk), which is exactly why it's a
first-class node.

```dot
digraph marketing {
  start   [type=start]
  brief   [type=issue-agent, role="roles/brief-triager.md"]   // shape a content request
  writer  [type=producer,    role="roles/copywriter.md"]      // draft copy in a PR
  brand   [type=pr-review,   role="roles/brand-critic.md", gates="linkcheck.yml,spellcheck.yml"]
  editor  [type=pr-fix,      role="roles/editor.md", max_attempts=2]
  publish [type=human-gate,  environment=production]          // brand sign-off before go-live

  start  -> brief   [on="issues.opened"]
  brief  -> writer  [when="label=content"]
  writer -> brand   [on="pull_request.opened"]
  brand  -> publish [when="verdict=approve"]
  brand  -> editor  [when="verdict=request_changes"]
  editor -> brand   [on="push"]
}
```

---

## 4. Platform constraints the compiler must respect

These GitHub Actions facts (verified, 2024–2026) are *inputs to the compiler*, not footnotes.

| # | Constraint | Compiler consequence |
|---|---|---|
| P1 | `uses:` can't be an expression | The compiler emits **literal** `uses:` refs; node behavior is chosen at *build* time by `type`, never at runtime. No dispatcher. |
| P2 | A workflow's `./` action paths resolve against the **caller** repo | Generated workflows call runtime-core actions by **full pinned path**; the consumer's `./.github/agent-setup` is invoked *after* checkout, so `./` correctly resolves to the consumer (§6). |
| P3 | Reusable-workflow inputs are scalar-only; env doesn't cross the boundary | Not our problem — we **generate** workflows rather than parameterize a reusable one, so rich config rides in files, not inputs. (This is a reason codegen beats a reusable-workflow library here.) |
| P4 | A single matrix job's outputs overwrite across legs | The `fan_in` handler collects via **artifacts / state re-query**, never job outputs. |
| P5 | `GITHUB_TOKEN` pushes don't trigger downstream workflows | Generated workflows use the **App token** for pushes so loops actually fire; the compiler wires the App-token mint into the preamble. |
| P6 | Permissions only narrow; a job's `permissions:` is static | Each generated job gets the **minimal static permission set for its node type** (producer=write, pr-review=read+PR). This is why per-type handlers own their permissions. |
| P7 | JS actions run committed `dist/`; tags are mutable | Runtime-core actions ship ncc `dist/` with a check-dist gate; consumers **SHA-pin** them. |

---

## 5. Component decomposition (cleanroom catalog)

Each component: **responsibility · contract · depends-on · test tier**. Components depend only
on the *contracts* (types/`action.yml`) of their dependencies. The shared types below are the
public headers.

### Shared types (the "headers" — Group A)

```ts
// A2 — Harness IR (produced by B1, consumed by B2/B3/B4/B5/B7)
type NodeType = 'analyst'|'issue-agent'|'producer'|'pr-review'|'pr-fix'|'merge-gate'
              | 'human-gate'|'parallel'|'fan_in'|'start'|'exit'
interface Node { id:string; type:NodeType; role?:string; attrs:Record<string,string|number|boolean>;
                 files:{prompt?:string; policy?:string; tools?:string} }
interface Edge { from:string; to:string; on?:string; when?:string; do?:string }
interface Harness { name:string; nodes:Node[]; edges:Edge[]; config:FoundryConfig }

// B2/B3 — diagnostics
interface Diagnostic { level:'error'|'warn'; code:string; where?:{node?:string; edge?:[string,string]}; message:string }

// B4 — node-type handler contract (the registry entry)
interface StepSpec { /* structured step, not raw YAML */ }
interface WorkflowJobFragment { jobId:string; permissions:Record<string,'read'|'write'|'none'>;
                                needs?:string[]; environment?:string; strategy?:unknown; steps:StepSpec[] }
interface Handler { type:NodeType; emit(node:Node, ir:Harness, ctx:EmitContext):WorkflowJobFragment }
```

### Group A — Spec & IR (build first; everything depends on these)

- **A1 · Harness Spec & Schemas** — *the DOT subset grammar + node/edge attribute vocabulary +
  role front-matter schema + `foundry.config.yaml` + `policy/*.yaml` JSON Schemas.*
  **Contract:** a written grammar + JSON Schema files. **Depends:** nothing.
  **Tests:** schema self-tests; example specs validate. *This is the contract of contracts.*
- **A2 · Harness IR types** — *the typed model above.* **Contract:** the TS types.
  **Depends:** A1. **Tests:** type-level; fixtures.

### Group B — Compiler (deterministic, TypeScript)

- **B1 · DOT Parser** — DOT(subset) + resolved file set → `Harness` IR or parse errors.
  **Contract:** `parse(dot:string, files:FileSet): Result<Harness, Diagnostic[]>`.
  **Depends:** A1,A2. **Tests:** Tier 1 — golden IR fixtures; malformed-DOT → expected errors.
- **B2 · Validator** — IR → `Diagnostic[]` for referential integrity (edges↔nodes, **role
  handoffs↔out-edges**, `role/prompt/policy` files exist, human-gate has an environment),
  schema validation. **Contract:** `validate(ir, files): Diagnostic[]`. **Depends:** A1,A2.
  **Tests:** Tier 1 — fixture IR → expected diagnostics.
- **B3 · Graph Model-Checker** — IR → `Diagnostic[]` for topology: unreachable nodes, dead
  ends, **cycles without a bounded escape edge** (the dixie fixer↔merger livelock class), label
  races (two nodes on same event+guard). **Contract:** `check(ir): Diagnostic[]`.
  **Depends:** A2 only (pure graph theory — implementable with zero GitHub/Claude knowledge).
  **Tests:** Tier 2 — crafted graphs → expected topology verdicts. *Most cleanroom component.*
- **B4 · Node-Type Handlers** — one `Handler` per `NodeType`; `emit()` → `WorkflowJobFragment`.
  **Contract:** the `Handler` interface + a registry keyed by type. **Depends:** A2 + the
  **`action.yml` contracts of Group C** (not implementations) + the `StepSpec` type.
  **Tests:** Tier 1 — per handler, node fixture → expected fragment (semantic assertions, not
  byte snapshots). *Most parallelizable set: each handler is a small independent function.*
- **B5 · Edge/Wiring Compiler** — edges → per-target triggers (`on:`), `if:` guards from
  `when=`, and cross-workflow dispatches. **Contract:** `wire(ir): WiringPlan`. **Depends:**
  A2. **Tests:** Tier 1/2 — fixture graph → expected trigger/guard/dispatch plan.
- **B6 · Assembler/Serializer** — fragments + wiring + **security preamble** (App-token mint,
  checkout-with-token, static `permissions:`, harden-runner) → complete workflow YAML with the
  GENERATED header. **Contract:** `assemble(fragments, wiring, ctx): Map<path,yaml>`.
  **Depends:** B4,B5 outputs + a preamble template. **Tests:** Tier 1 — output passes
  `actionlint`+`zizmor`; golden files.
- **B7 · Diagram Renderer** — IR → `HARNESS.md` graph. **Contract:** `render(ir): string`.
  **Depends:** A2. **Tests:** Tier 1 — golden.
- **B8 · CLI `gp-foundry`** — the human **and** agent command surface (first-class, not just an
  internal engine). Subcommands: `init` (scaffold spec/config), `build [--check] [--dry-run]`
  (compile / drift-gate / preview diff), `validate`, `graph` (render/inspect topology),
  `add <role|node>` (extend the graph), `explain <node>` (show what a node compiles to).
  Ergonomics: readable diffs, `--json` for machine/agent consumption, diagnostics with
  `file:line` + fix hints (from B2/B3). Orchestrates B1–B7; the skill (E) shells out to it.
  **Contract:** argv → files/diff/exit-code (+ `--json`). **Depends:** B1–B7. **Tests:** Tier 1
  — e2e on fixture specs; `--check` idempotence; golden CLI output.

### Group C — Runtime core (pinned actions; the node handlers at runtime)

Each is an independently unit-tested action with an `action.yml` contract. Where a dixie
original exists it's the starting point. (JS = Vitest + ncc + check-dist; composite = shell.)

- **C1 · setup-agent** (composite) — install claude-code + git identity + toolchains-as-inputs.
  **Contract:** inputs `{install-go, go-version, install-protoc, node-version, setup-commands, identity…}` → tools on PATH.
- **C2 · loader** (JS) — parse `foundry.config.yaml` + resolve a node's role/tools/model/timeout/labels → outputs + JSON blob. **Contract:** `(config-path, node-id) → resolved`.
- **C3 · agent-context** (JS) — fetch issue/PR/diff (octokit), cap diff, write context file. **Contract:** `(type, number, token) → context-file`. *Liftable from dixie ~verbatim.*
- **C4 · run-agent** (composite) — assemble prompt `[role → overlay → conventions → scope → context]`, invoke `claude -p --model --allowedTools`, capture stderr. **Contract:** `(node/role, config-json, context-file, prompt-files, oauth-token, timeout) → runs`. *Keystone + the seam mocked in Tier-2 tests.*
- **C5 · sanitize-untrusted-input** (JS) — neutralize attacker-controlled text before it reaches a prompt. **Contract:** `(raw) → safe`.
- **C6 · agent-fallback** (composite) — strip `immutable_paths` (from `scope.yaml`), commit leftover work, push, open/label PR. **Contract:** `(branch, token, config-json) → effect`.
- **C7 · merge-gate** (JS) — evaluate merge policy (approval-delay, CI, size excl. generated, protected paths, clean rebase) → decision + audit. **Contract:** `(pr, policy) → {action:'merge'|'skip'|'label', reason}`. *Ports the Shipper bash into a tested function.*
- **C8 · dependency-chain** (JS) — parse `depends-on/parent` markers, unblock dependents on merge, close finished parents. **Contract:** `(mergedPR, openIssues) → labelOps`.
- **C9 · wait-for-checks** (JS) — poll a named CI workflow / check to conclusion. **Contract:** `(sha, workflow-name, timeout) → conclusion`.

**Tests (all C):** Tier 3 — unit tests (mock `@actions/core`, `vi.resetModules()`, `throw` not
`process.exit`), check-dist, self-dogfood `uses: ./actions/<x>` under OS matrix.

### Group D — Mock/test harness (Tier 2 plumbing e2e)

- **D1 · Mock agent** — a stub with C4's interface that performs **scripted git/gh actions**
  instead of calling Claude. **Contract:** `(scenario, node) → deterministic actions`.
- **D2 · Scenario driver + fixtures** — scripts of `(event → mock-response → expected repo
  state)`; the plumbing regression suite. **Contract:** a scenario schema + assertion runner.
- **D3 · Sandbox e2e runner** — provisions an ephemeral repo, installs a generated harness with
  the mock agent, drives events, asserts transitions. **Depends:** B8 + D1/D2 + C4 *interface*.

### Group E — Agent-shaped interface (the primary UX)

The front door is a packaged **Claude skill** (`skill/SKILL.md` in gp-foundry, invoked inside a
target repo). It calls the B8 CLI under the hood; the CLI stays the deterministic engine for CI
and drift-check. The thing that sets up the agent harness is itself an agent.

- **E1 · Socratic setup** — interviews the user instead of demanding a blank `harness.dot`; the
  questions *are* the graph-construction algorithm (*What does this repo produce, and what is
  'done'? Who or what approves, and what must never change? What roles, and how do they hand
  off? What cadence?*). From the answers it drafts `harness.dot` + role/prompt stubs +
  `foundry.config.yaml` + `scope.yaml`, renders the diagram, and iterates. **Contract:**
  conversation → spec files.
- **E2 · Build & reconcile** — runs `gp-foundry build`, explains the diff, reconciles regen
  against local edits (managed-region markers + Claude-merge fallback). **Depends:** B8.
- **E3 · Evolve-as-PR** — "add a Copywriter role", "tighten the merge gate" → edits the spec,
  rebuilds, opens a PR. How a live harness (and its own Gardener) self-modifies. **Depends:** B8.
- **E4 · Role library** — curated starter role packs the interview adapts from: *software*
  (Builder/Critic/Scout/Fixer/…), *content* (Copywriter/Brand-Critic/Editor), *docs*
  (Writer/Reviewer). A registry of job descriptions (the shadcn registry, now of roles).
  **Contract:** versioned `roles/*.md` packs + manifest. **Tests:** each pack's handoffs form a
  valid graph.

### Group F — Evals (Tier 4, periodic)

- **F1 · Eval fixtures** — planted-bug PRs (Critic), planted-regression issues (Builder),
  injection/immutable-path safety cases.
- **F2 · Scored runner + LLM-judge** — deterministic checks + judged quality; tracks pass-rate.
- **F3 · Seam contract tests** — assert agent output conforms to the parseable contract
  (valid `**Verdict:**`, JSON report block, `Closes #N`). *Cheap enough for per-commit.*

---

## 6. Setup injection (unchanged, still needed at runtime)

Generated workflows checkout the consumer, then call the literal `uses: ./.github/agent-setup`
— which resolves to the **consumer's** composite (P2). That composite calls the pinned
`setup-agent` with the repo's toolchain inputs and may `uses:` any third-party setup action.
The compiler emits the `./.github/agent-setup` call; the consumer owns the file. No-stack
harnesses ship a no-op composite (node + claude-code only).

---

## 7. Testing & validation (the five tiers, mapped to components)

Decompose "is a generation *true*?" into tiers of decreasing determinism; push work upward.

**Tier 1 — Structural truth (deterministic, per-commit).** A *correct generation* = these
**spec↔output invariants** hold (test as properties, plus golden diffs + output-lint):
- edge `a→b [on=E, when=L]` ⟺ b's workflow has trigger `E` and a guard matching `L`.
- `type=producer` ⟺ job has the producer permission set + `run-agent`+`agent-fallback`, nothing more privileged.
- `type=human-gate, environment=X` ⟺ job has `environment: X`.
- `type=analyst` ⟺ job is `contents: read` (no code write) + context-appropriate comment perm; `output=doc:<glob>` ⟺ the only committed paths match `<glob>`.
- every `role/prompt=P` ⟺ `P` exists, is **referenced not inlined**, role handoffs == out-edges.
- **no** generated `run:` contains `${{ github.event.* }}`; output passes `actionlint`+`zizmor`.
- `build --check` is idempotent (drift gate).
Owned by: B1,B2,B4,B5,B6 tests.

**Tier 2 — Plumbing behavior (deterministic).**
- **Graph model-check (B3):** unreachable/deadlock/**unbounded-loop**/label-race — catches the
  dixie fixer↔merger livelock class *at build time*.
- **Mock-agent e2e (D):** swap `run-agent` for a scripted stub, drive a sandbox repo with
  scripted events, assert state transitions (branch/PR/labels/merge). Tests the **entire wiring
  on real GitHub, deterministically, with zero LLM cost.** *The highest-leverage test.*

**Tier 3 — Runtime-core correctness (deterministic).** Unit tests + check-dist + OS-matrix
self-dogfood for every Group C action.

**Tier 4 — Agent contract & safety (mostly deterministic).**
- **Seam contract (F3):** agent output parses to the contract the state machine depends on
  (`merge-gate` greps `Verdict.*APPROVE`; a drifted format silently stalls the pipeline).
- **Safety (partly deterministic):** immutable-path edit → `agent-fallback` strips it;
  injection payload → `sanitize` neutralizes it. Test the *mechanisms* hard.

**Tier 5 — Agent judgment (nondeterministic, periodic).** Scored eval suite (F1/F2): planted
bugs/regressions + LLM-judge; gates *releases*, not commits.

The graph feeds compiler + model-checker + e2e, so correctness largely reduces to: the graph is
well-formed (B3), the compiler preserves it (Tier 1 invariants), and reality matches it (Tier 2
mock e2e). The LLM is the *only* thing not unit-tested, and it's boxed in on all sides.

---

## 8. Dependency graph & build order (cleanroom sequencing)

```
A1 ─► A2 ─►┬─► B1 ─► B2 ─► B3
           ├─► B4 ─► B6 ─► B8
           ├─► B5 ─┘
           └─► B7
C1..C9  (independent of B; start from dixie originals) ── parallel ──► B4 needs only their action.yml CONTRACTS
D  needs B8 + C4-interface        E needs B8        F needs C4 (real)
```

- **Wave 0:** A1, A2 (freeze the contracts).
- **Wave 1 (parallel):** Group C runtime actions (from dixie originals) **and** B1→B2→B3→B4/B5→B6→B7. B4 needs only C's `action.yml` contracts, so C impl and B can proceed independently.
- **Wave 2:** B8 CLI (integrate), then D (mock e2e).
- **Wave 3:** E (skill), F (evals).

Because each component has a frozen contract, waves 1's ~17 units (9 actions + 8 compiler parts)
are near-independent — implementable cleanroom, even by separate agents.

---

## 9. Runtime distribution model

- **Runtime core** default `pinned`: generated workflows `uses: thegpvc/gp-foundry/actions/<x>@<sha>`; SHA-pinned; Dependabot-tracked; central security fixes.
- **`runtime: vendored`** knob: the CLI copies the action sources into the consumer (shadcn-style) for zero external deps, accepting manual security-patch reconciliation.
- The **compiler + skill** are consumed as a dev dependency / the Claude skill; they run at author-time and in the drift-check CI job, not at harness runtime.

---

## 10. Phasing / milestones

- **M0 — Contracts:** A1 schemas + A2 IR + all Group C `action.yml` contracts + the
  `WorkflowJobFragment`/`Handler` interfaces. Nothing runs yet; everything downstream unblocks.
- **M1 — Runtime core:** implement C1–C9 (lift `agent-context` first), unit-tested + check-dist.
  Independently useful — improves dixie even before the compiler exists.
- **M2 — Compiler MVP:** B1–B8 for the 6 core node types; Tier-1 invariants + golden + output
  lint green; `build --check` drift gate. Can compile dixie's harness from a hand-written
  `harness.dot`.
- **M3 — Plumbing proof:** B3 model-checker + D mock-agent e2e on a sandbox repo (Tier 2).
- **M4 — Skill + reconcile:** E1–E4 (Socratic setup + role packs + reconcile); migrate gp-dixie
  to a generated harness end-to-end. Prove domain-generality with a second consumer (e.g. a
  marketing-site repo) driven purely by a different role pack.
- **M5 — Evals:** F fixtures + scored runner (Tier 5), wired as a release gate.

---

## 11. Open decisions

| # | Decision | Recommendation |
|---|---|---|
| **D0** | Repo name | **`gp-foundry`** (vs `gp-harness`). Update `moat.yaml` on confirm. |
| **D1** | Generator language | **TypeScript** (cohesion with JS actions + skill; shared types). |
| **D2** | v1 node-type set | **6** (`issue-agent, producer, pr-review, pr-fix, merge-gate, human-gate`) + `start/exit`; add `parallel/fan_in` when a real fan-out appears. |
| **D3** | Mock-agent scenario suite in v1 | **Yes** — it's the highest-leverage test (Tier 2). |
| **D4** | Scored evals in v1 | **Defer to M5** — ship Tiers 1–4 (deterministic) first; add evals once plumbing is proven. |
| **D5** | Reconcile model | **Managed-region markers** (predictable) with Claude-merge as the fallback for conflicts. |
| **D6** | Runtime default | **`pinned`** core (central security fixes); `vendored` available. |
| **D7** | Distribution | Marketplace-ready per your earlier call: keep each `actions/<x>` self-contained + root-`action.yml`-splittable; reusable-workflow layer is gone, so this only affects the runtime-core actions. |
| **D8** | Primary interface | **Skill-first / Socratic** — the CLI stays for CI + power users. |
| **D9** | Role library v1 | Ship a **software** pack + one **content/marketing** pack to prove domain-generality. |
| **D10** | `analyst` type + naming | Add read-only **`analyst`** (comment/answer/plan/spec/draft output). Recommend it **subsumes** `issue-agent`+`pr-review` (context-parameterized); keep `producer` as the mechanical id, with `code-agent` a fine synonym in a code harness. |

---

## 12. Provenance & sources

Supersedes the earlier library-approach drafts (removed). Durable inputs carried forward:
the GitHub Actions platform constraints (§4), the security baseline (§6, preamble in B6), and
the runtime-core actions (§5C, from the gp-dixie originals). Prior art & references:
[Attractor](https://github.com/strongdm/attractor/blob/main/attractor-spec.md) ·
[reusing workflows](https://docs.github.com/en/actions/sharing-automations/reusing-workflows) ·
[untrusted input](https://securitylab.github.com/resources/github-actions-untrusted-input/) ·
[pwn requests](https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/) ·
[create-github-app-token](https://github.com/actions/create-github-app-token) ·
[actionlint](https://github.com/rhysd/actionlint) ·
[harden-runner](https://github.com/step-security/harden-runner) ·
[super-linter config model](https://github.com/super-linter/super-linter) ·
[claude-code-action](https://github.com/anthropics/claude-code-action).
