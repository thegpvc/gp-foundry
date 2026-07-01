# `run-agent` (composite)

The keystone action of a gp-foundry harness. It assembles a single prompt file
from ordered fragments, then runs the [Claude Code](https://github.com/anthropics/claude-code)
CLI headlessly (`claude -p`). It is deliberately **fire-and-forget**: it never
fails the step, so the agent's side effects (file edits, commits, comments) are
what downstream steps act on — not the CLI exit code.

## Prompt assembly order

The prompt is concatenated in a fixed, documented order. Missing optional
fragments are skipped; only `role-file` is mandatory.

| # | Fragment               | Source                        | Notes                                             |
|---|------------------------|-------------------------------|---------------------------------------------------|
| 1 | Role                   | `role-file`                   | Required. Who the agent is (a `roles/*.md` file). |
| 2 | Prompt override        | `prompt-override-file` (opt)  | Task-specific instructions.                       |
| 3 | Conventions            | `conventions` (opt, inline)   | Repo guardrails, typically from the config JSON.  |
| 4 | Scope                  | `scope-path` (opt file)       | Path/boundary config. Default `.github/agents/scope.yaml`. |
| 5 | Context                | `context-file` (opt)          | Runtime payload (issue body, PR diff, review…).   |

Rationale: the agent reads *who it is* and *what to do* before it reads the
*payload*, and the payload (untrusted content) is clearly delimited last.

## Inputs

| Name                      | Required | Default                       | Description |
|---------------------------|----------|-------------------------------|-------------|
| `role-file`               | yes      | —                             | Path to the role / job-description markdown file. |
| `prompt-override-file`    | no       | `""`                          | Optional task-specific prompt appended after the role. |
| `context-file`            | no       | `""`                          | Optional runtime context file, appended last. |
| `conventions`             | no       | `""`                          | Inline conventions/guardrails string (from config JSON). |
| `scope-path`              | no       | `.github/agents/scope.yaml`   | Scope config file, included verbatim if it exists. |
| `model`                   | yes      | —                             | Value for `claude --model`. |
| `allowed-tools`           | yes      | —                             | Value for `claude --allowedTools` (comma-separated). |
| `claude-code-oauth-token` | yes      | —                             | OAuth token; passed explicitly (composites have no `secrets`). |
| `extra-args`              | no       | `""`                          | Extra args appended verbatim to the `claude` invocation. |

## Behaviour

- The assembled prompt is written to a temp file; the run step invokes
  `claude -p "$(cat <promptfile>)" --model <model> --allowedTools <allowed-tools> <extra-args>`.
- `stderr` is captured to a file. If non-empty, it is emitted as a single
  `::warning::` group. `stdout` streams to the job log normally.
- The `claude` invocation is suffixed with `|| true`, so a nonzero exit code
  **does not fail the step**. Detecting "no changes" and reacting is the job of
  a downstream fallback step, not this action.
- If `role-file` is missing, or the token is empty, the step **does** fail
  (these are configuration errors, not agent outcomes).

## Example

```yaml
- name: Run agent
  uses: ./actions/run-agent
  with:
    role-file: .github/agents/roles/builder.md
    prompt-override-file: .github/agents/prompts/implement.md
    context-file: ${{ steps.ctx.outputs.context-file }}
    conventions: ${{ fromJSON(steps.cfg.outputs.json).conventions }}
    scope-path: .github/agents/scope.yaml
    model: ${{ fromJSON(steps.cfg.outputs.json).agent.model }}
    allowed-tools: "Read,Write,Edit,Glob,Grep,Bash(git:*),Bash(gh:*)"
    claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
    extra-args: "--max-turns 40"
```

## Notes

- This action assumes the Claude Code CLI is already installed and on `PATH`
  (e.g. by a preceding `setup-agent` / `npm install -g @anthropic-ai/claude-code`
  step). It does not install it.
- Nothing here is repo-specific: model, tools, labels, and conventions all
  arrive as inputs or via the config JSON, so the same action drives every node
  type in the harness.
