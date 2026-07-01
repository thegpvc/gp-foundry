/** Parse a role/*.md file's YAML front-matter into a RoleSpec. */
import yaml from "js-yaml";
import type { RoleSpec } from "../ir/types.js";

const FM = /^---\r?\n([\s\S]*?)\r?\n---/;

export function parseRoleFrontmatter(md: string): RoleSpec | undefined {
  const m = FM.exec(md);
  if (!m) return undefined;
  try {
    const data = yaml.load(m[1]!) as RoleSpec;
    if (data && typeof data === "object") return data;
  } catch {
    return undefined;
  }
  return undefined;
}
