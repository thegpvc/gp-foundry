/** Public API: compile a Harness IR into generated files + diagnostics. */
import type { Diagnostic, GeneratedFile, Harness } from "./ir/types.js";
import { validate, type ValidateDeps } from "./validate/validate.js";
import { modelCheck } from "./modelcheck/check.js";
import { wire } from "./wiring/wire.js";
import { assemble } from "./assemble/assemble.js";
import { renderDiagram } from "./diagram/render.js";

export interface CompileResult {
  files: GeneratedFile[];
  diagnostics: Diagnostic[];
}

export function compile(
  ir: Harness,
  deps: ValidateDeps = {},
  opts: { specDir?: string } = {},
): CompileResult {
  const diagnostics = [...validate(ir, deps), ...modelCheck(ir)];
  const files = assemble(ir, wire(ir), opts.specDir ?? "");
  files.push({ path: ".github/HARNESS.md", contents: renderDiagram(ir), generated: true });
  return { files, diagnostics };
}

export function hasErrors(diags: Diagnostic[]): boolean {
  return diags.some((d) => d.level === "error");
}

export * from "./ir/types.js";
export { parseDot } from "./parser/parse.js";
export { loadHarness, loadConfig } from "./config/load.js";
export { validate } from "./validate/validate.js";
export { modelCheck } from "./modelcheck/check.js";
