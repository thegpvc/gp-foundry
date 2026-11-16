// merge-gate mode="evaluate": compiles to a check-publishing job that cannot
// push or merge, and validate() holds the attribute rules.
import { describe, expect, it } from "vitest";
import yaml from "js-yaml";
import { parseDot } from "../src/parser/parse.js";
import { loadConfig } from "../src/config/load.js";
import { compile } from "../src/index.js";
import { validate } from "../src/validate/validate.js";
import { renderDiagram } from "../src/diagram/render.js";
import type { FoundryConfig, Harness } from "../src/ir/types.js";

const BOT = "fletch-bot[bot]";

function mkHarness(nodes: string, cfg: Partial<FoundryConfig> = {}): Harness {
  const g = parseDot(`digraph t {\n  start [type=start]\n${nodes}\n}`);
  expect(g.errors).toEqual([]);
  const config = { ...loadConfig(undefined), identity: { bot_login: BOT }, ...cfg } as FoundryConfig;
  return { name: g.name, nodes: g.nodes, edges: g.edges, config, sourcePath: "test.dot" };
}

function job(nodes: string, id: string, cfg: Partial<FoundryConfig> = {}): any {
  const f = compile(mkHarness(nodes, cfg)).files.find((x) => x.path.endsWith(`/${id}.yml`));
  expect(f, `${id}.yml`).toBeTruthy();
  return (yaml.load(f!.contents) as any).jobs[id];
}

const gateStep = (j: any) => j.steps.find((s: any) => String(s.uses).includes("merge-gate"));
const codes = (h: Harness, level = "error") => validate(h).filter((d) => d.level === level).map((d) => d.code);

const EVAL = `  gate [type=merge-gate, policy="agents/policy/merge.yaml", schedule="*/5 * * * *", mode="evaluate", check_name="fletch/approval"]`;
const MERGE = `  ship [type=merge-gate, policy="agents/policy/merge.yaml", schedule="*/30 * * * *"]`;

describe("merge-gate mode=evaluate compiles", () => {
  it("reads with GITHUB_TOKEN, writes only checks, and passes mode + check-name", () => {
    const j = job(EVAL, "gate");
    expect(j.permissions).toEqual({ contents: "read", "pull-requests": "read", checks: "write" });
    const step = gateStep(j);
    expect(step.with).toMatchObject({
      mode: "evaluate",
      "check-name": "fletch/approval",
      token: "${{ github.token }}",
      "checks-token": "${{ github.token }}",
      "policy-path": "agents/policy/merge.yaml",
      "bot-login": BOT,
    });
    // No App token, no git identity, no persisted credential: nothing here pushes.
    expect(j.steps.map((s: any) => s.name)).toEqual(["Checkout", step.name]);
    expect(j.steps[0].with).toMatchObject({ token: "${{ github.token }}", "persist-credentials": false });
  });

  it("does not mint an App token in app auth mode either", () => {
    const j = job(EVAL, "gate", { auth: { mode: "app", app_id_secret: "APP_ID", app_key_secret: "APP_KEY" } } as Partial<FoundryConfig>);
    expect(JSON.stringify(j)).not.toContain("create-github-app-token");
    expect(j.permissions.contents).toBe("read");
  });

  it("defaults the check name from the node id", () => {
    const j = job(`  gate [type=merge-gate, policy="p.yaml", schedule="*/5 * * * *", mode="evaluate"]`, "gate");
    expect(gateStep(j).with["check-name"]).toBe("gp-foundry/approval (gate)");
  });

  it("passes the author allowlist, opt-in label and skip= selection", () => {
    const j = job(
      `  gate [type=merge-gate, policy="p.yaml", schedule="*/5 * * * *", mode="evaluate", authors="Dpup, octocat", opt_in_label="agent_review", skip="draft,bot-author,label:hold"]`,
      "gate",
      { labels: { agent_review: "agent-review", hold: "on-hold" } } as Partial<FoundryConfig>,
    );
    expect(gateStep(j).with).toMatchObject({
      authors: "dpup,octocat",
      "opt-in-label": "agent-review",
      "skip-labels": "on-hold",
      "skip-bot-authors": "true",
    });
  });

  it("honours repo.authors", () => {
    const j = job(EVAL, "gate", { repo: { ...loadConfig(undefined).repo, authors: ["dpup"] } } as Partial<FoundryConfig>);
    expect(gateStep(j).with.authors).toBe("dpup");
  });

  it("passes configured verdict words to both gate modes, and nothing at the defaults", () => {
    const cfg = { verdicts: ["SHIP", "FIX", "HUMAN"] } as Partial<FoundryConfig>;
    expect(gateStep(job(EVAL, "gate", cfg)).with.verdicts).toBe("SHIP,FIX,HUMAN");
    expect(gateStep(job(MERGE, "ship", cfg)).with.verdicts).toBe("SHIP,FIX,HUMAN");
    expect(gateStep(job(EVAL, "gate")).with.verdicts).toBeUndefined();
  });

  it("leaves merge mode unchanged", () => {
    const j = job(MERGE, "ship");
    expect(j.permissions).toEqual({ contents: "write", "pull-requests": "write", issues: "write", checks: "read" });
    expect(gateStep(j).with.mode).toBeUndefined();
    expect(gateStep(j).with["check-name"]).toBeUndefined();
  });

  it("HARNESS.md names the check an evaluate gate publishes", () => {
    expect(renderDiagram(mkHarness(EVAL))).toContain("merge-gate · evaluate → check fletch/approval");
  });
});

describe("validate: mode= and check_name=", () => {
  it("accepts an evaluate gate beside a merge gate", () => {
    expect(codes(mkHarness(`${EVAL}\n${MERGE}`))).toEqual([]);
  });
  it("rejects an unknown mode", () => {
    expect(codes(mkHarness(`  gate [type=merge-gate, policy="p.yaml", schedule="*/5 * * * *", mode="dry"]`))).toContain("node.bad-mode");
  });
  it("rejects mode= off a merge-gate", () => {
    expect(codes(mkHarness(`  scout [type=scheduled-agent, role="r.md", schedule="0 * * * *", mode="evaluate"]`))).toContain("node.mode-unsupported");
  });
  it("rejects check_name= without mode=evaluate", () => {
    expect(codes(mkHarness(`  ship [type=merge-gate, policy="p.yaml", schedule="*/30 * * * *", check_name="x"]`))).toContain(
      "node.check-name-without-evaluate",
    );
  });
  it("rejects two evaluate gates publishing the same check", () => {
    const two = `${EVAL}\n  gate2 [type=merge-gate, policy="p.yaml", schedule="*/5 * * * *", mode="evaluate", check_name="fletch/approval"]`;
    expect(codes(mkHarness(two))).toContain("node.duplicate-check-name");
  });
  it("allows authors=, opt_in_label= and skip= on an evaluate gate only", () => {
    const sel = `authors="dpup", opt_in_label="agent_review", skip="bot-author,label:hold"`;
    expect(codes(mkHarness(`  gate [type=merge-gate, policy="p.yaml", schedule="*/5 * * * *", mode="evaluate", ${sel}]`))).toEqual([]);
    const merge = codes(mkHarness(`  ship [type=merge-gate, policy="p.yaml", schedule="*/30 * * * *", ${sel}]`));
    expect(merge).toEqual(expect.arrayContaining(["node.authors-unsupported", "node.opt-in-label-unsupported", "node.skip-unsupported"]));
  });
  it("rejects skip=unchanged-diff on an evaluate gate", () => {
    expect(codes(mkHarness(`  gate [type=merge-gate, policy="p.yaml", schedule="*/5 * * * *", mode="evaluate", skip="unchanged-diff"]`))).toContain(
      "node.skip-unsupported",
    );
  });
});
