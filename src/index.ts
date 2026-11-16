/** Public API: compile a Harness IR into generated files + diagnostics. */
import type { Diagnostic, GeneratedFile, Harness } from "./ir/types.js";
import { validate, type ValidateDeps } from "./validate/validate.js";
import { modelCheck } from "./modelcheck/check.js";
import { wire } from "./wiring/wire.js";
import { assemble } from "./assemble/assemble.js";
import { renderDiagram } from "./diagram/render.js";
import { parseRoleFrontmatter } from "./roles/role.js";

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
  // A role's `tools:` front-matter, when the role can be read. Undefined means
  // "unknown", which every consumer of it treats as "assume it needs everything".
  const roleTools = (nodeId: string): string | undefined => {
    const rel = ir.nodes.find((n) => n.id === nodeId)?.files.role;
    const text = rel && deps.readFile ? deps.readFile(rel) : undefined;
    if (text === undefined) return undefined;
    const tools = parseRoleFrontmatter(text)?.tools;
    return typeof tools === "string" ? tools : undefined;
  };
  const wiring = wire(ir);
  const files = assemble(ir, wiring, opts.specDir ?? "", { roleTools });
  files.push({ path: ".github/HARNESS.md", contents: renderDiagram(ir, wiring), generated: true });
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
