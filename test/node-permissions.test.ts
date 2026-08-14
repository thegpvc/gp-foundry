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

  it("fails closed on a malformed entry: an error diagnostic, and NO scope in the output", () => {
    const bads = [
      "id-token: admin",
      "Id-Token: write",
      "id-token",
      "id-token: write; run: rm -rf /",
      "contents: write\nruns-on: evil", // real newline inside the DOT quoted string
      "   ",
      ",",
    ];
    for (const bad of bads) {
      const dot = SCOPED_DOT.replace('permissions="id-token: write"', `permissions="${bad}"`);
      const harness = ir(dot);
      expect(
        validate(harness).some((d) => d.code === "node.bad-permissions" && d.level === "error"),
        bad,
      ).toBe(true);
      // assemble stays non-throwing (the CLI refuses to write on the error diagnostic);
      // the fragment keeps only the handler defaults — nothing smuggled in.
      const wf: any = yaml.load(compile(harness).files.find((f) => f.path.endsWith("builder.yml"))!.contents);
      expect(wf.jobs.builder.permissions, bad).toEqual({
        contents: "write",
        "pull-requests": "write",
        issues: "write",
      });
    }
  });

  it("rejects a non-string attr value (unquoted permissions=5) via validate()", () => {
    const dot = SCOPED_DOT.replace('permissions="id-token: write"', "permissions=5");
    expect(validate(ir(dot)).some((d) => d.code === "node.bad-permissions" && d.level === "error")).toBe(true);
  });

  it("tolerates a trailing comma, matching secrets=", () => {
    const dot = SCOPED_DOT.replace('permissions="id-token: write"', 'permissions="id-token: write,"');
    expect(validate(ir(dot)).some((d) => d.code === "node.bad-permissions")).toBe(false);
    expect(jobPermissions(dot, "builder")).toMatchObject({ "id-token": "write" });
  });

  it("warns when permissions= sits on a node that emits no job", () => {
    const dot = SCOPED_DOT.replace(', permissions="id-token: write"]', "]") // strip builder's grant first…
      .replace("start   [type=start]", 'start   [type=start, permissions="id-token: write"]'); // …so only start carries it
    const diags = validate(ir(dot));
    expect(diags.some((d) => d.code === "node.permissions-ignored" && d.level === "warning")).toBe(true);
    // and no job in the output gains the scope from the start node
    for (const f of compile(ir(dot)).files.filter((x) => x.path.endsWith(".yml"))) {
      const wf: any = yaml.load(f.contents.replace(/^#.*\n#.*\n/, ""));
      for (const job of Object.values<any>(wf.jobs ?? {})) {
        if (job.permissions) expect(job.permissions["id-token"]).not.toBe("write");
      }
    }
  });

  it("merges the attr on a fan_in node (the join job outside the HANDLERS path)", () => {
    const dot = `digraph t {
      start [type=start]
      builder [type=producer, role="agents/roles/builder.md"]
      split [type=parallel]
      lane_a [type=analyst, role="agents/roles/lane-a.md", context="pr-diff", permissions="id-token: write"]
      lane_b [type=analyst, role="agents/roles/lane-b.md", context="pr-diff"]
      panel [type=fan_in, role="agents/roles/panel.md", permissions="packages: read"]
      start -> builder [on="issues.opened"]
      builder -> split [on="pull_request.opened"]
      split -> lane_a
      split -> lane_b
      lane_a -> panel
      lane_b -> panel
    }`;
    const wf: any = yaml.load(
      compile(ir(dot)).files.find((f) => f.path.endsWith("panel.yml"))!.contents.replace(/^#.*\n#.*\n/, ""),
    );
    expect(wf.jobs.panel.permissions).toMatchObject({ packages: "read" });
    // a diamond leg routes through emitNode and merges too; its sibling is untouched
    expect(wf.jobs.lane_a.permissions).toMatchObject({ "id-token": "write" });
    expect(wf.jobs.lane_b.permissions["id-token"]).toBeUndefined();
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
