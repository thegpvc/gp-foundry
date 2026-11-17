/**
 * Pinned workflows reference the runtime actions at a git ref. With none named
 * in the config, that ref is this compiler's own release tag — so the workflows
 * a version generates always call the actions that version shipped with.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parseDot } from "../src/parser/parse.js";
import { loadConfig, loadHarness } from "../src/config/load.js";
import { compile } from "../src/index.js";
import { validate } from "../src/validate/validate.js";
import { makeActionRef } from "../src/assemble/assemble.js";
import { packageVersion, releaseTag } from "../src/shared/version.js";
import type { FoundryConfig, Harness } from "../src/ir/types.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const cfg = (runtime?: FoundryConfig["runtime"]) => ({ ...loadConfig(undefined), ...(runtime ? { runtime } : {}) }) as FoundryConfig;

describe("the default ref for pinned actions", () => {
  it("is this package's release tag", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(packageVersion()).toBe(pkg.version);
    expect(releaseTag()).toBe(`v${pkg.version}`);
    expect(makeActionRef(cfg())("run-agent")).toBe(`thegpvc/gp-foundry/actions/run-agent@v${pkg.version}`);
  });

  it("is never the old floating v1", () => {
    expect(makeActionRef(cfg())("merge-gate")).not.toMatch(/@v1$/);
  });

  it("yields to an explicit ref, a commit included", () => {
    expect(makeActionRef(cfg({ mode: "pinned", ref: "8ca0c5b" }))("run-agent")).toBe("thegpvc/gp-foundry/actions/run-agent@8ca0c5b");
    expect(makeActionRef(cfg({ mode: "pinned", ref: "v1" }))("run-agent")).toMatch(/@v1$/); // honoured, and warned about
  });

  it("does not apply to vendored actions", () => {
    expect(makeActionRef(cfg({ mode: "vendored" }))("run-agent")).toBe("./.github/actions/run-agent");
  });
});

describe("validate warns about the stale v1 ref", () => {
  const ir = (runtime?: FoundryConfig["runtime"]): Harness => {
    const g = parseDot(`digraph t { start [type=start] }`);
    return { name: g.name, nodes: g.nodes, edges: g.edges, config: cfg(runtime), sourcePath: "t.dot" };
  };
  const stale = (h: Harness) => validate(h).find((d) => d.code === "runtime.stale-ref");

  it("when a pinned config names v1", () => {
    const d = stale(ir({ mode: "pinned", ref: "v1" }));
    expect(d?.level).toBe("warning");
    expect(d?.hint).toContain(releaseTag());
  });

  it("and not otherwise", () => {
    expect(stale(ir())).toBeUndefined();
    expect(stale(ir({ mode: "pinned", ref: "v0.3.0" }))).toBeUndefined();
    expect(stale(ir({ mode: "vendored", ref: "v1" }))).toBeUndefined();
  });
});

describe("examples/starter is what this compiler generates", () => {
  // The example pins no ref, so its workflows carry the release tag: bumping the
  // version without rebuilding the example fails here, not in someone's fork.
  it("every generated file is in sync", () => {
    const base = join(root, "examples/starter/.github");
    const { harness, parseErrors } = loadHarness(join(base, "harness.dot"), join(base, "agents/foundry.config.yaml"));
    expect(parseErrors).toEqual([]);
    const readFile = (rel: string) => {
      try {
        return readFileSync(join(base, rel), "utf8");
      } catch {
        return undefined;
      }
    };
    const { files } = compile(harness, { readFile }, { specDir: ".github" });
    const drift = files.filter((f) => {
      try {
        return readFileSync(join(root, "examples/starter", f.path), "utf8") !== f.contents;
      } catch {
        return true;
      }
    });
    expect(drift.map((f) => f.path), "run: gp-foundry build on examples/starter").toEqual([]);
    const generated = new Set(files.map((f) => f.path.replace(".github/workflows/", "")));
    for (const name of readdirSync(join(base, "workflows"))) expect(generated.has(name), `stale workflow ${name}`).toBe(true);
  });
});
