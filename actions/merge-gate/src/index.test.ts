// The action wrapper, run end to end against a stub Octokit: evaluate mode
// publishes, updates or leaves alone one check run per head, and never merges.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const inputs: Record<string, string> = {};
const outputs: Record<string, string> = {};
const failures: string[] = [];
vi.mock("@actions/core", () => ({
  getInput: (name: string) => inputs[name] ?? "",
  setOutput: (name: string, value: string) => {
    outputs[name] = value;
  },
  setFailed: (msg: string) => {
    failures.push(msg);
  },
  info: () => {},
  debug: () => {},
  warning: () => {},
}));

let stub: ReturnType<typeof makeOctokit>;
vi.mock("@actions/github", () => ({
  getOctokit: () => stub,
  context: { repo: { owner: "o", repo: "r" } },
}));

const { run } = await import("./index.js");

const HEAD = "a".repeat(40);
const BOT = "fletch-bot[bot]";
const CHECK = "fletch/approval";

interface World {
  approved: boolean;
  /** When set, the PR's reviews verbatim (overrides `approved`). */
  reviews?: unknown[];
  verdictBody?: string;
  threads: unknown[];
  existing: { id: number; name: string; status: string; conclusion: string; app: { slug: string }; output: { summary: string; text: string } }[];
}

function makeOctokit(world: World) {
  const calls: { method: string; params: any }[] = [];
  const rec = (method: string, data: unknown) => async (params: any) => {
    calls.push({ method, params });
    return { data };
  };
  const pr = {
    number: 7,
    title: "Add widget",
    draft: false,
    head: { sha: HEAD, ref: "agent/widget" },
    base: { ref: "main" },
    user: { login: BOT, type: "Bot" },
    labels: [],
    mergeable: true,
    mergeable_state: "clean",
    requested_reviewers: [],
    requested_teams: [],
  };
  const octokit = {
    calls,
    paginate: async (fn: (p: any) => Promise<{ data: unknown }>, params: any) => {
      const { data } = await fn(params);
      return data;
    },
    graphql: async () => ({
      repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: world.threads } } },
    }),
    rest: {
      pulls: {
        list: rec("pulls.list", [pr]),
        get: rec("pulls.get", pr),
        listReviews: rec(
          "pulls.listReviews",
          world.reviews ??
            (world.approved
              ? [{ submitted_at: "2026-01-01T00:00:00Z", state: "COMMENTED", commit_id: HEAD, user: { login: BOT }, author_association: "NONE", body: world.verdictBody ?? "Looks right.\n\n**Verdict:** APPROVE\n" }]
              : []),
        ),
        listFiles: rec("pulls.listFiles", [{ filename: "src/w.ts", additions: 10, deletions: 0 }]),
        merge: rec("pulls.merge", {}),
      },
      issues: {
        listComments: rec("issues.listComments", []),
        addLabels: rec("issues.addLabels", {}),
        removeLabel: rec("issues.removeLabel", {}),
        createComment: rec("issues.createComment", {}),
      },
      repos: { getCommit: rec("repos.getCommit", { commit: { committer: { date: "2025-12-31T00:00:00Z" } } }) },
      git: { deleteRef: rec("git.deleteRef", {}) },
      checks: {
        listForRef: async (params: any) => {
          calls.push({ method: "checks.listForRef", params });
          const ci = { id: 1, name: "ci", status: "completed", conclusion: "success", app: { slug: "github-actions" } };
          const named = params.check_name ? world.existing.filter((c) => c.name === params.check_name) : [ci, ...world.existing];
          return { data: named };
        },
        create: rec("checks.create", {}),
        update: rec("checks.update", {}),
      },
    },
  };
  return octokit;
}

const methods = () => stub.calls.map((c) => c.method);
const writes = () => stub.calls.filter((c) => /merge|addLabels|removeLabel|createComment|deleteRef|checks\.(create|update)/.test(c.method));

function setup(world: Partial<World>, policyYaml = "") {
  const dir = mkdtempSync(join(tmpdir(), "merge-gate-"));
  const policyPath = join(dir, "merge.yaml");
  writeFileSync(
    policyPath,
    `branch_prefix: "agent/"\nrequire_no_open_threads: true\n${policyYaml}`,
  );
  for (const k of Object.keys(inputs)) delete inputs[k];
  for (const k of Object.keys(outputs)) delete outputs[k];
  failures.length = 0;
  Object.assign(inputs, { token: "t", "checks-token": "t", "policy-path": policyPath, "bot-login": BOT, mode: "evaluate", "check-name": CHECK });
  stub = makeOctokit({ approved: true, threads: [], existing: [], ...world });
}

const openThread = {
  isResolved: false,
  path: "src/w.ts",
  line: 4,
  originalLine: 4,
  firstComment: { nodes: [{ reactions: { nodes: [] } }] },
  comments: { nodes: [{ author: { login: "alice" }, body: "This leaks." }] },
};

describe("merge-gate evaluate mode", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a success check on an approved, green head — and does not merge it", async () => {
    setup({});
    await run();
    expect(failures).toEqual([]);
    const create = stub.calls.find((c) => c.method === "checks.create");
    expect(create?.params).toMatchObject({ name: CHECK, head_sha: HEAD, status: "completed", conclusion: "success" });
    expect(methods()).not.toContain("pulls.merge");
    expect(writes().map((c) => c.method)).toEqual(["checks.create"]);
    expect(outputs).toMatchObject({ evaluated: "1", "checks-written": "1", merged: "false" });
  });

  it("updates its existing check in place when the result changed", async () => {
    setup({
      threads: [openThread],
      existing: [{ id: 99, name: CHECK, status: "completed", conclusion: "success", app: { slug: "github-actions" }, output: { summary: "old", text: "" } }],
    });
    await run();
    const update = stub.calls.find((c) => c.method === "checks.update");
    expect(update?.params).toMatchObject({ check_run_id: 99, conclusion: "failure" });
    expect(update?.params.output.summary).toContain("open-threads");
    expect(update?.params.output.text).toContain("src/w.ts:4");
    expect(writes().map((c) => c.method)).toEqual(["checks.update"]);
  });

  it("leaves its own failing check out of the CI rollup, so it can flip to success", async () => {
    setup({
      existing: [{ id: 99, name: CHECK, status: "completed", conclusion: "failure", app: { slug: "github-actions" }, output: { summary: "`open-threads` — 1 open review thread awaiting the author", text: "" } }],
    });
    await run();
    expect(stub.calls.find((c) => c.method === "checks.update")?.params).toMatchObject({ check_run_id: 99, conclusion: "success" });
  });

  it("writes nothing when the existing check already says the same", async () => {
    setup({});
    await run();
    const created = stub.calls.find((c) => c.method === "checks.create")!.params;
    const existing = [{ id: 5, name: CHECK, status: "completed", conclusion: created.conclusion, app: { slug: "github-actions" }, output: { summary: created.output.summary, text: created.output.text } }];
    setup({ existing });
    await run();
    expect(writes()).toEqual([]);
    expect(outputs["checks-written"]).toBe("0");
  });

  it("does not adopt a same-named check written by another app", async () => {
    setup({ existing: [{ id: 5, name: CHECK, status: "completed", conclusion: "success", app: { slug: "impostor" }, output: { summary: "", text: "" } }] });
    await run();
    expect(writes().map((c) => c.method)).toEqual(["checks.create"]);
  });

  it("never merges or labels, even with labels configured and nothing approved", async () => {
    setup({ approved: false }, "labels:\n  awaiting_approval: awaiting-approval\n");
    await run();
    expect(writes().map((c) => c.method)).toEqual(["checks.create"]);
    expect(stub.calls.find((c) => c.method === "checks.create")?.params.conclusion).toBe("failure");
  });

  it("approves only on an exact verdict line, in the configured words", async () => {
    setup({ verdictBody: "Looks right.\n\n**Verdict:** APPROVE (once gates pass)" });
    await run();
    expect(stub.calls.find((c) => c.method === "checks.create")?.params.output.summary).toContain("not-approved");

    setup({ verdictBody: "Looks right.\n\n**Verdict:** SHIP" });
    inputs.verdicts = "SHIP,FIX,HUMAN";
    await run();
    expect(stub.calls.find((c) => c.method === "checks.create")?.params.conclusion).toBe("success");

    setup({ verdictBody: "Needs a person.\n\n**Verdict:** HUMAN" });
    inputs.verdicts = "SHIP,FIX,HUMAN";
    await run();
    expect(stub.calls.find((c) => c.method === "checks.create")?.params.conclusion).toBe("action_required");
  });

  it("no_verdict_conclusion: neutral publishes neutral for a head only awaiting the approver", async () => {
    setup({ approved: false }, "no_verdict_conclusion: neutral\n");
    await run();
    const create = stub.calls.find((c) => c.method === "checks.create")?.params;
    expect(create).toMatchObject({ conclusion: "neutral", output: { title: "Awaiting the approver" } });
    expect(create.output.summary).toContain("awaiting the approver");
    // An open thread is a second failing clause: a real failure, not a wait.
    setup({ approved: false, threads: [openThread] }, "no_verdict_conclusion: neutral\n");
    await run();
    expect(stub.calls.find((c) => c.method === "checks.create")?.params.conclusion).toBe("failure");
    // A bad value fails the run rather than silently meaning failure.
    setup({ approved: false }, "no_verdict_conclusion: grey\n");
    await run();
    expect(failures.join("")).toContain("no_verdict_conclusion");
  });

  it("merge mode is unchanged: the same head is merged", async () => {
    setup({});
    inputs.mode = "";
    await run();
    expect(methods()).toContain("pulls.merge");
    expect(methods()).not.toContain("checks.create");
  });
});

// The harness appends machine markers AFTER the verdict line: the unchanged-diff
// stamp, and the also-head marker a guard adds when it skips a head. A marker
// regex anchored with `$` must still see the verdict — above all a rejection,
// where not seeing it means an earlier approval stands and the PR merges.
describe("verdict markers are read from the visible body", () => {
  const STAMP = `<!-- gp-foundry:diff:reviewer:${"f".repeat(64)} -->`;
  const ALSO = `<!-- gp-foundry:also-head:reviewer:${"b".repeat(40)} -->`;
  const review = (at: string, body: string) => ({
    submitted_at: at,
    state: "COMMENTED",
    commit_id: HEAD,
    user: { login: BOT },
    author_association: "NONE",
    body,
  });
  const approve = (at: string, tail = "") => review(at, `Looks right.\n\n**Verdict:** APPROVE${tail}`);
  const reject = (at: string, tail = "") => review(at, `Needs work.\n\n**Verdict:** REQUEST_CHANGES${tail}`);
  const mergeMode = (reviews: unknown[], policyYaml = "") => {
    setup({ reviews }, policyYaml);
    inputs.mode = "";
  };

  it("a stamped approval still approves under an anchored regex", async () => {
    mergeMode([approve("2026-01-01T00:00:00Z", `\n\n${STAMP}\n${ALSO}\n`)]);
    await run();
    expect(methods()).toContain("pulls.merge");
  });

  it("a stamped rejection after an approval blocks the merge (default rejection regex)", async () => {
    mergeMode([approve("2026-01-01T00:00:00Z"), reject("2026-01-02T00:00:00Z", `\n\n${STAMP}`)]);
    await run();
    expect(methods()).not.toContain("pulls.merge");
  });

  it("…and with the also-head marker a guard appends later", async () => {
    mergeMode([approve("2026-01-01T00:00:00Z"), reject("2026-01-02T00:00:00Z", `\n\n${STAMP}\n${ALSO}`)]);
    await run();
    expect(methods()).not.toContain("pulls.merge");
  });

  it("…and under the anchored rejection regex the policy template ships", async () => {
    mergeMode(
      [approve("2026-01-01T00:00:00Z"), reject("2026-01-02T00:00:00Z", `\n\n${STAMP}`)],
      `rejection_body_regex: '\\*\\*Verdict:\\*\\* REQUEST_CHANGES$'\n`,
    );
    await run();
    expect(methods()).not.toContain("pulls.merge");
  });

  it("a verdict hidden inside an HTML comment is not a verdict", async () => {
    mergeMode([review("2026-01-01T00:00:00Z", "Just notes.\n\n<!-- **Verdict:** APPROVE -->")]);
    await run();
    expect(methods()).not.toContain("pulls.merge");
  });

  it("evaluate mode reads an escalation through the markers too", async () => {
    setup({ reviews: [review("2026-01-01T00:00:00Z", `Unsure.\n\n**Verdict:** ESCALATE\n\n${STAMP}`)] });
    await run();
    expect(stub.calls.find((c) => c.method === "checks.create")?.params.conclusion).toBe("action_required");
  });
});
