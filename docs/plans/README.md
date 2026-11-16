# Plans

Dated design specs for gp-foundry. Newest ideas start here; each becomes an
implementable artifact. Naming convention:

```
docs/plans/YYYY-MM-DD-<slug>.md
```

Prefix by date so the record is chronological and append-only — a later plan may
supersede an earlier one, but we don't rewrite history in place; we add a new
dated plan and mark the old one superseded.

| Date | Plan | Status |
|------|------|--------|
| 2026-07-01 | [gp-foundry — System Design](./2026-07-01-gp-foundry-system-design.md) | Draft — for review |
| 2026-11-16 | [Native merge, one policy](./2026-11-16-native-merge-and-one-policy.md) | Superseded |
| 2026-11-16 | [Hybrid pipeline (0.3.0)](./2026-11-16-hybrid-pipeline.md) | Design settled; not yet built |

Anticipated follow-on plans (each a component deep-spec spawned from the system design):
`…-harness-spec-and-ir.md`, `…-dot-compiler.md`, `…-runtime-core-actions.md`,
`…-mock-agent-and-e2e.md`, `…-claude-skill.md`, `…-eval-suite.md`.
