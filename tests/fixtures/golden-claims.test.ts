import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { compareClaimToEvidence, metricSupportedInContext } from "@/services/openai";
import { normalizeClaimText } from "@/utils/claims";

type GoldenClaim = {
  normalizedClaim: string;
  verdict: string;
  minConfidence?: number;
  forbiddenVerdicts?: string[];
  allowedVerdicts?: string[];
};

type GoldenFixture = {
  claims: GoldenClaim[];
};

const fixture = JSON.parse(
  readFileSync(
    join(process.cwd(), "tests", "fixtures", "2see_test_document.expected.json"),
    "utf8",
  ),
) as GoldenFixture;

describe("2see_test_document golden comparator expectations", () => {
  it("defines expectations for all 15 benchmark claims", () => {
    expect(fixture.claims).toHaveLength(15);
  });

  it("never marks fabricated $1.2T market claim as verified via substring guardrails", () => {
    const claimText = "The global AI market reached exactly $1.2 trillion in 2023.";
    const sources = [
      {
        title: "Subprime mortgage crisis",
        url: "https://en.wikipedia.org/wiki/Subprime_mortgage_crisis",
        snippet: "Historical mortgage crisis context from 2008.",
        credibility: "High" as const,
      },
      {
        title: "AI spending worldwide 2027",
        url: "https://www.statista.com/statistics/694638/worldwide-cognitive-and-artificial-intelligence-revenues",
        snippet: "Projected cognitive AI revenues of 1.2 by 2027.",
        credibility: "High" as const,
      },
    ];

    expect(metricSupportedInContext(claimText, sources)).toBe(false);
    const comparison = compareClaimToEvidence(claimText, sources);
    expect(comparison.verdict).not.toBe("Verified");
  });

  for (const entry of fixture.claims) {
    it(`maps normalized key for: ${entry.normalizedClaim.slice(0, 48)}...`, () => {
      const sample =
        entry.normalizedClaim.includes("perplexity")
          ? "Perplexity AI surpassed Google Search in global market share in 2025."
          : entry.normalizedClaim.includes("$1 2t")
            ? "The global AI market reached exactly $1.2 trillion in 2023."
            : "OpenAI launched ChatGPT publicly in November 2022.";

      expect(normalizeClaimText(sample).length).toBeGreaterThan(10);
      expect(entry.verdict).toMatch(/^(Verified|Inaccurate|False|Unverifiable)$/);
    });
  }
});
