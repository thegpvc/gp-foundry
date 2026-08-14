/**
 * Per-node `permissions="scope: level, ..."` merges extra GitHub token scopes into
 * the generated job's `permissions:` block. This is the generic hook for lanes that
 * need a GitHub-native capability the compiler doesn't model — the motivating case
 * is `id-token: write` for cloud OIDC federation from a consumer-owned setup step,
 * keeping all provider knowledge (AWS/GCP/...) out of gp-foundry.
 */
import { describe, it, expect } from "vitest";
import { parseDot } from "../src/parser/parse.js";
import { loadConfig } from "../src/config/load.js";
import { compile } from "../src/index.js";
import { validate } from "../src/validate/validate.js";
import yaml from "js-yaml";
import type { FoundryConfig, Harness } from "../src/ir/types.js";

function ir(dot: string): Harness {
  const g = parseDot(dot);
  const config = loadConfig(undefined) as FoundryConfig;
  return { name: g.name, nodes: g.nodes, edges: g.edges, config, sourcePath: ".github/harness.dot" };
}

function jobPermissions(dot: string, jobId: string): Record<string, string> | undefined {
  const wf: any = yaml.load(compile(ir(dot)).files.find((f) => f.path.endsWith(`${jobId}.yml`))!.contents);
  return wf.jobs[jobId].permissions;
}

const SCOPED_DOT = `digraph t {
  start   [type=start]
  scout   [type=issue-agent, role="agents/roles/scout.md", context=issue]
  builder [type=producer,    role="agents/roles/builder.md", permissions="id-token: write"]
  start -> scout   [on="issues.opened"]
  scout -> builder [when="label=build"]
}`;

describe("per-node permissions= attr", () => {
  it("merges the attr's scope into the handler's defaults", () => {
    expect(jobPermissions(SCOPED_DOT, "builder")).toEqual({
      contents: "write",
      "pull-requests": "write",
      issues: "write",
      "id-token": "write",
    });
  });

  it("does NOT leak the attr to sibling nodes", () => {
    expect(jobPermissions(SCOPED_DOT, "scout")).toEqual({ contents: "read", issues: "write" });
  });

  it("accepts multiple comma-separated scopes", () => {
    const dot = SCOPED_DOT.replace('permissions="id-token: write"', 'permissions="id-token: write, packages: read"');
    expect(jobPermissions(dot, "builder")).toMatchObject({ "id-token": "write", packages: "read" });
  });

  it("lets the attr override a handler default (attr wins)", () => {
    const dot = SCOPED_DOT.replace('permissions="id-token: write"', 'permissions="issues: read"');
    expect(jobPermissions(dot, "builder")).toEqual({
      contents: "write",
      "pull-requests": "write",
      issues: "read",
    });
  });

  it("applies to scheduled-agent lanes too", () => {
    const dot = `digraph t {
      sweeper [type=scheduled-agent, role="agents/roles/sweeper.md", schedule="0 8 * * *", commit=none, permissions="id-token: write"]
    }`;
    expect(jobPermissions(dot, "sweeper")).toMatchObject({ "id-token": "write" });
  });

  it("rejects a malformed entry at compile time (no YAML smuggling)", () => {
    for (const bad of ["id-token: admin", "Id-Token: write", "id-token", "id-token: write; run: rm -rf /"]) {
      const dot = SCOPED_DOT.replace('permissions="id-token: write"', `permissions="${bad}"`);
      expect(() => compile(ir(dot)), bad).toThrow(/bad permissions= entry/);
    }
  });

  it("surfaces a malformed attr as a validate() diagnostic", () => {
    const dot = SCOPED_DOT.replace('permissions="id-token: write"', 'permissions="id-token = write"');
    const diags = validate(ir(dot));
    expect(diags.some((d) => d.code === "node.bad-permissions" && d.level === "error")).toBe(true);
  });

  it("emits no diagnostic and no extra scopes when the attr is absent", () => {
    const dot = SCOPED_DOT.replace(', permissions="id-token: write"', "");
    expect(validate(ir(dot)).some((d) => d.code === "node.bad-permissions")).toBe(false);
    expect(jobPermissions(dot, "builder")).toEqual({
      contents: "write",
      "pull-requests": "write",
      issues: "write",
    });
  });
});
