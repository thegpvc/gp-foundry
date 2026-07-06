import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseDot } from "./parse.js";

const dixie = readFileSync(
  fileURLToPath(new URL("../../test/fixtures/dixie/harness.dot", import.meta.url)),
  "utf8",
);

describe("parseDot", () => {
  it("parses the dixie harness with no errors", () => {
    const g = parseDot(dixie);
    expect(g.errors).toEqual([]);
    expect(g.name).toBe("dixie");
    expect(g.nodes.map((n) => n.id).sort()).toEqual(
      ["architect", "builder", "critic", "fixer", "needs_human", "scout", "shipper", "start"].sort(),
    );
  });

  it("assigns node types and file refs", () => {
    const g = parseDot(dixie);
    const byId = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
    expect(byId.builder!.type).toBe("producer");
    expect(byId.architect!.type).toBe("analyst");
    expect(byId.critic!.type).toBe("pr-review");
    expect(byId.builder!.files.role).toBe("roles/builder.md");
    expect(byId.critic!.context).toBe("pr-diff");
    expect(byId.fixer!.attrs.max_attempts).toBe(3);
    expect(byId.shipper!.attrs.schedule).toBe("*/30 * * * *");
  });

  it("parses edges with on/when", () => {
    const g = parseDot(dixie);
    const e = g.edges.find((x) => x.from === "scout" && x.to === "builder");
    expect(e?.when).toBe("label=agent");
    const open = g.edges.find((x) => x.from === "builder" && x.to === "critic");
    expect(open?.on).toBe("pull_request.opened");
    expect(g.edges.length).toBe(9);
  });

  it("reports unknown node types", () => {
    const g = parseDot(`digraph x { a [type=bogus] }`);
    expect(g.errors.some((e) => /unknown node type 'bogus'/.test(e.message))).toBe(true);
  });

  it("does not treat /* in a // line-comment or a string as a block comment", () => {
    const g = parseDot(`
      // NEVER hand-edit .github/workflows/*.yml — edit this graph
      digraph t {
        a [type=start]
        s [type=merge-gate, schedule="*/30 * * * *"]
        a -> s [on="issues.opened"]
      }
    `);
    expect(g.errors).toEqual([]);
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["a", "s"]);
    expect(g.nodes.find((n) => n.id === "s")?.attrs.schedule).toBe("*/30 * * * *");
  });

  it("handles comments and quoted strings", () => {
    const g = parseDot(`
      // a line comment
      digraph t {
        /* block */
        a [type=producer, role="roles/a.md"]
        a -> b [when="label=go"]
      }
    `);
    expect(g.errors).toEqual([]);
    expect(g.nodes.find((n) => n.id === "a")?.files.role).toBe("roles/a.md");
  });
});
