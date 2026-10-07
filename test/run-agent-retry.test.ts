/**
 * run-agent retries a transient API failure and refuses to retry anything else.
 *
 * A 529 or a dropped connection is not an agent failure: failing the lane on one
 * turns a server-side blip into a red run indistinguishable from a broken agent,
 * and on a scheduled lane it strands the sweep until the next cron tick. A usage
 * wall is the opposite case — it clears on a wall-clock reset far past any step
 * budget, so retrying only burns the runner.
 *
 * These tests execute the step's actual bash, lifted out of action.yml, against a
 * stub `claude` on PATH. Asserting on the YAML text instead would pass happily
 * while the shell did something else.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";

const actionFile = fileURLToPath(new URL("../actions/run-agent/action.yml", import.meta.url));

let runScript: string;

beforeAll(() => {
  const doc = yaml.load(readFileSync(actionFile, "utf8")) as any;
  const step = (doc.runs.steps as any[]).find((s) => s.name === "Run agent");
  expect(step, "the Run agent step must exist").toBeTruthy();
  runScript = step.run;
});

/**
 * Runs the step with a stub `claude` whose behaviour is scripted per attempt.
 *
 * `attempts` is one entry per invocation: the text the stub writes and the code
 * it exits with. The stub records each call so the test can assert how many
 * times the CLI actually ran.
 */
function runStep(
  attempts: { stdout?: string; stderr?: string; exit: number }[],
  env: Record<string, string> = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "run-agent-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);

  // One set of files per scripted attempt, so the stub needs no escaping or
  // JSON parsing — it just replays attempt N.
  attempts.forEach((a, i) => {
    writeFileSync(join(dir, `attempt_${i}.out`), a.stdout ? `${a.stdout}\n` : "");
    writeFileSync(join(dir, `attempt_${i}.err`), a.stderr ? `${a.stderr}\n` : "");
    writeFileSync(join(dir, `attempt_${i}.code`), String(a.exit));
  });
  writeFileSync(join(dir, "count"), "0");

  const stub = `#!/usr/bin/env bash
DIR=${JSON.stringify(dir)}
N="$(cat "$DIR/count")"
echo $((N + 1)) > "$DIR/count"
if [ ! -f "$DIR/attempt_$N.code" ]; then
  echo "stub: unscripted attempt $N" >&2
  exit 99
fi
cat "$DIR/attempt_$N.out"
cat "$DIR/attempt_$N.err" >&2
exit "$(cat "$DIR/attempt_$N.code")"
`;
  writeFileSync(join(bin, "claude"), stub);
  chmodSync(join(bin, "claude"), 0o755);

  const promptFile = join(dir, "prompt.md");
  writeFileSync(promptFile, "be a good agent");

  let stdout = "";
  let status = 0;
  try {
    stdout = execFileSync("bash", ["-e", "-o", "pipefail", "-c", runScript], {
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        CLAUDE_CODE_OAUTH_TOKEN: "token",
        PROMPT_FILE: promptFile,
        ROLE_FILE: "",
        MODEL: "claude-opus-5",
        ALLOWED_TOOLS: "Read",
        EXTRA_ARGS: "",
        EXTRA_ENV: "",
        MAX_ATTEMPTS: "3",
        // Keep the suite fast; the backoff arithmetic is asserted separately.
        RETRY_BASE_DELAY_SECONDS: "0",
        ...env,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e: any) {
    status = e.status ?? 1;
    stdout = (e.stdout ?? "") + (e.stderr ?? "");
  }

  const calls = Number(readFileSync(join(dir, "count"), "utf8").trim());
  return { stdout, status, calls };
}

describe("run-agent retry", () => {
  it("does not retry a run that succeeds", () => {
    const r = runStep([{ stdout: "done", exit: 0 }]);
    expect(r.calls).toBe(1);
    expect(r.status).toBe(0);
  });

  it("retries a 529 and succeeds on a later attempt", () => {
    const r = runStep([
      { stdout: "API Error: 529 Overloaded. This is a server-side issue, usually temporary", exit: 1 },
      { stdout: "done", exit: 0 },
    ]);
    expect(r.calls).toBe(2);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("transient API failure");
  });

  it("gives up after max-attempts and stays red", () => {
    const overloaded = { stdout: "API Error: 529 Overloaded", exit: 1 };
    const r = runStep([overloaded, overloaded, overloaded]);
    expect(r.calls).toBe(3);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("all 3 attempts");
  });

  it("honours max-attempts: 1 as a kill switch", () => {
    const r = runStep([{ stdout: "API Error: 529 Overloaded", exit: 1 }], { MAX_ATTEMPTS: "1" });
    expect(r.calls).toBe(1);
    expect(r.status).not.toBe(0);
  });

  it("never retries a usage wall, and says so", () => {
    const r = runStep([{ stdout: "You've hit your session limit · resets 9:20am (UTC)", exit: 1 }]);
    expect(r.calls).toBe(1);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("capacity wall, not a code failure");
  });

  it("never retries a genuine agent error", () => {
    const r = runStep([{ stderr: "TypeError: cannot read property of undefined", exit: 1 }]);
    expect(r.calls).toBe(1);
    expect(r.status).not.toBe(0);
    // The original contract: a dead agent is visibly red.
    expect(r.stdout).toContain("failing the step so the run is visibly red");
  });

  it("does not mistake an agent that merely discussed rate limits for one that hit them", () => {
    // The phrase appears early, far outside the tail window the classifier reads,
    // and the run dies of something else entirely.
    const chatter = Array.from({ length: 40 }, (_, i) => `line ${i}: considering rate limit backoff`).join("\n");
    const r = runStep([{ stdout: `${chatter}\nfatal: could not write file`, exit: 2 }]);
    expect(r.calls).toBe(1);
    expect(r.status).toBe(2);
  });

  it("preserves the agent's exit code", () => {
    const r = runStep([{ stderr: "boom", exit: 42 }]);
    expect(r.status).toBe(42);
  });

  it("still surfaces stderr as a grouped warning", () => {
    const r = runStep([{ stdout: "done", stderr: "a deprecation notice", exit: 0 }]);
    expect(r.stdout).toContain("Claude produced stderr output");
    expect(r.stdout).toContain("a deprecation notice");
  });
});
