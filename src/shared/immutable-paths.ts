/**
 * The one definition of "read `immutable_paths:` out of scope.yaml".
 *
 * Two generated surfaces enforce that list — the PR guard this compiler emits and
 * the `agent-fallback` composite's pre-push strip — and they must agree about
 * which paths are protected. They cannot share a file: `gp-foundry vendor` copies
 * only `action.yml` and `dist/` into a consumer repo, so a shell script sitting
 * next to the composite would never arrive. So the scan lives here, the compiler
 * emits it from here, and a test asserts the copy inside `action.yml` is
 * byte-identical — drift fails CI instead of silently splitting the two controls.
 */

/** The awk program, as the lines that sit between `awk '` and `'`. */
export const IMMUTABLE_PATHS_AWK: string[] = [
  `    /^immutable_paths[[:space:]]*:/ { grab=1; next }`,
  `    grab {`,
  `      # A new top-level key (no leading whitespace, ends with ":") ends the list.`,
  `      if ($0 ~ /^[^[:space:]#][^:]*:/) { grab=0; next }`,
  `      # List item: "  - some/path"`,
  `      if ($0 ~ /^[[:space:]]*-[[:space:]]*/) {`,
  `        line=$0`,
  `        sub(/^[[:space:]]*-[[:space:]]*/, "", line)   # drop the "- " marker`,
  `        sub(/[[:space:]]*#.*$/, "", line)             # drop trailing comment`,
  `        gsub(/^[[:space:]]+|[[:space:]]+$/, "", line)  # trim`,
  `        gsub(/^["'\\'']|["'\\'']$/, "", line)            # drop surrounding quotes`,
  `        if (line != "") print line`,
  `      }`,
  `    }`,
];

/** Strip comments/indentation so two copies can be compared for real drift. */
export function normalizeAwk(program: string): string {
  return program
    .split("\n")
    .map((l) => l.replace(/\s+#.*$/, "").trim())
    .filter((l) => l !== "" && !l.startsWith("#"))
    .join("\n");
}
