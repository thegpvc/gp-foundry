/**
 * Three small things from the field: a configurable runner label, harness files
 * for the PR that installs the harness, and (in post-review.test.ts) the posted
 * review's link in the job summary.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { parseDot } from "../src/parser/parse.js";
import { loadConfig } from "../src/config/load.js";
import { compile } from "../src/index.js";
import { validate } from "../src/validate/validate.js";
import type { FoundryConfig, Harness } from "../src/ir/types.js";

const BOT = "agent-bot[bot]";
function mkHarness(dot: string, cfg: Partial<FoundryConfig> = {}): Harness {
  const g = parseDot(dot);
  expect(g.errors).toEqual([]);
  const config = { ...loadConfig(undefined), identity: { bot_login: BOT }, ...cfg } as FoundryConfig;
  return { name: g.name, nodes: g.nodes, edges: g.edges, config, sourcePath: ".github/harness.dot" };
}
const workflows = (dot: string, cfg: Partial<FoundryConfig> = {}): Record<string, any> =>
  Object.fromEntries(
    compile(mkHarness(dot, cfg), {}, { specDir: ".github" })
      .files.filter((f) => f.path.endsWith(".yml"))
      .map((f) => [f.path.split("/").pop()!.replace(".yml", ""), yaml.load(f.contents)]),
  );
const errors = (dot: string, cfg: Partial<FoundryConfig> = {}) =>
  validate(mkHarness(dot, cfg)).filter((d) => d.level === "error").map((d) => d.code);

const DOT = (reviewerAttrs = "") => `digraph t {
  start    [type=start]
  builder  [type=producer, role="agents/roles/builder.md"]
  reviewer [type=pr-review, role="agents/roles/reviewer.md", context="pr-diff"${reviewerAttrs ? ", " + reviewerAttrs : ""}]
  approver [type=pr-review, role="agents/roles/approver.md", context="pr-review", select="sweep", schedule="*/10 * * * *"]
  gate     [type=merge-gate, policy="agents/policy/merge.yaml", schedule="*/10 * * * *"]
  start    -> builder  [on="issues.opened"]
  builder  -> reviewer [on="pull_request.opened"]
}`;
const runners = (wfs: Record<string, any>) =>
  Object.fromEntries(Object.entries(wfs).flatMap(([file, wf]) => Object.entries(wf.jobs).map(([job, j]: [string, any]) => [`${file}/${job}`, j["runs-on"]])));

describe("the runner label", () => {
  it("is ubuntu-latest unless told otherwise", () => {
    expect(new Set(Object.values(runners(workflows(DOT()))))).toEqual(new Set(["ubuntu-latest"]));
  });

  it("runtime.runs_on sets it for every generated job — guards, selectors and the immutable guard included", () => {
    const all = runners(workflows(DOT(), { rollout: {}, runtime: { runs_on: "blacksmith-4vcpu-ubuntu-2404" } }));
    expect(Object.keys(all)).toEqual(
      expect.arrayContaining(["reviewer/reviewer_guard", "reviewer/reviewer", "approver/approver_select", "approver/approver", "approver/approver_mark", "gate/gate", "immutable-guard/immutable-paths"]),
    );
    expect(new Set(Object.values(all))).toEqual(new Set(["blacksmith-4vcpu-ubuntu-2404"]));
  });

  it("a node's runs_on= overrides it for that node's jobs only", () => {
    const all = runners(workflows(DOT('runs_on="big-runner"'), { rollout: {}, runtime: { runs_on: "small-runner" } }));
    expect(all["reviewer/reviewer"]).toBe("big-runner");
    expect(all["reviewer/reviewer_guard"]).toBe("big-runner");
    expect(all["builder/builder"]).toBe("small-runner");
  });

  it("rejects anything that is not one plain label", () => {
    for (const bad of ["two labels", "${{ secrets.X }}", "", "[self-hosted, linux]"]) {
      expect(errors(DOT(), { runtime: { runs_on: bad } }), bad).toContain("config.bad-runs-on");
    }
    expect(errors(DOT('runs_on="a b"'))).toContain("node.bad-runs-on");
    expect(errors(DOT(), { runtime: { runs_on: "ubuntu-24.04" } })).toEqual([]);
    // …and a rejected value never reaches a workflow.
    const all = runners(workflows(DOT('runs_on="a b"'), { runtime: { runs_on: "${{ x }}" } }));
    expect(new Set(Object.values(all))).toEqual(new Set(["ubuntu-latest"]));
  });

  it("is refused on a node that emits no job", () => {
    const dot = DOT().replace("start    [type=start]", 'start    [type=start, runs_on="x"]');
    expect(errors(dot)).toContain("node.runs-on-unsupported");
  });
});

describe("the PR that installs the harness", () => {
  const step = () => workflows(DOT()).reviewer.jobs.reviewer.steps.find((s: any) => s.name === "Use this PR's harness files if the base ref has no harness yet");

  it("has a fallback step after the base-ref checkout and before anything reads a harness file", () => {
    const names = workflows(DOT()).reviewer.jobs.reviewer.steps.map((s: any) => s.name);
    const at = names.indexOf("Use this PR's harness files if the base ref has no harness yet");
    expect(at).toBeGreaterThan(names.indexOf("Checkout harness files (base ref)"));
    expect(at).toBeLessThan(names.indexOf("Setup agent toolchain"));
    expect(step().env).toEqual({ HARNESS: ".gp-foundry/harness", SPEC: ".github/harness.dot", DIRS: ".github/agent-setup\n.github/agents" });
    expect(step().run).not.toContain("${{");
  });

  /** A workspace: the PR head's files at the root, the base ref's copy under .gp-foundry/harness. */
  function workspace(baseHasHarness: boolean) {
    const ws = mkdtempSync(join(tmpdir(), "gpf-boot-"));
    const put = (rel: string, text: string) => {
      mkdirSync(join(ws, rel, ".."), { recursive: true });
      writeFileSync(join(ws, rel), text);
    };
    put(".github/harness.dot", "head spec");
    put(".github/agents/roles/reviewer.md", "HEAD role");
    put(".github/agent-setup/action.yml", "HEAD setup");
    if (baseHasHarness) {
      put(".gp-foundry/harness/.github/harness.dot", "base spec");
      put(".gp-foundry/harness/.github/agents/roles/reviewer.md", "BASE role");
      put(".gp-foundry/harness/.github/agent-setup/action.yml", "BASE setup");
    } else {
      mkdirSync(join(ws, ".gp-foundry/harness"), { recursive: true });
    }
    const out = execFileSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", step().run], { cwd: ws, env: { PATH: process.env.PATH!, ...step().env }, encoding: "utf8" });
    const read = (rel: string) => (existsSync(join(ws, rel)) ? readFileSync(join(ws, rel), "utf8") : undefined);
    return { out, read };
  }

  it("uses the head's files when the base ref has no harness at all, and says so", () => {
    const { out, read } = workspace(false);
    expect(out).toContain("::notice::the base ref has no harness yet");
    expect(read(".gp-foundry/harness/.github/agents/roles/reviewer.md")).toBe("HEAD role");
    expect(read(".gp-foundry/harness/.github/agent-setup/action.yml")).toBe("HEAD setup");
  });

  it("never touches the base ref's copy once the base has a harness", () => {
    const { out, read } = workspace(true);
    expect(out).toBe("");
    expect(read(".gp-foundry/harness/.github/agents/roles/reviewer.md")).toBe("BASE role");
    expect(read(".gp-foundry/harness/.github/agent-setup/action.yml")).toBe("BASE setup");
  });
});
