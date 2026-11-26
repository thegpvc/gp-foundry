/**
 * POC — `gp-foundry ship`: read a repo's Claude Ship inputs
 * (`.claude/approvals.yml`, `REVIEW.md`) and print what they come to in
 * gp-foundry's terms. Read-only: it proposes, the user applies.
 */
import type { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import yaml from "js-yaml";
import pc from "picocolors";
import { parseApprovals, translateApprovals, type ShipNote } from "../ship/approvals.js";
import { resolveReviewMd } from "../ship/review-md.js";
import { emitJson } from "./common.js";

const MARK: Record<ShipNote["level"], string> = { mapped: pc.green("✓ mapped     "), lossy: pc.yellow("~ lossy      "), unsupported: pc.red("✗ unsupported") };

export function registerShipCommand(program: Command): void {
  program
    .command("ship")
    .description("(POC) Translate Claude Ship inputs (.claude/approvals.yml, REVIEW.md) into gp-foundry settings; prints, writes nothing")
    .option("--dir <path>", "repo root", ".")
    .option("--json", "output the translation as JSON")
    .action((opts: { dir: string; json?: boolean }) => {
      const root = resolve(opts.dir);
      const read = (rel: string): string | undefined => (existsSync(join(root, rel)) ? readFileSync(join(root, rel), "utf8") : undefined);
      // `.yaml` is read only when the `.yml` is absent, as Ship does.
      const policyPath = [".claude/approvals.yml", ".claude/approvals.yaml"].find((p) => read(p) !== undefined);
      const review = resolveReviewMd(read);
      if (!policyPath && !review.sources.length) {
        process.stderr.write(pc.red(`no Claude Ship inputs under ${root} (.claude/approvals.yml, REVIEW.md)\n`));
        process.exit(1);
      }
      let translation;
      try {
        translation = policyPath ? translateApprovals(parseApprovals(read(policyPath)!)) : undefined;
      } catch (e) {
        process.stderr.write(pc.red(`${policyPath}: ${(e as Error).message}\n`));
        process.exit(1);
      }
      if (opts.json) {
        emitJson({ policyPath: policyPath ?? null, translation: translation ?? null, review: { sources: review.sources, bytes: Buffer.byteLength(review.text), warnings: review.warnings } });
        return;
      }
      const out = (s = "") => process.stdout.write(s + "\n");
      if (translation && policyPath) {
        out(pc.bold(`${policyPath} → gp-foundry`));
        out();
        for (const n of translation.notes) out(`${MARK[n.level]}  ${pc.dim(n.where === "policy" ? "(policy)" : `"${n.where}"`)}\n               ${n.message}`);
        out();
        if (Object.keys(translation.policy).length) {
          out(pc.bold("# .github/agents/policy/merge.yaml — set:"));
          out(yaml.dump(translation.policy, { flowLevel: 1 }).trimEnd());
          out();
        }
        if (translation.config.rollout) {
          out(pc.bold("# .github/agents/foundry.config.yaml — set:"));
          out(yaml.dump(translation.config, { flowLevel: 2 }).trimEnd());
          out();
        }
        if (translation.immutablePaths.length) {
          out(pc.bold("# .github/agents/scope.yaml — add to immutable_paths:"));
          out(yaml.dump(translation.immutablePaths).trimEnd());
          out();
        }
        const lost = translation.notes.filter((n) => n.level !== "mapped").length;
        out(lost ? pc.yellow(`${lost} of ${translation.notes.length} items do not carry over exactly — read the notes above before relying on this.`) : pc.green("Everything in this policy carries over."));
      }
      if (review.sources.length || review.warnings.length) {
        out();
        out(pc.bold("REVIEW.md → reviewer guidance"));
        if (review.sources.length) out(`  ${review.sources.join(", ")} — ${Buffer.byteLength(review.text)} bytes of review instructions for the pr-review lanes' roles`);
        for (const w of review.warnings) out(pc.yellow(`  ! ${w}`));
      }
    });
}
