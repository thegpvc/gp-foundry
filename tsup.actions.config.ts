import { defineConfig } from "tsup";

// Bundle each JS runtime-core action into its own actions/<name>/dist/index.js.
// The committed bundle is what GitHub runs; `npm run check:dist` gates it in CI.
const JS_ACTIONS = [
  "agent-context",
  "config-loader",
  "dependency-chain",
  "merge-gate",
  "sanitize-untrusted-input",
  "wait-for-checks",
];

export default defineConfig(
  JS_ACTIONS.map((name) => ({
    entry: { index: `actions/${name}/src/index.ts` },
    outDir: `actions/${name}/dist`,
    format: ["cjs"] as const,
    target: "node20",
    platform: "node" as const,
    bundle: true,
    noExternal: [/.*/],
    dts: false,
    clean: true,
    splitting: false,
    sourcemap: false,
    silent: true,
  })),
);
