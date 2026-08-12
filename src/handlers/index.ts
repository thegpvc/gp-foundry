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

  // Checkout FIRST: in vendored mode the wait-for-checks gate below is a LOCAL
  // action (./.github/actions/…) that cannot resolve before checkout.
  steps.push(checkoutStep(ctx, isPr ? { ref: PR_HEAD_SHA, fetchDepth: 0 } : undefined));

  // pr-review waits for named CI gates before reviewing
  const gatesAttr = typeof node.attrs.gates === "string" ? node.attrs.gates : undefined;
  const gates = isPr && gatesAttr ? gatesAttr.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const gateIds = gates.map((wf, i) => stepId(`gate-${wf}`, i, gates));
  gates.forEach((wf, i) => {
    steps.push({
      uses: ctx.actionRef("wait-for-checks"),
      id: gateIds[i],
      name: `Wait for ${wf}`,
      with: { sha: PR_HEAD_SHA, "workflow-name": wf, token: tokenExpr(ctx) },
    });
  });

  steps.push(setupStep());
  const ctxType = context === "pr-diff" ? "pr-diff" : context === "pr-review" ? "pr-review" : "issue";
  steps.push(contextStep(ctx, ctxType, isPr ? PR_NUMBER : ISSUE_NUMBER));
  // Waiting for a gate is not the same as reading it: wait-for-checks never fails
  // the step, so a red or timed-out gate used to be indistinguishable from a green
  // one. Put every conclusion in front of the reviewer and say what a non-success
  // means, so a broken build cannot be reviewed as if CI had passed.
  if (gates.length) steps.push(gateResultsStep(gates, gateIds));
  steps.push(runAgentStep(ctx, { withContext: true }));

  return {
    jobId: node.id,
    name: node.id,
    permissions,
    // Each wait-for-checks step budgets 15 minutes by default; a job timeout that
    // ignored them would kill the review mid-wait and stall the PR with no verdict.
    timeoutMinutes: timeoutOf(node, 15 + 15 * gates.length),
    steps,
  };
}

/** A workflow name → a valid, unique GitHub step id. */
function stepId(raw: string, index: number, all: string[]): string {
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  const base = slug(raw) || `gate-${index + 1}`;
  const collides = all.filter((o, i) => i !== index && slug(`gate-${o}`) === base).length > 0;
  return collides ? `${base}-${index + 1}` : base;
}

/** Append each gate's conclusion to the context file the reviewer is handed. */
function gateResultsStep(gates: string[], gateIds: string[]): StepSpec {
  const env: Record<string, string> = { CONTEXT_FILE: "${{ steps.ctx.outputs.context-file }}" };
  const lines = [`{`, `  echo ""`, `  echo "=== CI GATES ==="`];
  gates.forEach((wf, i) => {
    env[`GATE_${i + 1}_NAME`] = wf;
    env[`GATE_${i + 1}_RESULT`] = `\${{ steps.${gateIds[i]}.outputs.conclusion }}`;
    lines.push(`  echo "$GATE_${i + 1}_NAME: $GATE_${i + 1}_RESULT"`);
  });
  lines.push(
    `  echo ""`,
    `  echo "A gate whose result is not 'success' is a blocking finding: say which one"`,
    `  echo "failed and request changes. 'timeout' or 'skipped' means CI never gave an"`,
    `  echo "answer — treat it as unverified, not as a pass."`,
    `} >> "$CONTEXT_FILE"`,
  );
  return runStep({ name: "Record CI gate results in the context", env, run: lines.join("\n") });
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
    // Salvage committed work even when the agent step failed (job still reports red).
    if: "${{ !cancelled() }}",
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
  // Make `max_attempts` REAL: count how many times the reviewer has asked for
  // changes on this PR and stop at the limit instead of looping forever. (The
  // graph's `attempts>=N` escape edge is the declaration; this is the mechanism.)
  //
  // The count comes from SUBMITTED REVIEWS, not from marker comments: comments can
  // be deleted, and deleting them used to reset the budget — so the declared bound
  // was not monotonic and the fix↔review loop could be driven past it. A submitted
  // review cannot be deleted through the API, only dismissed, so this ratchets.
  const maxAttempts = typeof node.attrs.max_attempts === "number" ? node.attrs.max_attempts : 3;
  const marker = `<!-- gp-foundry:attempt:${node.id} -->`;
  const needsHuman = ctx.config.labels?.["needs-human"] ?? "needs-human";
  const botLogin = ctx.config.identity?.bot_login ?? "";
  steps.push(
    runStep({
      id: "attempts",
      name: `Enforce attempt budget (max ${maxAttempts})`,
      env: {
        GH_TOKEN: tokenExpr(ctx),
        PR: PR_NUMBER,
        MARKER: marker,
        MAX: String(maxAttempts),
        BOT_LOGIN: botLogin,
      },
      run: [
        `# One request-changes verdict = one attempt. The jq filter reads the bot`,
        `# login from the environment (never interpolated into the script), and an`,
        `# empty BOT_LOGIN counts any reviewer's request-changes.`,
        `# (--paginate emits one count per page, so the counts are summed.)`,
        `COUNT=$(gh api "repos/$GITHUB_REPOSITORY/pulls/$PR/reviews" --paginate --jq '`,
        `  [ .[]`,
        `    | select(env.BOT_LOGIN == "" or .user.login == env.BOT_LOGIN)`,
        `    | select(.state == "CHANGES_REQUESTED" or ((.body // "") | test("Verdict.*REQUEST_CHANGES")))`,
        `  ] | length' 2>/dev/null | awk '{s+=$1} END {print s+0}')`,
        `[ -n "$COUNT" ] || COUNT=0`,
        `echo "attempts so far: $COUNT / $MAX"`,
        `if [ "$COUNT" -gt "$MAX" ]; then`,
        `  gh pr edit "$PR" --add-label "${needsHuman}" 2>/dev/null || gh api --method POST "repos/$GITHUB_REPOSITORY/issues/$PR/labels" -f 'labels[]=${needsHuman}'`,
        `  gh pr comment "$PR" --body "$(printf '## ⛔ Attempt budget (${node.id})\\n\\nExhausted (%s/%s requested-changes rounds) — labeling \`${needsHuman}\` and stopping. A human should take this over.\\n\\n%s' "$COUNT" "$MAX" "$MARKER")"`,
        `  echo "exhausted=true" >> "$GITHUB_OUTPUT"`,
        `else`,
        `  gh pr comment "$PR" --body "$(printf '%s attempt %s of %s' "$MARKER" "$COUNT" "$MAX")" >/dev/null`,
        `  echo "exhausted=false" >> "$GITHUB_OUTPUT"`,
        `fi`,
      ].join("\n"),
    }),
  );
  const notExhausted = "steps.attempts.outputs.exhausted != 'true'";
  steps.push({ ...setupStep(), if: notExhausted });
  steps.push({ ...contextStep(ctx, "pr-review", PR_NUMBER), if: notExhausted }); // the Fixer needs the review feedback
  steps.push({ ...runAgentStep(ctx, { withContext: true }), if: notExhausted });
  steps.push(
    runStep({
      name: "Commit and push fixes",
      // Push committed work even if the agent step failed mid-run (job stays red).
      if: `${notExhausted} && !cancelled()`,
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

/**
 * The check-run a human-gate publishes on the PR head after its Environment
 * approval — and the name the merge gate requires. Both sides derive it from the
 * node, so the two workflows cannot drift apart.
 */
export function humanGateCheckName(node: HarnessNode): string {
  return `gp-foundry/human-approval (${String(node.attrs.environment ?? "production")})`;
}

/**
 * The app slug that must have CREATED the approval check for the merge gate to
 * believe it. A check-run is only as trustworthy as its author: matching on the
 * name alone lets anything that can write checks publish its own approval.
 *
 * The human-gate publishes with GITHUB_TOKEN, so the check is attributed to
 * `github-actions`, and GITHUB_TOKEN is bounded by each job's `permissions:` —
 * no agent lane declares `checks: write`. The App installation token the agents
 * carry is NOT bounded that way, which is exactly why the gate must not accept a
 * check that token could have written.
 */
export const HUMAN_GATE_CHECK_APP = "github-actions";

/** `<check-name>@<app-slug>` — the form merge-gate's `required-checks` parses. */
export function humanGateRequiredCheck(node: HarnessNode): string {
  return `${humanGateCheckName(node)}@${HUMAN_GATE_CHECK_APP}`;
}

// ── merge-gate: policy decision (no agent) ──
function emitMergeGate(ctx: EmitContext): WorkflowJobFragment {
  const node = ctx.node;
  const steps: StepSpec[] = preamble(ctx, { fetchDepth: 0 });
  // A human-gate feeding this gate is a PRECONDITION, not a suggestion: require
  // its approval check on the exact head SHA. Before this, the human-gate job ran
  // on its own and the merge gate never looked at it — approval blocked a merge
  // only incidentally, via the pending check-run its waiting job happened to
  // create, and not at all when the approval arrived by another route.
  const humanGates = ctx.inEdges
    .map((e) => ctx.nodeById?.(e.from))
    .filter((n): n is HarnessNode => !!n && n.type === "human-gate");
  // `<name>@<app>` — the check must also have been WRITTEN by the app the
  // human-gate publishes as, or a name is all an impostor needs.
  const requiredChecks = humanGates.map(humanGateRequiredCheck);
  steps.push({
    uses: ctx.actionRef("merge-gate"),
    name: "Evaluate merge gate",
    with: {
      token: tokenExpr(ctx),
      "policy-path": resolveFile(ctx, node.files.policy),
      "base-branch": ctx.config.repo.base_branch,
      "branch-prefix": ctx.config.repo.branch_prefix,
      ...(ctx.config.identity?.bot_login ? { "bot-login": ctx.config.identity.bot_login } : {}),
      ...(requiredChecks.length ? { "required-checks": requiredChecks.join(",") } : {}),
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
    // checks:write publishes the approval below; the merge gate requires it.
    permissions: { checks: "write" },
    environment: env,
    steps: [
      runStep({
        name: "Record the approval on the head commit",
        // The Environment approval is what gates this job. Its only durable trace
        // used to be an `echo`, which no other workflow could observe — so the
        // merge gate had nothing to require. Publishing a check-run on the exact
        // head SHA makes the approval a fact about THIS commit: push again, and
        // the new head carries no approval.
        env: {
          // GITHUB_TOKEN, deliberately — not the harness token. Two reasons, both
          // load-bearing: the Checks API only accepts a GitHub App (a PAT is
          // rejected outright, and `pat` is the shipped default), and GITHUB_TOKEN
          // is the one token a job's `permissions:` block actually constrains, so
          // only a job that declares `checks: write` — this one — can write the
          // approval. The merge gate pins the resulting `github-actions` author.
          GH_TOKEN: "${{ github.token }}",
          CHECK_NAME: humanGateCheckName(node),
          HEAD_SHA: PR_HEAD_SHA,
          ENVIRONMENT: env,
        },
        run: [
          `if ! gh api --method POST "repos/$GITHUB_REPOSITORY/check-runs" \\`,
          `  -f name="$CHECK_NAME" \\`,
          `  -f head_sha="$HEAD_SHA" \\`,
          `  -f status=completed \\`,
          `  -f conclusion=success \\`,
          `  -f 'output[title]=Approved' \\`,
          `  -f "output[summary]=Environment \\"$ENVIRONMENT\\" was approved by a human for $HEAD_SHA."; then`,
          `  echo "::error::Approved for $ENVIRONMENT, but publishing the approval check failed."`,
          `  echo "::error::The merge gate requires \\"$CHECK_NAME\\" on $HEAD_SHA, so this PR will not merge until it is published."`,
          `  exit 1`,
          `fi`,
          `echo "Approved for $ENVIRONMENT."`,
        ].join("\n"),
      }),
    ],
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
  // A scheduled lane commits straight to the base branch — no PR, no reviewer, no
  // merge gate. That makes it the one path where an agent could edit the gate
  // definitions themselves, so it runs the SAME immutable-path strip the producer
  // lane does (plus an optional per-lane pathspec allowlist) before pushing.
  const allowedPaths = typeof node.attrs.paths === "string" ? node.attrs.paths : "";
  steps.push({
    uses: ctx.actionRef("agent-fallback"),
    name: "Strip protected paths, commit, push",
    // No `!cancelled()` here, unlike the producer lane. There the salvage lands
    // on an agent branch behind a review; here it lands on the base branch with
    // no PR and no gate, so a run that failed halfway must publish nothing.
    with: {
      branch: cfg.repo.base_branch,
      "base-branch": cfg.repo.base_branch,
      token: tokenExpr(ctx),
      "agent-name": node.id,
      "scope-path": resolveFile(ctx, "agents/scope.yaml"),
      "commit-message": `chore(${node.id}): scheduled update`,
      ...(allowedPaths ? { "allowed-paths": allowedPaths } : {}),
    },
  });
  return {
    jobId: node.id,
    name: node.id,
    // `actions: write` lets maintenance roles inspect and re-run workflow runs
    // (the supervisor's `gh run list` / `gh run rerun` re-drive path).
    permissions: { contents: "write", issues: "write", "pull-requests": "write", actions: "write" },
    timeoutMinutes: timeoutOf(node, 15),
    steps,
  };
}

// ── fan_in: the join job of a parallel diamond (native `needs:` on the leg jobs) ──
export function emitFanIn(ctx: EmitContext, legIds: string[], prScoped: boolean): WorkflowJobFragment {
  const node = ctx.node;
  const steps: StepSpec[] = [];
  const app = appTokenStep(ctx);
  if (app) steps.push(app);
  steps.push(checkoutStep(ctx, prScoped ? { ref: PR_HEAD_SHA, fetchDepth: 0 } : undefined));
  steps.push(setupStep());
  // The thread context contains every lane's posted analysis — that's the join input.
  steps.push(contextStep(ctx, prScoped ? "pr-review" : "issue", prScoped ? PR_NUMBER : ISSUE_NUMBER));
  if (node.files.role) steps.push(runAgentStep(ctx, { withContext: true }));
  // Optional completion label (resolved through config.labels) — cascades the next
  // stage via the existing label guards.
  const rawLabel = node.attrs.on_complete_label;
  if (typeof rawLabel === "string" && rawLabel) {
    const label = ctx.config.labels?.[rawLabel] ?? rawLabel;
    steps.push(
      runStep({
        name: "Apply completion label",
        env: { GH_TOKEN: tokenExpr(ctx), NUM: prScoped ? PR_NUMBER : ISSUE_NUMBER },
        run: `gh api --method POST "repos/$GITHUB_REPOSITORY/issues/$NUM/labels" -f 'labels[]=${label}'`,
      }),
    );
  }
  return {
    jobId: node.id,
    name: node.id,
    needs: legIds,
    permissions: prScoped
      ? { contents: "read", "pull-requests": "write", issues: "write" }
      : { contents: "read", issues: "write" },
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
