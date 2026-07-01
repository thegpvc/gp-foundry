/**
 * B4 — Node-type handlers. One `emit` per NodeType → a WorkflowJobFragment.
 * The job-level `if:` guard is applied later by the assembler (from wiring);
 * handlers own permissions, steps, environment, and timeout.
 */
import type {
  EmitContext,
  Harness,
  HarnessNode,
  NodeType,
  Permission,
  StepSpec,
  WorkflowJobFragment,
} from "../ir/types.js";
import {
  appTokenStep,
  checkoutStep,
  contextStep,
  gitIdentityStep,
  resolveFile,
  runAgentStep,
  runStep,
  setupStep,
  tokenExpr,
} from "./steps.js";

type Perms = Record<string, Permission>;

const ISSUE_NUMBER = "${{ github.event.issue.number }}";
const PR_NUMBER = "${{ github.event.pull_request.number }}";
const PR_HEAD_SHA = "${{ github.event.pull_request.head.sha }}";
const PR_HEAD_REF = "${{ github.event.pull_request.head.ref }}";

function timeoutOf(node: HarnessNode, dflt: number): number {
  const t = node.attrs.timeout;
  return typeof t === "number" ? t : dflt;
}

function preamble(ctx: EmitContext, checkout?: Parameters<typeof checkoutStep>[1]): StepSpec[] {
  const steps: StepSpec[] = [];
  const app = appTokenStep(ctx);
  if (app) steps.push(app);
  steps.push(checkoutStep(ctx, checkout));
  steps.push(gitIdentityStep(ctx));
  return steps;
}

// ── analyst / issue-agent / pr-review: read-and-advise (no code write) ──
function emitAnalyst(ctx: EmitContext): WorkflowJobFragment {
  const node = ctx.node;
  const context = node.context ?? "issue";
  const isPr = context === "pr-diff" || context === "pr-review";
  const permissions: Perms = isPr
    ? { contents: "read", "pull-requests": "write" }
    : { contents: "read", issues: "write" };

  const steps: StepSpec[] = [];
  const app = appTokenStep(ctx);
  if (app) steps.push(app);

  // pr-review waits for named CI gates before reviewing
  const gates = typeof node.attrs.gates === "string" ? node.attrs.gates : undefined;
  if (isPr && gates) {
    for (const wf of gates.split(",").map((s) => s.trim()).filter(Boolean)) {
      steps.push({
        uses: ctx.actionRef("wait-for-checks"),
        name: `Wait for ${wf}`,
        with: { sha: PR_HEAD_SHA, "workflow-name": wf, token: tokenExpr(ctx) },
      });
    }
  }

  steps.push(checkoutStep(ctx, isPr ? { ref: PR_HEAD_SHA, fetchDepth: 0 } : undefined));
  steps.push(setupStep());
  const ctxType = context === "pr-diff" ? "pr-diff" : context === "pr-review" ? "pr-review" : "issue";
  steps.push(contextStep(ctx, ctxType, isPr ? PR_NUMBER : ISSUE_NUMBER));
  steps.push(runAgentStep(ctx, { withContext: true }));

  return {
    jobId: node.id,
    name: node.id,
    permissions,
    timeoutMinutes: timeoutOf(node, 15),
    steps,
  };
}

// ── producer: author a committed change → new PR ──
function emitProducer(ctx: EmitContext): WorkflowJobFragment {
  const node = ctx.node;
  const cfg = ctx.config;
  const steps: StepSpec[] = preamble(ctx);
  steps.push(
    runStep({
      id: "branch",
      name: "Create branch",
      env: {
        ISSUE_NUMBER,
        ISSUE_TITLE: "${{ github.event.issue.title }}",
        PREFIX: cfg.repo.branch_prefix,
      },
      run: [
        `SLUG=$(printf '%s' "$ISSUE_TITLE" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr -cd 'a-z0-9-' | cut -c1-50 | sed 's/-$//')`,
        `BRANCH="$PREFIX$ISSUE_NUMBER-$SLUG"`,
        `git checkout -b "$BRANCH"`,
        `echo "branch=$BRANCH" >> "$GITHUB_OUTPUT"`,
      ].join("\n"),
    }),
  );
  steps.push(setupStep());
  steps.push(contextStep(ctx, "issue", ISSUE_NUMBER));
  steps.push(runAgentStep(ctx, { withContext: true }));
  steps.push({
    uses: ctx.actionRef("agent-fallback"),
    name: "Fallback: commit / push / PR",
    with: {
      branch: "${{ steps.branch.outputs.branch }}",
      token: tokenExpr(ctx),
      "agent-name": node.id,
      "base-branch": cfg.repo.base_branch,
      "issue-number": ISSUE_NUMBER,
      // Meaningful title from the issue; the agent normally opens its own PR with a
      // fuller body — this fires only as a safety net if it didn't.
      "pr-title": "${{ github.event.issue.title }}",
      "pr-body": `### 🛠️ Auto-created (fallback)\n\nThe agent finished but didn't open a PR itself, so one was created automatically. See the commits and the linked issue for context.\n\nCloses #${ISSUE_NUMBER}`,
    },
  });

  return {
    jobId: node.id,
    name: node.id,
    permissions: { contents: "write", "pull-requests": "write", issues: "write" },
    timeoutMinutes: timeoutOf(node, 30),
    steps,
  };
}

// ── pr-fix: amend an existing PR ──
function emitPrFix(ctx: EmitContext): WorkflowJobFragment {
  const node = ctx.node;
  const steps: StepSpec[] = preamble(ctx, { ref: PR_HEAD_REF, fetchDepth: 0 });
  steps.push(setupStep());
  steps.push(contextStep(ctx, "pr-review", PR_NUMBER)); // the Fixer needs the review feedback
  steps.push(runAgentStep(ctx, { withContext: true }));
  steps.push(
    runStep({
      name: "Commit and push fixes",
      env: { BRANCH: PR_HEAD_REF },
      run: [
        `# Commit anything the agent left uncommitted...`,
        `if [ -n "$(git status --porcelain)" ]; then`,
        `  git add -A`,
        `  git commit -m "agent fix: ${node.id}"`,
        `fi`,
        `# ...then push if HEAD is ahead of the remote (the agent may have committed itself).`,
        `git fetch origin "$BRANCH" --quiet 2>/dev/null || true`,
        `if [ "$(git rev-parse HEAD)" != "$(git rev-parse "origin/$BRANCH" 2>/dev/null || echo none)" ]; then`,
        `  git push origin "HEAD:$BRANCH"`,
        `  echo "pushed fix to $BRANCH"`,
        `else`,
        `  echo "no changes to push"`,
        `fi`,
      ].join("\n"),
    }),
  );
  return {
    jobId: node.id,
    name: node.id,
    permissions: { contents: "write", "pull-requests": "write" },
    timeoutMinutes: timeoutOf(node, 30),
    steps,
  };
}

// ── merge-gate: policy decision (no agent) ──
function emitMergeGate(ctx: EmitContext): WorkflowJobFragment {
  const node = ctx.node;
  const steps: StepSpec[] = preamble(ctx, { fetchDepth: 0 });
  steps.push({
    uses: ctx.actionRef("merge-gate"),
    name: "Evaluate merge gate",
    with: {
      token: tokenExpr(ctx),
      "policy-path": resolveFile(ctx, node.files.policy),
      "base-branch": ctx.config.repo.base_branch,
      "branch-prefix": ctx.config.repo.branch_prefix,
    },
  });
  return {
    jobId: node.id,
    name: node.id,
    permissions: { contents: "write", "pull-requests": "write", issues: "write" },
    timeoutMinutes: timeoutOf(node, 10),
    steps,
  };
}

// ── human-gate: a GitHub Environment approval ──
function emitHumanGate(ctx: EmitContext): WorkflowJobFragment {
  const node = ctx.node;
  const env = String(node.attrs.environment ?? "production");
  return {
    jobId: node.id,
    name: node.id,
    permissions: {},
    environment: env,
    steps: [runStep({ name: "Awaiting approval", run: `echo "Approved for ${env}."` })],
  };
}

// ── scheduled-agent: a maintenance agent on schedule/dispatch (Scribe, Gardener, …) ──
function emitScheduledAgent(ctx: EmitContext): WorkflowJobFragment {
  const node = ctx.node;
  const cfg = ctx.config;
  const steps: StepSpec[] = preamble(ctx, { fetchDepth: 0 }); // app-token, checkout, git identity
  steps.push(setupStep());
  // No triggering issue/PR: the role uses gh to gather what it needs (e.g. [learning] issues).
  steps.push(runAgentStep(ctx, { withContext: false }));
  steps.push(
    runStep({
      name: "Commit changes",
      env: { BRANCH: cfg.repo.base_branch },
      run: [
        `if [ -n "$(git status --porcelain)" ]; then`,
        `  git add -A`,
        `  git commit -m "chore(${node.id}): scheduled update"`,
        `fi`,
        `git fetch origin "$BRANCH" --quiet 2>/dev/null || true`,
        `if [ "$(git rev-parse HEAD)" != "$(git rev-parse "origin/$BRANCH" 2>/dev/null || echo none)" ]; then`,
        `  git push origin "HEAD:$BRANCH"`,
        `  echo "pushed changes to $BRANCH"`,
        `else`,
        `  echo "no changes to commit"`,
        `fi`,
      ].join("\n"),
    }),
  );
  return {
    jobId: node.id,
    name: node.id,
    permissions: { contents: "write", issues: "write", "pull-requests": "write" },
    timeoutMinutes: timeoutOf(node, 15),
    steps,
  };
}

export type EmitFn = (ctx: EmitContext) => WorkflowJobFragment | null;

export const HANDLERS: Partial<Record<NodeType, EmitFn>> = {
  analyst: emitAnalyst,
  "issue-agent": emitAnalyst,
  "pr-review": emitAnalyst,
  producer: emitProducer,
  "pr-fix": emitPrFix,
  "merge-gate": emitMergeGate,
  "human-gate": emitHumanGate,
  "scheduled-agent": emitScheduledAgent,
  // start / exit / parallel / fan_in are virtual (no generated job) for v1
  start: () => null,
  exit: () => null,
};

export function emitNode(node: HarnessNode, ir: Harness, ctx: EmitContext): WorkflowJobFragment | null {
  const fn = HANDLERS[node.type];
  if (!fn) return null;
  return fn(ctx);
}
