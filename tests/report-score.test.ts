import { describe, expect, it } from "vitest";

import { calculateReportScore } from "@/utils/report-score";

describe("calculateReportScore", () => {
  it("returns null before any claims are verified", () => {
    expect(calculateReportScore([])).toBeNull();
  });

  it("scores verified claims at full value", () => {
    expect(calculateReportScore([{ verdict: "Verified" }, { verdict: "Verified" }])).toBe(100);
  });

  it("penalizes inaccurate, unverifiable, and false claims", () => {
    expect(
      calculateReportScore([
        { verdict: "Verified" },
        { verdict: "Inaccurate" },
        { verdict: "Unverifiable" },
        { verdict: "False" },
      ]),
    ).toBe(44);
  });

  it("updates as each live result arrives", () => {
    const liveResults = [
      { verdict: "Verified" as const },
      { verdict: "Inaccurate" as const },
      { verdict: "False" as const },
    ];

    expect(calculateReportScore(liveResults.slice(0, 1))).toBe(100);
    expect(calculateReportScore(liveResults.slice(0, 2))).toBe(75);
    expect(calculateReportScore(liveResults)).toBe(50);
  });
});
