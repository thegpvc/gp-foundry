import { defineConfig } from "tsup";

// Builds the gp-foundry CLI (dev/publish). Actions are bundled separately
// (tsup.actions.config.ts) because each needs its own actions/<name>/dist.
export default defineConfig({
  entry: { "cli/index": "src/cli/index.ts" },
  outDir: "dist",
  format: ["cjs"],
  target: "node20",
  platform: "node",
  bundle: true,
  noExternal: [/.*/],
  dts: false,
  clean: false,
  splitting: false,
  sourcemap: false,
  silent: true,
});
