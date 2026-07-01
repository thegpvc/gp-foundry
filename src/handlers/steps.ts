/**
 * Shared step builders used by the node-type handlers (B4). Centralizes the
 * security preamble and the calls into the runtime-core actions so every agent
 * job is assembled the same way.
 *
 * Injection safety: any ${{ github.event.* }} value is passed via `env:` and read
 * as "$VAR" inside run: — never interpolated directly into a run script.
 */
import type { EmitContext, RunStep, StepSpec, UsesStep } from "../ir/types.js";
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

/** Emit the App-token mint step only in App mode. */
export function appTokenStep(ctx: EmitContext): UsesStep | undefined {
  const a = resolveAuth(ctx.config);
  if (a.mode !== "app" || !a.appIdSecret || !a.appKeySecret) return undefined;
  return {
    uses: "actions/create-github-app-token@v3",
    id: "app-token",
    name: "Mint app token",
    with: {
      "app-id": secretRef(a.appIdSecret),
      "private-key": secretRef(a.appKeySecret),
    },
  };
}

export function checkoutStep(ctx: EmitContext, opts: { ref?: string; fetchDepth?: number } = {}): UsesStep {
  const withBlock: Record<string, string | number> = { token: tokenExpr(ctx) };
  if (opts.ref) withBlock.ref = opts.ref;
  if (opts.fetchDepth !== undefined) withBlock["fetch-depth"] = opts.fetchDepth;
  return { uses: "actions/checkout@v5", name: "Checkout", with: withBlock };
}

/** The consumer-owned toolchain composite (literal ./ path — resolves to the consumer repo). */
export function setupStep(): UsesStep {
  return { uses: "./.github/agent-setup", name: "Setup agent toolchain" };
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

export function contextStep(ctx: EmitContext, type: string, numberExpr: string): UsesStep {
  return {
    uses: ctx.actionRef("agent-context"),
    id: "ctx",
    name: "Fetch context",
    with: { type, number: numberExpr, token: tokenExpr(ctx) },
  };
}

export function runAgentStep(ctx: EmitContext, opts: { withContext: boolean }): UsesStep {
  const node = ctx.node;
  const cfg = ctx.config;
  const withBlock: Record<string, string> = {
    "role-file": resolveFile(ctx, node.files.role),
    model: cfg.agent.model,
    "scope-path": resolveFile(ctx, "agents/scope.yaml"),
    "claude-code-oauth-token": secretRef(cfg.agent.oauth_token_secret ?? "CLAUDE_CODE_OAUTH_TOKEN"),
  };
  if (opts.withContext) withBlock["context-file"] = "${{ steps.ctx.outputs.context-file }}";
  const override = node.files.prompt;
  if (override) withBlock["prompt-override-file"] = resolveFile(ctx, override);
  return { uses: ctx.actionRef("run-agent"), name: "Run agent", with: withBlock };
}

/** A guard-safe run step: env holds any untrusted event values, read as "$VAR". */
export function runStep(spec: RunStep): RunStep {
  return { shell: "bash", ...spec };
}

export function isNonEmpty(s: StepSpec | undefined): s is StepSpec {
  return s !== undefined;
}
