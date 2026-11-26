/**
 * POC — read a Claude Ship approvals policy (`.claude/approvals.yml`, schema
 * version 1) and translate what it says into gp-foundry's own inputs: merge
 * policy keys, foundry.config.yaml settings, and notes for everything that has
 * no equivalent. Pure: text in, a proposal out. Nothing here writes a file.
 *
 * The two models differ in kind. Ship decides per changed file who must approve
 * (`seats`) and whether Claude may (`verdict.claude`), from rules with
 * conditions. gp-foundry has one policy for the PR: the approver's verdict, a
 * size limit, protected paths, and a person's sign-off on a handoff. So this is
 * a translation with losses, and every loss is reported — see docs/plans/
 * 2026-11-26-claude-ship-inputs.md for the mapping and what a native evaluator
 * would take.
 */
import yaml from "js-yaml";

// ── the Ship schema (the subset this reads; unknown keys are refused, as Ship does) ──

export type ShipClaude = "approves" | "comments" | "blocks";

export interface ShipSeatSet {
  count: number;
  from: string[];
}

export interface ShipVerdict {
  claude?: ShipClaude;
  /** Normalized: a bare number N is `[{ count: N, from: [humans] }]`. */
  seats: ShipSeatSet[];
  maxAge?: string;
}

export interface ShipOverride {
  if: string;
  verdict?: ShipVerdict;
}

export interface ShipRule {
  purpose: string;
  paths: string[];
  if?: string;
  verdict?: ShipVerdict;
  override: ShipOverride[];
  advisory: string[];
  mode?: "enforce" | "observe";
  /** Keys present on the rule that this POC reads but does not translate. */
  untranslated: string[];
}

export interface ShipPolicy {
  mode: "enforce" | "observe";
  rules: ShipRule[];
}

const TOP_KEYS = ["version", "rules", "mode", "nested", "run", "locals"];
const RULE_KEYS = ["purpose", "paths", "verdict", "if", "override", "advisory", "reuse", "findings", "use", "mode", "nested", "run"];
const VERDICT_KEYS = ["claude", "seats", "max_age"];
const OVERRIDE_KEYS = ["if", "verdict", "reuse", "findings"];

function isMap(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function refuseUnknown(obj: Record<string, unknown>, allowed: string[], where: string): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) throw new Error(`${where}: unknown key '${k}'`);
  }
}

/** Replace `"@name"` values with the local they name, anywhere in the tree. */
function resolveLocals(v: unknown, locals: Record<string, unknown>, where: string, depth = 0): unknown {
  if (depth > 16) throw new Error(`${where}: locals refer to each other too deeply`);
  if (typeof v === "string" && v.startsWith("@")) {
    const name = v.slice(1);
    if (!(name in locals)) throw new Error(`${where}: no local named '${name}'`);
    return resolveLocals(locals[name], locals, where, depth + 1);
  }
  if (Array.isArray(v)) return v.map((x) => resolveLocals(x, locals, where, depth));
  if (isMap(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveLocals(x, locals, where, depth)]));
  return v;
}

function readVerdict(raw: unknown, where: string): ShipVerdict {
  if (!isMap(raw)) throw new Error(`${where}: verdict must be a map`);
  refuseUnknown(raw, VERDICT_KEYS, `${where}.verdict`);
  const claude = raw.claude as ShipClaude | undefined;
  if (claude !== undefined && !["approves", "comments", "blocks"].includes(claude)) {
    throw new Error(`${where}.verdict.claude: '${String(claude)}' is not approves, comments or blocks`);
  }
  let seats: ShipSeatSet[] = [];
  if (typeof raw.seats === "number") {
    if (!Number.isInteger(raw.seats) || raw.seats < 0 || raw.seats > 16) throw new Error(`${where}.verdict.seats: must be 0 to 16`);
    if (raw.seats > 0) seats = [{ count: raw.seats, from: ["humans"] }];
  } else if (Array.isArray(raw.seats)) {
    seats = raw.seats.map((s, i) => {
      if (!isMap(s) || typeof s.count !== "number") throw new Error(`${where}.verdict.seats[${i}]: needs count and from`);
      const from = Array.isArray(s.from) ? s.from.map(String) : [String(s.from)];
      return { count: s.count, from };
    });
  } else if (raw.seats !== undefined) {
    throw new Error(`${where}.verdict.seats: must be a number or a list of sets`);
  }
  if (claude === "blocks" && seats.length) throw new Error(`${where}.verdict: seats cannot stand beside claude: blocks`);
  return { ...(claude ? { claude } : {}), seats, ...(raw.max_age !== undefined ? { maxAge: String(raw.max_age) } : {}) };
}

/** Parse and validate `.claude/approvals.yml`. Throws with the place of the first problem. */
export function parseApprovals(text: string): ShipPolicy {
  const doc = yaml.load(text);
  if (!isMap(doc)) throw new Error("approvals.yml: must be a YAML map");
  refuseUnknown(doc, TOP_KEYS, "approvals.yml");
  if (doc.version !== 1) throw new Error(`approvals.yml: version must be 1, got ${JSON.stringify(doc.version)}`);
  if (!Array.isArray(doc.rules)) throw new Error("approvals.yml: rules must be a list");
  const mode = (doc.mode ?? "enforce") as ShipPolicy["mode"];
  if (mode !== "enforce" && mode !== "observe") throw new Error(`approvals.yml: mode must be enforce or observe`);
  const locals = isMap(doc.locals) ? doc.locals : {};

  const rules = doc.rules.map((r, i): ShipRule => {
    const where = `rules[${i}]`;
    if (!isMap(r)) throw new Error(`${where}: must be a map`);
    refuseUnknown(r, RULE_KEYS, where);
    // `use` copies a local's keys into the rule; the rule's own keys win.
    let merged: Record<string, unknown> = {};
    for (const name of Array.isArray(r.use) ? r.use : []) {
      const local = resolveLocals(String(name), locals, `${where}.use`);
      if (!isMap(local)) throw new Error(`${where}.use: '${String(name)}' is not a map of rule keys`);
      merged = { ...merged, ...local };
    }
    const rule = resolveLocals({ ...merged, ...r }, locals, where) as Record<string, unknown>;
    if (typeof rule.purpose !== "string" || !rule.purpose) throw new Error(`${where}: needs a purpose`);
    if (!Array.isArray(rule.paths) || !rule.paths.some((p) => !String(p).startsWith("!"))) {
      throw new Error(`${where}: needs paths, with at least one pattern that is not an exclusion`);
    }
    const override = (Array.isArray(rule.override) ? rule.override : []).map((o, j): ShipOverride => {
      const ow = `${where}.override[${j}]`;
      if (!isMap(o) || typeof o.if !== "string") throw new Error(`${ow}: needs an if`);
      refuseUnknown(o, OVERRIDE_KEYS, ow);
      return { if: o.if, ...(o.verdict !== undefined ? { verdict: readVerdict(o.verdict, ow) } : {}) };
    });
    return {
      purpose: rule.purpose,
      paths: rule.paths.map(String),
      ...(typeof rule.if === "string" ? { if: rule.if } : {}),
      ...(rule.verdict !== undefined ? { verdict: readVerdict(rule.verdict, where) } : {}),
      override,
      advisory: (Array.isArray(rule.advisory) ? rule.advisory : []).map(String),
      ...(rule.mode === "observe" || rule.mode === "enforce" ? { mode: rule.mode } : {}),
      untranslated: ["reuse", "findings", "nested", "run"].filter((k) => rule[k] !== undefined),
    };
  });
  return { mode, rules };
}

// ── conditions: the three shapes gp-foundry has an answer for ──

export type Condition =
  | { kind: "review-passes" }
  | { kind: "larger-than"; lines: number }
  | { kind: "bot-authored"; bot: string }
  | { kind: "other"; text: string };

/** One condition, classified. Anything joined with AND / OR, or reading another fact, is `other`. */
export function classifyCondition(text: string): Condition {
  const t = text.trim();
  if (/^claude\/code_review(\([^)]*\))?\s*=\s*pass$/.test(t)) return { kind: "review-passes" };
  const size = /^pr\/diff_lines\s*(>=|>)\s*(\d+)$/.exec(t);
  if (size) return { kind: "larger-than", lines: Number(size[2]) - (size[1] === ">=" ? 1 : 0) };
  const bot = /^ALL\s+pr\/authors\s*=\s*bot:([A-Za-z0-9-]+)$/.exec(t);
  if (bot) return { kind: "bot-authored", bot: `${bot[1]}[bot]` };
  return { kind: "other", text: t };
}

// ── the translation ──

export interface ShipNote {
  /** `mapped`: carried over. `lossy`: carried over with a stated difference. `unsupported`: dropped. */
  level: "mapped" | "lossy" | "unsupported";
  /** The rule's purpose, or `policy` for a file-level note. */
  where: string;
  message: string;
}

export interface ShipTranslation {
  /** Keys for `.github/agents/policy/merge.yaml`, snake_case. */
  policy: {
    protected_paths?: string[];
    protected_path_exclude_globs?: string[];
    handoff_clauses?: ("protected-path" | "too-large")[];
    max_additions?: number;
  };
  /** Settings for `.github/agents/foundry.config.yaml`. */
  config: { rollout?: { bot_authors: string[] } };
  /** Paths for `scope.yaml`'s `immutable_paths` (Ship's `claude: blocks`). */
  immutablePaths: string[];
  notes: ShipNote[];
}

const people = (v: ShipVerdict | undefined): number => (v ? v.seats.reduce((n, s) => Math.max(n, s.count), 0) : 0);

/** Ship's `**` covers dot folders and is a whole segment; gp-foundry's glob matcher reads these the same way. */
const isCatchAll = (rule: ShipRule): boolean => rule.paths.includes("**");

export function translateApprovals(ship: ShipPolicy): ShipTranslation {
  const notes: ShipNote[] = [];
  const protectedPaths = new Set<string>();
  const excludes = new Set<string>();
  const immutable = new Set<string>();
  const bots = new Set<string>();
  const handoffs = new Set<"protected-path" | "too-large">();
  let maxAdditions: number | undefined;

  if (ship.mode === "observe") {
    notes.push({
      level: "lossy",
      where: "policy",
      message:
        "mode: observe has no switch in gp-foundry. The equivalent is to run the gate with merge=\"off\" and leave its check out of the branch's required checks: it reports and blocks nothing.",
    });
  }

  for (const rule of ship.rules) {
    const where = rule.purpose;
    const note = (level: ShipNote["level"], message: string) => notes.push({ level, where, message });

    if (rule.mode === "observe") {
      note("unsupported", "a rule in observe mode decides nothing in Ship, and gp-foundry cannot observe one clause: left out.");
      continue;
    }
    for (const key of rule.untranslated) {
      note(
        "unsupported",
        key === "reuse"
          ? "reuse: gp-foundry never carries a verdict or a sign-off across a push — both are for the exact head. Stricter than this rule asks."
          : key === "findings"
            ? "findings: who may close a finding has no equivalent. The nearest clause is require_no_open_threads, which holds a PR while any review thread is unanswered."
            : `${key}: subdirectory policy files and classifier start order are not read.`,
      );
    }
    for (const c of rule.advisory.filter((c) => c !== "claude/code_review")) {
      note("unsupported", `advisory ${c}: custom classifiers are not run. The nearest thing is an analyst lane in harness.dot that posts a comment.`);
    }
    if (!rule.verdict) {
      if (rule.advisory.includes("claude/code_review")) note("mapped", "advisory code review: the reviewer lane already reviews every PR in scope and decides nothing on its own.");
      continue;
    }
    if (rule.verdict.maxAge) note("unsupported", `max_age ${rule.verdict.maxAge}: results do not expire in gp-foundry; a new head needs a new verdict.`);

    // What the rule asks for once the review passes, and what it asks for otherwise.
    const onPass = rule.override.find((o) => classifyCondition(o.if).kind === "review-passes")?.verdict;
    const settled = onPass ?? rule.verdict;
    const needsPerson = people(settled) > 0;

    const ruleCondition = rule.if ? classifyCondition(rule.if) : undefined;
    if (ruleCondition?.kind === "other") {
      note("unsupported", `if "${ruleCondition.text}": gp-foundry's policy cannot read this condition, so the rule is left out. Until it is expressed some other way the translated policy asks for less than this one.`);
      continue;
    }

    if (ruleCondition?.kind === "bot-authored") {
      bots.add(ruleCondition.bot);
      note(
        needsPerson ? "lossy" : "mapped",
        needsPerson
          ? `PRs written by ${ruleCondition.bot} come into scope (rollout.bot_authors). This rule also asks for a person on them, which gp-foundry cannot require for one author only.`
          : `PRs written by ${ruleCondition.bot} come into scope (rollout.bot_authors): the approver's verdict decides them, with no person required. Merging them is a separate grant, merge_bots= on the gate.`,
      );
      continue;
    }

    if (ruleCondition?.kind === "larger-than") {
      if (needsPerson || settled.claude !== "approves") {
        maxAdditions = Math.min(maxAdditions ?? Infinity, ruleCondition.lines);
        handoffs.add("too-large");
        note("lossy", `a change over ${ruleCondition.lines} lines needs a person (max_additions + the too-large handoff). Ship counts every changed line across the PR; gp-foundry counts hand-written additions only, and for the whole PR rather than this rule's paths.`);
      }
      continue;
    }

    const patterns = rule.paths.filter((p) => !p.startsWith("!"));
    const ruleExcludes = rule.paths.filter((p) => p.startsWith("!")).map((p) => p.slice(1));

    if (settled.claude === "blocks") {
      if (isCatchAll(rule)) {
        note("unsupported", "claude: blocks on every path would fail every PR: left out.");
        continue;
      }
      patterns.forEach((p) => immutable.add(p));
      note("lossy", "claude: blocks → scope.yaml immutable_paths. That stops the pipeline's own agents changing these paths and fails their PRs; a person's PR touching them is not failed by the gate.");
      continue;
    }

    if (needsPerson) {
      patterns.forEach((p) => protectedPaths.add(p));
      ruleExcludes.forEach((p) => excludes.add(p));
      handoffs.add("protected-path");
      note("mapped", `${isCatchAll(rule) ? "every change" : `a change under ${patterns.join(", ")}`} needs a person: protected_paths + the protected-path handoff. The check reads "A person decides" until a trusted person formally approves that exact head.`);
      if (ruleExcludes.length) note("lossy", `the exclusions (${ruleExcludes.join(", ")}) become protected_path_exclude_globs, which apply to every protected path, not this rule only.`);
      const n = people(settled);
      if (n > 1) note("lossy", `${n} people: gp-foundry's sign-off is one person. Require ${n} approvals in the branch's GitHub rules — the sign-off only stands once GitHub's own review decision is met.`);
      const named = settled.seats.flatMap((s) => s.from).filter((f) => !["humans", "!pr/authors", "everyone"].includes(f));
      if (named.length) note("lossy", `seats from ${[...new Set(named)].join(", ")}: gp-foundry trusts a sign-off by repository association (signoff_author_associations), not by team or login. Use CODEOWNERS with required code-owner review for this.`);
      if (settled.seats.some((s) => !s.from.includes("!pr/authors"))) note("lossy", "this rule lets the PR's author fill a seat; a gp-foundry sign-off never comes from the PR's author.");
    } else if (settled.claude === "approves") {
      note("mapped", `${isCatchAll(rule) ? "every change" : patterns.join(", ")}: Claude's approval is enough — the approver's APPROVE verdict already satisfies the gate.`);
    } else {
      note("lossy", "claude: comments with no seats passes with no approval at all in Ship; gp-foundry's gate still needs the approver's APPROVE (or a trusted person's approval).");
    }

    if (onPass && (people(rule.verdict) > people(onPass) || rule.verdict.claude !== onPass.claude)) {
      note("lossy", `without a passing review Ship falls back to ${people(rule.verdict)} people and "${rule.verdict.claude ?? "no"}" from Claude. gp-foundry has one path: a head the approver has not approved is not-approved, unless a trusted person's formal approval stands in (trusted_author_associations).`);
    }
    for (const o of rule.override) {
      const c = classifyCondition(o.if);
      if (c.kind === "review-passes") continue;
      if (c.kind === "larger-than" && o.verdict && people(o.verdict) > 0) {
        maxAdditions = Math.min(maxAdditions ?? Infinity, c.lines);
        handoffs.add("too-large");
        note("lossy", `override over ${c.lines} lines → max_additions + the too-large handoff (hand-written additions, whole PR).`);
      } else if (c.kind === "bot-authored") {
        bots.add(c.bot);
        note("lossy", `override for ${c.bot} → rollout.bot_authors brings its PRs into scope; a different seat count for one author is not expressible.`);
      } else {
        note("unsupported", `override if "${o.if}": not readable by gp-foundry's policy; the rule's own verdict is what was translated.`);
      }
    }
  }

  return {
    policy: {
      ...(protectedPaths.size ? { protected_paths: [...protectedPaths] } : {}),
      ...(excludes.size ? { protected_path_exclude_globs: [...excludes] } : {}),
      ...(handoffs.size ? { handoff_clauses: [...handoffs].sort() } : {}),
      ...(maxAdditions !== undefined ? { max_additions: maxAdditions } : {}),
    },
    config: bots.size ? { rollout: { bot_authors: [...bots] } } : {},
    immutablePaths: [...immutable],
    notes,
  };
}
