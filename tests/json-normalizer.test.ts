import { describe, expect, it } from "vitest";
import { normalizeClaimJson } from "@/utils/ai";

describe("Claim JSON Normalizer", () => {
  it("normalizes standard arrays of claims successfully", () => {
    const raw = [
      {
        claim: "The market size grew to $10B in 2023.",
        type: "Statistical",
        importance_score: 95,
        page_number: 1,
      },
    ];
    const normalized = normalizeClaimJson(raw);
    expect(normalized).toHaveLength(1);
    expect(normalized[0]).toEqual({
      claim: "The market size grew to $10B in 2023.",
      type: "statistical",
      importance_score: 95,
      page_number: 1,
    });
  });

  it("handles alternative keys and stringified types/scores", () => {
    const raw = {
      claims: [
        {
          statement: "Next-gen chips are 4x faster.",
          claim_type: "Technical Benchmark",
          importanceScore: "85",
        },
        {
          text: "Launch date was scheduled on Nov 12.",
          type: "dates",
          score: "high",
        },
      ],
    };
    const normalized = normalizeClaimJson(raw);
    expect(normalized).toHaveLength(2);
    expect(normalized[0]).toEqual({
      claim: "Next-gen chips are 4x faster.",
      type: "technical",
      importance_score: 85,
    });
    expect(normalized[1]).toEqual({
      claim: "Launch date was scheduled on Nov 12.",
      type: "date",
      importance_score: 80,
    });
  });

  it("filters out invalid claim entries (empty or short claim text)", () => {
    const raw = [
      {
        claim: "  ", // too short / empty
        type: "statistical",
        importance_score: 50,
      },
      {
        claim: "Valid claim statement about growth.",
        type: "financial",
        importance_score: 40,
      },
    ];
    const normalized = normalizeClaimJson(raw);
    expect(normalized).toHaveLength(1);
    expect(normalized[0].claim).toBe("Valid claim statement about growth.");
  });
});
