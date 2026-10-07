import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
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
          },
        });
        expect(result.status, result.stderr).toBe(exitCode);
        expect(readFileSync(join(dir, "stdin"), "utf8")).toBe(prompt);
        expect(readFileSync(join(dir, "args"), "utf8")).toBe("-p\n--model\ntest-model\n--allowedTools\nRead\n");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
