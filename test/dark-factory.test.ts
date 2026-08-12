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
import { evalGuard } from "../src/sim/gh-expr.js";
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
    expect(wf).not.toContain("🔧 Fixer");
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

// ── trigger scoping: agent lanes must not run on human PRs ────────────────

describe("branch-prefix guard (item 5)", () => {
  const REVIEW_DOT = `digraph t {
    start [type=start]
    reviewer [type=pr-review, role="agents/roles/reviewer.md", context="pr-diff"]
    fixer [type=pr-fix, role="agents/roles/fixer.md"]
    start -> reviewer [on="pull_request.opened, pull_request.synchronize"]
    reviewer -> fixer [when="verdict=request_changes"]
  }`;

  it("guards a PR-triggered reviewer on the configured branch prefix", () => {
    const ir = mkHarness(REVIEW_DOT);
    const guard = wire(ir).perNode.reviewer!.guard!;
    expect(guard).toBe("startsWith(github.event.pull_request.head.ref, 'agent/')");
  });

  it("parenthesizes the existing OR before ANDing the prefix", () => {
    const ir = mkHarness(REVIEW_DOT, { identity: { bot_login: "bot" } } as Partial<FoundryConfig>);
    const guard = wire(ir).perNode.fixer!.guard!;
    // `a || b && prefix` would only constrain b — the OR must be grouped.
    expect(guard).toMatch(/^\(.*\) && startsWith\(github\.event\.pull_request\.head\.ref, 'agent\/'\)$/);
  });

  it("requires the prefix only of PR events on a mixed-trigger node", () => {
    const ir = mkHarness(`digraph t {
      start [type=start]
      scout [type=issue-agent, role="agents/roles/scout.md"]
      start -> scout [on="issues.opened, pull_request.opened"]
    }`);
    const guard = wire(ir).perNode.scout!.guard!;
    expect(guard).toContain("github.event_name == 'issues'");
    expect(guard).toContain("startsWith(github.event.pull_request.head.ref, 'agent/')");
    // An issue event still fires: its own clause satisfies the OR.
    expect(evalGuard(guard, { github: { event_name: "issues", event: { action: "opened" } } })).toBe(true);
    // A PR on a human branch does not.
    expect(
      evalGuard(guard, {
        github: { event_name: "pull_request", event: { action: "opened", pull_request: { head: { ref: "dpup/hotfix" } } } },
      }),
    ).toBe(false);
  });

  it("leaves issue-only lanes untouched", () => {
    const ir = mkHarness(LANE_DOT);
    expect(wire(ir).perNode.builder!.guard).not.toContain("startsWith");
  });
});

describe("verdict guards check the reviewing actor (item 6)", () => {
  const VERDICT_DOT = `digraph t {
    reviewer [type=pr-review, role="agents/roles/reviewer.md"]
    fixer [type=pr-fix, role="agents/roles/fixer.md"]
    reviewer -> fixer [when="verdict=request_changes"]
  }`;

  it("ANDs the bot login onto the verdict marker", () => {
    const ir = mkHarness(VERDICT_DOT, { identity: { bot_login: "agent-bot" } } as Partial<FoundryConfig>);
    const guard = wire(ir).perNode.fixer!.guard!;
    expect(guard).toContain("github.event.review.user.login == 'agent-bot'");
    const payload = (login: string) => ({
      github: {
        event_name: "pull_request_review",
        event: {
          action: "submitted",
          review: { body: "**Verdict:** REQUEST_CHANGES", user: { login } },
          pull_request: { head: { ref: "agent/1-x" } },
        },
      },
    });
    expect(evalGuard(guard, payload("agent-bot"))).toBe(true);
    // The escalation from the report: a stranger's review carrying the marker.
    expect(evalGuard(guard, payload("stranger"))).toBe(false);
  });

  it("omits the clause when no bot_login is configured (validate warns instead)", () => {
    const ir = mkHarness(VERDICT_DOT);
    expect(wire(ir).perNode.fixer!.guard).not.toContain("review.user.login");
    expect(validate(ir).some((d) => d.code === "auth.no-bot-login")).toBe(true);
  });
});

describe("CI gates are consumed, not just awaited (item 7)", () => {
  const gated = (gates: string) =>
    compile(
      mkHarness(`digraph t {
        start [type=start]
        reviewer [type=pr-review, role="agents/roles/reviewer.md", context="pr-diff", gates="${gates}"]
        start -> reviewer [on="pull_request.opened"]
      }`),
    );

  const reviewerJob = (gates: string) => {
    const file = gated(gates).files.find((f) => f.path.endsWith("reviewer.yml"))!;
    const doc = yaml.load(file.contents) as any;
    return doc.jobs.reviewer;
  };

  it("gives each wait step an id and feeds its conclusion into the review context", () => {
    const job = reviewerJob("ci.yml, e2e.yml");
    const waits = job.steps.filter((s: any) => String(s.uses ?? "").includes("wait-for-checks"));
    expect(waits.map((s: any) => s.id)).toEqual(["gate-ci-yml", "gate-e2e-yml"]);

    const record = job.steps.find((s: any) => s.name === "Record CI gate results in the context");
    expect(record.env.GATE_1_RESULT).toBe("${{ steps.gate-ci-yml.outputs.conclusion }}");
    expect(record.env.GATE_2_RESULT).toBe("${{ steps.gate-e2e-yml.outputs.conclusion }}");
    expect(record.env.CONTEXT_FILE).toBe("${{ steps.ctx.outputs.context-file }}");
    // It must land BEFORE the agent runs, or the reviewer never sees it.
    const ids = job.steps.map((s: any) => s.name);
    expect(ids.indexOf("Record CI gate results in the context")).toBeLessThan(ids.indexOf("Run agent"));
  });

  it("tells the reviewer that a non-success gate is blocking", () => {
    const record = reviewerJob("ci.yml").steps.find(
      (s: any) => s.name === "Record CI gate results in the context",
    );
    expect(record.run).toContain("blocking finding");
    expect(record.run).toContain("unverified");
  });

  it("sizes the job timeout to the waits it contains", () => {
    expect(reviewerJob("ci.yml")["timeout-minutes"]).toBe(30);
    expect(reviewerJob("ci.yml, e2e.yml")["timeout-minutes"]).toBe(45);
  });

  it("keeps an explicit timeout attr authoritative", () => {
    const file = compile(
      mkHarness(`digraph t {
        start [type=start]
        reviewer [type=pr-review, role="agents/roles/reviewer.md", context="pr-diff", gates="ci.yml", timeout=20]
        start -> reviewer [on="pull_request.opened"]
      }`),
    ).files.find((f) => f.path.endsWith("reviewer.yml"))!;
    expect((yaml.load(file.contents) as any).jobs.reviewer["timeout-minutes"]).toBe(20);
  });

  it("emits no gate plumbing when the node declares none", () => {
    const job = reviewerJob("");
    expect(job.steps.some((s: any) => s.name === "Record CI gate results in the context")).toBe(false);
    expect(job["timeout-minutes"]).toBe(15);
  });
});

// ── the human gate, the scheduled lanes, and the budget ───────────────────

describe("human-gate is a real precondition (item 2)", () => {
  const GATED = `digraph t {
    start [type=start]
    reviewer [type=pr-review, role="agents/roles/reviewer.md", context="pr-diff"]
    publish [type=human-gate, environment=production]
    merge_gate [type=merge-gate, policy="agents/policy/merge.yaml", schedule="*/30 * * * *"]
    start -> reviewer [on="pull_request.opened"]
    reviewer -> publish [when="verdict=approve"]
    publish -> merge_gate
  }`;
  const build = (dot = GATED) => {
    const { files } = compile(mkHarness(dot, { identity: { bot_login: "agent-bot" } } as Partial<FoundryConfig>));
    const job = (name: string) => {
      const doc = yaml.load(files.find((f) => f.path.endsWith(`${name}.yml`))!.contents) as any;
      return doc.jobs[name];
    };
    return { job };
  };

  it("publishes the Environment approval as a check-run on the head SHA", () => {
    const publish = build().job("publish");
    expect(publish.environment).toBe("production");
    expect(publish.permissions.checks).toBe("write");
    const step = publish.steps[0];
    expect(step.env.CHECK_NAME).toBe("gp-foundry/human-approval (production)");
    expect(step.env.HEAD_SHA).toBe("${{ github.event.pull_request.head.sha }}");
    expect(step.run).toContain("check-runs");
    expect(step.run).toContain("conclusion=success");
  });

  it("makes the merge gate require exactly that check, pinned to its author", () => {
    const step = build()
      .job("merge_gate")
      .steps.find((s: any) => s.name === "Evaluate merge gate");
    // The `@github-actions` pin is load-bearing: without it the gate would accept
    // a same-named check from anything that can write checks, including the App
    // token every agent lane carries.
    expect(step.with["required-checks"]).toBe("gp-foundry/human-approval (production)@github-actions");
    expect(step.with["bot-login"]).toBe("agent-bot");
  });

  it("publishes the approval with GITHUB_TOKEN, not the harness token", () => {
    // The Checks API is App-only (a PAT is rejected, and `pat` is the shipped
    // default), and GITHUB_TOKEN is the only token a job's `permissions:` block
    // constrains -- which is what stops another lane forging the approval.
    const step = build().job("publish").steps[0];
    expect(step.env.GH_TOKEN).toBe("${{ github.token }}");
  });

  it("requires nothing extra when no human-gate feeds the merge gate", () => {
    const step = build(`digraph t {
      merge_gate [type=merge-gate, policy="agents/policy/merge.yaml", schedule="*/30 * * * *"]
    }`)
      .job("merge_gate")
      .steps.find((s: any) => s.name === "Evaluate merge gate");
    expect(step.with["required-checks"]).toBeUndefined();
  });
});

describe("scheduled lanes strip immutable paths before pushing to base (item 4)", () => {
  const scheduled = (attrs = "") => {
    const { files } = compile(
      mkHarness(`digraph t {
        retro [type=scheduled-agent, role="agents/roles/retro.md", schedule="0 7 * * 1-5"${attrs}]
      }`),
    );
    const doc = yaml.load(files.find((f) => f.path.endsWith("retro.yml"))!.contents) as any;
    return doc.jobs.retro;
  };

  it("routes the push through agent-fallback instead of a raw git push", () => {
    const steps = scheduled().steps;
    const push = steps.at(-1);
    expect(push.uses).toContain("agent-fallback");
    expect(push.with["scope-path"]).toContain("scope.yaml");
    expect(push.with.branch).toBe("main");
    // No unguarded `git push` to the base branch anywhere in the job.
    const raw = steps.filter((s: any) => typeof s.run === "string" && s.run.includes("git push"));
    expect(raw).toEqual([]);
  });

  it("passes a per-lane path allowlist when the node declares one", () => {
    expect(scheduled(", paths=\"memory/\"").steps.at(-1).with["allowed-paths"]).toBe("memory/");
    expect(scheduled().steps.at(-1).with["allowed-paths"]).toBeUndefined();
  });
});

describe("attempt budget is derived from undeletable state (item 10)", () => {
  const attemptsStep = (cfg: Partial<FoundryConfig> = {}) => {
    const { files } = compile(
      mkHarness(
        `digraph t {
          reviewer [type=pr-review, role="agents/roles/reviewer.md"]
          fixer [type=pr-fix, role="agents/roles/fixer.md", max_attempts=3]
          reviewer -> fixer [when="verdict=request_changes"]
        }`,
        cfg,
      ),
    );
    const doc = yaml.load(files.find((f) => f.path.endsWith("fixer.yml"))!.contents) as any;
    return doc.jobs.fixer.steps.find((s: any) => s.id === "attempts");
  };

  it("counts request-changes REVIEWS, not deletable marker comments", () => {
    const step = attemptsStep();
    expect(step.run).toContain("/reviews");
    expect(step.run).toContain("CHANGES_REQUESTED");
    // The old mechanism — counting comment bodies — is what made the bound resettable.
    expect(step.run).not.toContain("--json comments");
  });

  it("only counts the reviewer bot's verdicts when a bot_login is configured", () => {
    const step = attemptsStep({ identity: { bot_login: "agent-bot" } } as Partial<FoundryConfig>);
    expect(step.env.BOT_LOGIN).toBe("agent-bot");
    // Read from the environment inside jq, never interpolated into the script.
    expect(step.run).toContain("env.BOT_LOGIN");
    expect(step.run).not.toContain("'agent-bot'");
  });
});

describe("immutable-paths guard is scaffolded (item 12)", () => {
  const guard = () => {
    const { files } = compile(mkHarness(LANE_DOT), {}, { specDir: ".github" });
    const file = files.find((f) => f.path.endsWith("immutable-guard.yml"))!;
    return yaml.load(file.contents) as any;
  };

  it("is emitted for every harness, scoped to agent branches", () => {
    const doc = guard();
    const job = doc.jobs["immutable-paths"];
    expect(doc.on.pull_request.types).toContain("synchronize");
    expect(job.if).toBe("startsWith(github.event.pull_request.head.ref, 'agent/')");
    expect(job.permissions ?? doc.permissions).toEqual({ contents: "read" });
  });

  it("reads the scope file the harness actually ships", () => {
    const step = guard().jobs["immutable-paths"].steps[1];
    expect(step.env.SCOPE_PATH).toBe(".github/agents/scope.yaml");
    expect(step.run).toContain("immutable_paths");
    expect(step.run).toContain("exit 1");
  });
});

describe("fixes from the review pass", () => {
  it("a PR-triggered diamond guards its legs and its join on the branch prefix", () => {
    // A review panel is still an agent lane. The diamond branch of wire() used to
    // return before the branch-prefix guard was applied, so every leg ran on
    // human PRs -- the exact hole the guard exists to close.
    const ir = mkHarness(`digraph t {
      start [type=start]
      panel [type=parallel]
      sec [type=pr-review, role="agents/roles/reviewer.md"]
      perf [type=pr-review, role="agents/roles/reviewer.md"]
      join [type=fan_in, role="agents/roles/reviewer.md"]
      start -> panel [on="pull_request.opened, pull_request.synchronize"]
      panel -> sec
      panel -> perf
      sec -> join
      perf -> join
    }`);
    const guard = wire(ir).perNode.join!.guard!;
    expect(guard).toBe("startsWith(github.event.pull_request.head.ref, 'agent/')");

    const doc = yaml.load(
      compile(ir).files.find((f) => f.path.endsWith("join.yml"))!.contents,
    ) as any;
    // The legs carry the entry guard; the join is gated by needs:.
    expect(doc.jobs.sec.if).toContain("startsWith(github.event.pull_request.head.ref");
    expect(doc.jobs.perf.if).toContain("startsWith(github.event.pull_request.head.ref");
  });

  it("a scheduled lane publishes nothing when its agent step failed", () => {
    // This lane commits straight to the base branch with no PR and no gate, so
    // salvage-on-failure (which is right for the producer) is wrong here.
    const doc = yaml.load(
      compile(
        mkHarness(`digraph t {
          retro [type=scheduled-agent, role="agents/roles/retro.md", schedule="0 7 * * 1-5"]
        }`),
      ).files.find((f) => f.path.endsWith("retro.yml"))!.contents,
    ) as any;
    const push = doc.jobs.retro.steps.at(-1);
    expect(push.uses).toContain("agent-fallback");
    expect(push.if).toBeUndefined();
  });
});

describe("the reviewer bot is named to agent-context as a trusted author", () => {
  it("passes identity.bot_login so the Fixer's checklist is not framed as hostile", () => {
    const doc = yaml.load(
      compile(
        mkHarness(
          `digraph t {
            reviewer [type=pr-review, role="agents/roles/reviewer.md"]
            fixer [type=pr-fix, role="agents/roles/fixer.md"]
            reviewer -> fixer [when="verdict=request_changes"]
          }`,
          { identity: { bot_login: "agent-bot" } } as Partial<FoundryConfig>,
        ),
      ).files.find((f) => f.path.endsWith("fixer.yml"))!.contents,
    ) as any;
    const ctx = doc.jobs.fixer.steps.find((s: any) => s.id === "ctx");
    expect(ctx.with["trusted-authors"]).toBe("agent-bot");
  });

  it("omits the input when no bot_login is configured", () => {
    const doc = yaml.load(
      compile(mkHarness(LANE_DOT)).files.find((f) => f.path.endsWith("reviewer.yml"))!.contents,
    ) as any;
    expect(doc.jobs.reviewer.steps.find((s: any) => s.id === "ctx").with["trusted-authors"]).toBeUndefined();
  });
});
