/**
 * config.agent.secrets exposes extra Actions secrets to every agent. The composite
 * run-agent action has no secrets context, so the compiler resolves each secret name
 * to `NAME=${{ secrets.NAME }}` and passes them into the run-agent step's `extra-env`
 * input; the action exports them before invoking the CLI so roles read them as $NAME.
 */
import { describe, it, expect } from "vitest";
import { parseDot } from "../src/parser/parse.js";
import { loadConfig } from "../src/config/load.js";
import { compile } from "../src/index.js";
import yaml from "js-yaml";
import type { FoundryConfig, Harness } from "../src/ir/types.js";

function harness(secrets?: string[]): Harness {
  const g = parseDot(`digraph t {
    start   [type=start]
    builder [type=producer, role="agents/roles/builder.md"]
    start -> builder [on="issues.opened"]
  }`);
  const config = loadConfig(undefined) as FoundryConfig;
  if (secrets) config.agent.secrets = secrets;
  return { name: g.name, nodes: g.nodes, edges: g.edges, config, sourcePath: ".github/harness.dot" };
}

function runAgentWith(secrets?: string[]): Record<string, string> | undefined {
  const wf: any = yaml.load(
    compile(harness(secrets)).files.find((f) => f.path.endsWith("builder.yml"))!.contents,
  );
  const steps = wf.jobs.builder.steps as Array<{ name?: string; with?: Record<string, string> }>;
  return steps.find((s) => s.name === "Run agent")?.with;
}

describe("agent.secrets → run-agent extra-env", () => {
  it("injects a declared secret as NAME=${{ secrets.NAME }}", () => {
    expect(runAgentWith(["SENTRY_PAT"])?.["extra-env"]).toBe("SENTRY_PAT=${{ secrets.SENTRY_PAT }}");
  });

  it("joins multiple secrets one per line", () => {
    expect(runAgentWith(["SENTRY_PAT", "DATADOG_API_KEY"])?.["extra-env"]).toBe(
      "SENTRY_PAT=${{ secrets.SENTRY_PAT }}\nDATADOG_API_KEY=${{ secrets.DATADOG_API_KEY }}",
    );
  });

  it("omits extra-env entirely when no secrets are declared", () => {
    expect(runAgentWith()?.["extra-env"]).toBeUndefined();
  });
});
