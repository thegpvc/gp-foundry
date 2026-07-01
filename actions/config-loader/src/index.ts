/**
 * config-loader — parse a consumer's foundry.config.yaml, validate it against
 * the FoundryConfig JSON Schema, resolve a given node/persona's effective
 * settings, and emit them as GitHub Actions outputs.
 *
 * This action is domain-neutral: nothing about any particular agent fleet is
 * hardcoded. Identity (bot login, git name/email, app-secret names), model,
 * allowed-tools and labels are all read from the config and, where present,
 * overridden per-persona.
 *
 * Inputs:
 *   - config-path (required): path to foundry.config.yaml
 *   - node        (optional): persona/role key whose overrides to apply
 *
 * Outputs:
 *   - model         effective model id
 *   - cli           effective agent CLI binary
 *   - allowed-tools effective allowed-tools as a comma-joined string
 *   - labels-json   effective labels map as JSON
 *   - bot-login / git-name / git-email / app-id-secret / app-key-secret / oauth-token-secret
 *   - name          harness name
 *   - json          the full resolved persona view as a JSON blob
 */
import { readFileSync } from "node:fs";
import * as core from "@actions/core";
import yaml from "js-yaml";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { CONFIG_SCHEMA } from "./schema.js";

/** Minimal shape mirror (kept local so the bundled action has no repo imports). */
export interface Identity {
  app_id_secret?: string;
  app_key_secret?: string;
  bot_login?: string;
  git_name?: string;
  git_email?: string;
}

export interface Persona {
  model?: string;
  cli?: string;
  allowed_tools?: string | string[];
  labels?: Record<string, string>;
  identity?: Identity;
  [k: string]: unknown;
}

export interface FoundryConfig {
  name: string;
  identity: Identity;
  agent: {
    cli: string;
    model: string;
    oauth_token_secret?: string;
    allowed_tools?: string | string[];
  };
  repo: { base_branch: string; branch_prefix: string };
  labels: Record<string, string>;
  markers?: Record<string, string>;
  size?: {
    warn_additions?: number;
    hard_additions?: number;
    exclude_globs?: string[];
  };
  runtime?: { mode?: "pinned" | "vendored"; ref?: string; owner_repo?: string };
  personas?: Record<string, Persona>;
  [k: string]: unknown;
}

/** The fully-resolved, persona-flattened view emitted by this action. */
export interface ResolvedConfig {
  name: string;
  node: string | null;
  model: string;
  cli: string;
  allowedTools: string[];
  labels: Record<string, string>;
  identity: Required<Pick<Identity, never>> & Identity;
  oauthTokenSecret: string | null;
  repo: { base_branch: string; branch_prefix: string };
  markers: Record<string, string>;
  size: FoundryConfig["size"] | null;
  runtime: FoundryConfig["runtime"] | null;
}

// ajv-formats / ajv have CJS interop quirks under ESM; normalize the callables.
const AjvCtor = (Ajv as unknown as { default?: typeof Ajv }).default ?? Ajv;
const applyFormats =
  (addFormats as unknown as { default?: typeof addFormats }).default ??
  addFormats;

let cachedValidator: ValidateFunction | null = null;
function getValidator(): ValidateFunction {
  if (cachedValidator) return cachedValidator;
  const ajv = new AjvCtor({ allErrors: true, allowUnionTypes: true });
  applyFormats(ajv);
  cachedValidator = ajv.compile(CONFIG_SCHEMA);
  return cachedValidator;
}

/** Normalize allowed-tools (string or array) into a clean string[]. */
export function normalizeTools(value: string | string[] | undefined): string[] {
  if (value == null) return [];
  const parts = Array.isArray(value) ? value : value.split(",");
  return parts.map((t) => t.trim()).filter((t) => t.length > 0);
}

/**
 * Resolve the effective config for a persona/node. Persona fields shadow the
 * top-level defaults; labels and identity are shallow-merged (persona wins per
 * key); everything else falls back to the config-level value.
 */
export function resolveConfig(
  config: FoundryConfig,
  node: string | null,
): ResolvedConfig {
  const persona: Persona =
    node != null && config.personas ? (config.personas[node] ?? {}) : {};

  if (node != null && config.personas && !(node in config.personas)) {
    core.warning(
      `config-loader: node "${node}" has no persona entry; using top-level defaults.`,
    );
  }

  const identity: Identity = { ...config.identity, ...(persona.identity ?? {}) };
  const labels: Record<string, string> = {
    ...config.labels,
    ...(persona.labels ?? {}),
  };

  const allowedTools = normalizeTools(
    persona.allowed_tools ?? config.agent.allowed_tools,
  );

  return {
    name: config.name,
    node,
    model: persona.model ?? config.agent.model,
    cli: persona.cli ?? config.agent.cli,
    allowedTools,
    labels,
    identity,
    oauthTokenSecret: config.agent.oauth_token_secret ?? null,
    repo: config.repo,
    markers: config.markers ?? {},
    size: config.size ?? null,
    runtime: config.runtime ?? null,
  };
}

/** Load + parse + validate a foundry.config.yaml. Throws on any failure. */
export function loadConfig(configPath: string): FoundryConfig {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (err) {
    throw new Error(
      `config-loader: could not read config at "${configPath}": ${
        (err as Error).message
      }`,
    );
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    throw new Error(
      `config-loader: failed to parse YAML at "${configPath}": ${
        (err as Error).message
      }`,
    );
  }

  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `config-loader: config at "${configPath}" must be a YAML mapping.`,
    );
  }

  const validate = getValidator();
  if (!validate(parsed)) {
    const details = (validate.errors ?? [])
      .map((e) => `  - ${e.instancePath || "/"} ${e.message ?? "is invalid"}`)
      .join("\n");
    throw new Error(
      `config-loader: config at "${configPath}" failed schema validation:\n${details}`,
    );
  }

  return parsed as FoundryConfig;
}

export function run(): void {
  const configPath = core.getInput("config-path", { required: true });
  const nodeInput = core.getInput("node");
  const node = nodeInput.trim() === "" ? null : nodeInput.trim();

  const config = loadConfig(configPath);
  const resolved = resolveConfig(config, node);

  core.setOutput("name", resolved.name);
  core.setOutput("model", resolved.model);
  core.setOutput("cli", resolved.cli);
  core.setOutput("allowed-tools", resolved.allowedTools.join(","));
  core.setOutput("labels-json", JSON.stringify(resolved.labels));

  core.setOutput("bot-login", resolved.identity.bot_login ?? "");
  core.setOutput("git-name", resolved.identity.git_name ?? "");
  core.setOutput("git-email", resolved.identity.git_email ?? "");
  core.setOutput("app-id-secret", resolved.identity.app_id_secret ?? "");
  core.setOutput("app-key-secret", resolved.identity.app_key_secret ?? "");
  core.setOutput("oauth-token-secret", resolved.oauthTokenSecret ?? "");

  core.setOutput("json", JSON.stringify(resolved));

  core.info(
    `config-loader: resolved "${resolved.name}"` +
      (node ? ` (persona: ${node})` : "") +
      ` → model=${resolved.model}, cli=${resolved.cli}, ` +
      `tools=[${resolved.allowedTools.join(", ")}]`,
  );
}

// Only auto-run when invoked as the action entrypoint (not under test import).
const isMain =
  process.env.GITHUB_ACTIONS === "true" ||
  process.env.CONFIG_LOADER_RUN === "1";
if (isMain) {
  try {
    run();
  } catch (err) {
    core.setFailed((err as Error).message);
  }
}
