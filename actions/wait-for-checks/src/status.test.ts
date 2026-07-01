import { describe, it, expect } from "vitest";
import {
  classifyRun,
  aggregate,
  isTerminal,
  isPassing,
  type CheckRunLike,
} from "./status.js";

describe("classifyRun", () => {
  it("returns the conclusion verbatim when present", () => {
    expect(classifyRun({ status: "completed", conclusion: "success" })).toBe(
      "success",
    );
    expect(classifyRun({ status: "completed", conclusion: "failure" })).toBe(
      "failure",
    );
    expect(classifyRun({ status: "completed", conclusion: "cancelled" })).toBe(
      "cancelled",
    );
    expect(classifyRun({ status: "completed", conclusion: "skipped" })).toBe(
      "skipped",
    );
  });

  it("prefers a non-null conclusion even if status is not 'completed'", () => {
    // GitHub occasionally reports conclusion before status flips to completed.
    expect(classifyRun({ status: "in_progress", conclusion: "failure" })).toBe(
      "failure",
    );
  });

  it("treats in-flight statuses as pending", () => {
    for (const status of [
      "queued",
      "in_progress",
      "waiting",
      "pending",
      "requested",
    ]) {
      expect(classifyRun({ status, conclusion: null })).toBe("pending");
    }
  });

  it("treats missing/empty status as pending", () => {
    expect(classifyRun({})).toBe("pending");
    expect(classifyRun({ status: "", conclusion: "" })).toBe("pending");
    expect(classifyRun({ status: null, conclusion: null })).toBe("pending");
  });

  it("treats unknown statuses conservatively as pending", () => {
    expect(classifyRun({ status: "banana", conclusion: null })).toBe("pending");
  });

  it("maps completed-with-null-conclusion to neutral", () => {
    expect(classifyRun({ status: "completed", conclusion: null })).toBe(
      "neutral",
    );
  });

  it("is case-insensitive", () => {
    expect(classifyRun({ status: "COMPLETED", conclusion: "SUCCESS" })).toBe(
      "success",
    );
    expect(classifyRun({ status: "In_Progress" })).toBe("pending");
  });
});

describe("aggregate", () => {
  it("returns not_found for an empty list", () => {
    expect(aggregate([])).toBe("not_found");
    expect(aggregate(undefined as unknown as CheckRunLike[])).toBe("not_found");
  });

  it("returns success when the single run succeeded", () => {
    expect(aggregate([{ status: "completed", conclusion: "success" }])).toBe(
      "success",
    );
  });

  it("stays pending while any run is in-flight", () => {
    expect(
      aggregate([
        { status: "completed", conclusion: "success" },
        { status: "in_progress", conclusion: null },
      ]),
    ).toBe("pending");
  });

  it("is failure-dominant once all runs are terminal", () => {
    expect(
      aggregate([
        { status: "completed", conclusion: "success" },
        { status: "completed", conclusion: "failure" },
        { status: "completed", conclusion: "success" },
      ]),
    ).toBe("failure");
  });

  it("prefers failure over cancelled/skipped/neutral", () => {
    expect(
      aggregate([
        { status: "completed", conclusion: "skipped" },
        { status: "completed", conclusion: "cancelled" },
        { status: "completed", conclusion: "failure" },
      ]),
    ).toBe("failure");
  });

  it("prefers cancelled over skipped/success when no failure", () => {
    expect(
      aggregate([
        { status: "completed", conclusion: "success" },
        { status: "completed", conclusion: "cancelled" },
        { status: "completed", conclusion: "skipped" },
      ]),
    ).toBe("cancelled");
  });

  it("reports success when every run passed", () => {
    expect(
      aggregate([
        { status: "completed", conclusion: "success" },
        { status: "completed", conclusion: "success" },
      ]),
    ).toBe("success");
  });

  it("does not conclude on a mix of success + still-pending failure-to-be", () => {
    // one queued run keeps the whole gate pending, hiding a not-yet-final result
    expect(
      aggregate([
        { status: "completed", conclusion: "success" },
        { status: "queued", conclusion: null },
        { status: "completed", conclusion: "failure" },
      ]),
    ).toBe("pending");
  });
});

describe("isTerminal", () => {
  it("pending and not_found are non-terminal", () => {
    expect(isTerminal("pending")).toBe(false);
    expect(isTerminal("not_found")).toBe(false);
  });

  it("all real conclusions are terminal", () => {
    for (const c of [
      "success",
      "failure",
      "cancelled",
      "skipped",
      "timed_out",
      "neutral",
      "timeout",
    ] as const) {
      expect(isTerminal(c)).toBe(true);
    }
  });
});

describe("isPassing", () => {
  it("success, skipped, and neutral pass", () => {
    expect(isPassing("success")).toBe(true);
    expect(isPassing("skipped")).toBe(true);
    expect(isPassing("neutral")).toBe(true);
  });

  it("failure, cancelled, timeout, not_found do not pass", () => {
    for (const c of [
      "failure",
      "cancelled",
      "timeout",
      "not_found",
      "timed_out",
    ] as const) {
      expect(isPassing(c)).toBe(false);
    }
  });
});
