/**
 * merge= on a merge-gate node: the single gate, as compiled. The gate's
 * behaviour is tested in actions/merge-gate/src/index.test.ts; this file pins
 * what the compiler hands it, and what validate() refuses.
 */
import { describe, it, expect } from "vitest";
import yaml from "js-yaml";
import { parseDot } from "../src/parser/parse.js";
import { loadConfig } from "../src/config/load.js";
import { compile } from "../src/index.js";
import { validate } from "../src/validate/validate.js";
import type { Diagnostic, FoundryConfig, Harness } from "../src/ir/types.js";

const BOT = "agent-bot[bot]";
const APP = { auth: { mode: "app", app_id_secret: "APP_ID", app_key_secret: "APP_KEY" } } as Partial<FoundryConfig>;
const PAT = { auth: { mode: "pat", token_secret: "AGENT_PAT" } } as Partial<FoundryConfig>;

function mkHarness(dot: string, cfg: Partial<FoundryConfig> = {}): Harness {
  const g = parseDot(dot);
  expect(g.errors).toEqual([]);
  const config = { ...loadConfig(undefined), identity: { bot_login: BOT }, ...cfg } as FoundryConfig;
  return { name: g.name, nodes: g.nodes, edges: g.edges, config, sourcePath: "test.dot" };
}
const gateDot = (attrs = "") =>
  `digraph t { gate [type=merge-gate, policy="agents/policy/merge.yaml", schedule="*/10 * * * *"${attrs ? ", " + attrs : ""}] }`;
function gateJob(attrs: string, cfg: Partial<FoundryConfig> = {}): any {
  const { files } = compile(mkHarness(gateDot(attrs), cfg));
  const wf: any = yaml.load(files.find((f) => f.path.endsWith("/gate.yml"))!.contents);
  return wf.jobs.gate;
}
const gateStep = (job: any) => job.steps.find((s: any) => String(s.uses ?? "").includes("merge-gate"));
const diags = (attrs: string, cfg: Partial<FoundryConfig> = {}): Diagnostic[] => validate(mkHarness(gateDot(attrs), cfg));
const codes = (ds: Diagnostic[], level?: string) => ds.filter((d) => !level || d.level === level).map((d) => d.code);

describe('merge="off"', () => {
  it("publishes a check and can do nothing else", () => {
    const job = gateJob('merge="off"', PAT);
    expect(job.permissions).toEqual({ contents: "read", "pull-requests": "read", checks: "write" });
    const w = gateStep(job).with;
    expect(w.merge).toBe("off");
    expect(w.mode).toBeUndefined();
    expect(w["check-name"]).toBe("gp-foundry/approval (gate)");
    // Nothing to merge with: the read-only job token, not the harness PAT.
    expect(w.token).toBe("${{ github.token }}");
    expect(w["checks-token"]).toBe("${{ github.token }}");
    expect(w["check-app"]).toBeUndefined();
    // Scope is the rollout's, so no branch prefix is handed to the gate.
    expect(w["branch-prefix"]).toBeUndefined();
    expect(job.steps.find((s: any) => s.name === "Checkout").with["persist-credentials"]).toBe(false);
  });

  it("takes check_name=", () => {
    expect(gateStep(gateJob('merge="off", check_name="acme/approval"')).with["check-name"]).toBe("acme/approval");
  });
});

describe('merge="agent-only"', () => {
  it("merges under the harness identity and keeps reading checks with GITHUB_TOKEN (PAT auth)", () => {
    const job = gateJob('merge="agent-only"', PAT);
    expect(job.permissions).toEqual({ contents: "write", "pull-requests": "write", issues: "write", checks: "write" });
    const w = gateStep(job).with;
    expect(w.merge).toBe("agent-only");
    expect(w.token).toBe("${{ secrets.AGENT_PAT }}"); // a PAT merge cascades; GITHUB_TOKEN's would not
    expect(w["checks-token"]).toBe("${{ github.token }}"); // a PAT cannot hold the Checks permission
    expect(w["bot-login"]).toBe(BOT);
  });
});

describe("under App auth the check is the App's, not github-actions'", () => {
  it("publishes with the App token and adopts only that App's runs", () => {
    for (const merge of ["off", "agent-only"]) {
      const job = gateJob(`merge="${merge}"`, APP);
      const w = gateStep(job).with;
      expect(w["checks-token"], merge).toBe("${{ steps.app-token.outputs.token }}");
      expect(w["check-app"], merge).toBe("${{ steps.app-token.outputs.app-slug }}");
      expect(w.token, merge).toBe("${{ steps.app-token.outputs.token }}");
    }
  });

  it('narrows the App token for "off"; leaves a merging gate on the App\'s own permissions', () => {
    const mint = (merge: string) => gateJob(`merge="${merge}"`, APP).steps.find((s: any) => s.id === "app-token").with;
    const perms = (w: Record<string, string>) => Object.fromEntries(Object.entries(w).filter(([k]) => k.startsWith("permission-")));
    expect(perms(mint("off"))).toEqual({
      "permission-contents": "read",
      "permission-pull-requests": "read",
      "permission-checks": "write",
    });
    expect(perms(mint("agent-only"))).toEqual({});
  });

  it('the older mode="evaluate" gate is unchanged: still GITHUB_TOKEN, no App token', () => {
    const job = gateJob('mode="evaluate"', APP);
    expect(job.steps.find((s: any) => s.id === "app-token")).toBeUndefined();
    expect(gateStep(job).with["checks-token"]).toBe("${{ github.token }}");
    expect(gateStep(job).with.merge).toBeUndefined();
  });
});

describe("the rollout dial reaches the gate", () => {
  it("as parsed, label-resolved JSON", () => {
    const cfg = {
      rollout: { authors: ["Alice"], opt_in_label: "agent_review", skip_label: "no-agent-review" },
      labels: { agent_review: "bot:review" },
    } as Partial<FoundryConfig>;
    expect(JSON.parse(gateStep(gateJob('merge="off"', cfg)).with.rollout)).toEqual({
      authors: ["alice"],
      optInLabel: "bot:review",
      skipLabel: "no-agent-review",
    });
  });

  it("is omitted when there is no dial: every PR is in scope", () => {
    expect(gateStep(gateJob('merge="off"')).with.rollout).toBeUndefined();
  });

  it("a malformed dial compiles to nobody-by-name, never to everybody", () => {
    const cfg = { rollout: { authors: "alice" } } as unknown as Partial<FoundryConfig>;
    expect(JSON.parse(gateStep(gateJob('merge="off"', cfg)).with.rollout)).toEqual({ authors: [] });
    expect(codes(diags('merge="off"', cfg), "error")).toContain("config.bad-rollout");
  });
});

describe("validate", () => {
  it("accepts both settings", () => {
    expect(codes(diags('merge="off"'), "error")).toEqual([]);
    expect(codes(diags('merge="agent-only"'), "error")).toEqual([]);
  });

  it("rejects any other value — and such a gate compiles to one that cannot merge", () => {
    expect(codes(diags('merge="all"'), "error")).toContain("node.bad-merge");
    expect(gateStep(gateJob('merge="all"')).with.merge).toBe("off");
    expect(gateJob('merge="all"').permissions.contents).toBe("read");
  });

  it("rejects merge= together with mode=", () => {
    expect(codes(diags('merge="off", mode="evaluate"'), "error")).toContain("node.merge-and-mode");
  });

  it("rejects per-node scope on a gate with merge=: scope is the rollout block", () => {
    for (const attr of ['authors="alice"', 'opt_in_label="x"', 'skip="bot-author"']) {
      expect(codes(diags(`merge="off", ${attr}`), "error"), attr).toContain("node.gate-scope-attr");
    }
  });

  it('needs identity.bot_login for "agent-only": nothing else can be called agent-written', () => {
    expect(codes(diags('merge="agent-only"', { identity: {} }), "error")).toContain("node.merge-needs-bot-login");
    expect(codes(diags('merge="off"', { identity: {} }), "error")).not.toContain("node.merge-needs-bot-login");
  });

  it("rejects merge= on a node that is not a gate", () => {
    const dot = `digraph t { start [type=start] r [type=pr-review, role="r.md", context="pr-diff", merge="off"] start -> r [on="pull_request.opened"] }`;
    expect(codes(validate(mkHarness(dot)), "error")).toContain("node.merge-unsupported");
  });

  it("two gates may not publish under one check name", () => {
    const dot = `digraph t {
      a [type=merge-gate, policy="p.yaml", schedule="*/10 * * * *", merge="off", check_name="x/approval"]
      b [type=merge-gate, policy="p.yaml", schedule="*/10 * * * *", mode="evaluate", check_name="x/approval"]
    }`;
    expect(codes(validate(mkHarness(dot)), "error")).toContain("node.duplicate-check-name");
  });
});

describe("the original gate is untouched", () => {
  it("with no merge= it compiles exactly as before, and merges by branch prefix", () => {
    const job = gateJob("", PAT);
    const w = gateStep(job).with;
    expect(w.merge).toBeUndefined();
    expect(w.mode).toBeUndefined();
    expect(w["branch-prefix"]).toBe("agent/");
    expect(w["check-name"]).toBeUndefined();
    expect(job.permissions).toEqual({ contents: "write", "pull-requests": "write", issues: "write", checks: "read" });
  });

  it("validate only notes that the choice could be written down", () => {
    const d = diags("").find((x) => x.code === "node.merge-implicit");
    expect(d?.level).toBe("info");
    expect(codes(diags(""), "error")).toEqual([]);
    expect(codes(diags('merge="off"'))).not.toContain("node.merge-implicit");
    expect(codes(diags('mode="evaluate"'))).not.toContain("node.merge-implicit");
  });
});

describe("HARNESS.md", () => {
  it("says what the gate does with a ready PR, and names its check", () => {
    const md = (attrs: string) => compile(mkHarness(gateDot(attrs))).files.find((f) => f.path.endsWith("HARNESS.md"))!.contents;
    expect(md('merge="off"')).toContain("merge off → check gp-foundry/approval (gate)");
    expect(md('merge="agent-only", check_name="acme/approval"')).toContain("merge agent-only → check acme/approval");
  });
});
