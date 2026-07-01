<!-- roles/<name>.md — a job description (content, runtime-loaded). Editing the prose below
     needs NO rebuild; only changing the `handoffs` (which must mirror the node's out-edges
     in harness.dot) is a topology change that requires `gp-foundry build`. -->
---
role: <RoleName>                 # human-readable identity, e.g. Builder / Copywriter
type: <node-type>               # must equal this node's type in harness.dot
mission: <one sentence — what this role turns X into Y>
accountable_for:                # the definition-of-done, as checkable bullets
  - <e.g. tests pass>
  - <e.g. stays in scope (scope.yaml)>
  - <e.g. PR <= size gate>
inputs:                         # what it reads before acting
  - <e.g. issue + comments>
  - <e.g. plan from the analyst, if present>
  - <e.g. scope.yaml>
outputs:                        # what it produces
  - <e.g. branch <prefix>/<n>-slug>
  - <e.g. PR closing the issue>
  - <e.g. a JSON report block>
handoffs:                       # MUST equal this node's out-edges in harness.dot (validated both ways)
  - to: <TargetRole>            #   e.g. Reviewer
    when: <guard>               #   e.g. PR opened  (mirrors the edge's on=/when=)
  - to: needs-human
    when: <bounded-escape condition, e.g. touches immutable path OR exceeds size gate>
tools: "<allowed-tools list, e.g. Read,Write,Edit,Glob,Grep,Bash(git:*),Bash(gh:*)>"
quality_bar: <the non-negotiable, e.g. never report success with failing tests; match existing patterns>
---

## Repo-specific guidance

<!-- The ONLY per-repo delta. Put stack commands, conventions, and gotchas here.
     e.g. "Run `make generate` if proto/sqlc files change before testing." -->
- <repo-specific instruction>
- <repo-specific instruction>
