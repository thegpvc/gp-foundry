import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { loadHarness } from "../src/config/load.js";
import { wire } from "../src/wiring/wire.js";
import { runScenario, type MockAgent, type SimEvent } from "../src/sim/simulate.js";

const dot = fileURLToPath(new URL("./fixtures/dixie/harness.dot", import.meta.url));
const config = fileURLToPath(new URL("./fixtures/dixie/foundry.config.yaml", import.meta.url));
const { harness } = loadHarness(dot, config);
const wiring = wire(harness);

// Mock agents (scripted deterministic stand-ins for `run-agent`).
const scout: MockAgent = () => [
  { event: "issues", action: "labeled", payload: { label: { name: "agent" }, issue: { number: 1 } } },
];
const builder: MockAgent = (_id, _ev, state) => {
  state.prs.add(10);
  return [{ event: "pull_request", action: "opened", payload: { pull_request: { number: 10, head: { sha: "abc" } } } }];
};
const critic: MockAgent = () => [
  { event: "pull_request_review", action: "submitted", payload: { review: { state: "approved" }, pull_request: { number: 10 } } },
];

describe("plumbing simulator (Tier 2)", () => {
  it("routes issue → scout → builder → critic via the compiled triggers+guards", () => {
    const seed: SimEvent[] = [{ event: "issues", action: "opened", payload: { issue: { number: 1 } } }];
    const { fired, state } = runScenario(harness, wiring, seed, {
      scout,
      builder,
      critic,
    });
    expect(fired).toContain("scout");
    expect(fired).toContain("builder");
    expect(fired).toContain("critic");
    expect(state.prs.has(10)).toBe(true);
  });

  it("the label guard gates the builder: a non-'agent' label does not fire it", () => {
    const seed: SimEvent[] = [
      { event: "issues", action: "labeled", payload: { label: { name: "wontfix" }, issue: { number: 2 } } },
    ];
    const { fired } = runScenario(harness, wiring, seed, {});
    expect(fired).not.toContain("builder");
    expect(fired).not.toContain("architect");
  });

  it("brainstorm label routes to the architect, not the builder", () => {
    const seed: SimEvent[] = [
      { event: "issues", action: "labeled", payload: { label: { name: "agent-brainstorm" }, issue: { number: 3 } } },
    ];
    const { fired } = runScenario(harness, wiring, seed, {});
    expect(fired).toContain("architect");
    expect(fired).not.toContain("builder");
  });

  it("terminates (no livelock) on the happy path", () => {
    const seed: SimEvent[] = [{ event: "issues", action: "opened", payload: { issue: { number: 1 } } }];
    const { steps } = runScenario(harness, wiring, seed, { scout, builder, critic }, { maxSteps: 50 });
    expect(steps).toBeLessThan(50);
  });
});
