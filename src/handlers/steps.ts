/**
 * Shared step builders used by the node-type handlers (B4). Centralizes the
 * security preamble and the calls into the runtime-core actions so every agent
 * job is assembled the same way.
 *
 * Injection safety: any ${{ github.event.* }} value is passed via `env:` and read
 * as "$VAR" inside run: — never interpolated directly into a run script.
 */
import type { EmitContext, HarnessNode, Permission, RunStep, StepSpec, UsesStep } from "../ir/types.js";
import { hasPrContext } from "./attrs.js";
import { resolveAuth } from "../auth/auth.js";

export function secretRef(name: string): string {
  return `\${{ secrets.${name} }}`;
}

/** Prefix a spec-relative file path with the spec dir so it resolves from the repo root. */
export function resolveFile(ctx: EmitContext, rel: string | undefined): string {
  if (!rel) return "";
  const dir = ctx.specDir?.replace(/\/+$/, "");
  return dir ? `${dir}/${rel}` : rel;
}

/** The token expression for a job, per the configured auth mode. */
export function tokenExpr(ctx: EmitContext): string {
  const a = resolveAuth(ctx.config);
  if (a.mode === "app") return "${{ steps.app-token.outputs.token }}";
  if (a.mode === "pat") return secretRef(a.tokenSecret ?? "AGENT_PAT");
  return "${{ github.token }}";
}

/**
 * Repository permissions an App installation token can be narrowed to. A job's
 * `permissions:` block also carries GITHUB_TOKEN-only scopes (`id-token`), which
 * are not App permissions and must not be requested of the App.
 */
const APP_PERMISSIONS = new Set([
  "actions", "checks", "contents", "deployments", "issues", "packages",
  "pages", "pull-requests", "security-events", "statuses", "workflows",
]);

/**
 * Emit the App-token mint step only in App mode.
 *
 * `scope` narrows the token to what the lane can use. Without it the token
 * carries every permission the App was installed with — on a real install that
 * has included `actions: write` and security read scopes — and that token sits
 * in the environment of an agent reading untrusted PR text. A lane whose needs
 * are open-ended (a scheduled maintenance agent, the merge gate) passes none.
 */
export function appTokenStep(ctx: EmitContext, scope?: Record<string, Permission>): UsesStep | undefined {
  const a = resolveAuth(ctx.config);
  if (a.mode !== "app" || !a.appIdSecret || !a.appKeySecret) return undefined;
  const withBlock: Record<string, string> = {
    // `app-id` is deprecated in favour of `client-id`; the input takes either an
    // App's client id or its numeric id, so the consumer's secret is unchanged.
    "client-id": secretRef(a.appIdSecret),
    "private-key": secretRef(a.appKeySecret),
  };
  for (const [name, level] of Object.entries(scope ?? {})) {
    if (APP_PERMISSIONS.has(name) && level !== "none") withBlock[`permission-${name}`] = level;
  }
  return {
    uses: "actions/create-github-app-token@v3",
    id: "app-token",
    name: "Mint app token",
    with: withBlock,
  };
}

/** Where a lane's base-ref copy of the harness files is checked out (inside the workspace). */
export const HARNESS_DIR = ".gp-foundry/harness";

/**
 * Should this node read its harness files (role, prompt, scope, comms, the
 * agent-setup composite, vendored actions) from the PR's BASE ref?
 *
 * Yes for every lane handed a pull request, unless `harness_ref="head"`. Read
 * from the head, those files are whatever the PR says they are: a branch cut
 * before the harness merged has none and dies at setup, and a PR that edits
 * `.github/agents/` is reviewed under its own edit — by an agent holding secrets.
 */
export function harnessFromBase(node: HarnessNode, prScoped = false): boolean {
  if (node.attrs.harness_ref === "head") return false;
  return (
    prScoped ||
    node.type === "pr-fix" ||
    ((node.type === "pr-review" || node.type === "analyst") && hasPrContext(node))
  );
}

/**
 * The second checkout: the base ref's harness directories, sparse and shallow,
 * into HARNESS_DIR. Returns the steps plus the EmitContext every later step
 * builder must use — its specDir / actionRef / harnessRoot point at the copy.
 * The PR head stays the working tree the agent reads and edits.
 */
export function harnessCheckout(ctx: EmitContext, baseRef: string): { ctx: EmitContext; steps: StepSpec[] } {
  const vendored = ctx.config.runtime?.mode === "vendored";
  const spec = ctx.specDir.replace(/\/+$/, "");
  const files = [ctx.node.files.role, ctx.node.files.prompt, "agents/scope.yaml", "agents/communication.md"]
    .filter((f): f is string => !!f)
    .map((f) => (spec ? `${spec}/${f}` : f));
  const dirs = new Set<string>([".github/agent-setup"]);
  if (vendored) dirs.add(".github/actions");
  for (const f of files) {
    const dir = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "";
    if (dir) dirs.add(dir); // a file at the repo root is always in a cone-mode checkout
  }
  // Cone mode takes directories; drop any that sit inside another on the list.
  const all = [...dirs].sort();
  const sparse = all.filter((d) => !all.some((o) => o !== d && d.startsWith(`${o}/`)));

  const steps: StepSpec[] = [
    {
      uses: "actions/checkout@v5",
      name: "Checkout harness files (base ref)",
      with: {
        ref: baseRef,
        path: HARNESS_DIR,
        "fetch-depth": 1,
        "sparse-checkout": sparse.join("\n"),
        token: tokenExpr(ctx),
        // Read once and never fetched from again: no credential is left behind.
        "persist-credentials": false,
      },
    },
    runStep({
      name: "Keep the harness copy out of the working tree",
      // It lives inside the workspace because a local `uses:` path must; without
      // this a lane that commits (`git add -A`) would sweep it into the PR.
      run: `mkdir -p .git/info\necho "/${HARNESS_DIR.split("/")[0]}/" >> .git/info/exclude`,
    }),
  ];
  const actionRef = vendored ? (n: string) => `./${HARNESS_DIR}/.github/actions/${n}` : ctx.actionRef;
  return {
    ctx: { ...ctx, specDir: spec ? `${HARNESS_DIR}/${spec}` : HARNESS_DIR, harnessRoot: HARNESS_DIR, actionRef },
    steps,
  };
}

export function checkoutStep(
  ctx: EmitContext,
  opts: { ref?: string; fetchDepth?: number; persistCredentials?: boolean } = {},
): UsesStep {
  const withBlock: Record<string, string | number | boolean> = { token: tokenExpr(ctx) };
  if (opts.ref) withBlock.ref = opts.ref;
  // A lane that never pushes has no use for the token actions/checkout leaves in
  // .git/config — and an agent with a shell can read it there.
  if (opts.persistCredentials === false) withBlock["persist-credentials"] = false;
  if (ctx.node.attrs.checkout === "partial") {
    // checkout="partial": a blob-less partial clone. Every commit and tree is
    // fetched, so `git log`, `git blame` and merge-base diffs work as in a full
    // clone, but file contents arrive on demand — the cost of history without
    // the cost of every version of every file. It overrides the lane's default
    // depth: a shallow blob-less clone would have no history to be cheap about.
    withBlock["fetch-depth"] = 0;
    withBlock.filter = "blob:none";
  } else if (opts.fetchDepth !== undefined) {
    withBlock["fetch-depth"] = opts.fetchDepth;
  }
  return { uses: "actions/checkout@v5", name: "Checkout", with: withBlock };
}

/**
 * The consumer-owned toolchain composite (literal ./ path — resolves to the
 * consumer repo). From the base-ref copy when the lane has one: this composite
 * runs with the job's secrets in reach, so it must not be the PR's own version.
 */
export function setupStep(ctx?: EmitContext): UsesStep {
  const root = ctx?.harnessRoot ? `./${ctx.harnessRoot}` : ".";
  return { uses: `${root}/.github/agent-setup`, name: "Setup agent toolchain" };
}

/**
 * Whether an analyst-family lane's checkout keeps its credential. Off by
 * default — except for checkout="partial", whose on-demand blob fetches need it.
 */
export function analystPersistsCredentials(node: HarnessNode): boolean {
  const v = node.attrs.persist_credentials;
  if (typeof v === "boolean") return v;
  return node.attrs.checkout === "partial";
}

/**
 * Can a role with this `tools:` allowlist run `gh`? Unknown tools (role not
 * readable at compile time) and an unrestricted `Bash` both count as yes: the
 * question is only ever used to WITHHOLD the token, so it errs towards passing it.
 */
export function roleCanUseGh(tools: string | undefined): boolean {
  if (tools === undefined) return true;
  return tools.split(",").some((t) => {
    const tool = t.trim();
    return tool === "Bash" || /^Bash\(\s*gh\b/.test(tool);
  });
}

/** Set the git author identity from config so the agent's commits succeed on a fresh runner. */
export function gitIdentityStep(ctx: EmitContext): RunStep {
  const id = ctx.config.identity;
  const name = id.git_name ?? id.bot_login ?? "gp-foundry agent";
  const email = id.git_email ?? `${id.bot_login ?? "gp-foundry-agent"}@users.noreply.github.com`;
  return runStep({
    name: "Configure git identity",
    env: { GIT_NAME: name, GIT_EMAIL: email },
    run: 'git config user.name "$GIT_NAME"\ngit config user.email "$GIT_EMAIL"',
  });
}

export function contextStep(
  ctx: EmitContext,
  type: string,
  numberExpr: string,
  opts: { framing?: "work-item" | "baseline"; checks?: boolean } = {},
): UsesStep {
  const withBlock: Record<string, string> = { type, number: numberExpr, token: tokenExpr(ctx) };
  // Check-run conclusions are read with GITHUB_TOKEN (the job declares
  // `checks: read`): the Checks permission has no fine-grained-PAT equivalent.
  if (opts.checks) withBlock["checks-token"] = "${{ github.token }}";
  // The reviewer bot's own posts are the harness talking to itself. Without this
  // the Fixer reads its own work item under a banner telling it never to follow
  // the instructions inside — see agent-context's trusted-authors input.
  const bot = ctx.config.identity?.bot_login;
  if (bot) {
    withBlock["trusted-authors"] = bot;
    // How the bot's own posts are introduced: the Fixer's work item (the action's
    // default), or — for a lane re-reading its own output — a baseline.
    if (opts.framing === "baseline") withBlock["trusted-framing"] = "baseline";
  }
  return {
    uses: ctx.actionRef("agent-context"),
    id: "ctx",
    name: "Fetch context",
    with: withBlock,
  };
}

export function runAgentStep(ctx: EmitContext, opts: { withContext: boolean; outputContract?: string }): UsesStep {
  const node = ctx.node;
  const cfg = ctx.config;
  const withBlock: Record<string, string> = {
    "role-file": resolveFile(ctx, node.files.role),
    model: cfg.agent.model,
    "comms-file": resolveFile(ctx, "agents/communication.md"),
    "scope-path": resolveFile(ctx, "agents/scope.yaml"),
    // One credential, never both: an API key (usage-billed, not tied to a person)
    // replaces the OAuth token (bound to one subscription seat) when configured.
    ...(cfg.agent.api_key_secret
      ? { "anthropic-api-key": secretRef(cfg.agent.api_key_secret) }
      : { "claude-code-oauth-token": secretRef(cfg.agent.oauth_token_secret ?? "CLAUDE_CODE_OAUTH_TOKEN") }),
  };
  // The token in the agent's environment is what turns any shell escape into
  // token theft, so a role whose tools cannot run `gh` is not handed one. It is
  // withheld HERE, not dropped inside run-agent: a variable unset in a shell is
  // still readable from that shell's /proc environ. The cost is that giving a
  // role `gh` later needs a rebuild — `build --check` flags the drift.
  // post="review" (outputContract set): a workflow step posts what the agent
  // prints, so the agent gets no token whatever its role's tools say.
  if (!opts.outputContract && roleCanUseGh(ctx.roleTools?.(node.id))) withBlock["github-token"] = tokenExpr(ctx);
  if (opts.outputContract) withBlock["output-contract"] = opts.outputContract;
  // repo_guides=false: keep the repo's CLAUDE.md / AGENTS.md out of every turn.
  if (node.attrs.repo_guides === false) withBlock["repo-guides"] = "false";
  if (opts.withContext) withBlock["context-file"] = "${{ steps.ctx.outputs.context-file }}";
  // Optional repo-wide conventions string from config (inserted before the scope).
  if (cfg.agent.conventions) withBlock["conventions"] = cfg.agent.conventions;
  // Extra secrets exposed in the agent's environment: the global config.agent.secrets
  // (every lane) unioned with this node's `secrets="A,B"` attr (this lane only). Per-node
  // scoping is least-privilege — e.g. a Sentry token only on the sweeper, not on the
  // web-capable advisory lanes where it would just widen the exfiltration surface. The
  // composite has no secrets context, so VALUES are resolved here as NAME=${{ secrets.NAME }}
  // and run-agent exports them before the CLI.
  const nodeSecrets =
    typeof node.attrs.secrets === "string"
      ? node.attrs.secrets.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
  const secrets = [...new Set([...(cfg.agent.secrets ?? []), ...nodeSecrets])];
  if (secrets.length) {
    withBlock["extra-env"] = secrets.map((name) => `${name}=${secretRef(name)}`).join("\n");
  }
  // How many times run-agent invokes the CLI when it fails TRANSIENTLY (5xx,
  // overloaded, dropped connection). A genuine agent error and a usage-limit wall
  // are never retried, so this only trades a little wall-clock for not reddening a
  // lane on a server-side blip. Per-node because retrying re-runs the whole role,
  // which is safe only for a role that reads current state before acting — the
  // assumption the harness already makes when a cron, agent_refire or the
  // supervisor re-drives a lane. A role with an unconditional side effect (posting
  // a digest, say) sets agent_attempts=1 so a partial run is never repeated.
  //
  // Deliberately NOT named max_attempts: that attr is the pr-fix fix↔review loop
  // bound, counted from submitted reviews. Sharing the name would silently couple
  // two unrelated budgets — dropping the Fixer's loop bound to 1 would also
  // disable its transient retry.
  const agentAttempts = node.attrs.agent_attempts;
  if (agentAttempts !== undefined) withBlock["max-attempts"] = String(agentAttempts);
  const override = node.files.prompt;
  if (override) withBlock["prompt-override-file"] = resolveFile(ctx, override);
  return {
    uses: ctx.actionRef("run-agent"),
    ...(opts.outputContract ? { id: "agent" } : {}),
    name: "Run agent",
    with: withBlock,
  };
}

/** A guard-safe run step: env holds any untrusted event values, read as "$VAR". */
export function runStep(spec: RunStep): RunStep {
  return { shell: "bash", ...spec };
}

export function isNonEmpty(s: StepSpec | undefined): s is StepSpec {
  return s !== undefined;
}
