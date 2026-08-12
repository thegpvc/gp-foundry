/**
 * agent-fallback's immutable-path strip, exercised as the shell it actually is.
 *
 * The composite's `run:` body is lifted straight out of action.yml (it must stay
 * inline there — `vendor` copies only action.yml + dist/ into a consumer repo)
 * and run against a real scratch repo with a real `origin`, once per way an
 * agent can smuggle in an edit: committed, staged, unstaged, invented, deleted.
 *
 * The bug this pins: the old strip ran `git checkout -- $P` (restore worktree
 * FROM THE INDEX) before `git reset`, so a staged edit to an immutable path was
 * written back into the worktree, re-committed by the next step, and the push
 * was then rejected — losing the whole lane's work.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const ACTION_YML = fileURLToPath(new URL("./action.yml", import.meta.url));

/** The `run:` script of the strip step, as shipped. */
function stripScript(): string {
  const doc = yaml.load(readFileSync(ACTION_YML, "utf8")) as {
    runs: { steps: { name?: string; run?: string }[] };
  };
  const step = doc.runs.steps.find((s) => s.name === "Strip protected path changes");
  if (!step?.run) throw new Error("strip step not found in action.yml");
  return step.run;
}

let repo: string;
let scratch: string;

function git(args: string[], cwd = repo): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function write(rel: string, contents: string): void {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, contents);
}

function read(rel: string): string {
  return readFileSync(join(repo, rel), "utf8");
}

/** Run the shipped strip script over `.github/workflows/` in the scratch repo. */
function runStrip(immutablePaths = ".github/workflows/"): void {
  const script = join(scratch, "strip.sh");
  writeFileSync(script, `set -e\n${stripScript()}`);
  execFileSync("bash", [script], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, BASE_BRANCH: "main", IMMUTABLE_PATHS: immutablePaths },
  });
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "gp-foundry-strip-"));
  const origin = join(scratch, "origin.git");
  repo = join(scratch, "work");

  execFileSync("git", ["init", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, repo]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);

  // Base content: a workflow (immutable) and a source file (fair game).
  write(".github/workflows/ci.yml", "name: ci\n");
  write("src/app.ts", "export const version = 1;\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "base"]);
  git(["push", "-q", "origin", "main"]);
  git(["checkout", "-qb", "agent/1-change"]);
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("immutable-path strip", () => {
  it("drops a STAGED edit instead of resurrecting it into the worktree", () => {
    write(".github/workflows/ci.yml", "name: pwned\n");
    git(["add", ".github/workflows/ci.yml"]);

    runStrip();

    expect(read(".github/workflows/ci.yml")).toBe("name: ci\n");
    expect(git(["status", "--porcelain"])).toBe("");
  });

  it("drops an UNSTAGED worktree edit", () => {
    write(".github/workflows/ci.yml", "name: pwned\n");

    runStrip();

    expect(read(".github/workflows/ci.yml")).toBe("name: ci\n");
    expect(git(["status", "--porcelain"])).toBe("");
  });

  it("reverts a COMMITTED edit and keeps the lane's legitimate work", () => {
    write(".github/workflows/ci.yml", "name: pwned\n");
    write("src/app.ts", "export const version = 2;\n");
    git(["add", "-A"]);
    git(["commit", "-qm", "agent: feature + sneaky workflow edit"]);

    runStrip();

    expect(read(".github/workflows/ci.yml")).toBe("name: ci\n");
    expect(read("src/app.ts")).toBe("export const version = 2;\n");
    expect(git(["diff", "--name-only", "origin/main...HEAD"])).toBe("src/app.ts");
    expect(git(["status", "--porcelain"])).toBe("");
  });

  it("removes a file the agent INVENTED under a protected path (staged or untracked)", () => {
    write(".github/workflows/backdoor.yml", "name: backdoor\n");
    write(".github/workflows/backdoor-staged.yml", "name: backdoor\n");
    git(["add", ".github/workflows/backdoor-staged.yml"]);

    runStrip();

    expect(existsSync(join(repo, ".github/workflows/backdoor.yml"))).toBe(false);
    expect(existsSync(join(repo, ".github/workflows/backdoor-staged.yml"))).toBe(false);
    expect(git(["status", "--porcelain"])).toBe("");
  });

  it("restores a protected file the agent DELETED (committed or staged)", () => {
    git(["rm", "-q", ".github/workflows/ci.yml"]);
    git(["commit", "-qm", "agent: remove the gate"]);

    runStrip();

    expect(read(".github/workflows/ci.yml")).toBe("name: ci\n");
    expect(git(["status", "--porcelain"])).toBe("");
  });

  it("accepts a single-file immutable path, not just a directory prefix", () => {
    write("src/app.ts", "export const version = 99;\n");
    git(["add", "-A"]);
    git(["commit", "-qm", "agent: touch a protected file"]);

    runStrip("src/app.ts");

    expect(read("src/app.ts")).toBe("export const version = 1;\n");
  });

  it("leaves the base commit alone when the branch has no commits of its own", () => {
    const base = git(["rev-parse", "HEAD"]);
    write(".github/workflows/ci.yml", "name: pwned\n");
    git(["add", "-A"]);

    runStrip();

    // Nothing to amend — the strip must not rewrite the base commit.
    expect(git(["rev-parse", "HEAD"])).toBe(base);
    expect(read(".github/workflows/ci.yml")).toBe("name: ci\n");
  });

  it("is a no-op when the agent stayed in bounds", () => {
    write("src/app.ts", "export const version = 2;\n");
    git(["add", "-A"]);
    git(["commit", "-qm", "agent: legitimate change"]);
    const head = git(["rev-parse", "HEAD"]);

    runStrip();

    expect(git(["rev-parse", "HEAD"])).toBe(head);
    expect(read("src/app.ts")).toBe("export const version = 2;\n");
  });
});
