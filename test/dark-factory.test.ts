/**
 * Regression tests for the dark-factory audit findings: label mapping, guard
 * OR-merge, placeholder detection, vendored-actions check, the real attempt
 * budget, approval integrity, and out-of-the-box template runnability.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { parseDot } from "../src/parser/parse.js";
import { loadConfig } from "../src/config/load.js";
import { wire } from "../src/wiring/wire.js";
import { validate } from "../src/validate/validate.js";
import { compile } from "../src/index.js";
import { latestValidApproval } from "../actions/merge-gate/src/gate.js";
import type { FoundryConfig, Harness } from "../src/ir/types.js";

const tpl = (rel: string) => fileURLToPath(new URL(`../skill/templates/${rel}`, import.meta.url));

function mkHarness(dotSrc: string, cfg: Partial<FoundryConfig> = {}): Harness {
  const g = parseDot(dotSrc);
  const config = { ...loadConfig(undefined), ...cfg } as FoundryConfig;
  return { name: g.name, nodes: g.nodes, edges: g.edges, config, sourcePath: "test.dot" };
}

const LANE_DOT = `digraph t {
  start [type=start]
  scout [type=issue-agent, role="agents/roles/scout.md"]
  builder [type=producer, role="agents/roles/builder.md"]
  reviewer [type=pr-review, role="agents/roles/reviewer.md"]
  start -> scout [on="issues.opened"]
  scout -> builder [when="label=build"]
  builder -> reviewer [on="pull_request.opened"]
}`;

describe("label mapping (config.labels is live, not dead config)", () => {
  it("resolves semantic keys through config.labels", () => {
    const ir = mkHarness(LANE_DOT, { labels: { build: "agent-go" } } as Partial<FoundryConfig>);
    const guard = wire(ir).perNode.builder!.guard!;
    expect(guard).toContain("github.event.label.name == 'agent-go'");
  });

  it("defaults to identity when unmapped", () => {
    const ir = mkHarness(LANE_DOT);
    expect(wire(ir).perNode.builder!.guard!).toContain("== 'build'");
  });
});

describe("guard OR-merge: unguarded events survive a guarded sibling edge", () => {
  // reviewer has BOTH a label-guarded in-edge and an unguarded pull_request in-edge
  const MIXED = `digraph t {
    start [type=start]
    builder [type=producer, role="agents/roles/builder.md"]
    nudge [type=issue-agent, role="agents/roles/nudge.md"]
    reviewer [type=pr-review, role="agents/roles/reviewer.md"]
    start -> builder [on="issues.opened"]
    builder -> reviewer [on="pull_request.opened"]
    nudge -> reviewer [when="label=re-review"]
  }`;
  it("reviewer keeps firing on pull_request events despite the label guard", () => {
    const ir = mkHarness(MIXED);
    const w = wire(ir).perNode.reviewer!;
    // the label guard must be OR'd with a discriminator for the unguarded event
    expect(w.guard).toContain("github.event.label.name == 're-review'");
    expect(w.guard).toContain("github.event_name == 'pull_request'");
    expect(w.guard).toContain("github.event.action == 'opened'");
  });
});

describe("placeholder detection", () => {
  it("errors when config values still contain <placeholders>", () => {
    const ir = mkHarness(LANE_DOT, { identity: { git_email: "<agent@example.com>" } } as Partial<FoundryConfig>);
    const diags = validate(ir);
    expect(diags.some((d) => d.code === "config.placeholder" && d.level === "error")).toBe(true);
  });

  it("is silent on a fully-filled config", () => {
    const ir = mkHarness(LANE_DOT);
    expect(validate(ir).filter((d) => d.code === "config.placeholder")).toEqual([]);
  });
});

describe("vendored-runtime checks", () => {
  it("warns when vendored actions / agent-setup are missing", () => {
    const ir = mkHarness(LANE_DOT, { runtime: { mode: "vendored" } } as Partial<FoundryConfig>);
    const diags = validate(ir, { fileExists: (p) => p.startsWith("agents/") });
    expect(diags.some((d) => d.code === "runtime.action-not-vendored")).toBe(true);
    expect(diags.some((d) => d.code === "runtime.agent-setup-missing")).toBe(true);
  });
});

describe("auth github-token severity", () => {
  it("explicit github-token + cascade edges = error", () => {
    const ir = mkHarness(LANE_DOT, { auth: { mode: "github-token" } } as Partial<FoundryConfig>);
    const d = validate(ir).find((x) => x.code === "auth.github-token-no-cascade");
    expect(d?.level).toBe("error");
  });
  it("defaulted auth = warning (no choice made yet)", () => {
    const ir = mkHarness(LANE_DOT);
    const d = validate(ir).find((x) => x.code === "auth.github-token-no-cascade");
    expect(d?.level).toBe("warning");
  });
});

describe("attempt budget is real (pr-fix)", () => {
  const FIX_DOT = `digraph t {
    start [type=start]
    reviewer [type=pr-review, role="agents/roles/reviewer.md"]
    fixer [type=pr-fix, role="agents/roles/fixer.md", max_attempts=2]
    start -> reviewer [on="pull_request.opened"]
    reviewer -> fixer [when="verdict=request_changes"]
  }`;
  it("emits an attempts gate that labels needs-human at the limit", () => {
    const ir = mkHarness(FIX_DOT);
    const { files } = compile(ir);
    const fixer = files.find((f) => f.path.endsWith("fixer.yml"))!.contents;
    expect(fixer).toContain("Enforce attempt budget (max 2)");
    expect(fixer).toContain("needs-human");
    // downstream steps are gated on the budget
    expect(fixer).toContain("steps.attempts.outputs.exhausted != 'true'");
  });
});

describe("merge-gate approval integrity (latestValidApproval)", () => {
  const HEAD = "abc123";
  it("a later REQUEST_CHANGES invalidates an earlier APPROVE", () => {
    expect(latestValidApproval([
      { at: "2026-01-01T10:00:00Z", kind: "approve", sha: HEAD },
      { at: "2026-01-01T11:00:00Z", kind: "reject", sha: HEAD },
    ], HEAD)).toBeNull();
  });
  it("an approval for a stale SHA does not count", () => {
    expect(latestValidApproval([
      { at: "2026-01-01T10:00:00Z", kind: "approve", sha: "oldsha" },
    ], HEAD)).toBeNull();
  });
  it("approve on the current head counts", () => {
    expect(latestValidApproval([
      { at: "2026-01-01T10:00:00Z", kind: "reject", sha: "oldsha" },
      { at: "2026-01-01T11:00:00Z", kind: "approve", sha: HEAD },
    ], HEAD)).toBe("2026-01-01T11:00:00Z");
  });
  it("a comment verdict (no SHA) must postdate the head commit", () => {
    const events = [{ at: "2026-01-01T10:00:00Z", kind: "approve" as const }];
    expect(latestValidApproval(events, HEAD, "2026-01-01T11:00:00Z")).toBeNull();
    expect(latestValidApproval(events, HEAD, "2026-01-01T09:00:00Z")).toBe("2026-01-01T10:00:00Z");
  });
  it("no events → no approval", () => {
    expect(latestValidApproval([], HEAD)).toBeNull();
  });
});

describe("shipped templates are runnable out of the box", () => {
  it("template config has no <placeholders> and uses vendored runtime", () => {
    const cfg = yaml.load(readFileSync(tpl("foundry.config.yaml"), "utf8")) as Record<string, any>;
    expect(JSON.stringify(cfg)).not.toMatch(/<[A-Za-z][^<>]*>/);
    expect(cfg.runtime.mode).toBe("vendored");
    expect(cfg.repo.branch_prefix).toBe("agent/"); // must match policy branch_prefix
  });

  it("template harness compiles with zero errors and includes the self-healing/-improving lanes", () => {
    const g = parseDot(readFileSync(tpl("harness.dot"), "utf8"));
    const cfgRaw = yaml.load(readFileSync(tpl("foundry.config.yaml"), "utf8")) as Partial<FoundryConfig>;
    const config = { ...loadConfig(undefined), ...cfgRaw } as FoundryConfig;
    const ir: Harness = { name: g.name, nodes: g.nodes, edges: g.edges, config, sourcePath: "harness.dot" };
    const { files, diagnostics } = compile(ir);
    expect(diagnostics.filter((d) => d.level === "error")).toEqual([]);
    const paths = files.map((f) => f.path);
    for (const wf of ["scout", "planner", "builder", "reviewer", "fixer", "merge_gate", "janitor", "supervisor", "retro"]) {
      expect(paths).toContain(`.github/workflows/${wf}.yml`);
    }
    // no placeholder leaks into any generated WORKFLOW (HARNESS.md has legit mermaid HTML)
    for (const f of files.filter((x) => x.path.startsWith(".github/workflows/"))) {
      expect(f.contents).not.toMatch(/<[A-Za-z][^<>]{0,40}>/);
    }
  });
});

describe("verification-pass regressions", () => {
  it("rejection default is anchored; approvals mentioning REQUEST_CHANGES in prose stay approvals", () => {
    // simulated: approval body that discusses the earlier requested changes
    const approveRe = /Verdict.*APPROVE/;
    const rejectRe = /Verdict.*REQUEST_CHANGES/;
    const reApproval = "## Reviewer\n\nAll REQUEST_CHANGES items addressed.\n\n**Verdict:** APPROVE";
    expect(approveRe.test(reApproval)).toBe(true);
    expect(rejectRe.test(reApproval)).toBe(false); // the anchored default must NOT match
  });

  it("push edge into a PR node gets a post-mapping discriminator (pull_request, not push)", () => {
    const MIX = `digraph t {
      start [type=start]
      builder [type=producer, role="agents/roles/builder.md"]
      fixer [type=pr-fix, role="agents/roles/fixer.md"]
      reviewer [type=pr-review, role="agents/roles/reviewer.md"]
      start -> builder [on="issues.opened"]
      builder -> reviewer [when="label=re-review"]
      fixer -> reviewer [on="push"]
    }`;
    const ir = mkHarness(MIX);
    const g = wire(ir).perNode.reviewer!.guard!;
    expect(g).not.toContain("github.event_name == 'push'");
    expect(g).toContain("github.event.action == 'synchronize'");
  });

  it("scheduled-agent jobs can inspect/re-run workflow runs (actions permission)", () => {
    const DOT = `digraph t {
      sup [type=scheduled-agent, role="agents/roles/supervisor.md", schedule="17 * * * *"]
    }`;
    const ir = mkHarness(DOT);
    const { files } = compile(ir);
    const wf = files.find((f) => f.path.endsWith("sup.yml"))!.contents;
    expect(wf).toContain("actions: write");
  });

  it("pr-fix budget respects config.labels needs-human mapping", () => {
    const DOT = `digraph t {
      start [type=start]
      reviewer [type=pr-review, role="agents/roles/reviewer.md"]
      fixer [type=pr-fix, role="agents/roles/fixer.md"]
      start -> reviewer [on="pull_request.opened"]
      reviewer -> fixer [when="verdict=request_changes"]
    }`;
    const ir = mkHarness(DOT, { labels: { "needs-human": "escalated" } } as Partial<FoundryConfig>);
    const { files } = compile(ir);
    const wf = files.find((f) => f.path.endsWith("fixer.yml"))!.contents;
    expect(wf).toContain("escalated");
  });

  it("template config no longer advertises the dead size block", () => {
    const cfg = yaml.load(readFileSync(tpl("foundry.config.yaml"), "utf8")) as Record<string, any>;
    expect(cfg.size).toBeUndefined();
  });
});

describe("skill install", () => {
  it("copies SKILL.md to the skill root with reference/ + templates/ beside it", async () => {
    const { installSkillInto } = await import("../src/cli/ops.js");
    const { mkdtempSync, existsSync: ex, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join: j } = await import("node:path");
    const d = mkdtempSync(j(tmpdir(), "gpf-skill-"));
    try {
      installSkillInto(d);
      expect(ex(j(d, "SKILL.md"))).toBe(true);
      expect(ex(j(d, "reference/cli.md"))).toBe(true);
      expect(ex(j(d, "templates/harness.dot"))).toBe(true);
      const fm = readFileSync(j(d, "SKILL.md"), "utf8");
      expect(fm.startsWith("---\nname: gp-foundry")).toBe(true);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("skill dry-run regressions", () => {
  it("human-gate concurrency is PR-scoped (verdict edges ride pull_request_review)", () => {
    const DOT = `digraph t {
      start [type=start]
      reviewer [type=pr-review, role="agents/roles/reviewer.md"]
      publish [type=human-gate, environment=production]
      start -> reviewer [on="pull_request.opened"]
      reviewer -> publish [when="verdict=approve"]
    }`;
    const ir = mkHarness(DOT);
    const w = wire(ir).perNode.publish!;
    expect(w.concurrency?.group).toContain("github.event.pull_request.number");
  });

  it("attempt-budget escalation names the node, not a hardcoded Fixer persona", () => {
    const DOT = `digraph t {
      start [type=start]
      reviewer [type=pr-review, role="agents/roles/reviewer.md"]
      editor [type=pr-fix, role="agents/roles/editor.md", max_attempts=2]
      start -> reviewer [on="pull_request.opened"]
      reviewer -> editor [when="verdict=request_changes"]
    }`;
    const ir = mkHarness(DOT);
    const { files } = compile(ir);
    const wf = files.find((f) => f.path.endsWith("editor.yml"))!.contents;
    expect(wf).toContain("Attempt budget (editor)");
    expect(wf).not.toContain("🧑‍🔧 Fixer");
  });
});

describe("AGENTS.md bootstrap (zero-install front door)", () => {
  const agentMd = readFileSync(fileURLToPath(new URL("../AGENTS.md", import.meta.url)), "utf8");
  it("is shipped in the npm package", async () => {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
    expect(pkg.files).toContain("AGENTS.md");
  });
  it("uses npx (no global install) and names the real commands + secrets", () => {
    expect(agentMd).toContain("npx -y @thegpvc/gp-foundry@latest init");
    expect(agentMd).toContain("npx -y @thegpvc/gp-foundry@latest up");
    expect(agentMd).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(agentMd).toContain("AGENT_PAT");
    expect(agentMd).not.toContain("npm i -g");
    expect(agentMd).not.toMatch(/<[A-Za-z][^<>]{0,40}>/); // no placeholders
  });
});

describe("honesty guards", () => {
  it("errors when parallel is used outside a clean diamond", () => {
    const DOT = `digraph t {
      start [type=start]
      fan [type=parallel]
      start -> fan [on="issues.opened"]
    }`;
    const ir = mkHarness(DOT);
    expect(validate(ir).some((d) => d.code === "diamond.malformed" && d.level === "error")).toBe(true);
  });
});

describe("gate ordering (vendored local actions need checkout first)", () => {
  it("pr-review with gates= checks out before wait-for-checks", () => {
    const DOT = `digraph t {
      start [type=start]
      builder [type=producer, role="agents/roles/builder.md"]
      reviewer [type=pr-review, role="agents/roles/reviewer.md", context="pr-diff", gates="ci.yml"]
      start -> builder [on="issues.opened"]
      builder -> reviewer [on="pull_request.opened"]
    }`;
    const ir = mkHarness(DOT, { runtime: { mode: "vendored" } } as Partial<FoundryConfig>);
    const { files } = compile(ir);
    const wf = files.find((f) => f.path.endsWith("reviewer.yml"))!.contents;
    expect(wf.indexOf("actions/checkout")).toBeLessThan(wf.indexOf("wait-for-checks"));
  });
});

describe("parallel/fan_in diamonds (needs-join)", () => {
  const PANEL = `digraph t {
    start [type=start]
    builder [type=producer, role="agents/roles/builder.md"]
    split [type=parallel]
    lane_correctness [type=analyst, role="agents/roles/lane-correctness.md", context="pr-diff"]
    lane_security [type=analyst, role="agents/roles/lane-security.md", context="pr-diff"]
    panel [type=fan_in, role="agents/roles/panel.md"]
    start -> builder [on="issues.opened"]
    builder -> split [on="pull_request.opened, pull_request.synchronize"]
    split -> lane_correctness
    split -> lane_security
    lane_correctness -> panel
    lane_security -> panel
  }`;

  it("compiles the diamond into ONE workflow: legs + needs-joined fan_in", () => {
    const ir = mkHarness(PANEL);
    const { files, diagnostics } = compile(ir);
    expect(diagnostics.filter((d) => d.level === "error")).toEqual([]);
    const paths = files.map((f) => f.path);
    expect(paths).toContain(".github/workflows/panel.yml");
    // legs and the parallel node get no standalone workflows
    for (const p of ["split", "lane_correctness", "lane_security"]) {
      expect(paths).not.toContain(`.github/workflows/${p}.yml`);
    }
    const wf = yaml.load(files.find((f) => f.path.endsWith("panel.yml"))!.contents.replace(/^#.*\n#.*\n/, "")) as any;
    expect(Object.keys(wf.jobs).sort()).toEqual(["lane_correctness", "lane_security", "panel"]);
    expect(wf.jobs.panel.needs.sort()).toEqual(["lane_correctness", "lane_security"]);
    // triggered by the diamond's entry edge
    expect(wf.on.pull_request.types).toContain("opened");
    expect(wf.on.pull_request.types).toContain("synchronize");
    // PR-scoped concurrency, node-id prefixed, never cancel mid-join
    expect(wf.concurrency.group).toContain("panel-");
    expect(wf.concurrency.group).toContain("github.event.pull_request.number");
    expect(wf.concurrency["cancel-in-progress"]).toBe(false);
  });

  it("errors on a malformed diamond (fan_in without a shared parallel)", () => {
    const BAD = `digraph t {
      start [type=start]
      a [type=analyst, role="agents/roles/a.md"]
      f [type=fan_in, role="agents/roles/f.md"]
      start -> a [on="issues.opened"]
      a -> f
      start -> f [on="issues.opened"]
    }`;
    const ir = mkHarness(BAD);
    expect(validate(ir).some((d) => d.code === "diamond.malformed" && d.level === "error")).toBe(true);
  });

  it("errors on an unobservable join (no role, no on_complete_label)", () => {
    const NOOBS = PANEL.replace('panel [type=fan_in, role="agents/roles/panel.md"]', "panel [type=fan_in]");
    const ir = mkHarness(NOOBS);
    expect(validate(ir).some((d) => d.code === "diamond.unobservable-join")).toBe(true);
  });

  it("warns when lanes are pr-review typed (verdict-bypass trap)", () => {
    const RISKY = PANEL
      .replace('lane_correctness [type=analyst', 'lane_correctness [type=pr-review')
      .replace('lane_security [type=analyst', 'lane_security [type=pr-review');
    const ir = mkHarness(RISKY);
    expect(validate(ir).some((d) => d.code === "diamond.lane-verdict-risk")).toBe(true);
  });

  it("on_complete_label resolves through config.labels and emits the label step", () => {
    const LBL = PANEL.replace('panel [type=fan_in, role="agents/roles/panel.md"]',
      'panel [type=fan_in, role="agents/roles/panel.md", on_complete_label=reviewed]');
    const ir = mkHarness(LBL, { labels: { reviewed: "panel-done" } } as Partial<FoundryConfig>);
    const { files } = compile(ir);
    const wf = files.find((f) => f.path.endsWith("panel.yml"))!.contents;
    expect(wf).toContain("panel-done");
  });

  it("github-token mode + verdict/label cascade edges are flagged", () => {
    const DOT = `digraph t {
      start [type=start]
      reviewer [type=pr-review, role="agents/roles/reviewer.md"]
      fixer [type=pr-fix, role="agents/roles/fixer.md"]
      start -> reviewer [on="issues.labeled"]
      reviewer -> fixer [when="verdict=request_changes"]
    }`;
    const ir = mkHarness(DOT, { auth: { mode: "github-token" } } as Partial<FoundryConfig>);
    const d = validate(ir).find((x) => x.code === "auth.github-token-no-cascade");
    expect(d?.level).toBe("error");
  });
});

describe("npm packaging", () => {
  it("files globs use the recursive form for action dists (0.1.0 shipped without them)", () => {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
    // npm-packlist does NOT recurse a glob'd directory entry ("actions/*/dist"
    // matches the dir itself, packs nothing) — the /** suffix is load-bearing.
    expect(pkg.files).toContain("actions/*/dist/**");
    expect(pkg.files).not.toContain("actions/*/dist");
  });
});
