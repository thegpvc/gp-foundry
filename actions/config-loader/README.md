# config-loader

Parse a consumer's `foundry.config.yaml`, validate it against the FoundryConfig
JSON Schema (`schema/config.schema.json`), resolve a given node/persona's
effective settings, and emit them as GitHub Actions outputs.

This action is **domain-neutral**. Nothing about any particular agent fleet is
hardcoded — the bot login, git identity, model, allowed-tools, secret names and
label names all come from the config, and can be overridden per persona.

## Inputs

| Input         | Required | Description                                                                                   |
| ------------- | -------- | --------------------------------------------------------------------------------------------- |
| `config-path` | yes      | Path to the consumer's `foundry.config.yaml`.                                                 |
| `node`        | no       | Persona/role key. When set, that persona's overrides (from `personas`) shadow the top level. |

## Outputs

| Output               | Description                                                        |
| -------------------- | ----------------------------------------------------------------- |
| `name`               | The harness/fleet name.                                           |
| `model`              | Effective model id for the resolved persona.                      |
| `cli`                | Effective agent CLI binary.                                       |
| `allowed-tools`      | Effective allowed-tools as a comma-joined string.                 |
| `labels-json`        | Effective semantic-role → label map, as a JSON object.            |
| `bot-login`          | Effective bot login (empty if unset).                             |
| `git-name`           | Effective git author name (empty if unset).                       |
| `git-email`          | Effective git author email (empty if unset).                      |
| `app-id-secret`      | Name of the Actions secret holding the GitHub App id.             |
| `app-key-secret`     | Name of the Actions secret holding the GitHub App private key.    |
| `oauth-token-secret` | Name of the Actions secret holding the agent OAuth token.         |
| `json`               | The full resolved (persona-flattened) config view as a JSON blob. |

## Resolution semantics

Given a `node`, the matching entry in the config's `personas` map (if any) is
merged over the top-level defaults:

- `model`, `cli`, `allowed_tools` — **replaced** wholesale by the persona value
  when present, else inherited.
- `labels`, `identity` — **shallow-merged** per key (persona wins per key,
  everything else is inherited).

An unknown `node` (no matching persona) resolves to the top-level defaults and
emits a warning. `allowed_tools` may be authored as a comma-string or a YAML
list; either way it is normalized and emitted as a comma-joined string.

## Example

```yaml
- name: Load foundry config
  id: cfg
  uses: ./actions/config-loader
  with:
    config-path: foundry.config.yaml
    node: reviewer

- name: Run the agent
  run: |
    ${{ steps.cfg.outputs.cli }} -p "$PROMPT" \
      --model "${{ steps.cfg.outputs.model }}" \
      --allowedTools "${{ steps.cfg.outputs.allowed-tools }}"
  env:
    READY_LABEL: ${{ fromJSON(steps.cfg.outputs.labels-json).ready }}
```

## Config shape

See [`schema/config.schema.json`](../../schema/config.schema.json) for the
authoritative contract. It mirrors `FoundryConfig` in `src/ir/types.ts`, with an
added optional `personas` map keyed by node/role for per-persona overrides.

## Development

- Source: `src/index.ts` (bundled to `dist/index.js` later — do not hand-edit
  `dist/`).
- `src/schema.ts` is an embedded copy of `schema/config.schema.json` so the
  bundled action needs no filesystem access at runtime. The JSON file is
  canonical; keep the embedded copy in sync.
- Tests: `test/index.test.ts` with the fixture in `test/fixtures/`.
