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

/**
 * Classify an update from the `updated-dependencies` block dependabot writes
 * into its commit messages, one entry per dependency, each with an
 * `update-type: version-update:semver-<level>`. A grouped update ("Bump the X
 * group with 3 updates") has no versions in its title but every level in that
 * block, so it is classified as the HIGHEST level present: one major among
 * three patches is a major update.
 *
 * An entry without a recognisable level makes the whole update "unknown", which
 * outranks major — an unclassified dependency is never read as a safe one. A
 * title that names versions counts too: the higher of the two levels wins. No
 * block in any message: the title decides (parseDependabotBump).
 *
 * Callers pass only the messages of commits GitHub made for the bot (see
 * isGitHubSignedBy): anyone who can push could write such a block.
 */
export function parseDependabotUpdateType(messages: string[], title?: string): DependabotBump {
  let found = false;
  let level: DependabotBump = "patch";
  for (const message of messages) {
    const lines = message.split(/\r?\n/);
    const start = lines.findIndex((l) => /^\s*updated-dependencies:\s*$/.test(l));
    if (start < 0) continue;
    // The block runs to the YAML document end (`...`) or the first line that is
    // neither indented nor a list item.
    let entries = 0;
    let typed = 0;
    for (const raw of lines.slice(start + 1)) {
      if (/^\s*\.\.\.\s*$/.test(raw) || (raw.trim() && !/^[\s-]/.test(raw))) break;
      if (/^\s*-\s*dependency-name:/.test(raw)) entries++;
      const t = /^\s*-?\s*update-type:\s*version-update:semver-(patch|minor|major)\s*$/.exec(raw);
      if (t) {
        typed++;
        if (RANK[t[1] as DependabotBump] > RANK[level]) level = t[1] as DependabotBump;
      }
    }
    if (!entries) continue;
    found = true;
    if (typed < entries) return "unknown";
  }
  // The title too, when it names versions: whichever of the two is higher. A
  // grouped title names none, and then the block alone decides.
  const fromTitle = parseDependabotBump(title);
  if (!found) return fromTitle;
  return fromTitle !== "unknown" && RANK[fromTitle] > RANK[level] ? fromTitle : level;
}
