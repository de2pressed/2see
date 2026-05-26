import { describe, expect, it } from "vitest";

import {
  evidenceStrengthScore,
  getDomain,
  hallucinationRiskScore,
  scoreSourceCredibility,
} from "@/utils/sources";
import { processSearchResults } from "@/services/openai";

describe("source credibility", () => {
  it("extracts domains from URLs", () => {
    expect(getDomain("https://www.reuters.com/world/")).toBe("reuters.com");
  });

  it("scores high, medium, and low source classes", () => {
    expect(scoreSourceCredibility("https://data.gov/report")).toBe("High");
    expect(scoreSourceCredibility("https://www.bloomberg.com/news")).toBe("High");
    expect(scoreSourceCredibility("https://techcrunch.com/article")).toBe("Medium");
    expect(scoreSourceCredibility("https://medium.com/some-post")).toBe("Low");

    // Test new domains added in this phase
    expect(scoreSourceCredibility("https://axios.com/article")).toBe("High");
    expect(scoreSourceCredibility("https://thelancet.com/article")).toBe("High");
    expect(scoreSourceCredibility("https://nielsen.com/insights")).toBe("High");
    expect(scoreSourceCredibility("https://ibm.com/news")).toBe("High");
    expect(scoreSourceCredibility("https://business-standard.com/news")).toBe("High");
    expect(scoreSourceCredibility("https://deepmind.google/discover")).toBe("High");
    expect(scoreSourceCredibility("https://who.int/news-room")).toBe("High"); // .int domain
    expect(scoreSourceCredibility("https://idc.com/getdoc.jsp")).toBe("High");
    expect(scoreSourceCredibility("https://nasscom.in/report")).toBe("High");
    expect(scoreSourceCredibility("https://weforum.org/reports/future-of-jobs")).toBe("High");
    expect(scoreSourceCredibility("https://whitehouse.gov/briefing-room")).toBe("High");
    expect(scoreSourceCredibility("https://eur-lex.europa.eu/legal-content")).toBe("High");
    expect(scoreSourceCredibility("https://statcounter.com/search-engine-market-share")).toBe("High");
  });

  it("derives evidence strength and risk scores", () => {
    const sources = [{ credibility: "High" as const }];
    expect(evidenceStrengthScore(sources, 90)).toBeGreaterThan(50);
    expect(hallucinationRiskScore("Verified", 90, sources)).toBeLessThan(50);
  });

  it("calculates calibrated hallucination risk correctly for Verified, False, and Unverifiable scenarios", () => {
    // 1. Fully grounded False claim (high confidence + high credibility sources) -> Should have low risk
    const strongSources = [
      { credibility: "High" as const },
      { credibility: "High" as const },
    ];
    // strength = 32 + 32 + 95 * 0.35 = 64 + 33 = 97
    // deduction = 97 * 0.7 = 67.9
    // raw = 30 + 1.25 - 67.9 = -36.65 -> clamped to 5
    expect(hallucinationRiskScore("False", 95, strongSources)).toBe(5);

    // 2. Ungrounded False claim (zero sources, low confidence) -> Should have high risk
    expect(hallucinationRiskScore("False", 40, [])).toBe(75); // 30 + 15 + 30 = 75, clamped/rounded properly

    // 3. Unverifiable claim with zero sources -> Should have high risk
    expect(hallucinationRiskScore("Unverifiable", 50, [])).toBe(95); // 60 + 12.5 + 30 = 102.5 -> clamped to 95
  });
});
describe("search results processing", () => {
  it("deduplicates, filters, ranks, and trims search results successfully", () => {
    const raw = [
      {
        title: "Medium Blog Post on Perplexity",
        url: "https://medium.com/@user/perplexity-market-share",
        snippet: "A random user post claiming huge growth numbers that are unsupported.",
      },
      {
        title: "Bloomberg Official Market Report",
        url: "https://www.bloomberg.com/news/articles/perplexity-google-share",
        snippet: "Google Search maintains a 91% global market share in 2026, while Perplexity holds less than 0.5% global query share.",
      },
      {
        title: "Duplicate Bloomberg Report",
        url: "https://www.bloomberg.com/news/other-page",
        snippet: "Duplicate snippet content from the same host that should be filtered out.",
      },
      {
        title: "TechCrunch Review of Search",
        url: "https://techcrunch.com/2026/search-comparison",
        snippet: "Perplexity's conversational answer engine is growing fast but is still highly niche compared to incumbents.",
      },
      {
        title: "WHO Official Statistics",
        url: "https://who.int/news-room/statistics",
        snippet: "World Health Organization official global health numbers and data.",
      },
    ];

    const processed = processSearchResults(raw);

    // 1. Check deduplication; at most one low-credibility source is kept when stronger sources exist.
    expect(processed.length).toBe(4);

    // 2. Check prioritization: WHO (score 10) > Bloomberg (score 8) > TechCrunch (score 5)
    expect(processed[0].title).toBe("WHO Official Statistics");
    expect(processed[1].title).toBe("Bloomberg Official Market Report");
    expect(processed[2].title).toBe("TechCrunch Review of Search");
    expect(
      processed.filter((item) => item.credibility === "Low").length,
    ).toBeLessThanOrEqual(1);
  });

  it("penalizes future-only sources for historical claims", () => {
    const processed = processSearchResults(
      [
        {
          title: "AI market outlook 2026",
          url: "https://www.grandviewresearch.com/industry-analysis/artificial-intelligence-ai-market",
          snippet: "The market is projected to grow through 2030 with later-decade estimates.",
        },
        {
          title: "IDC Worldwide AI Tracker 2023",
          url: "https://www.idc.com/getdoc.jsp?containerId=prUS00000023",
          snippet: "Worldwide AI spending reached $154 billion in 2023.",
        },
      ],
      { claimText: "Global enterprise AI spending reached $154 billion in 2023" },
    );

    expect(processed[0].url).toContain("idc.com");
  });
});
