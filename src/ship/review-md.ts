/**
 * POC — resolve a Claude Ship `REVIEW.md` the way Code Review reads it: the root
 * file, with each line that is only `@<file>` replaced by that file. A reviewer
 * lane can then take the result as repo-specific review guidance.
 *
 * Follows the documented limits, so what gp-foundry's reviewer sees is what
 * Code Review would see: at most 8 included files, 8 skill lines, 30,000 bytes
 * per skill, 150,000 bytes in all, and a root file with more than 64 Markdown
 * links is skipped whole. Subdirectory REVIEW.md files are not read here.
 */

export interface ReviewMd {
  /** The resolved instructions; empty when there is no REVIEW.md or it was skipped. */
  text: string;
  /** Files that went into it, root first. */
  sources: string[];
  /** Why something was left out. */
  warnings: string[];
}

const MAX_INCLUDES = 8;
const MAX_SKILLS = 8;
const MAX_SKILL_BYTES = 30_000;
const MAX_TOTAL_BYTES = 150_000;
const MAX_LINKS = 64;

const bytes = (s: string): number => Buffer.byteLength(s, "utf8");

/** Markdown links that count towards the limit: not http(s), mailto or in-page anchors. */
function countedLinks(text: string): number {
  return [...text.matchAll(/\]\(([^)\s]+)[^)]*\)/g)].filter((m) => !/^(https?:|mailto:|#)/i.test(m[1]!)).length;
}

/** A skill file's body, without its frontmatter. */
function stripFrontmatter(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

/**
 * @param read returns a repo-relative file's text, or undefined when it does not
 *   exist. The caller decides which ref that is: Ship reads the base or default
 *   branch, never the PR's own copy, and so should a caller here.
 */
export function resolveReviewMd(read: (path: string) => string | undefined): ReviewMd {
  const root = read("REVIEW.md");
  if (root === undefined) return { text: "", sources: [], warnings: [] };
  if (countedLinks(root) > MAX_LINKS) {
    return { text: "", sources: [], warnings: [`REVIEW.md has more than ${MAX_LINKS} links: skipped, as Code Review skips it`] };
  }
  const warnings: string[] = [];
  const sources = ["REVIEW.md"];
  const seen = new Set<string>();
  let skills = 0;
  let includes = 0;
  const out = root.split(/\r?\n/).map((line) => {
    const m = /^@(\S+)$/.exec(line.trim());
    if (!m) return line;
    const path = m[1]!;
    const skill = /^\.claude\/skills\/[^/\s]+\/SKILL\.md$/.test(path);
    if (!skill && path.includes("/")) {
      warnings.push(`@${path}: an included file must sit beside REVIEW.md at the root`);
      return "";
    }
    if (seen.has(path)) return "";
    if (skill ? ++skills > MAX_SKILLS : ++includes > MAX_INCLUDES) {
      warnings.push(`@${path}: over the limit of ${skill ? MAX_SKILLS + " skill lines" : MAX_INCLUDES + " included files"}`);
      return "";
    }
    const body = read(path);
    if (body === undefined) {
      warnings.push(`@${path}: no such file`);
      return "";
    }
    if (skill && bytes(body) > MAX_SKILL_BYTES) {
      warnings.push(`@${path}: over ${MAX_SKILL_BYTES} bytes`);
      return "";
    }
    seen.add(path);
    sources.push(path);
    return skill ? stripFrontmatter(body).trim() : body.trim();
  });
  const text = out.join("\n").trim();
  if (bytes(text) > MAX_TOTAL_BYTES) {
    return { text: "", sources: [], warnings: [...warnings, `REVIEW.md and its included files are over ${MAX_TOTAL_BYTES} bytes together: skipped`] };
  }
  return { text, sources, warnings };
}
