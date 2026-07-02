import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { normalizePolicyKeys } from "./gate.js";

// The shipped default policy must use the FLAT keys the merge-gate action reads
// (normalized to camelCase). A nested approval:/ci:/on_block: schema parses to keys
// the action ignores — the gate would then never detect approval and never merge.
const templatePath = fileURLToPath(
  new URL("../../../skill/templates/policy-merge.yaml", import.meta.url),
);

describe("default policy-merge.yaml matches the merge-gate schema", () => {
  const p = normalizePolicyKeys(
    yaml.load(readFileSync(templatePath, "utf8")),
  ) as Record<string, unknown>;

  it("exposes the flat keys the gate consumes", () => {
    expect(typeof p.approvalBodyRegex).toBe("string"); // else approval is never detected
    expect(typeof p.maxAdditions).toBe("number");
    expect(Array.isArray(p.protectedPaths)).toBe(true);
    expect(Array.isArray(p.blockingLabels)).toBe(true);
    expect(p.requireCleanRebase).toBe(false);
    expect(p.rebaseLabel).toBe("needs-rebase");
    expect((p.labels as Record<string, unknown> | undefined)?.rebaseNeeded).toBe("needs-rebase");
  });

  it("uses squash (the Janitor's merge commits make rebase-merge fail)", () => {
    expect(p.mergeMethod).toBe("squash");
  });

  it("has no stale nested schema the action would ignore", () => {
    expect(p.approval).toBeUndefined();
    expect(p.ci).toBeUndefined();
    expect(p.onBlock).toBeUndefined();
    expect(p.size).toBeUndefined();
  });
});
