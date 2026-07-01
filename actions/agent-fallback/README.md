# agent-fallback

A composite action that acts as a **safety net** after an agent (Claude, etc.)
finishes running in a workflow. If the agent left work uncommitted, forgot to
push, or forgot to open a PR, this action finishes the job. It also protects
paths the agent must never touch and can post a "no changes" comment when the
agent produced nothing.

It is fully generalized: nothing about a specific bot, app, label, model, or
repository layout is hardcoded. Everything is driven by inputs and a scope file.

## What it does (in order)

1. **Resolve immutable paths.** Reads the `immutable_paths:` list from the scope
   YAML file (`scope-path`, default `.github/agents/scope.yaml`) using a
   dependency-free `awk` scan. If the file or the key is missing, it defaults to
   `.github/workflows/`.
2. **Strip protected path changes.** Reverts any changes to the immutable paths —
   both committed (via `git checkout <base> -- <file>` / `git rm`, amended into
   the tip commit) and uncommitted (working tree + index). This prevents pushes
   from being rejected when the token lacks permission for those paths (e.g. the
   GitHub `workflows` permission).
3. **Commit uncommitted changes.** If the working tree is dirty, stages
   everything and commits with `commit-message` (or a generated default using
   `agent-name`).
4. **Check for changes.** Compares `HEAD` against `origin/<base-branch>`.
5. **Post no-changes comment.** If there were no changes and
   `no-changes-comment` is set, posts it to the PR or the issue per
   `comment-target`.
6. **Push branch.** Pushes `branch` when there are changes.
7. **Create PR if needed.** If no PR already exists for `branch` and `pr-title`
   is set, opens a PR against `base-branch` with the given title/body/label, and
   optionally links it back to `issue-number`.

## Inputs

| Input                | Required | Default                     | Description |
| -------------------- | -------- | --------------------------- | ----------- |
| `branch`             | yes      | —                           | Branch name to push. |
| `token`              | yes      | —                           | GitHub token for push, PR creation, and comments. |
| `agent-name`         | yes      | —                           | Agent name used in fallback commit messages and the PR-link comment. |
| `base-branch`        | no       | `main`                      | Base branch to diff against and to target for the fallback PR. |
| `scope-path`         | no       | `.github/agents/scope.yaml` | Scope YAML file whose `immutable_paths:` list is stripped before pushing. |
| `commit-message`     | no       | `""`                        | Fallback commit message. Empty → `Agent <agent-name>: automated changes`. |
| `pr-title`           | no       | `""`                        | Fallback PR title. Empty → never create a fallback PR. |
| `pr-body`            | no       | `""`                        | Fallback PR body. |
| `pr-label`           | no       | `""`                        | Label applied to the fallback PR. |
| `issue-number`       | no       | `""`                        | Issue to comment on with the PR link (and optional no-changes comment). |
| `no-changes-comment` | no       | `""`                        | Comment posted if no changes were made. Empty → skip. |
| `comment-target`     | no       | `pr`                        | Where to post `no-changes-comment`: `pr` or `issue`. |

## Notes

- Composite actions have **no `secrets` context**; pass the token explicitly via
  the `token` input.
- The action assumes a checked-out repo with `origin/<base-branch>` fetched and
  git identity configured by an earlier step.
- Immutable paths may be directories (e.g. `.github/workflows/`) or individual
  files; each entry is passed to `git` as-is.

## Scope file format

```yaml
immutable_paths:      # enforced here: stripped before push
  - .github/workflows/
  - .github/agents/scope.yaml
```

Only the `immutable_paths:` key is consulted. Other keys (e.g. `forbidden_paths`,
`guidance`) are ignored by this action.

## Example

```yaml
- uses: ./actions/agent-fallback
  with:
    branch: agent/implement-${{ github.event.issue.number }}
    token: ${{ steps.app-token.outputs.token }}
    agent-name: implement
    base-branch: main
    scope-path: .github/agents/scope.yaml
    commit-message: "Agent implement: automated changes"
    pr-title: "Implement #${{ github.event.issue.number }}"
    pr-body: "Automated implementation. Closes #${{ github.event.issue.number }}."
    pr-label: agent-generated
    issue-number: ${{ github.event.issue.number }}
    no-changes-comment: "The agent did not produce any changes."
    comment-target: issue
```
