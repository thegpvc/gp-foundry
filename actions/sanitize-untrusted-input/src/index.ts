/**
 * sanitize-untrusted-input (C5) — the action entrypoint.
 *
 * The sanitizing itself lives in `sanitize.ts`, which is pure and importable.
 * This file is only the @actions/core adapter plus the auto-run, so that another
 * action bundling the pipeline (agent-context) does not also execute this
 * entrypoint the moment it imports it.
 */

import * as core from "@actions/core";
import { sanitize, type SanitizeConfig } from "./sanitize.js";

export * from "./sanitize.js";

function parseConfigInput(rawConfig: string): Partial<SanitizeConfig> | null {
  const trimmed = rawConfig.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") return parsed as Partial<SanitizeConfig>;
    core.warning("sanitize-untrusted-input: `config` was not a JSON object; ignoring.");
    return null;
  } catch (err) {
    core.warning(
      `sanitize-untrusted-input: could not parse \`config\` as JSON (${(err as Error).message}); using defaults.`,
    );
    return null;
  }
}

export async function run(): Promise<void> {
  try {
    const raw = core.getInput("raw"); // required in action.yml but tolerate empty
    const configInput = core.getInput("config");

    const overrides = parseConfigInput(configInput);

    // Individual scalar inputs override the config blob when provided.
    const maxLengthInput = core.getInput("max-length");
    const merged: Partial<SanitizeConfig> = { ...(overrides ?? {}) };
    if (maxLengthInput.trim()) {
      const n = Number(maxLengthInput);
      if (Number.isFinite(n) && n > 0) merged.maxLength = n;
    }
    const bannerInput = core.getInput("banner-label");
    if (bannerInput.trim()) merged.bannerLabel = bannerInput;

    const result = sanitize(raw, merged);

    core.setOutput("safe", result.safe);
    core.setOutput("truncated", String(result.truncated));
    core.setOutput("injection-hits", String(result.injectionHits));
    core.setOutput("secret-hits", String(result.secretHits));
    core.setOutput("original-length", String(result.originalLength));

    if (result.injectionHits > 0) {
      core.warning(
        `sanitize-untrusted-input: neutralized ${result.injectionHits} suspected prompt-injection marker(s).`,
      );
    }
    if (result.secretHits > 0) {
      core.warning(
        `sanitize-untrusted-input: masked ${result.secretHits} secret-looking string(s).`,
      );
    }
  } catch (err) {
    core.setFailed(`sanitize-untrusted-input failed: ${(err as Error).message}`);
  }
}

// Only auto-run inside the Actions runtime, never when imported by tests.
if (process.env.GITHUB_ACTIONS === "true") {
  void run();
}
