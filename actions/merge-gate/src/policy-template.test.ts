import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { normalizePolicyKeys } from "./gate.js";
import { verdictMarkers } from "./index.js";
import { parseVerdictWords, verdictRegexSource } from "../../../src/shared/verdicts.js";

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
    // The verdict markers are derived from the verdict words, not set here (see below).
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

describe("policy-merge.yaml verdict markers and evaluate-mode keys", () => {
  const raw = readFileSync(templatePath, "utf8");
  const p = normalizePolicyKeys(yaml.load(raw)) as Record<string, string>;

  it("derives the verdict markers from the shared grammar (approval exact, rejection loose)", () => {
    expect(p.approvalBodyRegex).toBeUndefined();
    expect(p.rejectionBodyRegex).toBeUndefined();
    expect(p.escalationBodyRegex).toBeUndefined();
    const m = verdictMarkers(p);
    expect(m.approval.test("Looks good.\n\n**Verdict:** APPROVE")).toBe(true);
    expect(m.approval.test("Looks good.\n\n  **Verdict:** APPROVE  ")).toBe(true);
    expect(m.approval.test("Looks good.\n\n**Verdict:** APPROVE (once gates pass)")).toBe(false);
    expect(m.approval.test("I would write `**Verdict:** APPROVE` once fixed.\n\n**Verdict:** REQUEST_CHANGES")).toBe(false);
    // An approval that mentions the earlier request is still an approval (tested first).
    expect(m.approval.test("Earlier: **Verdict:** REQUEST_CHANGES. Fixed now.\n\n**Verdict:** APPROVE")).toBe(true);
    // A missed rejection is the one that merges, so it stays loose.
    expect(m.rejection.test("Needs work.\n\n**Verdict:** REQUEST_CHANGES (see the three items above)")).toBe(true);
    expect(m.rejection.test("Needs work.\n\n**Verdict:** REQUEST_CHANGES\n\n— the reviewer")).toBe(true);
    expect(m.escalation.test("**Verdict:** ESCALATE")).toBe(true);
    expect(m.escalation.test("**Verdict:** ESCALATE (maybe)")).toBe(false);
    // Custom words reach all three markers.
    const custom = verdictMarkers({ ...p, verdictWords: parseVerdictWords("SHIP,FIX,HUMAN") });
    expect(custom.approval.test("**Verdict:** SHIP")).toBe(true);
    expect(custom.approval.test("**Verdict:** APPROVE")).toBe(false);
    expect(custom.rejection.test("**Verdict:** FIX")).toBe(true);
    expect(custom.escalation.test("**Verdict:** HUMAN")).toBe(true);
  });

  it("documents overrides equal to the derived defaults", () => {
    const on = normalizePolicyKeys(yaml.load(raw.replace(/^# ((?:approval|rejection|escalation)_body_regex:)/gm, "$1"))) as Record<string, string>;
    expect(on.approvalBodyRegex).toBe(verdictRegexSource("APPROVE"));
    expect(on.rejectionBodyRegex).toBe(verdictMarkers({}).rejection.source);
    expect(on.escalationBodyRegex).toBe(verdictRegexSource("ESCALATE"));
  });

  it("ships the evaluate-mode keys commented out, and they parse when uncommented", () => {
    expect(p.requireNoOpenThreads).toBeUndefined();
    const on = normalizePolicyKeys(yaml.load(raw.replace(/^# ((?:require_no_open_threads|bot_logins|bot_thread_blocking_regex|require_no_review_requests|no_verdict_conclusion):)/gm, "$1"))) as Record<string, unknown>;
    expect(on.requireNoOpenThreads).toBe(true);
    expect(on.requireNoReviewRequests).toBe(true);
    expect(on.noVerdictConclusion).toBe("neutral");
    expect(on.botLogins).toEqual(["greptile-apps[bot]", "cursor[bot]"]);
    expect(new RegExp(on.botThreadBlockingRegex as string).test("**P1** bug")).toBe(true);
  });
});
