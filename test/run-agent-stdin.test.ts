import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import yaml from "js-yaml";

const action: any = yaml.load(readFileSync(new URL("../actions/run-agent/action.yml", import.meta.url), "utf8"));
const script = action.runs.steps.find((s: any) => s.name === "Run agent").run;

describe("run-agent prompt transport", () => {
  for (const exitCode of [0, 42]) {
    it(`delivers a 256 KiB prompt intact and propagates exit ${exitCode}`, () => {
      const dir = mkdtempSync(join(tmpdir(), "foundry-stdin-"));
      try {
        mkdirSync(join(dir, "bin"));
        const prompt = "x".repeat(256 * 1024) + "\n$(should-not-execute)\n";
        writeFileSync(join(dir, "prompt"), prompt);
        writeFileSync(join(dir, "bin", "claude"), '#!/bin/bash\nprintf "%s\\n" "$@" > "$CAPTURE_ARGS"\ncat > "$CAPTURE_STDIN"\nexit "$FAKE_EXIT"\n', { mode: 0o755 });
        const result = spawnSync("bash", ["-c", script], {
          encoding: "utf8",
          env: {
            ...process.env, PATH: `${dir}/bin:${process.env.PATH}`,
            CLAUDE_CODE_OAUTH_TOKEN: "test", PROMPT_FILE: join(dir, "prompt"),
            ROLE_FILE: "", MODEL: "test-model", ALLOWED_TOOLS: "Read", EXTRA_ARGS: "", EXTRA_ENV: "",
            CAPTURE_ARGS: join(dir, "args"), CAPTURE_STDIN: join(dir, "stdin"), FAKE_EXIT: String(exitCode),
            RUNNER_TEMP: join(dir, "runner-temp"),
          },
        });
        expect(result.status, result.stderr).toBe(exitCode);
        expect(readFileSync(join(dir, "stdin"), "utf8")).toBe(prompt);
        // --add-dir: the agent may write its working files outside the repository (#3).
        expect(readFileSync(join(dir, "args"), "utf8")).toBe(`-p\n--model\ntest-model\n--allowedTools\nRead\n--add-dir\n${join(dir, "runner-temp", "agent-scratch")}\n`);
        expect(existsSync(join(dir, "runner-temp", "agent-scratch"))).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

describe("run-agent: the prompt names a place for working files outside the repository (#3)", () => {
  const assemble = action.runs.steps.find((s: any) => s.name === "Assemble prompt").run;
  it("says where, and that the working tree is committed", () => {
    const dir = mkdtempSync(join(tmpdir(), "foundry-assemble-"));
    try {
      writeFileSync(join(dir, "role.md"), "You are a builder.\n");
      const out = join(dir, "out");
      writeFileSync(out, "");
      const r = spawnSync("bash", ["-c", assemble], {
        encoding: "utf8",
        env: { ...process.env, ROLE_FILE: join(dir, "role.md"), GITHUB_OUTPUT: out, RUNNER_TEMP: join(dir, "rt"), PROMPT_OVERRIDE_FILE: "", CONTEXT_FILE: "", CONVENTIONS: "", COMMS_FILE: "", SCOPE_PATH: "", OUTPUT_CONTRACT: "" },
      });
      expect(r.status, r.stderr).toBe(0);
      const promptFile = readFileSync(out, "utf8").match(/prompt-file=(.*)/)![1]!;
      const prompt = readFileSync(promptFile, "utf8");
      expect(prompt).toContain("## Working files");
      expect(prompt).toContain(join(dir, "rt", "agent-scratch"));
      expect(prompt).toContain("anything left in the working tree is committed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
