/**
 * Embedded copy of schema/config.schema.json so the bundled action needs no
 * filesystem access at runtime. Keep in sync with schema/config.schema.json
 * (it is the canonical source; this is generated from it).
 */
export const CONFIG_SCHEMA = {
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://gp-foundry/schema/config.schema.json",
  "title": "FoundryConfig",
  "description": "Consumer-repo global config (foundry.config.yaml). Mirrors src/ir/types.ts FoundryConfig, extended with an optional `personas` map keyed by node/role for per-persona overrides.",
  "type": "object",
  "required": ["name", "identity", "agent", "repo", "labels"],
  "additionalProperties": true,
  "properties": {
    "name": {
      "type": "string",
      "minLength": 1,
      "description": "Human-readable name of the harness/agent fleet."
    },
    "identity": {
      "type": "object",
      "additionalProperties": false,
      "description": "How the agent authenticates and signs commits. Generalized: no hardcoded bot login or app-secret names.",
      "properties": {
        "app_id_secret": {
          "type": "string",
          "description": "Name of the Actions secret holding the GitHub App id."
        },
        "app_key_secret": {
          "type": "string",
          "description": "Name of the Actions secret holding the GitHub App private key."
        },
        "bot_login": {
          "type": "string",
          "description": "The bot login used for commits/PRs, e.g. \"my-agent[bot]\"."
        },
        "git_name": { "type": "string" },
        "git_email": { "type": "string", "format": "email" }
      }
    },
    "agent": {
      "type": "object",
      "required": ["cli", "model"],
      "additionalProperties": false,
      "description": "The coding-agent CLI + default model.",
      "properties": {
        "cli": {
          "type": "string",
          "minLength": 1,
          "description": "The agent CLI binary, e.g. \"claude\"."
        },
        "model": {
          "type": "string",
          "minLength": 1,
          "description": "Default model id, e.g. \"claude-opus-4-8\"."
        },
        "oauth_token_secret": {
          "type": "string",
          "description": "Name of the Actions secret holding the agent OAuth token."
        },
        "allowed_tools": {
          "$ref": "#/$defs/allowedTools",
          "description": "Default allowed-tools list for the agent CLI."
        }
      }
    },
    "repo": {
      "type": "object",
      "required": ["base_branch", "branch_prefix"],
      "additionalProperties": false,
      "properties": {
        "base_branch": { "type": "string", "minLength": 1 },
        "branch_prefix": { "type": "string", "minLength": 1 }
      }
    },
    "labels": {
      "type": "object",
      "description": "semantic role -> repo label (the drift-killer).",
      "additionalProperties": { "type": "string" }
    },
    "markers": {
      "type": "object",
      "description": "parseable markers shared by prompts + guards + enforcers.",
      "additionalProperties": { "type": "string" }
    },
    "size": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "warn_additions": { "type": "integer", "minimum": 0 },
        "hard_additions": { "type": "integer", "minimum": 0 },
        "exclude_globs": { "type": "array", "items": { "type": "string" } }
      }
    },
    "runtime": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "mode": { "type": "string", "enum": ["pinned", "vendored"] },
        "ref": { "type": "string" },
        "owner_repo": { "type": "string" }
      }
    },
    "personas": {
      "type": "object",
      "description": "Per-node/per-role overrides, keyed by the node/persona key passed as the `node` input. Any field here shadows the top-level default when that persona is resolved.",
      "additionalProperties": { "$ref": "#/$defs/persona" }
    }
  },
  "$defs": {
    "allowedTools": {
      "oneOf": [
        { "type": "string" },
        { "type": "array", "items": { "type": "string" } }
      ]
    },
    "persona": {
      "type": "object",
      "additionalProperties": true,
      "description": "Overrides for one persona/role. Every field is optional; unspecified fields fall back to the top-level config.",
      "properties": {
        "model": { "type": "string", "minLength": 1 },
        "cli": { "type": "string", "minLength": 1 },
        "allowed_tools": { "$ref": "#/$defs/allowedTools" },
        "labels": {
          "type": "object",
          "additionalProperties": { "type": "string" }
        },
        "identity": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "app_id_secret": { "type": "string" },
            "app_key_secret": { "type": "string" },
            "bot_login": { "type": "string" },
            "git_name": { "type": "string" },
            "git_email": { "type": "string", "format": "email" }
          }
        }
      }
    }
  }
} as const;
