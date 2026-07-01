/**
 * B1 — DOT parser (restricted subset).
 *
 * Grammar (Attractor-style restricted DOT):
 *   digraph <name> { <stmt>* }
 *   stmt := node | edge
 *   node := ID [ '[' attrs ']' ]
 *   edge := ID ('->' ID)+ [ '[' attrs ']' ]
 *   attrs := (KEY '=' VALUE) (',' KEY '=' VALUE)*
 *   comments: // line  and  /* block *​/
 *
 * Contract: `parseDot(text) -> { name, nodes, edges, errors }`. Pure; no I/O.
 * The caller attaches FoundryConfig to form a full Harness.
 */
import type {
  AttrValue,
  ContextType,
  HarnessEdge,
  HarnessNode,
  NodeType,
} from "../ir/types.js";

export interface ParsedGraph {
  name: string;
  nodes: HarnessNode[];
  edges: HarnessEdge[];
  errors: Diagnosticish[];
}

export interface Diagnosticish {
  message: string;
  line?: number;
}

const VALID_TYPES: ReadonlySet<string> = new Set<NodeType>([
  "start",
  "exit",
  "analyst",
  "issue-agent",
  "producer",
  "pr-review",
  "pr-fix",
  "merge-gate",
  "human-gate",
  "parallel",
  "fan_in",
]);

const FILE_ATTRS = new Set(["role", "prompt", "policy", "tools"]);

// ── Tokenizer ────────────────────────────────────────────────────────────────

type TokKind = "id" | "arrow" | "lbrace" | "rbrace" | "lbrack" | "rbrack" | "eq" | "comma" | "semi";
interface Tok {
  kind: TokKind;
  value: string;
  line: number;
}

function tokenize(src: string): { toks: Tok[]; errors: Diagnosticish[] } {
  const toks: Tok[] = [];
  const errors: Diagnosticish[] = [];
  let line = 1;
  let i = 0;
  const s = src;
  while (i < s.length) {
    const c = s[i]!;
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }
    // Comments — handled here (not via pre-strip) so `/*`/`*/` inside strings
    // (e.g. cron "*/30 * * * *") or `//` line-comments are never misread.
    if (c === "/" && s[i + 1] === "/") {
      while (i < s.length && s[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && s[i + 1] === "*") {
      i += 2;
      while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) {
        if (s[i] === "\n") line++;
        i++;
      }
      i += 2;
      continue;
    }
    if (c === "-" && s[i + 1] === ">") {
      toks.push({ kind: "arrow", value: "->", line });
      i += 2;
      continue;
    }
    if (c === "{") { toks.push({ kind: "lbrace", value: c, line }); i++; continue; }
    if (c === "}") { toks.push({ kind: "rbrace", value: c, line }); i++; continue; }
    if (c === "[") { toks.push({ kind: "lbrack", value: c, line }); i++; continue; }
    if (c === "]") { toks.push({ kind: "rbrack", value: c, line }); i++; continue; }
    if (c === "=") { toks.push({ kind: "eq", value: c, line }); i++; continue; }
    if (c === ",") { toks.push({ kind: "comma", value: c, line }); i++; continue; }
    if (c === ";") { toks.push({ kind: "semi", value: c, line }); i++; continue; }
    if (c === '"') {
      // quoted string
      let j = i + 1;
      let val = "";
      while (j < s.length && s[j] !== '"') {
        if (s[j] === "\\" && j + 1 < s.length) {
          val += s[j + 1];
          j += 2;
          continue;
        }
        if (s[j] === "\n") line++;
        val += s[j];
        j++;
      }
      if (j >= s.length) {
        errors.push({ message: "unterminated string", line });
      }
      toks.push({ kind: "id", value: val, line });
      i = j + 1;
      continue;
    }
    // bare identifier: [A-Za-z0-9_.*/:-]+  (allow crons, globs, tool specs unquoted-ish)
    if (/[A-Za-z0-9_]/.test(c)) {
      let j = i;
      let val = "";
      while (j < s.length && /[A-Za-z0-9_.\-]/.test(s[j]!)) {
        val += s[j];
        j++;
      }
      toks.push({ kind: "id", value: val, line });
      i = j;
      continue;
    }
    errors.push({ message: `unexpected character '${c}'`, line });
    i++;
  }
  return { toks, errors };
}

// ── Parser ───────────────────────────────────────────────────────────────────

function coerce(v: string): AttrValue {
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  return v;
}

export function parseDot(text: string): ParsedGraph {
  const { toks, errors } = tokenize(text);
  const nodes: HarnessNode[] = [];
  const edges: HarnessEdge[] = [];
  const nodeIndex = new Map<string, HarnessNode>();
  let name = "harness";
  let p = 0;

  const peek = () => toks[p];
  const next = () => toks[p++];
  const err = (message: string, line?: number) => errors.push({ message, line });

  // header: digraph <name> {
  if (peek()?.kind === "id" && peek()?.value === "digraph") {
    next();
    if (peek()?.kind === "id" && peek()?.value !== undefined) {
      name = next()!.value;
    }
    if (peek()?.kind === "lbrace") next();
    else err("expected '{' after digraph header", peek()?.line);
  } else {
    err("expected 'digraph' keyword", peek()?.line);
  }

  function parseAttrs(): { attrs: Record<string, string>; line?: number } {
    const attrs: Record<string, string> = {};
    if (peek()?.kind !== "lbrack") return { attrs };
    const startLine = next()!.line; // consume [
    while (peek() && peek()!.kind !== "rbrack") {
      const key = next();
      if (!key || key.kind !== "id") {
        err("expected attribute name", key?.line);
        break;
      }
      if (peek()?.kind !== "eq") {
        err(`expected '=' after attribute '${key.value}'`, key.line);
        break;
      }
      next(); // =
      const val = next();
      if (!val || val.kind !== "id") {
        err(`expected value for attribute '${key.value}'`, val?.line);
        break;
      }
      attrs[key.value] = val.value;
      if (peek()?.kind === "comma") next();
    }
    if (peek()?.kind === "rbrack") next();
    else err("unterminated attribute list '['", startLine);
    return { attrs, line: startLine };
  }

  function ensureNode(id: string, line?: number): HarnessNode {
    let n = nodeIndex.get(id);
    if (!n) {
      n = { id, type: "analyst", attrs: {}, files: {}, raw: {}, line };
      nodeIndex.set(id, n);
      nodes.push(n);
    }
    return n;
  }

  function applyAttrsToNode(n: HarnessNode, raw: Record<string, string>, line?: number) {
    n.declared = true;
    n.raw = { ...n.raw, ...raw };
    if (line !== undefined) n.line = n.line ?? line;
    for (const [k, v] of Object.entries(raw)) {
      if (k === "type") {
        if (!VALID_TYPES.has(v)) err(`unknown node type '${v}' on node '${n.id}'`, line);
        n.type = v as NodeType;
      } else if (k === "context") {
        n.context = v as ContextType;
      } else if (FILE_ATTRS.has(k)) {
        (n.files as Record<string, string>)[k] = v;
      } else {
        n.attrs[k] = coerce(v);
      }
    }
  }

  // statements
  let guard = 0;
  while (peek() && peek()!.kind !== "rbrace") {
    if (guard++ > 100000) break;
    const tok = peek()!;
    if (tok.kind === "semi") { next(); continue; }
    if (tok.kind !== "id") {
      err(`unexpected token '${tok.value}'`, tok.line);
      next();
      continue;
    }
    // first ID
    const firstId = next()!;
    if (peek()?.kind === "arrow") {
      // edge chain: a -> b (-> c)*  [attrs]
      const chain: { id: string; line: number }[] = [{ id: firstId.value, line: firstId.line }];
      while (peek()?.kind === "arrow") {
        next(); // ->
        const target = next();
        if (!target || target.kind !== "id") {
          err("expected node id after '->'", target?.line);
          break;
        }
        chain.push({ id: target.value, line: target.line });
      }
      const { attrs, line } = parseAttrs();
      for (let k = 0; k + 1 < chain.length; k++) {
        const a = chain[k]!;
        const b = chain[k + 1]!;
        ensureNode(a.id, a.line);
        ensureNode(b.id, b.line);
        const edge: HarnessEdge = { from: a.id, to: b.id, raw: { ...attrs }, line: line ?? a.line };
        if (attrs.on !== undefined) edge.on = attrs.on;
        if (attrs.when !== undefined) edge.when = attrs.when;
        if (attrs.do !== undefined) edge.do = attrs.do;
        edges.push(edge);
      }
    } else {
      // node statement
      const { attrs, line } = parseAttrs();
      const n = ensureNode(firstId.value, firstId.line);
      applyAttrsToNode(n, attrs, line ?? firstId.line);
    }
    if (peek()?.kind === "semi") next();
  }

  if (peek()?.kind === "rbrace") next();

  return { name, nodes, edges, errors };
}
