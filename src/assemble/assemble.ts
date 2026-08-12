/**
 * B6 — Assembler / serializer. fragments + wiring + top-level scaffold → workflow YAML.
 * Every generated file carries the GENERATED header and is drift-checked.
 *
 * parallel/fan_in diamonds assemble into ONE workflow: the legs as sibling jobs plus
 * the fan_in job joined with GitHub's native `needs:` (see src/wiring/diamond.ts).
 */
import yaml from "js-yaml";
import type {
  EmitContext,
  FoundryConfig,
  GeneratedFile,
  Harness,
  HarnessNode,
  StepSpec,
  WiringPlan,
  WorkflowJobFragment,
} from "../ir/types.js";
import { isUsesStep } from "../ir/types.js";
import { emitFanIn, emitNode } from "../handlers/index.js";
import { detectDiamonds } from "../wiring/diamond.js";

const HEADER =
  "# GENERATED FROM harness.dot — DO NOT EDIT.\n" +
  "# Edit harness.dot / roles / foundry.config.yaml and run `gp-foundry build`.\n";

export function makeActionRef(cfg: FoundryConfig): (name: string) => string {
  const rt = cfg.runtime ?? {};
  if (rt.mode === "vendored") return (n) => `./.github/actions/${n}`;
  const ownerRepo = rt.owner_repo ?? "thegpvc/gp-foundry";
  const ref = rt.ref ?? "v1";
  return (n) => `${ownerRepo}/actions/${n}@${ref}`;
}

function stepToObject(s: StepSpec): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  if (s.name) o.name = s.name;
  if (s.id) o.id = s.id;
  if (s.if) o.if = s.if;
  if (isUsesStep(s)) {
    o.uses = s.uses;
    if (s.with && Object.keys(s.with).length) o.with = s.with;
  } else {
    if (s.shell) o.shell = s.shell;
    if (s.env && Object.keys(s.env).length) o.env = s.env;
    o.run = s.run;
  }
  return o;
}

function displayName(node: HarnessNode): string {
  return String(node.attrs.name ?? node.id);
}

/**
 * A PR check that fails when an agent branch touches an `immutable_paths` entry.
 *
 * scope.yaml calls those paths "CI-enforced", but nothing in the generated output
 * enforced them for PR lanes: agent-fallback strips such edits on the way out,
 * and the merge gate can label a protected-path PR, but neither is a check a
 * reviewer or a branch-protection rule can see. This is that check — scoped to
 * agent branches, since a human editing the harness is the point.
 */
function immutableGuardWorkflow(cfg: FoundryConfig, specDir: string): Record<string, unknown> {
  const scopePath = specDir ? `${specDir.replace(/\/+$/, "")}/agents/scope.yaml` : "agents/scope.yaml";
  return {
    name: "immutable-paths guard",
    on: { pull_request: { types: ["opened", "synchronize", "reopened"] } },
    permissions: { contents: "read" },
    jobs: {
      "immutable-paths": {
        "runs-on": "ubuntu-latest",
        if: `startsWith(github.event.pull_request.head.ref, '${cfg.repo.branch_prefix}')`,
        "timeout-minutes": 5,
        steps: [
          { name: "Checkout", uses: "actions/checkout@v5", with: { "fetch-depth": 0 } },
          {
            name: "Fail if the PR touches an immutable path",
            shell: "bash",
            env: {
              SCOPE_PATH: scopePath,
              BASE_SHA: "${{ github.event.pull_request.base.sha }}",
              HEAD_SHA: "${{ github.event.pull_request.head.sha }}",
            },
            run: [
              `# The immutable_paths list, read without a YAML parser (same scan as`,
              `# the agent-fallback composite).`,
              `PATHS=""`,
              `if [ -f "$SCOPE_PATH" ]; then`,
              `  PATHS=$(awk '`,
              `    /^immutable_paths[[:space:]]*:/ { grab=1; next }`,
              `    grab {`,
              `      if ($0 ~ /^[^[:space:]#][^:]*:/) { grab=0; next }`,
              `      if ($0 ~ /^[[:space:]]*-[[:space:]]*/) {`,
              `        line=$0`,
              `        sub(/^[[:space:]]*-[[:space:]]*/, "", line)`,
              `        sub(/[[:space:]]*#.*$/, "", line)`,
              `        gsub(/^[[:space:]]+|[[:space:]]+$/, "", line)`,
              `        gsub(/^["'\\'']|["'\\'']$/, "", line)`,
              `        if (line != "") print line`,
              `      }`,
              `    }`,
              `  ' "$SCOPE_PATH")`,
              `fi`,
              `if [ -z "$PATHS" ]; then`,
              `  PATHS=".github/workflows/"`,
              `fi`,
              ``,
              `CHANGED=$(git diff --name-only "$BASE_SHA" "$HEAD_SHA")`,
              `VIOLATIONS=""`,
              `while IFS= read -r P; do`,
              `  [ -z "$P" ] && continue`,
              `  HITS=$(printf '%s\\n' "$CHANGED" | grep -F -- "$P" || true)`,
              `  [ -n "$HITS" ] && VIOLATIONS="$VIOLATIONS$HITS"$'\\n'`,
              `done <<< "$PATHS"`,
              ``,
              `if [ -n "$(printf '%s' "$VIOLATIONS" | tr -d '[:space:]')" ]; then`,
              `  echo "::error::This branch changes paths scope.yaml marks immutable:"`,
              `  printf '%s\\n' "$VIOLATIONS" | sed '/^$/d' | sed 's/^/  - /'`,
              `  echo "Agents must never modify these. If the change is intentional, a human"`,
              `  echo "should make it on their own branch."`,
              `  exit 1`,
              `fi`,
              `echo "No immutable paths touched."`,
            ].join("\n"),
          },
        ],
      },
    },
  };
}

export function assemble(ir: Harness, wiring: WiringPlan, specDir = ""): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const actionRef = makeActionRef(ir.config);
  const byId = new Map(ir.nodes.map((n) => [n.id, n] as const));
  const outByNode = new Map<string, typeof ir.edges>();
  const inByNode = new Map<string, typeof ir.edges>();
  for (const n of ir.nodes) {
    outByNode.set(n.id, []);
    inByNode.set(n.id, []);
  }
  for (const e of ir.edges) {
    outByNode.get(e.from)?.push(e);
    inByNode.get(e.to)?.push(e);
  }

  const mkCtx = (node: HarnessNode): EmitContext => ({
    config: ir.config,
    node,
    outEdges: outByNode.get(node.id) ?? [],
    inEdges: inByNode.get(node.id) ?? [],
    actionRef,
    nodeById: (id: string) => byId.get(id),
    specDir,
  });

  const fragmentToJob = (fragment: WorkflowJobFragment, guard?: string): Record<string, unknown> => {
    const job: Record<string, unknown> = { "runs-on": "ubuntu-latest" };
    const g = fragment.if ?? guard;
    if (g) job.if = g;
    if (fragment.environment) job.environment = fragment.environment;
    if (fragment.permissions && Object.keys(fragment.permissions).length) {
      job.permissions = fragment.permissions;
    }
    if (fragment.timeoutMinutes) job["timeout-minutes"] = fragment.timeoutMinutes;
    if (fragment.needs?.length) job.needs = fragment.needs;
    if (fragment.strategy) job.strategy = fragment.strategy;
    job.steps = fragment.steps.map(stepToObject);
    return job;
  };

  const emitFile = (nodeId: string, workflow: Record<string, unknown>): void => {
    const body = yaml.dump(workflow, { lineWidth: -1, noRefs: true, quotingType: '"' });
    files.push({ path: `.github/workflows/${nodeId}.yml`, contents: HEADER + body, generated: true });
  };

  const diamonds = detectDiamonds(ir);

  // The claim scope.yaml makes ("CI-enforced") has to be true out of the box.
  emitFile("immutable-guard", immutableGuardWorkflow(ir.config, specDir));

  for (const node of ir.nodes) {
    if (diamonds.memberIds.has(node.id)) continue; // legs/parallel ride in the fan_in's file
    const nw = wiring.perNode[node.id];
    if (!nw || Object.keys(nw.triggers).length === 0) continue;

    const diamond = diamonds.byFanin.get(node.id);
    if (diamond) {
      const jobs: Record<string, unknown> = {};
      for (const legId of diamond.legIds) {
        const leg = byId.get(legId)!;
        const legFragment = emitNode(leg, ir, mkCtx(leg));
        // The entry-edge guard gates the LEGS; the fan_in is gated by `needs:` instead.
        if (legFragment) jobs[legFragment.jobId] = fragmentToJob(legFragment, nw.guard);
      }
      const prScoped = JSON.stringify(nw.triggers).includes('"pull_request"');
      const fragment = emitFanIn(mkCtx(node), diamond.legIds, prScoped);
      jobs[fragment.jobId] = fragmentToJob(fragment);
      emitFile(node.id, {
        name: displayName(node),
        on: nw.triggers,
        ...(nw.concurrency ? { concurrency: nw.concurrency } : {}),
        permissions: { contents: "read" },
        jobs,
      });
      continue;
    }

    const fragment = emitNode(node, ir, mkCtx(node));
    if (!fragment) continue;
    emitFile(node.id, {
      name: displayName(node),
      on: nw.triggers,
      ...(nw.concurrency ? { concurrency: nw.concurrency } : {}),
      permissions: { contents: "read" },
      jobs: { [fragment.jobId]: fragmentToJob(fragment, nw.guard) },
    });
  }

  return files;
}
