/**
 * rollout.bot_authors (#55) at build time: the committed fixture and the
 * attributes that serve it (bot_schedule=, merge_bots=).
 * Runtime behaviour is tested where it lives: src/shared/scope.ts (scope.test.ts),
 * the pr-scope and merge-gate actions, and the compiled jobs (hybrid-guard.test.ts).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadHarness } from "../src/config/load.js";
import { compile } from "../src/index.js";
import { parseDot } from "../src/parser/parse.js";
import { loadConfig } from "../src/config/load.js";
import { validate } from "../src/validate/validate.js";
import type { FoundryConfig, Harness } from "../src/ir/types.js";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("the bot-authors fixture is what this compiler generates (CI lints it)", () => {
  it("every file", () => {
    const base = join(root, "test/fixtures/bot-authors/.github");
    const { harness, parseErrors } = loadHarness(join(base, "harness.dot"), join(base, "agents/foundry.config.yaml"));
    expect(parseErrors).toEqual([]);
    const read = (rel: string) => {
      try {
        return readFileSync(join(base, rel), "utf8");
      } catch {
        return undefined;
      }
    };
    const out = compile(harness, { readFile: read }, { specDir: ".github" }).files;
    const drift = out.filter((f) => readFileSync(join(root, "test/fixtures/bot-authors", f.path), "utf8") !== f.contents).map((f) => f.path);
    expect(drift).toEqual([]);
  });
});

describe("validate", () => {
  const ir = (attrs: string, rollout: object | undefined = { bot_authors: ["dependabot[bot]"] }, sweep = false): Harness => {
    const g = parseDot(`digraph t {
      start    [type=start]
      reviewer [type=pr-review, role="agents/roles/reviewer.md", context="pr-diff"${sweep ? ', select="sweep", schedule="*/10 * * * *"' : ""}${attrs ? ", " + attrs : ""}]
      start    -> reviewer [on="pull_request.opened"]
    }`);
    expect(g.errors).toEqual([]);
    const config = { ...loadConfig(undefined), identity: { bot_login: "agent-bot[bot]" }, ...(rollout ? { rollout } : {}) } as FoundryConfig;
    return { name: g.name, nodes: g.nodes, edges: g.edges, config, sourcePath: "t.dot" };
  };
  const codes = (h: Harness, deps = {}) => validate(h, deps).filter((d) => d.level !== "info").map((d) => `${d.level}:${d.code}`);

  it("bot_schedule= only where there is a bot pass, and only a cron", () => {
    expect(codes(ir('bot_schedule="*/5 * * * *"'))).not.toContain("warning:node.bot-schedule-ignored");
    expect(codes(ir('bot_schedule="*/5 * * * *"', undefined, true))).toContain("warning:node.bot-schedule-ignored");
    expect(codes(ir('bot_schedule="often"'))).toContain("error:node.bad-bot-schedule");
  });

  it("bot_authors may not name the harness's own login, nor a person", () => {
    expect(codes(ir("", { bot_authors: ["agent-bot[bot]"] }))).toContain("error:config.bot-authors-names-harness");
    expect(codes(ir("", { bot_authors: ["alice"] }))).toContain("error:config.bad-rollout");
  });
});

describe("merge_bots= on the gate", () => {
  const ir = (gate: string, rollout: object = { bot_authors: ["dependabot[bot]"] }): Harness => {
    const g = parseDot(`digraph t {
      start [type=start]
      gate  [type=merge-gate, policy="agents/policy/merge.yaml", schedule="*/10 * * * *", ${gate}]
      start -> gate
    }`);
    const config = { ...loadConfig(undefined), identity: { bot_login: "agent-bot[bot]" }, rollout } as FoundryConfig;
    return { name: g.name, nodes: g.nodes, edges: g.edges, config, sourcePath: "t.dot" };
  };
  const errors = (h: Harness) => validate(h).filter((d) => d.level === "error").map((d) => d.code);

  it("names bots the rollout admits", () => {
    expect(errors(ir('merge="off", merge_bots="dependabot[bot]"'))).not.toContain("node.merge-bots-not-bot-author");
    expect(errors(ir('merge="off", merge_bots="renovate[bot]"'))).toContain("node.merge-bots-not-bot-author");
    expect(errors(ir('merge="off", merge_bots="dependabot[bot]"', { skip_label: "x" }))).toContain("node.merge-bots-not-bot-author");
  });

  it("only bot logins, and only on a single gate", () => {
    expect(errors(ir('merge="off", merge_bots="alice"'))).toContain("node.bad-merge-bots");
    expect(errors(ir('merge_bots="dependabot[bot]"'))).toContain("node.merge-bots-needs-single-gate");
  });

  it("is passed to the gate, which then holds the token a merge needs", () => {
    const h = ir('merge="off", merge_bots="dependabot[bot]"');
    const wf = compile(h).files.find((f) => f.path.endsWith("/gate.yml"))!.contents;
    expect(wf).toContain("merge-bots: dependabot[bot]");
    expect(wf).toContain("merge named bots' PRs");
    const without = compile(ir('merge="off"')).files.find((f) => f.path.endsWith("/gate.yml"))!.contents;
    expect(without).not.toContain("merge-bots");
    expect(without).toContain("never merge");
  });
});
