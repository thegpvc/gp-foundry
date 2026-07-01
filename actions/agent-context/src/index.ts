import * as core from "@actions/core";
import * as github from "@actions/github";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fetchContext } from "./fetchers.js";
import { formatContext, type ContextType } from "./formatters.js";

const VALID_TYPES: ContextType[] = ["issue", "pr-diff", "pr-review", "pr-full"];

function isContextType(value: string): value is ContextType {
  return (VALID_TYPES as string[]).includes(value);
}

async function run(): Promise<void> {
  try {
    const type = core.getInput("type", { required: true });
    if (!isContextType(type)) {
      throw new Error(
        `Invalid type "${type}". Must be one of: ${VALID_TYPES.join(", ")}`
      );
    }

    const number = parseInt(core.getInput("number", { required: true }), 10);
    if (Number.isNaN(number)) {
      throw new Error(`Invalid number "${core.getInput("number")}".`);
    }

    const token = core.getInput("token", { required: true });
    const includeDiff = core.getInput("include-diff") !== "false";
    const triggeringComment = core.getInput("triggering-comment");
    // base-branch is optional; when supplied it is surfaced in the log so the
    // caller can confirm the comparison base, and is available for downstream
    // steps. The diff itself is always relative to the PR's own base ref.
    const baseBranch = core.getInput("base-branch");

    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;

    const data = await fetchContext(octokit, {
      owner,
      repo,
      number,
      type,
      includeDiff,
    });
    const formatted = formatContext(data, { type, number, triggeringComment });

    const runnerTemp = process.env.RUNNER_TEMP || tmpdir();
    const outPath = join(runnerTemp, "agent-context.txt");
    writeFileSync(outPath, formatted);
    core.setOutput("context-file", outPath);
    core.info(
      `Context written to ${outPath} (${Buffer.byteLength(formatted, "utf8")} bytes)` +
        (baseBranch ? ` [base: ${baseBranch}]` : "")
    );
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}

run();
