# `run-agent` (composite)

The keystone action of a gp-foundry harness. It assembles a single prompt file
from ordered fragments, then runs the [Claude Code](https://github.com/anthropics/claude-code)
CLI headlessly (`claude -p`).

A dead agent is **red**, not a green no-op: the CLI's exit code is propagated so
a human — or the supervisor's stranded-work sweep — notices and re-drives it.
The agent's side effects are still the product, and the generated workflows run
their fallback steps under `if: !cancelled()`, so partial work is salvaged
regardless.

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
| `github-token`            | no       | `""`                          | Token for the agent's own `gh`/git calls (`GH_TOKEN`/`GITHUB_TOKEN`). |
| `comms-file`              | no       | `.github/agents/communication.md` | Team communication guide, included verbatim if it exists. |
| `extra-args`              | no       | `""`                          | Extra args appended verbatim to the `claude` invocation. |
| `extra-env`               | no       | `""`                          | Newline-separated `NAME=VALUE` pairs exported before the CLI runs. |
| `max-attempts`            | no       | `3`                           | Attempts when the CLI fails *transiently*. `1` disables retrying. |
| `retry-base-delay-seconds`| no       | `15`                          | Delay before attempt 2; doubles each attempt. |

## Behaviour

- The assembled prompt is written to a temp file; the run step invokes
  `claude -p "$(cat <promptfile>)" --model <model> --allowedTools <allowed-tools> <extra-args>`.
- `stderr` is captured to a file. If non-empty, it is emitted as a single
  `::warning::` group. `stdout` streams to the job log normally.
- A nonzero exit **fails the step**, preserving the CLI's own exit code.
- If `role-file` is missing, or the token is empty, the step fails (these are
  configuration errors, not agent outcomes).

### Failure classes

Not every nonzero exit is the agent's fault, so a failed attempt is classified
from the tail of what the CLI printed before it died:

| Class       | Example                                                        | Behaviour |
|-------------|----------------------------------------------------------------|-----------|
| `transient` | `API Error: 529 Overloaded`, a dropped or refused connection   | Retried up to `max-attempts`, backing off `retry-base-delay-seconds` and doubling. |
| `quota`     | `You've hit your session limit · resets 9:20am (UTC)`          | **Not** retried. Fails immediately with a message naming it a capacity wall. |
| `fatal`     | anything else                                                  | **Not** retried. Fails with the CLI's exit code. |

A `transient` failure clears in seconds, so retrying in-step turns a server-side
blip into a delay instead of a red run that looks exactly like a broken agent —
which on a scheduled lane otherwise strands the sweep until the next cron tick.

A `quota` wall clears at a wall-clock reset routinely tens of minutes out, far
past any step budget. Retrying would only burn the runner, so it fails fast and
says what it is; the distinct message matters because a quota wall read as an
agent bug sends people to the wrong place entirely.

Retrying assumes a role can be re-run. The harness already relies on that
everywhere else — scheduled lanes re-run on cron, `agent_refire` re-fires label
lanes, the supervisor re-drives stranded work — and roles are written to read
current state (labels, existing PRs, prior comments) before acting for exactly
that reason.

A lane whose role has an **unconditional** side effect is the exception and should
set `max-attempts: 1`. From a compiled harness that is the per-node
`agent_attempts=1` attr; the Herald is the worked example, since it posts a Slack
digest with no dedup and a retry after a partial run would post it twice. Note
`agent_attempts=` is deliberately distinct from the `pr-fix` node's
`max_attempts=`, which bounds the fix↔review **loop** rather than CLI invocations
within one run.

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
