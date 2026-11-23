/**
 * The semver level of a dependency update, for the merge gate's dependabot lane
 * and as context for an agent judging the update. Pure and dependency-free: the
 * actions bundle it too.
 */

/** Semver level of a dependabot bump; "unknown" when it cannot be classified. */
export type DependabotBump = "patch" | "minor" | "major" | "unknown";

/** The exact author login a genuine dependabot PR carries. */
export const DEPENDABOT_LOGIN = "dependabot[bot]";

/**
 * Classify a dependabot PR title ("Bump X from 1.2.3 to 1.3.0") by semver level.
 * Group/monorepo updates and non-semver versions yield "unknown", which the lane
 * treats as needs-a-human — the safe default.
 */
export function parseDependabotBump(title?: string): DependabotBump {
  if (!title) return "unknown";
  const m = /\bfrom\s+v?(\d+)\.(\d+)\.(\d+)[^\s]*\s+to\s+v?(\d+)\.(\d+)\.(\d+)/i.exec(title);
  if (!m) return "unknown";
  const from = [Number(m[1]), Number(m[2]), Number(m[3])];
  const to = [Number(m[4]), Number(m[5]), Number(m[6])];
  if (to[0] !== from[0]) return "major";
  if (to[1] !== from[1]) return "minor";
  return "patch";
}

const RANK: Record<DependabotBump, number> = { patch: 0, minor: 1, major: 2, unknown: 3 };

/** `MAJOR.MINOR.PATCH`, with an optional `v` and pre-release/build suffix; anything else is not semver. */
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.+-]*)?$/;

/** The semver level between two versions; "unknown" unless both are `MAJOR.MINOR.PATCH`. */
function levelBetween(from: string, to: string): DependabotBump {
  const a = SEMVER.exec(from);
  const b = SEMVER.exec(to);
  if (!a || !b) return "unknown";
  if (a[1] !== b[1]) return "major";
  if (a[2] !== b[2]) return "minor";
  return "patch";
}

/** One dependency a dependabot commit updates, with its versions where the message names them. */
export interface DependabotUpdate {
  name: string;
  from?: string;
  to?: string;
}

export interface DependabotUpdates {
  /** The highest level among the updates; "unknown" when any of them cannot be classified. */
  level: DependabotBump;
  /** Every dependency in the `updated-dependencies` blocks, in order. Empty when there is no block. */
  updates: DependabotUpdate[];
}

/**
 * The "from X to Y" lines dependabot writes in a commit body, by dependency
 * name: "Bumps [name](url) from X to Y." for a single update, "Updates `name`
 * from X to Y" for each one of several.
 */
function versionLines(message: string): Map<string, { from: string; to: string }[]> {
  const out = new Map<string, { from: string; to: string }[]>();
  const line = /^(?:Bumps \[([^\]]+)\]\([^)]*\)|Bumps (\S+)|Updates `([^`]+)`) from (\S+) to (\S+?)\.?$/gm;
  for (let m = line.exec(message); m; m = line.exec(message)) {
    const name = (m[1] ?? m[2] ?? m[3])!;
    out.set(name, [...(out.get(name) ?? []), { from: m[4]!, to: m[5]! }]);
  }
  return out;
}

/**
 * Classify an update from the `updated-dependencies` block dependabot writes
 * into its commit messages, one entry per dependency. A grouped update ("Bump
 * the X group with 3 updates") has no versions in its title but every
 * dependency in that block, so it is classified as the HIGHEST level present:
 * one major among three patches is a major update.
 *
 * Each entry's level comes from, in order:
 *   1. its `update-type: version-update:semver-<level>` line. Version updates
 *      carry one; SECURITY updates never do (#57).
 *   2. the versions the commit body names for that dependency ("Bumps [name](…)
 *      from X to Y.", "Updates `name` from X to Y"), when both are
 *      MAJOR.MINOR.PATCH. Named more than once (several directories): the highest.
 *   3. for the only entry of the only block, the title's versions ("Bump name
 *      from X to Y") — how a single update was classified before there was a block to read.
 *
 * An entry none of these classifies makes the whole update "unknown", which
 * outranks major — an unclassified dependency is never read as a safe one. A
 * title that names versions counts too: the higher of the two levels wins. No
 * block in any message: the title decides (parseDependabotBump).
 *
 * Callers pass only the messages of commits GitHub made for the bot (see
 * isGitHubSignedBy): anyone who can push could write such a block.
 */
export function parseDependabotUpdates(messages: string[], title?: string): DependabotUpdates {
  const fromTitle = parseDependabotBump(title);
  const entries: { update: DependabotUpdate; level: DependabotBump }[] = [];
  for (const message of messages) {
    const lines = message.split(/\r?\n/);
    const start = lines.findIndex((l) => /^\s*updated-dependencies:\s*$/.test(l));
    if (start < 0) continue;
    const named = versionLines(message);
    // The block runs to the YAML document end (`...`) or the first line that is
    // neither indented nor a list item.
    let entry: { update: DependabotUpdate; level: DependabotBump; typed: boolean } | undefined;
    const close = () => {
      if (!entry) return;
      const versions = named.get(entry.update.name) ?? [];
      if (versions.length) {
        // Shown to the agent: the pair with the highest level (the same one, in one directory).
        let top = versions[0]!;
        for (const v of versions) if (RANK[levelBetween(v.from, v.to)] > RANK[levelBetween(top.from, top.to)]) top = v;
        entry.update.from = top.from;
        entry.update.to = top.to;
        if (!entry.typed) entry.level = levelBetween(top.from, top.to);
      }
      entries.push({ update: entry.update, level: entry.level });
      entry = undefined;
    };
    for (const raw of lines.slice(start + 1)) {
      if (/^\s*\.\.\.\s*$/.test(raw) || (raw.trim() && !/^[\s-]/.test(raw))) break;
      const name = /^\s*-\s*dependency-name:\s*(.*?)\s*$/.exec(raw);
      if (name) {
        close();
        entry = { update: { name: name[1]!.replace(/^(["'])(.*)\1$/, "$2") }, level: "unknown", typed: false };
        continue;
      }
      const t = /^\s*-?\s*update-type:\s*version-update:semver-(patch|minor|major)\s*$/.exec(raw);
      if (t && entry) {
        entry.level = t[1] as DependabotBump;
        entry.typed = true;
      }
    }
    close();
  }
  if (!entries.length) return { level: fromTitle, updates: [] };
  // A single update whose body names no versions: the title's, as before the block was read.
  if (entries.length === 1 && entries[0]!.level === "unknown" && entries[0]!.update.from === undefined) entries[0]!.level = fromTitle;
  let level: DependabotBump = "patch";
  for (const e of entries) if (RANK[e.level] > RANK[level]) level = e.level;
  // The title too, when it names versions: whichever of the two is higher. A
  // grouped title names none, and then the block alone decides.
  if (fromTitle !== "unknown" && RANK[fromTitle] > RANK[level]) level = fromTitle;
  return { level, updates: entries.map((e) => e.update) };
}

/** A name or version that can travel through a workflow's scripts as one word. */
const WORD = /^[A-Za-z0-9@/._:+~-]+$/;

/**
 * The updates as one word for a workflow matrix: `name>from>to`, comma-separated
 * (the scripts that carry it split fields on whitespace). Undefined unless every
 * update has both versions and nothing in it needs quoting, or beyond 50 of them:
 * the list is context for the agent, and half a list would mislead it.
 */
export function encodeDependabotUpdates(updates: DependabotUpdate[]): string | undefined {
  if (!updates.length || updates.length > 50) return undefined;
  const parts: string[] = [];
  for (const u of updates) {
    if (u.from === undefined || u.to === undefined || ![u.name, u.from, u.to].every((w) => WORD.test(w))) return undefined;
    parts.push(`${u.name}>${u.from}>${u.to}`);
  }
  return parts.join(",");
}

/** The level alone (parseDependabotUpdates), for the merge gate's dependabot lane. */
export function parseDependabotUpdateType(messages: string[], title?: string): DependabotBump {
  return parseDependabotUpdates(messages, title).level;
}
