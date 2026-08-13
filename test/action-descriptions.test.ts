/**
 * GitHub evaluates `${{ }}` expressions inside a composite action.yml — including
 * in `description:` fields — when it LOADS the action. Contexts like `github` and
 * `secrets` are not available at load time, so a literal `${{ github.token }}` or
 * `${{ secrets.NAME }}` sitting in prose fails with "Unrecognized named-value" and
 * the whole action refuses to load, taking down every workflow that uses it. This
 * is not caught by compile tests (they check generated workflows, not action load).
 * Guard the whole class: no action.yml description may contain a live `${{`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import yaml from "js-yaml";

const actionsDir = fileURLToPath(new URL("../actions", import.meta.url));

describe("action.yml descriptions carry no live ${{ }} expression", () => {
  for (const name of readdirSync(actionsDir)) {
    const file = join(actionsDir, name, "action.yml");
    if (!existsSync(file)) continue;
    it(name, () => {
      const doc = yaml.load(readFileSync(file, "utf8")) as any;
      const descriptions: string[] = [];
      if (typeof doc?.description === "string") descriptions.push(doc.description);
      for (const input of Object.values(doc?.inputs ?? {}) as any[]) {
        if (input && typeof input.description === "string") descriptions.push(input.description);
      }
      for (const input of Object.values(doc?.outputs ?? {}) as any[]) {
        if (input && typeof input.description === "string") descriptions.push(input.description);
      }
      for (const d of descriptions) expect(d).not.toContain("${{");
    });
  }
});
