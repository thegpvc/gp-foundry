# setup-agent

Composite action providing one-step environment setup for agent workflows.

It **always** installs Node.js and the Claude Code CLI (`@anthropic-ai/claude-code`).
Go, protoc, arbitrary setup commands (e.g. `make tools`), and git identity are all
opt-in via inputs — nothing is hardcoded to a specific agent or project.

## Usage

```yaml
- uses: ./actions/setup-agent
  with:
    node-version: "20"
    install-go: "true"
    go-version: "1.24"
    install-protoc: "true"
    protoc-version: "25.1"
    setup-commands: make tools
    git-name: my-agent[bot]
    git-email: my-agent[bot]@users.noreply.github.com
    claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

Minimal usage (Node + Claude Code only):

```yaml
- uses: ./actions/setup-agent
```

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `node-version` | no | `20` | Node.js version to install. Node is always installed; falls back to `20` if left empty. |
| `install-go` | no | `""` | Set to `"true"` to install Go via `actions/setup-go`. Any other value (including empty) skips Go. |
| `go-version` | no | `1.24` | Go version to install when `install-go` is `"true"`. |
| `install-protoc` | no | `""` | Set to `"true"` to install `protoc`. Any other value (including empty) skips protoc. |
| `protoc-version` | no | `25.1` | `protoc` release version to download when `install-protoc` is `"true"`. |
| `setup-commands` | no | `""` | Arbitrary shell run after toolchain setup (e.g. `make tools`, dependency installs). Skipped when empty. |
| `git-name` | no | `""` | `git config user.name` value. Configured only when non-empty. |
| `git-email` | no | `""` | `git config user.email` value. Configured only when non-empty. |
| `claude-code-oauth-token` | no | `""` | Claude Code OAuth token. When provided, the action validates that it resolves to a non-empty value and fails fast otherwise. Skipped when empty. |

## Notes

- This is a **composite** action and has no `secrets` context. Pass any token
  (such as `claude-code-oauth-token`) explicitly as an input from the caller.
- protoc is installed for `linux-x86_64` and unpacked into `/usr/local` (requires `sudo`).
- `setup-commands` is injected into a `bash` run step; treat its contents as trusted
  and quote appropriately, as with any workflow `run:` value.
