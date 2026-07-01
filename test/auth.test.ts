import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { parseDot } from "../src/parser/parse.js";
import { compile } from "../src/index.js";
import type { AuthConfig, FoundryConfig, Harness } from "../src/ir/types.js";

const dot = readFileSync(fileURLToPath(new URL("../examples/dixie/harness.dot", import.meta.url)), "utf8");

function harnessWith(auth: AuthConfig | undefined, identity: FoundryConfig["identity"] = {}): Harness {
  const g = parseDot(dot);
  const config: FoundryConfig = {
    name: "t",
    identity,
    agent: { cli: "claude", model: "m", oauth_token_secret: "TOK" },
    repo: { base_branch: "main", branch_prefix: "agent/" },
    labels: {},
  };
  if (auth) config.auth = auth;
  return { name: g.name, nodes: g.nodes, edges: g.edges, config };
}

function builderJob(h: Harness): any {
  const f = compile(h).files.find((x) => x.path === ".github/workflows/builder.yml")!;
  return (yaml.load(f.contents) as any).jobs.builder;
}

describe("auth modes", () => {
  it("app mode mints an app token and uses it", () => {
    const job = builderJob(harnessWith({ mode: "app", app_id_secret: "APP_ID", app_key_secret: "APP_KEY" }));
    const appStep = job.steps.find((s: any) => s.uses === "actions/create-github-app-token@v3");
    expect(appStep.with["app-id"]).toBe("${{ secrets.APP_ID }}");
    const checkout = job.steps.find((s: any) => (s.uses ?? "").startsWith("actions/checkout"));
    expect(checkout.with.token).toBe("${{ steps.app-token.outputs.token }}");
  });

  it("pat mode uses the PAT secret directly, no app-token step", () => {
    const job = builderJob(harnessWith({ mode: "pat", token_secret: "AGENT_PAT" }));
    expect(job.steps.some((s: any) => s.uses === "actions/create-github-app-token@v3")).toBe(false);
    const checkout = job.steps.find((s: any) => (s.uses ?? "").startsWith("actions/checkout"));
    expect(checkout.with.token).toBe("${{ secrets.AGENT_PAT }}");
  });

  it("github-token mode uses github.token and warns about cascade", () => {
    const h = harnessWith({ mode: "github-token" });
    const job = builderJob(h);
    expect(job.steps.some((s: any) => s.uses === "actions/create-github-app-token@v3")).toBe(false);
    const checkout = job.steps.find((s: any) => (s.uses ?? "").startsWith("actions/checkout"));
    expect(checkout.with.token).toBe("${{ github.token }}");
    expect(compile(h).diagnostics.some((d) => d.code === "auth.github-token-no-cascade")).toBe(true);
  });

  it("back-compat: identity App secrets imply app mode", () => {
    const job = builderJob(harnessWith(undefined, { app_id_secret: "A", app_key_secret: "B" }));
    expect(job.steps.some((s: any) => s.uses === "actions/create-github-app-token@v3")).toBe(true);
  });
});
