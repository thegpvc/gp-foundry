/**
 * merge= on a merge-gate node: the single gate, as compiled. The gate's
 * behaviour is tested in actions/merge-gate/src/index.test.ts; this file pins
 * what the compiler hands it, and what validate() refuses.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import yaml from "js-yaml";
import { parseDot } from "../src/parser/parse.js";
import { loadConfig } from "../src/config/load.js";
import { compile } from "../src/index.js";
import { validate } from "../src/validate/validate.js";
import { evalGuard } from "../src/sim/gh-expr.js";
import { cronPeriodSeconds } from "../src/handlers/index.js";
import type { Diagnostic, FoundryConfig, Harness } from "../src/ir/types.js";

const BOT = "agent-bot[bot]";
const APP = { auth: { mode: "app", app_id_secret: "APP_ID", app_key_secret: "APP_KEY" } } as Partial<FoundryConfig>;
const PAT = { auth: { mode: "pat", token_secret: "AGENT_PAT" } } as Partial<FoundryConfig>;

function mkHarness(dot: string, cfg: Partial<FoundryConfig> = {}): Harness {
  const g = parseDot(dot);
  expect(g.errors).toEqual([]);
  // `rollout: {}` — a hybrid harness with the dial fully open — unless a test sets its own.
  const config = { ...loadConfig(undefined), identity: { bot_login: BOT }, rollout: {}, ...cfg } as FoundryConfig;
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

// What the runner hands the action: action.yml's defaults, overlaid by the step's `with:`.
const gateAction: any = yaml.load(readFileSync(fileURLToPath(new URL("../actions/merge-gate/action.yml", import.meta.url)), "utf8"));
const runnerInputs = (w: Record<string, unknown>): Record<string, string> => {
  const resolved: Record<string, string> = {};
  for (const [k, v] of Object.entries(gateAction.inputs as Record<string, { default?: string }>)) resolved[k] = v.default ?? "";
  for (const [k, v] of Object.entries(w)) resolved[k] = String(v);
  return resolved;
};

describe("the compiled step meets the action's inputs", () => {
  // 0.3.0 compiled merge= without mode, but action.yml defaulted mode to "merge",
  // so the gate saw both and failed on its first run.
  it("a merge= step reaches the gate with merge set and mode empty", () => {
    for (const merge of ["off", "agent-only"]) {
      const resolved = runnerInputs(gateStep(gateJob(`merge="${merge}"`, PAT)).with);
      expect(resolved.merge, merge).toBe(merge);
      expect(resolved.mode, merge).toBe("");
    }
  });

  it("every input the step passes is one the action declares", () => {
    const declared = Object.keys(gateAction.inputs);
    for (const merge of ["off", "agent-only"]) {
      expect(declared, merge).toEqual(expect.arrayContaining(Object.keys(gateStep(gateJob(`merge="${merge}"`, PAT)).with)));
    }
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
      // The App token does all of it, so GITHUB_TOKEN keeps only the checkout:
      // it can neither write a check nor merge.
      expect(job.permissions, merge).toEqual({ contents: "read" });
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

  it("is omitted when the dial is fully open: every PR is in scope", () => {
    expect(gateStep(gateJob('merge="off"')).with.rollout).toBeUndefined();
  });

  it("merge= needs the rollout block: it is what puts the gate and the lanes on one scope", () => {
    const noBlock = { rollout: undefined } as Partial<FoundryConfig>;
    expect(codes(diags('merge="off"', noBlock), "error")).toContain("node.merge-needs-rollout");
    expect(codes(diags('merge="off"'), "error")).not.toContain("node.merge-needs-rollout");
    // The original gate needs none.
    expect(codes(diags("", noBlock), "error")).toEqual([]);
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

describe("the single gate also evaluates one PR when something that decides it changes", () => {
  const wf = (attrs = 'merge="off"', cfg: Partial<FoundryConfig> = APP) => {
    const { files } = compile(mkHarness(gateDot(attrs), cfg));
    return yaml.load(files.find((f) => f.path.endsWith("/gate.yml"))!.contents) as any;
  };

  it("listens for reviews, labels, review requests and new commits, besides its schedule", () => {
    const on = wf().on;
    expect(on.schedule).toEqual([{ cron: "*/10 * * * *" }]);
    expect(on.workflow_dispatch).toEqual({});
    expect(on.pull_request.types).toEqual(["synchronize", "reopened", "ready_for_review", "labeled", "unlabeled", "review_requested", "review_request_removed"]);
    expect(on.pull_request_review.types).toEqual(["submitted", "dismissed"]);
    // No check_run / check_suite / workflow_run: CI finishing is the scheduled pass's.
    expect(Object.keys(on).sort()).toEqual(["pull_request", "pull_request_review", "schedule", "workflow_dispatch"]);
  });

  it("evaluates the event's PR, and the pass when scheduled, within the job's time", () => {
    const w = gateStep(wf().jobs.gate).with;
    expect(w["pr-number"]).toBe("${{ github.event.pull_request.number }}");
    // The window advances once per schedule period (from the clock, not a run counter).
    expect(w["rotation-period-seconds"]).toBe("600");
    expect(w.rotation).toBeUndefined();
    expect(w["time-budget-seconds"]).toBe("480"); // a 10-minute job, two minutes to spare
    expect(gateStep(wf('merge="off", timeout=30').jobs.gate).with["time-budget-seconds"]).toBe("1680");
  });

  it("one concurrency slot per PR for events, newest wins; the schedule has its own", () => {
    const c = wf().concurrency;
    expect(c.group).toBe("${{ github.event.pull_request.number && format('gate-pr-{0}', github.event.pull_request.number) || 'gate' }}");
    expect(c["cancel-in-progress"]).toBe("${{ github.event.pull_request.number != null }}");
  });

  describe("which runs do anything", () => {
    const guard = () => wf().jobs.gate.if as string;
    const run = (event_name: string, event: object = {}, actor = "alice", g: () => string = guard) =>
      evalGuard(g(), { github: { event_name, actor, repository: "o/r", event } } as any);
    const pr = (over: object = {}) => ({
      state: "open",
      draft: false,
      labels: [] as { name: string }[],
      user: { login: "alice", type: "User" },
      base: { ref: "main" },
      head: { repo: { full_name: "o/r" } },
      ...over,
    });

    it("the schedule and a manual run, always", () => {
      expect(run("schedule")).toBe(true);
      expect(run("workflow_dispatch")).toBe(true);
    });

    it("an event on an open PR from this repo", () => {
      expect(run("pull_request_review", { action: "submitted", pull_request: pr() })).toBe(true);
      expect(run("pull_request", { action: "unlabeled", pull_request: pr(), sender: { login: "alice" } })).toBe(true);
    });

    it("not a fork's, nor one Dependabot triggered: no secrets there — the schedule covers them", () => {
      expect(run("pull_request", { action: "synchronize", pull_request: pr({ head: { repo: { full_name: "someone/fork" } } }) })).toBe(false);
      expect(run("pull_request", { action: "synchronize", pull_request: pr() }, "dependabot[bot]")).toBe(false);
    });

    it("not a closed PR, nor one into another branch", () => {
      expect(run("pull_request", { action: "labeled", pull_request: pr({ state: "closed" }) })).toBe(false);
      expect(run("pull_request", { action: "labeled", pull_request: pr({ base: { ref: "release/1.x" } }) })).toBe(false);
    });

    it("labels and reviews from the harness's own identity DO run it: the reviewer's hold, the approver's verdict", () => {
      expect(run("pull_request", { action: "labeled", pull_request: pr(), sender: { login: BOT } }, BOT)).toBe(true);
      expect(run("pull_request_review", { action: "submitted", pull_request: pr(), sender: { login: BOT } }, BOT)).toBe(true);
    });

    // A person's label or review on a PR the gate will find out of scope used to
    // start a run that minted the App token and then did nothing.
    it("not a draft, nor another bot's PR, whoever triggered the event", () => {
      expect(run("pull_request", { action: "labeled", pull_request: pr({ draft: true }) })).toBe(false);
      const dependabot = pr({ user: { login: "dependabot[bot]", type: "Bot" } });
      expect(run("pull_request_review", { action: "submitted", pull_request: dependabot })).toBe(false);
      expect(run("pull_request", { action: "labeled", pull_request: pr({ user: { login: "renovate[bot]", type: "Bot" } }) })).toBe(false);
    });

    it("the harness bot's own PR runs, and another bot's only when rollout.authors names it", () => {
      expect(run("pull_request_review", { action: "submitted", pull_request: pr({ user: { login: BOT, type: "Bot" } }) })).toBe(true);
      const named = () => wf('merge="off"', { ...APP, rollout: { authors: ["renovate[bot]", "alice"] } } as Partial<FoundryConfig>).jobs.gate.if as string;
      expect(run("pull_request", { action: "labeled", pull_request: pr({ user: { login: "renovate[bot]", type: "Bot" } }) }, "alice", named)).toBe(true);
      expect(run("pull_request", { action: "labeled", pull_request: pr({ user: { login: "dependabot[bot]", type: "Bot" } }) }, "alice", named)).toBe(false);
      // …and the authors list still decides for people.
      expect(run("pull_request", { action: "labeled", pull_request: pr({ user: { login: "bob", type: "User" } }) }, "alice", named)).toBe(false);
    });

    it("not a PR carrying the rollout's skip label; removing it does run (the payload no longer carries it)", () => {
      const skip = () => wf('merge="off"', { ...APP, rollout: { skip_label: "fletch:skip" } } as Partial<FoundryConfig>).jobs.gate.if as string;
      const skipped = pr({ labels: [{ name: "fletch:skip" }] });
      expect(run("pull_request_review", { action: "submitted", pull_request: skipped }, "alice", skip)).toBe(false);
      expect(run("pull_request", { action: "labeled", label: { name: "fletch:skip" }, pull_request: skipped }, "alice", skip)).toBe(false);
      expect(run("pull_request", { action: "unlabeled", label: { name: "fletch:skip" }, pull_request: pr() }, "alice", skip)).toBe(true);
      // The schedule is never filtered.
      expect(run("schedule", {}, "alice", skip)).toBe(true);
      expect(run("workflow_dispatch", {}, "alice", skip)).toBe(true);
    });
  });

  // An event run on a pull request checks out the PR's merge ref by default: the
  // policy would be read from the PR it judges, which could loosen it.
  it("reads the policy from the base branch on every trigger, with no credential left behind", () => {
    for (const cfg of [APP, PAT]) {
      const checkout = wf('merge="off"', cfg).jobs.gate.steps.find((s: any) => s.name === "Checkout");
      expect(checkout.with.ref).toBe("main");
      expect(checkout.with["persist-credentials"]).toBe(false);
    }
    const other = wf('merge="agent-only"', { ...APP, repo: { ...loadConfig(undefined).repo, base_branch: "develop" } } as Partial<FoundryConfig>);
    expect(other.jobs.gate.steps.find((s: any) => s.name === "Checkout").with.ref).toBe("develop");
    expect(gateStep(other.jobs.gate).with["base-branch"]).toBe("develop");
  });

  it("names its own job's check run, so the gate leaves it out of the CI rollup", () => {
    expect(gateStep(wf().jobs.gate).with["job-check-name"]).toBe("gate");
    // The job has no display name: GitHub names its check run by the job id.
    expect(wf().jobs.gate.name).toBeUndefined();
  });

  it("the older gates are untouched: schedule only, one slot", () => {
    for (const attrs of ['mode="evaluate"', ""]) {
      const w = wf(attrs, { ...APP, rollout: undefined } as Partial<FoundryConfig>);
      expect(Object.keys(w.on).sort(), attrs).toEqual(["schedule", "workflow_dispatch"]);
      expect(w.concurrency, attrs).toEqual({ group: "gate", "cancel-in-progress": false });
      expect(gateStep(w.jobs.gate).with["pr-number"], attrs).toBeUndefined();
    }
  });
});

describe("cronPeriodSeconds", () => {
  it.each([
    ["*/10 * * * *", 600],
    ["*/5 * * * *", 300],
    ["17 * * * *", 3600],
    ["0 */2 * * *", 7200],
    ["0 7 * * *", 86400],
    ["0 7 * * 1-5", 300],
    ["nonsense", 300],
  ])("%s → %i", (cron, s) => {
    expect(cronPeriodSeconds(cron)).toBe(s);
  });
});
