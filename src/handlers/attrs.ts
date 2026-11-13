/**
 * Parsers for the structured node attributes (`gates=`, `skip=`, `select=`,
 * `checkout=`). Shared by the handlers, the wiring and validate(), so the three
 * cannot disagree about what a value means. Each parser throws on a malformed
 * value; validate() turns that into an error diagnostic, and the emitters catch
 * it and fall back to "attribute absent" so assemble stays non-throwing.
 */
import type { HarnessNode } from "../ir/types.js";

// ── gates= ───────────────────────────────────────────────────────────────────

export interface GateSpec {
  /** The workflow file name or the check-run name, without any `?N` suffix. */
  name: string;
  /** A `.yml`/`.yaml` entry waits on a workflow; anything else on a check-run. */
  kind: "workflow" | "check";
  /** `?N` — seconds to wait for the target to APPEAR before concluding `skipped`. */
  graceSeconds?: number;
}

/**
 * `gates="ci.yml, lint / eslint, e2e (chromium)?90"`. An entry that names a
 * workflow file waits on that workflow's runs; any other entry is a check-run
 * name. A trailing `?N` is the grace, in seconds, for a target that may never
 * appear on this head (a path-filtered or conditional check).
 */
export function parseGates(node: HarnessNode): GateSpec[] {
  const raw = node.attrs.gates;
  if (raw === undefined) return [];
  if (typeof raw !== "string") {
    throw new Error(`node '${node.id}': gates= must be a string like "ci.yml" or "lint?90"`);
  }
  const out: GateSpec[] = [];
  for (const entry of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^(.*?)(?:\?([^?]*))?$/.exec(entry)!;
    const name = m[1]!.trim();
    const grace = m[2];
    if (!name) {
      throw new Error(`node '${node.id}': gates= entry '${entry}' names no workflow or check`);
    }
    const spec: GateSpec = { name, kind: /\.ya?ml$/i.test(name) ? "workflow" : "check" };
    if (grace !== undefined) {
      if (!/^[1-9]\d*$/.test(grace.trim())) {
        throw new Error(
          `node '${node.id}': gates= entry '${entry}' has a bad grace suffix — expected '?<seconds>' with a whole number >= 1, e.g. "${name}?90"`,
        );
      }
      spec.graceSeconds = Number(grace.trim());
    }
    out.push(spec);
  }
  return out;
}

/** parseGates for emitters: a malformed attr is validate()'s to report. */
export function gatesOf(node: HarnessNode): GateSpec[] {
  try {
    return parseGates(node);
  } catch {
    return [];
  }
}

// ── skip= ────────────────────────────────────────────────────────────────────

export type SkipCondition =
  | { kind: "draft" }
  | { kind: "bot-author" }
  | { kind: "label"; label: string }
  | { kind: "unchanged-diff" };

/** `skip="draft,bot-author,label:no-agent-review,unchanged-diff"`. */
export function parseSkip(node: HarnessNode): SkipCondition[] {
  const raw = node.attrs.skip;
  if (raw === undefined) return [];
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error(`node '${node.id}': skip= must be a non-empty string like "draft,unchanged-diff"`);
  }
  const out: SkipCondition[] = [];
  const seen = new Set<string>();
  for (const entry of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    if (entry === "draft" || entry === "bot-author" || entry === "unchanged-diff") {
      out.push({ kind: entry });
    } else if (entry.startsWith("label:") && entry.slice("label:".length).trim()) {
      out.push({ kind: "label", label: entry.slice("label:".length).trim() });
    } else {
      throw new Error(
        `node '${node.id}': unknown skip= entry '${entry}' — expected draft, bot-author, label:<key> or unchanged-diff`,
      );
    }
  }
  if (!out.length) throw new Error(`node '${node.id}': skip= has no entries`);
  return out;
}

/** parseSkip for emitters: a malformed attr is validate()'s to report. */
export function skipOf(node: HarnessNode): SkipCondition[] {
  try {
    return parseSkip(node);
  } catch {
    return [];
  }
}

// ── context / select= / checkout= ────────────────────────────────────────────

/** A node whose job is handed a pull request (the context an analyst emits for). */
export function hasPrContext(node: HarnessNode): boolean {
  return node.context === "pr-diff" || node.context === "pr-review";
}

/**
 * `select="sweep"` on a scheduled pr-review: instead of reacting to one PR's
 * event, the lane runs on its cron and picks the PRs to review itself. True only
 * for the fully-formed combination, so a half-configured node (validate() errors
 * on it) compiles exactly as it did before rather than as a broken sweep.
 */
export function isSweep(node: HarnessNode): boolean {
  return (
    node.attrs.select === "sweep" &&
    node.type === "pr-review" &&
    hasPrContext(node) &&
    node.attrs.schedule !== undefined
  );
}

/** A skip guard is emitted for an event-driven PR analyst (never a sweep). */
export function hasSkipGuard(node: HarnessNode): boolean {
  return (
    (node.type === "pr-review" || node.type === "analyst") &&
    hasPrContext(node) &&
    node.attrs.schedule === undefined &&
    skipOf(node).length > 0
  );
}

/** The job that decides whether (or for which PRs) the node's own job runs. */
export function preJobId(node: HarnessNode): string {
  return isSweep(node) ? `${node.id}_select` : `${node.id}_guard`;
}

/**
 * `<!-- gp-foundry:diff:<node>:` — the prefix of the marker a reviewed diff's
 * hash is stamped into the review with. Node-scoped, so two review lanes that
 * post as the same bot never read each other's stamp.
 */
export function diffMarkerPrefix(node: HarnessNode): string {
  return `<!-- gp-foundry:diff:${node.id}:`;
}

/** The marker every verdict review carries; a sweep reads it as "decided". */
export const VERDICT_MARKER = "**Verdict:**";
