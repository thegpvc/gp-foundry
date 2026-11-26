import { describe, expect, it } from "vitest";
import { classifyCondition, parseApprovals, translateApprovals } from "./approvals.js";
import { resolveReviewMd } from "./review-md.js";
import { globMatch } from "../../actions/merge-gate/src/gate.js";

// The starter policy from the Claude Ship docs (approvals-policy).
const STARTER = `
version: 1
mode: observe
rules:
  - purpose: "A change takes two people. When Claude's review passes, one is enough and Claude approves."
    paths: ["**"]
    verdict: { claude: comments, seats: 2 }
    override:
      - { if: "claude/code_review = pass", verdict: { claude: approves, seats: 1 } }
  - purpose: "A change to the review rules takes two people."
    paths: ["**/.claude/**"]
    nested: inherit
    verdict: { claude: comments, seats: 2 }
`;

const translate = (text: string) => translateApprovals(parseApprovals(text));
const levels = (t: ReturnType<typeof translate>, level: string) => t.notes.filter((n) => n.level === level).map((n) => n.message);

describe("parseApprovals", () => {
  it("reads the docs' starter policy", () => {
    const p = parseApprovals(STARTER);
    expect(p.mode).toBe("observe");
    expect(p.rules).toHaveLength(2);
    expect(p.rules[0]!.verdict).toEqual({ claude: "comments", seats: [{ count: 2, from: ["humans"] }] });
    expect(p.rules[0]!.override[0]!.verdict?.claude).toBe("approves");
    expect(p.rules[1]!.untranslated).toEqual(["nested"]);
  });

  it("refuses what Ship refuses: unknown keys, a wrong version, seats beside blocks, paths that only exclude", () => {
    expect(() => parseApprovals("version: 1\nrules: []\nextra: 1\n")).toThrow(/unknown key 'extra'/);
    expect(() => parseApprovals("version: 2\nrules: []\n")).toThrow(/version must be 1/);
    expect(() => parseApprovals(`version: 1\nrules:\n  - { purpose: "x", paths: ["**"], verdict: { claude: blocks, seats: 1 } }\n`)).toThrow(/beside claude: blocks/);
    expect(() => parseApprovals(`version: 1\nrules:\n  - { purpose: "x", paths: ["!docs/**"], verdict: { claude: comments } }\n`)).toThrow(/not an exclusion/);
  });

  it("resolves locals: use copies rule keys, \"@name\" stands for a value", () => {
    const p = parseApprovals(`
version: 1
locals:
  payments_owner: { count: 1, from: [acme/payments, "!pr/authors"] }
  strict:
    verdict: { claude: comments, seats: [{ count: 2, from: humans }, "@payments_owner"] }
rules:
  - purpose: "The payments API takes two people, one of them a payments owner."
    paths: ["services/payments/api/**"]
    use: ["@strict"]
`);
    expect(p.rules[0]!.verdict?.seats).toEqual([
      { count: 2, from: ["humans"] },
      { count: 1, from: ["acme/payments", "!pr/authors"] },
    ]);
    expect(() => parseApprovals(`version: 1\nrules:\n  - { purpose: "x", paths: ["**"], use: ["@missing"] }\n`)).toThrow(/no local named 'missing'/);
  });
});

describe("classifyCondition", () => {
  it("knows the three conditions gp-foundry can answer, and nothing else", () => {
    expect(classifyCondition("claude/code_review = pass")).toEqual({ kind: "review-passes" });
    expect(classifyCondition("claude/code_review(level=deep) = pass")).toEqual({ kind: "review-passes" });
    expect(classifyCondition("pr/diff_lines > 400")).toEqual({ kind: "larger-than", lines: 400 });
    expect(classifyCondition("pr/diff_lines >= 400")).toEqual({ kind: "larger-than", lines: 399 });
    expect(classifyCondition("ALL pr/authors = bot:dependabot")).toEqual({ kind: "bot-authored", bot: "dependabot[bot]" });
    expect(classifyCondition("repo/change_risk <= medium").kind).toBe("other");
    expect(classifyCondition("claude/code_review = pass AND pr/files_changed > 50").kind).toBe("other");
  });
});

describe("translateApprovals", () => {
  it("the starter policy: every change needs a person, and the losses are named", () => {
    const t = translate(STARTER);
    expect(t.policy).toEqual({ protected_paths: ["**", "**/.claude/**"], handoff_clauses: ["protected-path"] });
    expect(levels(t, "lossy").join("\n")).toContain("mode: observe has no switch");
    expect(levels(t, "lossy").join("\n")).toContain("without a passing review Ship falls back to 2 people");
    expect(levels(t, "lossy").join("\n")).toContain("2 people: gp-foundry's sign-off is one person");
    expect(levels(t, "unsupported").join("\n")).toContain("nested: subdirectory policy files");
  });

  it("the patterns it emits are ones the gate's matcher reads the same way", () => {
    expect(globMatch("**", "src/a/b.ts")).toBe(true);
    expect(globMatch("**", ".github/workflows/ci.yml")).toBe(true);
    expect(globMatch("**/.claude/**", ".claude/approvals.yml")).toBe(true);
    expect(globMatch("**/.claude/**", "services/billing/.claude/approvals.yml")).toBe(true);
    expect(globMatch("services/payments/**", "services/payments/api/x.go")).toBe(true);
    expect(globMatch("services/payments/**", "services/other/x.go")).toBe(false);
  });

  it("Claude may approve alone: nothing to set, the approver's verdict already decides", () => {
    const t = translate(`version: 1\nrules:\n  - { purpose: "Claude approves.", paths: ["**"], verdict: { claude: approves, seats: 0 } }\n`);
    expect(t.policy).toEqual({});
    expect(t.notes.map((n) => n.level)).toEqual(["mapped"]);
  });

  it("a path that needs an owner becomes a protected path, with what cannot carry over", () => {
    const t = translate(`
version: 1
rules:
  - purpose: "Claude approves ordinary changes."
    paths: ["**", "!docs/**"]
    verdict: { claude: approves, seats: 0 }
  - purpose: "Payments takes a payments owner."
    paths: ["services/payments/**", "!services/payments/**/*.md"]
    verdict: { claude: comments, seats: [{ count: 1, from: [acme/payments, "!pr/authors"] }] }
`);
    expect(t.policy).toEqual({
      protected_paths: ["services/payments/**"],
      protected_path_exclude_globs: ["services/payments/**/*.md"],
      handoff_clauses: ["protected-path"],
    });
    expect(levels(t, "lossy").join("\n")).toContain("seats from acme/payments");
  });

  it("size and bot conditions map to max_additions and rollout.bot_authors", () => {
    const t = translate(`
version: 1
rules:
  - purpose: "Claude approves, but a large change takes a person."
    paths: ["**"]
    verdict: { claude: approves, seats: 0 }
    override:
      - { if: "pr/diff_lines > 800", verdict: { claude: comments, seats: 1 } }
  - purpose: "Dependabot's updates need nobody."
    paths: ["**"]
    if: "ALL pr/authors = bot:dependabot"
    verdict: { claude: approves, seats: 0 }
`);
    expect(t.policy).toEqual({ handoff_clauses: ["too-large"], max_additions: 800 });
    expect(t.config).toEqual({ rollout: { bot_authors: ["dependabot[bot]"] } });
  });

  it("blocks becomes immutable_paths; a condition it cannot read drops the rule and says so", () => {
    const t = translate(`
version: 1
rules:
  - purpose: "Nobody edits vendored code through a PR."
    paths: ["vendor/**"]
    verdict: { claude: blocks }
  - purpose: "Risky changes take two."
    paths: ["**"]
    if: "repo/change_risk >= high"
    verdict: { claude: comments, seats: 2 }
    advisory: [repo/change_risk]
`);
    expect(t.immutablePaths).toEqual(["vendor/**"]);
    expect(t.policy).toEqual({});
    expect(levels(t, "unsupported").join("\n")).toContain('if "repo/change_risk >= high"');
    expect(levels(t, "unsupported").join("\n")).toContain("advisory repo/change_risk");
  });
});

describe("resolveReviewMd", () => {
  const files = (map: Record<string, string>) => (p: string) => map[p];

  it("is empty without a REVIEW.md", () => {
    expect(resolveReviewMd(files({}))).toEqual({ text: "", sources: [], warnings: [] });
  });

  it("expands @ lines for root files and skills, dropping a skill's frontmatter", () => {
    const r = resolveReviewMd(
      files({
        "REVIEW.md": "# Review instructions\n\nReport at most five Nits per review.\n\n@review-security.md\n@.claude/skills/api-review/SKILL.md\n\nTreat any change under `migrations/` as Important.",
        "review-security.md": "Check every query is tenant-scoped.\n",
        ".claude/skills/api-review/SKILL.md": "---\nname: api-review\n---\nNew routes need an integration test.\n",
      }),
    );
    expect(r.sources).toEqual(["REVIEW.md", "review-security.md", ".claude/skills/api-review/SKILL.md"]);
    expect(r.text).toContain("Check every query is tenant-scoped.");
    expect(r.text).toContain("New routes need an integration test.");
    expect(r.text).not.toContain("name: api-review");
    expect(r.text).not.toContain("@review-security.md");
    expect(r.warnings).toEqual([]);
  });

  it("keeps Code Review's limits: nested paths, missing files, 8 includes, 64 links, 150,000 bytes", () => {
    expect(resolveReviewMd(files({ "REVIEW.md": "@docs/rules.md\n@gone.md" })).warnings).toEqual([
      "@docs/rules.md: an included file must sit beside REVIEW.md at the root",
      "@gone.md: no such file",
    ]);
    const many = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`r${i}.md`, `rule ${i}`]));
    const nine = resolveReviewMd(files({ "REVIEW.md": Object.keys(many).map((f) => `@${f}`).join("\n"), ...many }));
    expect(nine.sources).toHaveLength(9); // REVIEW.md + 8
    expect(nine.warnings).toEqual(["@r8.md: over the limit of 8 included files"]);
    const links = Array.from({ length: 65 }, (_, i) => `[d${i}](docs/${i}.md)`).join(" ");
    expect(resolveReviewMd(files({ "REVIEW.md": links })).text).toBe("");
    expect(resolveReviewMd(files({ "REVIEW.md": links.replace(/docs\//g, "https://x.test/") })).text).not.toBe("");
    expect(resolveReviewMd(files({ "REVIEW.md": "@big.md", "big.md": "x".repeat(150_001) })).text).toBe("");
  });
});
