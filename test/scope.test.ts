/**
 * The scope rule (which PRs the pipeline looks at) and the agent-written test
 * (which of them a writing lane may act on). One implementation, shared by the
 * guard, the sweep and the gate — see src/shared/scope.ts.
 */
import { describe, it, expect } from "vitest";
import { inScope, isAgentWritten, parseRollout, type Rollout, type ScopePr } from "../src/shared/scope.js";
import { parseDot } from "../src/parser/parse.js";
import { loadConfig } from "../src/config/load.js";
import { validate } from "../src/validate/validate.js";
import type { FoundryConfig, Harness } from "../src/ir/types.js";

const BOT = "agent-bot[bot]";
const human = (login: string, over: Partial<ScopePr> = {}): ScopePr => ({ authorLogin: login, authorType: "User", draft: false, labels: [], ...over });
const bot = (login: string, over: Partial<ScopePr> = {}): ScopePr => ({ authorLogin: login, authorType: "Bot", draft: false, labels: [], ...over });

describe("parseRollout", () => {
  it("no block means no dial", () => {
    expect(parseRollout(undefined)).toBeUndefined();
    expect(parseRollout(null)).toBeUndefined();
  });

  it("lower-cases and de-duplicates authors, and resolves labels through config.labels", () => {
    expect(
      parseRollout(
        { authors: ["Alice", "alice", "dependabot[bot]"], opt_in_label: "agent_review", skip_label: "no-agent-review" },
        { agent_review: "bot:review" },
      ),
    ).toEqual({ authors: ["alice", "dependabot[bot]"], optInLabel: "bot:review", skipLabel: "no-agent-review" });
  });

  it("keeps an empty author list distinct from no list", () => {
    expect(parseRollout({ authors: [], opt_in_label: "x" })).toEqual({ authors: [], optInLabel: "x" });
    expect(parseRollout({})).toEqual({});
  });

  it.each([
    ["a list instead of a mapping", ["alice"]],
    ["authors that is not a list", { authors: "alice" }],
    ["something that is not a login", { authors: ["alice", "not a login"] }],
    ["a login carrying an expression", { authors: ["a' || true || '"] }],
    ["an empty label", { opt_in_label: "  " }],
    ["a multi-line label", { skip_label: "a\nb" }],
    ["an unknown key", { author: ["alice"] }],
    ["one label used for both", { opt_in_label: "x", skip_label: "x" }],
  ])("rejects %s", (_name, raw) => {
    expect(() => parseRollout(raw)).toThrow();
  });

  it("is reported by validate as a build error", () => {
    const g = parseDot(`digraph t { start [type=start] }`);
    const config = { ...loadConfig(undefined), rollout: { author: ["alice"] } } as unknown as FoundryConfig;
    const ir: Harness = { name: g.name, nodes: g.nodes, edges: g.edges, config, sourcePath: "t.dot" };
    const d = validate(ir).find((x) => x.code === "config.bad-rollout");
    expect(d?.level).toBe("error");
    expect(d?.message).toContain("unknown key 'author'");
    const ok = { ...ir, config: { ...config, rollout: { authors: ["alice"] } } as FoundryConfig };
    expect(validate(ok).some((x) => x.code === "config.bad-rollout")).toBe(false);
  });
});

describe("inScope: which PRs the pipeline looks at", () => {
  const rollout: Rollout = { authors: ["alice", "renovate[bot]"], optInLabel: "agent-review", skipLabel: "no-agent-review" };
  /** `null` = no rollout block at all (an explicit `undefined` would pick up the default). */
  const decide = (pr: ScopePr, r: Rollout | null = rollout) => inScope(pr, r ?? undefined, BOT);

  it("with no rollout block, every human PR is in scope", () => {
    expect(decide(human("anyone"), null)).toMatchObject({ inScope: true, reason: "no-rollout" });
  });

  it("a listed author is in, whatever the case of the login", () => {
    expect(decide(human("Alice"))).toMatchObject({ inScope: true, reason: "author" });
    expect(decide(human("bob"))).toMatchObject({ inScope: false, reason: "not-in-rollout" });
  });

  it("the opt-in label admits anyone", () => {
    expect(decide(human("bob", { labels: ["bug", "agent-review"] }))).toMatchObject({ inScope: true, reason: "opt-in-label" });
  });

  it("an empty author list admits nobody by name, but the label still works", () => {
    const r: Rollout = { authors: [], optInLabel: "agent-review" };
    expect(decide(human("alice"), r).inScope).toBe(false);
    expect(decide(human("alice", { labels: ["agent-review"] }), r).inScope).toBe(true);
  });

  it("a block with only a skip label means everyone else: the end of a rollout", () => {
    // Nothing left to admit by, only the off switch. It must not read as "nobody".
    const r: Rollout = { skipLabel: "no-agent-review" };
    expect(decide(human("bob"), r)).toMatchObject({ inScope: true, reason: "no-rollout" });
    expect(decide(human("bob", { labels: ["no-agent-review"] }), r)).toMatchObject({ inScope: false, reason: "skip-label" });
    expect(decide(human("bob"), {})).toMatchObject({ inScope: true, reason: "no-rollout" });
  });

  describe("drafts", () => {
    it("are never in scope — listed author, opt-in label, the pipeline's own, or no dial at all", () => {
      expect(decide(human("alice", { draft: true })).reason).toBe("draft");
      expect(decide(human("bob", { draft: true, labels: ["agent-review"] })).reason).toBe("draft");
      expect(decide(bot(BOT, { draft: true })).reason).toBe("draft");
      expect(decide(human("anyone", { draft: true }), null).reason).toBe("draft");
    });
  });

  describe("the skip label", () => {
    it("outranks everything a person might otherwise be in scope for", () => {
      expect(decide(human("alice", { labels: ["no-agent-review"] })).reason).toBe("skip-label");
      expect(decide(human("bob", { labels: ["agent-review", "no-agent-review"] })).reason).toBe("skip-label");
    });

    it("is the off switch for the pipeline's own PRs too", () => {
      expect(decide(bot(BOT, { labels: ["no-agent-review"] }))).toMatchObject({ inScope: false, reason: "skip-label" });
    });
  });

  describe("PRs the pipeline opened", () => {
    it("are always in scope, whatever the dial says", () => {
      expect(decide(bot(BOT))).toMatchObject({ inScope: true, reason: "harness-bot" });
      expect(decide(bot(BOT), { authors: [] }).inScope).toBe(true);
      expect(decide(bot(BOT), null).inScope).toBe(true);
      // The bot posting under a PAT is an ordinary user account.
      expect(inScope(human("agent-user"), { authors: [] }, "Agent-User").inScope).toBe(true);
    });
  });

  describe("other bots", () => {
    it("are out unless named in authors — even with no dial at all", () => {
      expect(decide(bot("dependabot[bot]"))).toMatchObject({ inScope: false, reason: "other-bot" });
      expect(decide(bot("dependabot[bot]"), null).inScope).toBe(false);
      expect(decide(bot("renovate[bot]"))).toMatchObject({ inScope: true, reason: "author" });
    });

    it("are recognized by type or by the [bot] suffix", () => {
      expect(decide({ authorLogin: "some-app[bot]", authorType: "User", labels: [] }).reason).toBe("other-bot");
      expect(decide({ authorLogin: "machine-account", authorType: "Bot", labels: [] }).reason).toBe("other-bot");
    });

    it("the opt-in label does not admit a bot that is not named", () => {
      expect(decide(bot("dependabot[bot]", { labels: ["agent-review"] })).inScope).toBe(false);
    });
  });

  it("every decision explains itself in one line", () => {
    for (const pr of [human("alice"), human("bob"), bot("dependabot[bot]"), bot(BOT), human("x", { draft: true })]) {
      const d = decide(pr);
      expect(d.detail.length).toBeGreaterThan(10);
      expect(d.detail).not.toContain("\n");
    }
  });
});

describe("isAgentWritten: may a writing lane act on this PR", () => {
  const byBot = { authorLogin: BOT };
  const commit = (authorLogin: string | null) => ({ authorLogin });

  it("yes when the bot opened it and wrote every commit", () => {
    expect(isAgentWritten(byBot, [commit(BOT), commit("Agent-Bot[bot]")], BOT).agentWritten).toBe(true);
  });

  it("no when a person opened it, even if the bot wrote the commits", () => {
    const r = isAgentWritten({ authorLogin: "alice" }, [commit(BOT)], BOT);
    expect(r.agentWritten).toBe(false);
    expect(r.detail).toContain("alice");
  });

  it("no as soon as one commit is someone else's", () => {
    const r = isAgentWritten(byBot, [commit(BOT), commit("alice"), commit(BOT)], BOT);
    expect(r.agentWritten).toBe(false);
    expect(r.detail).toContain("alice");
  });

  it("no for a commit GitHub cannot attribute to any account", () => {
    expect(isAgentWritten(byBot, [commit(BOT), commit(null)], BOT).agentWritten).toBe(false);
  });

  it("fails closed when it cannot know", () => {
    expect(isAgentWritten(byBot, undefined, BOT).agentWritten).toBe(false);
    expect(isAgentWritten(byBot, [], BOT).agentWritten).toBe(false);
    expect(isAgentWritten(byBot, [commit(BOT)], undefined).agentWritten).toBe(false);
    expect(isAgentWritten(byBot, [commit(BOT)], "").agentWritten).toBe(false);
  });
});
