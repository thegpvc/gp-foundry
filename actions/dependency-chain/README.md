# dependency-chain

When an agent PR merges and closes a sub-issue, this action **chains** the next
step of work:

1. **Unblock dependents.** Any open issue that declares a dependency on the
   just-closed issue via a marker comment (`<!-- depends-on: #N -->`) has its
   *blocked* label swapped for a *ready* label — but only once **all** of its
   declared dependencies are resolved.
2. **Close finished parents.** A sub-issue may point at a parent tracking issue
   with `<!-- parent: #N -->`. When the last open sub-issue of a parent closes,
   the parent is commented on and closed.

It is a generalized, testable port of gp-dixie's `agent-chain.yml`. Every
domain-specific string — labels, markers, close-keywords, comment text — is
configurable, so there are no hardcoded label names or bot identities.

## Design

The logic lives in a **pure function**, `computeChainOps` (`src/chain.ts`), which
takes plain data (the merged PR body + a snapshot of open issues) and returns a
list of declarative operations. It performs no I/O, so it is exhaustively
unit-tested (`src/chain.test.ts`). The action entrypoint (`src/index.ts`) is a
thin Octokit adapter that fetches the snapshot, calls the pure function, and
applies the ops.

```
merged PR body ─┐
                ├─▶ computeChainOps() ─▶ [ {unblock…}, {close-parent…} ] ─▶ Octokit
open issues  ───┘        (pure)                (declarative ops)            (index.ts)
```

## Inputs

| Input       | Required | Default   | Description |
|-------------|----------|-----------|-------------|
| `token`     | yes      | —         | Token with `issues: write`. Prefer a GitHub App installation token so downstream label-triggered workflows fire. |
| `config`    | no       | `{}`      | JSON object (see below). |
| `pr-body`   | no       | event     | Merged PR body to scan. Falls back to `pr-number` (API fetch) or the `pull_request` event payload. |
| `pr-number` | no       | —         | PR number to fetch the body from when `pr-body` is absent. |
| `dry-run`   | no       | `false`   | Compute + log ops without applying changes. |

### `config` JSON

| Key                  | Type       | Default                       | Meaning |
|----------------------|------------|-------------------------------|---------|
| `blockedLabel`       | string     | — (all open issues eligible)  | Label removed on unblock; also filters candidate issues. |
| `readyLabel`         | string     | — (no label added)            | Label added on unblock. |
| `dependsOnMarker`    | string     | `<!-- depends-on: #{n} -->`   | Body marker template; must contain `{n}`. Whitespace is matched loosely. |
| `parentMarker`       | string     | `<!-- parent: #{n} -->`       | Body marker template; must contain `{n}`. |
| `closeKeywords`      | string[]   | close/fix/resolve variants    | PR-body keywords that mark an issue as closed. |
| `parentCloseComment` | string     | — (close silently)            | Comment posted before closing a parent; `{n}` → parent number. |

## Outputs

| Output           | Description |
|------------------|-------------|
| `closed-issues`  | JSON array of issue numbers the PR closed. |
| `unblocked`      | JSON array of unblocked issue numbers. |
| `closed-parents` | JSON array of closed parent issue numbers. |
| `ops`            | JSON array of the full computed `ChainOp` objects. |

## Usage

```yaml
name: Chain
on:
  pull_request:
    types: [closed]

jobs:
  chain:
    if: >-
      github.event.pull_request.merged == true
      && startsWith(github.event.pull_request.head.ref, 'agent/')
    runs-on: ubuntu-latest
    permissions:
      issues: write
    steps:
      # Recommended: mint a GitHub App token so downstream label workflows fire.
      - uses: actions/create-github-app-token@v3
        id: app-token
        with:
          app-id: ${{ secrets.MY_APP_ID }}
          private-key: ${{ secrets.MY_APP_PRIVATE_KEY }}

      - uses: ./actions/dependency-chain
        with:
          token: ${{ steps.app-token.outputs.token }}
          config: |
            {
              "blockedLabel": "agent-blocked",
              "readyLabel": "agent",
              "parentCloseComment": "All phases are complete. Closing this tracking issue."
            }
```

## Notes on behavior vs. the original workflow

- The original unblocked a dependent as soon as the merged PR's issue matched a
  single `depends-on`. This port is stricter: a dependent is unblocked only when
  **none** of its declared `depends-on` targets remain open, so an issue waiting
  on two blockers is not released prematurely.
- The open-issue snapshot is taken *before* GitHub flips the merged issue's
  state, so the just-closed issue(s) may still appear open. They are filtered out
  by number in the pure function.
- `listForRepo` returns pull requests as well as issues; the wrapper drops PRs.

## Development

```bash
npx vitest run actions/dependency-chain   # unit tests (pure logic)
npm run build:actions                      # bundle src/index.ts -> dist/index.js
```

`dist/` is committed and drift-checked via `npm run check:dist`.
