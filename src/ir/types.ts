/**
 * gp-foundry — shared contracts (the "public headers").
 *
 * Every component (parser, validator, model-checker, handlers, wiring, assembler,
 * diagram, CLI) depends ONLY on the types in this file — never on another
 * component's implementation. This is what makes the pieces implementable
 * cleanroom and composable.
 */

// ────────────────────────────────────────────────────────────────────────────
// A2 — Harness IR (produced by the parser, consumed by everything downstream)
// ────────────────────────────────────────────────────────────────────────────

/**
 * The mechanical interaction a node has with GitHub. Domain-neutral: the *role*
 * (a job description in `roles/*.md`) carries the domain, not the type.
 *
 * `analyst` is the read-and-advise agent (comment/answer/plan/spec/draft, read-only
 * on code). `issue-agent` and `pr-review` are specializations of `analyst` by
 * context; they are kept as distinct types for now (see design D10).
 */
export type NodeType =
  | "start"
  | "exit"
  | "analyst"
  | "issue-agent"
  | "producer"
  | "pr-review"
  | "pr-fix"
  | "merge-gate"
  | "human-gate"
  | "scheduled-agent"
  | "parallel"
  | "fan_in";

export const AGENT_TYPES: readonly NodeType[] = [
  "analyst",
  "issue-agent",
  "producer",
  "pr-review",
  "pr-fix",
  "scheduled-agent",
];

/** What context an agent node is fed before it runs. */
export type ContextType = "issue" | "pr-diff" | "pr-review" | "codebase" | "none";

export type AttrValue = string | number | boolean;

/** A node in the harness graph. */
export interface HarnessNode {
  id: string;
  type: NodeType;
  /** Context source for agent nodes; defaults are derived from `type`. */
  context?: ContextType;
  /** Typed, small scalar attributes (max_attempts, schedule, environment, output, gates…). */
  attrs: Record<string, AttrValue>;
  /** Referenced content files (never inlined). `role` is the job description. */
  files: { role?: string; prompt?: string; policy?: string; tools?: string };
  /** Original DOT attributes verbatim (round-trip / debugging). */
  raw: Record<string, string>;
  /** 1-indexed source line in harness.dot, for diagnostics. */
  line?: number;
  /** true if introduced by a node statement; false/undefined if only seen in an edge. */
  declared?: boolean;
}

/**
 * A GitHub event that can trigger a node. Open string union so unusual events
 * pass through; the well-known ones are enumerated for guard inference.
 */
export type GithubEvent =
  | "issues.opened"
  | "issues.labeled"
  | "issue_comment.created"
  | "pull_request.opened"
  | "pull_request.synchronize"
  | "pull_request.labeled"
  | "pull_request.closed"
  | "pull_request_review.submitted"
  | "push"
  | "schedule"
  | "workflow_dispatch"
  | (string & {});

/** A directed transition/loop between two nodes. */
export interface HarnessEdge {
  from: string;
  to: string;
  /** GitHub event that fires this transition (explicit; may be inferred from `when`). */
  on?: GithubEvent;
  /** GitHub-observable guard: e.g. "label=agent", "verdict=approve", "ci=pass", "attempts>=3". */
  when?: string;
  /** Optional explicit dispatch action (e.g. cross-workflow `workflow_dispatch`). */
  do?: string;
  raw: Record<string, string>;
  line?: number;
}

/**
 * How the harness authenticates to GitHub for writes (commits, PRs, comments).
 *  - "app": GitHub App installation token (bot identity; downstream events cascade).
 *  - "pat": a fine-grained/classic PAT secret used directly (events cascade).
 *  - "github-token": the built-in GITHUB_TOKEN — zero setup, but pushes/PRs made
 *    with it do NOT trigger other workflows, so chained stages won't cascade.
 */
export interface AuthConfig {
  mode: "app" | "pat" | "github-token";
  app_id_secret?: string;
  app_key_secret?: string;
  /** name of the secret holding a PAT, for mode "pat". */
  token_secret?: string;
}

/** Consumer-repo global config (from foundry.config.yaml). */
export interface FoundryConfig {
  name: string;
  /** authentication for GitHub writes; falls back to app (if identity secrets set) else github-token. */
  auth?: AuthConfig;
  identity: {
    app_id_secret?: string;
    app_key_secret?: string;
    bot_login?: string;
    git_name?: string;
    git_email?: string;
  };
  agent: { cli: string; model: string; oauth_token_secret?: string; conventions?: string };
  repo: { base_branch: string; branch_prefix: string };
  /** semantic role -> repo label (the drift-killer). */
  labels: Record<string, string>;
  /** parseable markers shared by prompts + guards + enforcers. */
  markers?: Record<string, string>;
  size?: { warn_additions?: number; hard_additions?: number; exclude_globs?: string[] };
  /** How generated workflows reference the runtime-core actions. */
  runtime?: { mode?: "pinned" | "vendored"; ref?: string; owner_repo?: string };
  [k: string]: unknown;
}

/** The parsed, resolved harness. The single source of truth in memory. */
export interface Harness {
  name: string;
  nodes: HarnessNode[];
  edges: HarnessEdge[];
  config: FoundryConfig;
  sourcePath?: string;
}

/** A role/job-description (front-matter of roles/*.md). */
export interface RoleHandoff {
  to: string;
  when?: string;
}
export interface RoleSpec {
  role: string;
  type?: NodeType;
  mission?: string;
  accountable_for?: string[];
  inputs?: string[];
  outputs?: string[];
  handoffs?: RoleHandoff[];
  tools?: string;
  quality_bar?: string;
  [k: string]: unknown;
}

// ────────────────────────────────────────────────────────────────────────────
// B2 / B3 — Diagnostics
// ────────────────────────────────────────────────────────────────────────────

export type DiagLevel = "error" | "warning" | "info";

export interface Diagnostic {
  level: DiagLevel;
  /** stable machine code, e.g. "edge.unknown-node", "graph.unbounded-loop". */
  code: string;
  message: string;
  where?: { node?: string; edge?: [string, string]; file?: string; line?: number };
  hint?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// B4 / B6 — Emitter contracts (node-type handler -> job fragment -> YAML)
// ────────────────────────────────────────────────────────────────────────────

export type Permission = "read" | "write" | "none";

export interface UsesStep {
  uses: string;
  id?: string;
  name?: string;
  if?: string;
  with?: Record<string, AttrValue>;
}

export interface RunStep {
  run: string;
  id?: string;
  name?: string;
  if?: string;
  shell?: string;
  env?: Record<string, string>;
}

export type StepSpec = UsesStep | RunStep;

export function isUsesStep(s: StepSpec): s is UsesStep {
  return (s as UsesStep).uses !== undefined;
}

/** A single job, produced by a node-type Handler, consumed by the Assembler. */
export interface WorkflowJobFragment {
  jobId: string;
  name?: string;
  permissions: Record<string, Permission>;
  needs?: string[];
  /** GitHub Environment (for human-gate / protected deploys). */
  environment?: string;
  /** Job-level guard. */
  if?: string;
  strategy?: { matrix?: Record<string, AttrValue[]>; "max-parallel"?: number };
  steps: StepSpec[];
  timeoutMinutes?: number;
}

/** Everything a Handler needs, resolved by the compiler, to emit a fragment. */
export interface EmitContext {
  config: FoundryConfig;
  node: HarnessNode;
  outEdges: HarnessEdge[];
  inEdges: HarnessEdge[];
  /** Resolve a runtime-core action reference (pinned full path or vendored ./ path). */
  actionRef: (name: string) => string;
  /** Directory of harness.dot relative to the repo root (e.g. ".github"); prefixes file paths. */
  specDir: string;
}

export interface Handler {
  type: NodeType;
  emit(node: HarnessNode, ir: Harness, ctx: EmitContext): WorkflowJobFragment;
}

// ────────────────────────────────────────────────────────────────────────────
// B5 — Wiring (edges -> per-workflow triggers + guards + dispatches)
// ────────────────────────────────────────────────────────────────────────────

/** The `on:`/`if:`/concurrency wiring the assembler needs for one node's workflow. */
export interface NodeWiring {
  nodeId: string;
  /** The `on:` block for the generated workflow file. */
  triggers: Record<string, unknown>;
  /** Job-level `if:` guard combining incoming edges' `when=`. */
  guard?: string;
  concurrency?: { group: string; "cancel-in-progress": boolean };
  /** Cross-workflow dispatches this node performs (e.g. Janitor -> Fixer). */
  dispatches: { toNode: string; when?: string }[];
}

export interface WiringPlan {
  /** One entry per node that owns a generated workflow file. */
  perNode: Record<string, NodeWiring>;
}

// ────────────────────────────────────────────────────────────────────────────
// B6 — Assembler output
// ────────────────────────────────────────────────────────────────────────────

export interface GeneratedFile {
  /** Path relative to the consumer repo, e.g. .github/workflows/builder.yml */
  path: string;
  contents: string;
  /** true for machine-generated, drift-checked files. */
  generated: boolean;
}
