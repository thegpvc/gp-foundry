import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, it, expect } from "vitest";
import {
  loadConfig,
  resolveConfig,
  normalizeTools,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "fixtures/foundry.config.yaml");

describe("normalizeTools", () => {
  it("splits a comma string and trims", () => {
    expect(normalizeTools("Read, Write ,Edit")).toEqual([
      "Read",
      "Write",
      "Edit",
    ]);
  });

  it("passes an array through, trimming empties", () => {
    expect(normalizeTools(["Read", " ", "Grep"])).toEqual(["Read", "Grep"]);
  });

  it("returns [] for undefined", () => {
    expect(normalizeTools(undefined)).toEqual([]);
  });
});

describe("loadConfig", () => {
  it("loads and validates a well-formed config", () => {
    const cfg = loadConfig(FIXTURE);
    expect(cfg.name).toBe("Example Agent Fleet");
    expect(cfg.agent.model).toBe("claude-opus-4-8");
    expect(cfg.labels.triage).toBe("needs-triage");
    expect(cfg.personas?.reviewer?.model).toBe("claude-sonnet-4-6");
  });

  it("throws on a missing file", () => {
    expect(() => loadConfig("/no/such/config.yaml")).toThrow(/could not read/);
  });

  it("throws on schema violations (missing required fields)", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "cfgtest-"));
    const bad = resolve(dir, "bad.yaml");
    writeFileSync(bad, "name: only-name\n", "utf8");
    expect(() => loadConfig(bad)).toThrow(/failed schema validation/);
  });

  it("throws when the document is not a mapping", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "cfgtest-"));
    const bad = resolve(dir, "list.yaml");
    writeFileSync(bad, "- a\n- b\n", "utf8");
    expect(() => loadConfig(bad)).toThrow(/must be a YAML mapping/);
  });
});

describe("resolveConfig", () => {
  const cfg = loadConfig(FIXTURE);

  it("returns top-level defaults when no node is given", () => {
    const r = resolveConfig(cfg, null);
    expect(r.model).toBe("claude-opus-4-8");
    expect(r.cli).toBe("claude");
    expect(r.allowedTools).toContain("Bash(git:*)");
    expect(r.labels.ready).toBe("agent-ready");
    expect(r.identity.bot_login).toBe("example-agent[bot]");
    expect(r.oauthTokenSecret).toBe("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("applies persona overrides and shallow-merges labels + identity", () => {
    const r = resolveConfig(cfg, "reviewer");
    expect(r.node).toBe("reviewer");
    // overridden
    expect(r.model).toBe("claude-sonnet-4-6");
    expect(r.allowedTools).toEqual(["Read", "Grep", "Glob"]);
    expect(r.labels.ready).toBe("review-ready");
    expect(r.identity.bot_login).toBe("example-reviewer[bot]");
    expect(r.identity.git_name).toBe("Example Reviewer");
    // inherited (not overridden by persona)
    expect(r.cli).toBe("claude");
    expect(r.labels.triage).toBe("needs-triage");
    expect(r.identity.git_email).toBe("agent@example.com");
    expect(r.identity.app_id_secret).toBe("EXAMPLE_APP_ID");
  });

  it("inherits defaults for a persona that only overrides labels", () => {
    const r = resolveConfig(cfg, "implementer");
    expect(r.model).toBe("claude-opus-4-8");
    expect(r.labels.ready).toBe("build-ready");
    expect(r.identity.bot_login).toBe("example-agent[bot]");
  });

  it("falls back to defaults for an unknown persona key", () => {
    const r = resolveConfig(cfg, "does-not-exist");
    expect(r.model).toBe("claude-opus-4-8");
    expect(r.labels.ready).toBe("agent-ready");
  });

  it("produces a JSON-serializable resolved view", () => {
    const r = resolveConfig(cfg, "reviewer");
    const blob = JSON.parse(JSON.stringify(r));
    expect(blob.model).toBe("claude-sonnet-4-6");
    expect(blob.labels.ready).toBe("review-ready");
  });
});
