/**
 * no_changes_comment= (#8): a producer run that commits nothing says so on its
 * issue, instead of ending green with no branch, no PR and no trace.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { parseDot } from "../src/parser/parse.js";
import { loadConfig } from "../src/config/load.js";
import { compile } from "../src/index.js";
import { validate } from "../src/validate/validate.js";
import type { FoundryConfig, Harness } from "../src/ir/types.js";

const dot = (attrs = "", type = "producer") => `digraph t {
  start   [type=start]
  builder [type=${type}, role="agents/roles/builder.md", context=issue${attrs ? ", " + attrs : ""}]
  start -> builder [on="issues.labeled", when="label=build"]
}`;
function harness(d: string): Harness {
  const g = parseDot(d);
  expect(g.errors).toEqual([]);
  const config = { ...loadConfig(undefined), identity: { bot_login: "agent-bot[bot]" } } as FoundryConfig;
  return { name: g.name, nodes: g.nodes, edges: g.edges, config, sourcePath: "t.dot" };
}
const fallback = (d: string) => {
  const wf = yaml.load(compile(harness(d)).files.find((f) => f.path.endsWith("/builder.yml"))!.contents) as any;
  return wf.jobs.builder.steps.find((s: any) => String(s.uses ?? "").includes("agent-fallback")).with;
};
const errors = (d: string) => validate(harness(d)).filter((x) => x.level === "error").map((x) => x.code);

describe("no_changes_comment= on a producer", () => {
  it("off by default: the fallback step is as it was", () => {
    expect(fallback(dot())["no-changes-comment"]).toBeUndefined();
  });

  it("=true posts a default message on the issue, linking the run", () => {
    const w = fallback(dot("no_changes_comment=true"));
    expect(w["comment-target"]).toBe("issue");
    expect(w["no-changes-comment"]).toContain("builder: no changes");
    expect(w["no-changes-comment"]).toContain("actions/runs/${{ github.run_id }}");
  });

  it("takes a message of its own, and comment_target=pr", () => {
    const w = fallback(dot('no_changes_comment="Nothing to do yet — waiting on another PR.", comment_target=pr'));
    expect(w["no-changes-comment"]).toBe("Nothing to do yet — waiting on another PR.");
    expect(w["comment-target"]).toBe("pr");
  });

  it("validates", () => {
    expect(errors(dot("no_changes_comment=true"))).toEqual([]);
    expect(errors(dot("comment_target=pr"))).toContain("node.comment-target-without-comment");
    expect(errors(dot("no_changes_comment=true, comment_target=thread"))).toContain("node.bad-comment-target");
    expect(errors(dot("no_changes_comment=true", "analyst"))).toContain("node.no-changes-comment-unsupported");
  });
});

describe("agent-fallback's no-changes comment is best effort", () => {
  const step = () => {
    const doc = yaml.load(readFileSync(new URL("../actions/agent-fallback/action.yml", import.meta.url), "utf8")) as any;
    return doc.runs.steps.find((s: any) => s.name === "Post no-changes comment").run as string;
  };
  it("a failed post is a warning, not a red run", () => {
    const dir = mkdtempSync(join(tmpdir(), "gpf-nochanges-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "gh"), "#!/usr/bin/env bash\necho 'HTTP 403' >&2\nexit 1\n");
    chmodSync(join(bin, "gh"), 0o755);
    const out = execFileSync("bash", ["-eo", "pipefail", "-c", step()], {
      env: { PATH: `${bin}:${process.env.PATH}`, COMMENT_TARGET: "issue", ISSUE_NUMBER: "12", COMMENT_BODY: "no changes", BRANCH: "agent/x" },
      encoding: "utf8",
    });
    expect(out).toContain("::warning::could not post the no-changes comment on #12");
  });
});
