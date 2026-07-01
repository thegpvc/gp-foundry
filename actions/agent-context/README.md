# agent-context

Fetches GitHub issue/PR data via the Octokit REST API and formats it into a
labeled plaintext context file for an agent prompt. Writes the file to a temp
path and exposes it via the `context-file` output.

This is a Node20 JavaScript action authored in TypeScript
(`src/*.ts`) and bundled to `dist/index.js` by the build pipeline.

## Inputs

| Name                 | Required | Default  | Description |
| -------------------- | -------- | -------- | ----------- |
| `type`               | yes      | —        | Context type: `issue`, `pr-diff`, `pr-review`, or `pr-full`. |
| `number`             | yes      | —        | Issue or PR number. |
| `token`              | yes      | —        | GitHub token used for API calls. |
| `include-diff`       | no       | `"true"` | Include the full unified diff for PR types. Any value other than `"false"` is treated as true. |
| `triggering-comment` | no       | `""`     | Body of the comment that triggered the workflow; appended as a final section when non-empty. |
| `base-branch`        | no       | `""`     | Optional base branch noted in the log for the comparison. The PR diff is always taken relative to the PR's own base ref; this input is surfaced for logging and downstream steps, not to re-target the diff. |

## Outputs

| Name           | Description |
| -------------- | ----------- |
| `context-file` | Absolute path to the formatted context file (written under `$RUNNER_TEMP`, falling back to the OS temp dir). |

## Context types

- **`issue`** — issue header (number, title, labels, body) plus all issue comments.
- **`pr-diff`** — PR header (title, file/line stats, body) plus the diff only.
- **`pr-review`** — PR header, issue comments, reviews, inline review comments, and diff.
- **`pr-full`** — identical to `pr-review`.

Empty sections are omitted. The diff is capped at ~100KB (100,000 bytes); larger
diffs are truncated with a `[Diff truncated at 100KB. Use Read tool to examine
full files.]` marker.

## Example

```yaml
- id: ctx
  uses: ./.github/actions/agent-context
  with:
    type: pr-review
    number: ${{ github.event.pull_request.number }}
    token: ${{ secrets.GITHUB_TOKEN }}
    triggering-comment: ${{ github.event.comment.body }}

- name: Use the context
  run: cat "${{ steps.ctx.outputs.context-file }}"
```

## Layout

- `src/index.ts` — action entrypoint: reads inputs, orchestrates fetch/format, writes the file.
- `src/fetchers.ts` — Octokit fetch logic per context type (`fetchContext`).
- `src/formatters.ts` — pure formatting of fetched data into labeled sections (`formatContext`) plus shared types.
- `src/fetchers.test.ts`, `src/formatters.test.ts` — Vitest unit tests.

## Development

```sh
# From the repo root:
npx vitest run actions/agent-context
```

The `dist/` bundle is produced by the repo's build pipeline; do not edit it by hand.
