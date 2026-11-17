// The action wrapper, run end to end against a stub Octokit: evaluate mode
// publishes, updates or leaves alone one check run per head, and never merges.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { beforeEach, describe, expect, it, vi } from "vitest";

const inputs: Record<string, string> = {};
// The runner fills every input the workflow leaves out with its action.yml
// default, so the stub does too: an input the workflow never set must look the
// same here as it does on Actions. (0.3.0 shipped `mode` defaulting to "merge",
// which made every merge= gate fail with "not both"; a stub returning "" hid it.)
const actionYml = yaml.load(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../action.yml"), "utf8")) as {
  inputs: Record<string, { default?: string }>;
};
const actionDefaults: Record<string, string> = Object.fromEntries(
  Object.entries(actionYml.inputs).map(([k, v]) => [k, v.default ?? ""]),
);
const outputs: Record<string, string> = {};
const failures: string[] = [];
vi.mock("@actions/core", () => ({
  getInput: (name: string) => inputs[name] ?? actionDefaults[name] ?? "",
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
  /** Labels on the PR. */
  labels?: string[];
  /** Is the PR a draft? */
  draft?: boolean;
  /** The head branch (default: an agent branch). */
  headRef?: string;
  /** Who authored each commit on the head, as GitHub attributes it (default: all the bot's). */
  commits?: (string | null)[];
  /** Who opened the PR (default: the harness bot). */
  author?: { login: string; type: string };
  /** When set, the PR's reviews verbatim (overrides `approved`). */
  reviews?: unknown[];
  verdictBody?: string;
  threads: unknown[];
  /** The head's CI check runs (default: one green `ci`). */
  ci?: { id: number; name: string; status: string; conclusion: string | null; app: { slug: string } }[];
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
    draft: world.draft ?? false,
    head: { sha: HEAD, ref: world.headRef ?? "agent/widget" },
    base: { ref: "main" },
    user: world.author ?? { login: BOT, type: "Bot" },
    labels: (world.labels ?? []).map((name) => ({ name })),
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
        listCommits: rec("pulls.listCommits", (world.commits ?? [BOT]).map((login) => ({ author: login ? { login } : null }))),
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
          const ci = world.ci ?? [{ id: 1, name: "ci", status: "completed", conclusion: "success", app: { slug: "github-actions" } }];
          const named = params.check_name ? world.existing.filter((c) => c.name === params.check_name) : [...ci, ...world.existing];
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
    expect(create.output.summary).toContain("every other clause of the merge policy passes");
  });

  it("no_verdict_conclusion: neutral stays neutral with other clauses failing, and names each", async () => {
    const created = () => stub.calls.find((c) => c.method === "checks.create")?.params;
    // An open thread: neutral, with the thread count in the summary.
    setup({ approved: false, threads: [openThread] }, "no_verdict_conclusion: neutral\n");
    await run();
    expect(created()).toMatchObject({ conclusion: "neutral", output: { title: "Awaiting the approver" } });
    expect(created().output.summary).toContain("has not given a verdict on this head yet");
    expect(created().output.summary).toContain("`open-threads` — 1 unanswered review thread");
    expect(created().output.text).toContain("src/w.ts:4");

    // CI still running: neutral, with the running checks counted.
    const running = (id: number) => ({ id, name: `test-${id}`, status: "in_progress", conclusion: null, app: { slug: "github-actions" } });
    setup({ approved: false, ci: [running(1), running(2), running(3)] }, "no_verdict_conclusion: neutral\n");
    await run();
    expect(created().conclusion).toBe("neutral");
    expect(created().output.summary).toContain("`ci-not-passing` — CI: 3 check runs still running");
    const summary = created().output.summary;
    // Deterministic for an unchanged state: a second tick writes nothing.
    const existing = [{ id: 9, name: CHECK, status: "completed", conclusion: "neutral", app: { slug: "github-actions" }, output: { summary, text: created().output.text } }];
    setup({ approved: false, ci: [running(1), running(2), running(3)], existing }, "no_verdict_conclusion: neutral\n");
    await run();
    expect(writes()).toEqual([]);

    // A rejection on the head is a decision, not a wait.
    setup(
      { approved: false, reviews: [{ submitted_at: "2026-01-01T00:00:00Z", state: "COMMENTED", commit_id: HEAD, user: { login: BOT }, author_association: "NONE", body: "No.\n\n**Verdict:** REQUEST_CHANGES\n" }] },
      "no_verdict_conclusion: neutral\n",
    );
    await run();
    expect(created()).toMatchObject({ conclusion: "failure", output: { title: "Not ready: not-approved" } });

    // Approved, but CI red: failure naming CI.
    setup({ ci: [{ id: 1, name: "ci", status: "completed", conclusion: "failure", app: { slug: "github-actions" } }] }, "no_verdict_conclusion: neutral\n");
    await run();
    expect(created()).toMatchObject({ conclusion: "failure", output: { title: "Not ready: ci-not-passing" } });

    // Without the setting, unchanged: failure.
    setup({ approved: false, threads: [openThread] });
    await run();
    expect(created()).toMatchObject({ conclusion: "failure", output: { title: "Not ready: not-approved" } });

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

// GitHub refuses a formal APPROVED review from a PR's own author, but a COMMENTED
// review is allowed — and a comment review ending in the approval line is how the
// gate reads an approval. A person must not be able to approve their own PR that way.
describe("nobody approves their own pull request", () => {
  const ALICE = { login: "alice", type: "User" };
  const commentApproval = (login: string, association: string) => ({
    submitted_at: "2026-01-01T00:00:00Z",
    state: "COMMENTED",
    commit_id: HEAD,
    user: { login },
    author_association: association,
    body: "LGTM.\n\n**Verdict:** APPROVE\n",
  });
  const mergeMode = (world: Partial<World>) => {
    setup(world);
    inputs.mode = "";
  };

  it("a trusted collaborator's comment approval of their OWN PR does not merge it", async () => {
    mergeMode({ author: ALICE, reviews: [commentApproval("alice", "COLLABORATOR")] });
    await run();
    expect(methods()).not.toContain("pulls.merge");
  });

  it("…whatever the case of the login", async () => {
    mergeMode({ author: ALICE, reviews: [commentApproval("Alice", "OWNER")] });
    await run();
    expect(methods()).not.toContain("pulls.merge");
  });

  it("another trusted collaborator's approval of that PR still counts", async () => {
    mergeMode({ author: ALICE, reviews: [commentApproval("bob", "COLLABORATOR")] });
    await run();
    expect(methods()).toContain("pulls.merge");
  });

  it("the bot's approval of a person's PR counts", async () => {
    mergeMode({ author: ALICE, reviews: [commentApproval(BOT, "NONE")] });
    await run();
    expect(methods()).toContain("pulls.merge");
  });

  it("the harness bot still approves the PRs it wrote (one identity writes and reviews)", async () => {
    mergeMode({ reviews: [commentApproval(BOT, "NONE")] });
    await run();
    expect(methods()).toContain("pulls.merge");
  });

  it("an author's own REQUEST_CHANGES still blocks their PR", async () => {
    mergeMode({
      author: ALICE,
      reviews: [
        commentApproval("bob", "COLLABORATOR"),
        { ...commentApproval("alice", "COLLABORATOR"), submitted_at: "2026-01-02T00:00:00Z", body: "Wait.\n\n**Verdict:** REQUEST_CHANGES" },
      ],
    });
    await run();
    expect(methods()).not.toContain("pulls.merge");
  });

  it("evaluate mode does not publish success on a self-approved head", async () => {
    setup({ author: ALICE, reviews: [commentApproval("alice", "COLLABORATOR")] });
    await run();
    expect(stub.calls.find((c) => c.method === "checks.create")?.params.conclusion).not.toBe("success");
  });
});

describe("escalation labels and standing change requests, end to end", () => {
  const botApproval = { submitted_at: "2026-01-02T00:00:00Z", state: "COMMENTED", commit_id: HEAD, user: { login: BOT }, author_association: "NONE", body: "Fine.\n\n**Verdict:** APPROVE" };
  const aliceBlocks = { submitted_at: "2026-01-01T00:00:00Z", state: "CHANGES_REQUESTED", commit_id: HEAD, user: { login: "alice" }, author_association: "COLLABORATOR", body: "Not like this." };
  const conclusion = () => stub.calls.find((c) => c.method === "checks.create")?.params.conclusion;

  it("an escalation label publishes action_required on an approved, green head", async () => {
    setup({ labels: ["needs-a-person"] }, "escalation_labels: [needs-a-person]\n");
    await run();
    expect(conclusion()).toBe("action_required");
    expect(stub.calls.find((c) => c.method === "checks.create")?.params.output.summary).toContain("needs-a-person");
  });

  it("…and on a head the approver has not looked at, instead of 'awaiting'", async () => {
    setup({ approved: false, labels: ["needs-a-person"] }, "escalation_labels: [needs-a-person]\nno_verdict_conclusion: neutral\n");
    await run();
    expect(conclusion()).toBe("action_required");
  });

  it("an escalation label stops a merge in merge mode", async () => {
    setup({ labels: ["needs-a-person"] }, "escalation_labels: [needs-a-person]\n");
    inputs.mode = "";
    await run();
    expect(methods()).not.toContain("pulls.merge");
  });

  it("without the clause, the bot's later approval overrides a teammate's block (unchanged)", async () => {
    setup({ reviews: [aliceBlocks, botApproval] });
    inputs.mode = "";
    await run();
    expect(methods()).toContain("pulls.merge");
  });

  it("with require_no_human_changes_requested, the teammate's block holds", async () => {
    setup({ reviews: [aliceBlocks, botApproval] }, "require_no_human_changes_requested: true\n");
    inputs.mode = "";
    await run();
    expect(methods()).not.toContain("pulls.merge");

    setup({ reviews: [aliceBlocks, botApproval] }, "require_no_human_changes_requested: true\n");
    await run();
    expect(conclusion()).toBe("failure");
    expect(stub.calls.find((c) => c.method === "checks.create")?.params.output.summary).toContain("alice");
  });

  it("…until she approves", async () => {
    const aliceApproves = { ...aliceBlocks, submitted_at: "2026-01-03T00:00:00Z", state: "APPROVED", body: "" };
    setup({ reviews: [aliceBlocks, botApproval, aliceApproves] }, "require_no_human_changes_requested: true\n");
    inputs.mode = "";
    await run();
    expect(methods()).toContain("pulls.merge");
  });
});

// merge= — one gate for a repo where people and agents both open pull requests.
// Every PR in scope gets the check; only a PR the pipeline wrote is ever merged.
describe("the single gate (merge=)", () => {
  const ALICE = { login: "alice", type: "User" };
  const gate = (merge: string, world: Partial<World> = {}, rollout?: object, policyYaml = "") => {
    setup(world, policyYaml);
    delete inputs.mode;
    inputs.merge = merge;
    if (rollout) inputs.rollout = JSON.stringify(rollout);
  };
  const check = () => stub.calls.find((c) => c.method === "checks.create")?.params;

  describe('merge="off"', () => {
    it("publishes the check on an agent PR and on a person's PR, and merges neither", async () => {
      gate("off");
      await run();
      expect(check()?.conclusion).toBe("success");
      expect(methods()).not.toContain("pulls.merge");

      gate("off", { author: ALICE, headRef: "alice/feature" });
      await run();
      expect(check()?.conclusion).toBe("success");
      expect(writes().map((c) => c.method)).toEqual(["checks.create"]);
    });

    it("does not fail a person's PR for its branch name", async () => {
      // The policy file here sets branch_prefix: "agent/" (see setup). Under the
      // original gate that is the `wrong-branch` clause; scope is the rollout's job now.
      gate("off", { author: ALICE, headRef: "alice/feature" });
      await run();
      expect(check()?.conclusion).toBe("success");
    });

    it("says nothing about who merges", async () => {
      gate("off");
      await run();
      expect(check()?.output.text ?? "").not.toContain("Merge:");
    });
  });

  describe('merge="agent-only"', () => {
    it("merges a ready PR the pipeline wrote, after publishing its check", async () => {
      gate("agent-only");
      await run();
      const order = methods().filter((m) => m === "checks.create" || m === "pulls.merge");
      expect(order).toEqual(["checks.create", "pulls.merge"]);
      expect(check()?.output.text).toContain("the pipeline wrote this PR and merges it");
      expect(outputs["merged-pr"]).toBe("7");
    });

    it("never merges a person's PR, however ready — and tells them so on the check", async () => {
      gate("agent-only", { author: ALICE, headRef: "alice/feature" });
      await run();
      expect(check()?.conclusion).toBe("success");
      expect(check()?.output.text).toContain("a person merges this PR");
      expect(writes().map((c) => c.method)).toEqual(["checks.create"]);
    });

    it("never merges a person's PR on an agent-named branch", async () => {
      // What the branch-prefix test could not tell apart.
      gate("agent-only", { author: ALICE, headRef: "agent/looks-like-one" });
      await run();
      expect(methods()).not.toContain("pulls.merge");
    });

    it("one commit by someone else makes the pipeline's PR human-merged", async () => {
      gate("agent-only", { commits: [BOT, "alice", BOT] });
      await run();
      expect(methods()).not.toContain("pulls.merge");
      expect(check()?.conclusion).toBe("success");
      expect(check()?.output.text).toContain("has commits by alice");
    });

    it("…and so does a commit GitHub cannot attribute to anyone", async () => {
      gate("agent-only", { commits: [BOT, null] });
      await run();
      expect(methods()).not.toContain("pulls.merge");
    });

    it("does not label or comment on a person's PR that is not ready", async () => {
      gate("agent-only", { author: ALICE, approved: false }, undefined, "labels: { awaiting_approval: awaiting-approval }\n");
      await run();
      expect(writes().map((c) => c.method)).toEqual(["checks.create"]);
    });

    it("still applies the policy's labels to the pipeline's own PR that is not ready", async () => {
      gate("agent-only", { approved: false }, undefined, "labels: { awaiting_approval: awaiting-approval }\n");
      await run();
      expect(methods()).toContain("issues.addLabels");
      expect(methods()).not.toContain("pulls.merge");
    });

    it("an escalation label stops the merge of an agent PR", async () => {
      gate("agent-only", { labels: ["needs-a-person"] }, undefined, "escalation_labels: [needs-a-person]\n");
      await run();
      expect(check()?.conclusion).toBe("action_required");
      expect(methods()).not.toContain("pulls.merge");
    });
  });

  describe("scope: the rollout dial", () => {
    const rollout = { authors: ["alice"], optInLabel: "agent-review", skipLabel: "no-agent-review" };
    const evaluated = () => outputs.evaluated;

    it("judges a listed author's PR and ignores everyone else's", async () => {
      gate("off", { author: ALICE }, rollout);
      await run();
      expect(evaluated()).toBe("1");
      gate("off", { author: { login: "bob", type: "User" } }, rollout);
      await run();
      expect(evaluated()).toBe("0");
      expect(writes()).toEqual([]);
    });

    it("the opt-in label admits anyone; the skip label excludes anyone", async () => {
      gate("off", { author: { login: "bob", type: "User" }, labels: ["agent-review"] }, rollout);
      await run();
      expect(evaluated()).toBe("1");
      gate("off", { author: ALICE, labels: ["no-agent-review"] }, rollout);
      await run();
      expect(evaluated()).toBe("0");
    });

    it("the pipeline's own PRs are in scope whatever the dial says", async () => {
      gate("agent-only", {}, { authors: [] });
      await run();
      expect(evaluated()).toBe("1");
      expect(methods()).toContain("pulls.merge");
    });

    it("drafts and other bots' PRs are never in scope", async () => {
      gate("off", { draft: true });
      await run();
      expect(evaluated()).toBe("0");
      gate("off", { author: { login: "renovate[bot]", type: "Bot" } });
      await run();
      expect(evaluated()).toBe("0");
    });

    it("with no rollout at all, every person's PR is in scope", async () => {
      gate("off", { author: { login: "anyone", type: "User" } });
      await run();
      expect(evaluated()).toBe("1");
    });
  });

  describe("who publishes the check", () => {
    it("adopts only its own app's run: github-actions by default", async () => {
      const theirs = { id: 5, name: CHECK, status: "completed", conclusion: "success", app: { slug: "some-other-app" }, output: { summary: "", text: "" } };
      gate("off", { existing: [theirs] });
      await run();
      expect(methods()).toContain("checks.create"); // not an update of someone else's run
    });

    it("with check-app, adopts the harness App's run and not github-actions'", async () => {
      const forged = { id: 5, name: CHECK, status: "completed", conclusion: "success", app: { slug: "github-actions" }, output: { summary: "", text: "" } };
      const mine = { id: 6, name: CHECK, status: "completed", conclusion: "failure", app: { slug: "my-harness-app" }, output: { summary: "old", text: "" } };
      gate("off", { existing: [forged, mine] });
      inputs["check-app"] = "my-harness-app";
      await run();
      const update = stub.calls.find((c) => c.method === "checks.update");
      expect(update?.params.check_run_id).toBe(6);
      expect(methods()).not.toContain("checks.create");
    });
  });

  describe("inputs", () => {
    it("rejects an unknown merge value", async () => {
      gate("everything");
      await run();
      expect(failures.join(" ")).toContain('merge must be "off" or "agent-only"');
    });

    it("merge= with no mode input runs the single gate (the step the 0.3.0 compiler writes)", async () => {
      gate("off");
      expect("mode" in inputs).toBe(false); // left to action.yml's default, as on the runner
      await run();
      expect(failures).toEqual([]);
      expect(check()?.conclusion).toBe("success");
      expect(outputs.evaluated).toBe("1");
    });

    it("merge= together with an explicit mode fails, naming both values", async () => {
      gate("off");
      inputs.mode = "evaluate";
      await run();
      expect(failures.join(" ")).toContain("merge replaces mode");
      expect(failures.join(" ")).toContain('merge="off" and mode="evaluate"');
      expect(writes()).toEqual([]);
    });
  });

  describe("mode with no merge=", () => {
    it("neither set: mode defaults to merge, and the original gate merges", async () => {
      setup({ reviews: [{ submitted_at: "2026-01-01T00:00:00Z", state: "COMMENTED", commit_id: HEAD, user: { login: BOT }, author_association: "NONE", body: "ok\n\n**Verdict:** APPROVE" }] });
      delete inputs.mode;
      await run();
      expect(failures).toEqual([]);
      expect(methods()).toContain("pulls.merge");
      expect(methods()).not.toContain("checks.create");
    });

    it("mode: evaluate alone still publishes a check and never merges", async () => {
      setup({});
      expect(inputs.mode).toBe("evaluate");
      expect("merge" in inputs).toBe(false);
      await run();
      expect(failures).toEqual([]);
      expect(check()?.conclusion).toBe("success");
      expect(methods()).not.toContain("pulls.merge");
    });

    it("needs a check name", async () => {
      gate("off");
      delete inputs["check-name"];
      await run();
      expect(failures.join(" ")).toContain("check-name");
    });
  });

  it("without merge=, the original gate is untouched: it merges by branch prefix and publishes nothing", async () => {
    setup({ author: ALICE, headRef: "agent/by-a-person", reviews: [{ submitted_at: "2026-01-01T00:00:00Z", state: "COMMENTED", commit_id: HEAD, user: { login: BOT }, author_association: "NONE", body: "ok\n\n**Verdict:** APPROVE" }] });
    inputs.mode = "";
    await run();
    expect(methods()).toContain("pulls.merge");
    expect(methods()).not.toContain("checks.create");
  });
});
