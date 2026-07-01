/** Load foundry.config.yaml + harness.dot into a Harness (compile-time config read). */
import { readFileSync, existsSync } from "node:fs";
import yaml from "js-yaml";
import type { FoundryConfig, Harness } from "../ir/types.js";
import { parseDot, type Diagnosticish } from "../parser/parse.js";

const DEFAULTS: FoundryConfig = {
  name: "harness",
  identity: {},
  agent: { cli: "claude", model: "claude-opus-4-8", oauth_token_secret: "CLAUDE_CODE_OAUTH_TOKEN" },
  repo: { base_branch: "main", branch_prefix: "agent/" },
  labels: {},
};

export function loadConfig(path?: string): FoundryConfig {
  if (!path || !existsSync(path)) return structuredClone(DEFAULTS);
  const raw = (yaml.load(readFileSync(path, "utf8")) as Partial<FoundryConfig>) ?? {};
  return {
    ...DEFAULTS,
    ...raw,
    identity: { ...DEFAULTS.identity, ...(raw.identity ?? {}) },
    agent: { ...DEFAULTS.agent, ...(raw.agent ?? {}) },
    repo: { ...DEFAULTS.repo, ...(raw.repo ?? {}) },
    labels: { ...DEFAULTS.labels, ...(raw.labels ?? {}) },
  };
}

export function loadHarness(dotPath: string, configPath?: string): { harness: Harness; parseErrors: Diagnosticish[] } {
  const g = parseDot(readFileSync(dotPath, "utf8"));
  const config = loadConfig(configPath);
  return {
    harness: { name: g.name, nodes: g.nodes, edges: g.edges, config, sourcePath: dotPath },
    parseErrors: g.errors,
  };
}
