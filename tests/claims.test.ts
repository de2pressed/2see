import { describe, expect, it } from "vitest";

import {
  isLikelyMaterialClaim,
  mergeRelatedClaims,
  normalizeClaimText,
  prepareClaims,
  scoreClaimMateriality,
  selectMaterialClaims,
  splitIndependentAssertions,
  similarityScore,
} from "@/utils/claims";
import type { ExtractedClaim } from "@/lib/schemas";
import {
  currentStressExtractedClaims,
  expectedStressVerdicts,
} from "@/tests/fixtures/stress-report";

describe("claim normalization and selection", () => {
  it("normalizes percentages and currency phrases", () => {
    expect(
      normalizeClaimText("The market grew by 75 percent to 17 billion dollars."),
    ).toBe("the market grew by 75% to $17B");
  });

  it("scores near-duplicate normalized claims above the threshold", () => {
    const left = normalizeClaimText("AI adoption reached 75 percent in 2025.");
    const right = normalizeClaimText("AI adoption reached 75% in 2025");

    expect(similarityScore(left, right)).toBeGreaterThan(0.8);
  });

  it("deduplicates and does not cap the claims", () => {
    const claims: ExtractedClaim[] = Array.from({ length: 25 }).map(
      (_, index) => ({
        claim: `Product line ${index} revenue reached ${index} billion dollars in 2025.`,
        type: "financial",
        importance_score: index,
      }),
    );

    claims.push({
      claim: "Product line 24 revenue reached 24 billion dollars in 2025.",
      type: "financial",
      importance_score: 100,
    });

    const prepared = prepareClaims(claims);

    expect(prepared.claims).toHaveLength(25);
    expect(prepared.wasCapped).toBe(false);
    expect(
      prepared.claims.some((claim) => claim.importance_score === 100),
    ).toBe(true);
  });

  it("does not impose a fixed 30-claim ceiling on material documents", () => {
    const claims: ExtractedClaim[] = Array.from({ length: 45 }).map(
      (_, index) => ({
        claim: `Company ${index} reported revenue of ${index + 10} billion dollars in 2025.`,
        type: "financial",
        importance_score: 80,
      }),
    );

    const prepared = prepareClaims(claims);

    expect(prepared.claims).toHaveLength(45);
    expect(prepared.wasCapped).toBe(false);
  });

  it("does not impose a fixed 30-claim ceiling on larger material documents", () => {
    const claims: ExtractedClaim[] = Array.from({ length: 60 }).map(
      (_, index) => ({
        claim: `Company ${index} reported revenue of ${index + 100} million dollars in 2025.`,
        type: "financial",
        importance_score: 85,
      }),
    );

    const prepared = prepareClaims(claims);

    expect(prepared.claims).toHaveLength(60);
    expect(prepared.wasCapped).toBe(false);
  });

  it("splits independent assertions while preserving the subject", () => {
    const assertions = splitIndependentAssertions(
      "Acme AI reached 200 million weekly users in Q2 2023 and reached that milestone in 5 weeks after launch.",
    );

    expect(assertions).toHaveLength(2);
    expect(assertions[0]).toContain("200 million weekly users");
    expect(assertions[1]).toContain("Acme AI");
    expect(assertions[1]).toContain("5 weeks");
  });

  it("preserves attribution as a materiality feature", () => {
    const attributed = {
      id: "claim-1",
      claim: "According to Acme Research, 55% of organizations adopted AI in 2023.",
      normalized_claim: normalizeClaimText("According to Acme Research, 55% of organizations adopted AI in 2023."),
      type: "statistical" as const,
      importance_score: 75,
    };
    const unattributed = {
      ...attributed,
      id: "claim-2",
      claim: "55% of organizations adopted AI in 2023.",
      normalized_claim: normalizeClaimText("55% of organizations adopted AI in 2023."),
    };

    expect(scoreClaimMateriality(attributed)).toBeGreaterThan(scoreClaimMateriality(unattributed));
  });

  it("scores material parent claims above noisy table and survey fragments", () => {
    const parent = {
      id: "claim-1",
      claim: "Global enterprise AI spending reached $154 billion in 2023",
      normalized_claim: normalizeClaimText("Global enterprise AI spending reached $154 billion in 2023"),
      type: "financial" as const,
      importance_score: 75,
    };
    const tableRow = {
      ...parent,
      id: "claim-2",
      claim: "ML Infrastructure spending grew 35% year-over-year to $51.7B in 2023",
      normalized_claim: normalizeClaimText("ML Infrastructure spending grew 35% year-over-year to $51.7B in 2023"),
    };

    expect(scoreClaimMateriality(parent)).toBeGreaterThan(scoreClaimMateriality(tableRow));
    expect(isLikelyMaterialClaim(parent)).toBe(true);
    expect(isLikelyMaterialClaim(tableRow)).toBe(false);
  });

  it("merges split claims that describe one material fact pattern", () => {
    const claims = [
      {
        id: "claim-1",
        claim: "The Indian AI market reached $8 billion in 2022",
        normalized_claim: normalizeClaimText("The Indian AI market reached $8 billion in 2022"),
        type: "financial" as const,
        importance_score: 80,
      },
      {
        id: "claim-2",
        claim: "The Indian AI market is projected to hit $25 billion by 2025",
        normalized_claim: normalizeClaimText("The Indian AI market is projected to hit $25 billion by 2025"),
        type: "financial" as const,
        importance_score: 80,
      },
    ];

    const merged = mergeRelatedClaims(claims);

    expect(merged).toHaveLength(1);
    expect(merged[0].claim).toContain("$8 billion");
    expect(merged[0].claim).toContain("$25 billion");
  });

  it("keeps public factual claims that are material without requiring a numeric metric", () => {
    const claims = [
      {
        id: "claim-1",
        claim: "Regulators approved a gene-editing therapy for a major inherited disease.",
        normalized_claim: normalizeClaimText("Regulators approved a gene-editing therapy for a major inherited disease."),
        type: "technical" as const,
        importance_score: 90,
      },
      {
        id: "claim-2",
        claim: "A major platform signed licensing agreements with AI companies.",
        normalized_claim: normalizeClaimText("A major platform signed licensing agreements with AI companies."),
        type: "technical" as const,
        importance_score: 88,
      },
      {
        id: "claim-3",
        claim: "The company stated a general commitment to innovation.",
        normalized_claim: normalizeClaimText("The company stated a general commitment to innovation."),
        type: "technical" as const,
        importance_score: 75,
      },
    ];

    expect(isLikelyMaterialClaim(claims[0])).toBe(true);
    expect(isLikelyMaterialClaim(claims[1])).toBe(true);
    expect(isLikelyMaterialClaim(claims[2])).toBe(false);
  });

  it("uses the supplied stress report as a regression fixture without hard-capping", () => {
    const expectedDistribution = expectedStressVerdicts.reduce<Record<string, number>>(
      (counts, item) => ({
        ...counts,
        [item.verdict]: (counts[item.verdict] ?? 0) + 1,
      }),
      {},
    );
    const selected = selectMaterialClaims(
      currentStressExtractedClaims.map((claim, index) => ({
        ...claim,
        id: `claim-${index + 1}`,
        normalized_claim: normalizeClaimText(claim.claim),
      })),
    );
    const selectedText = selected.map((claim) => claim.claim.toLowerCase());

    expect(expectedStressVerdicts).toHaveLength(30);
    expect(expectedDistribution).toEqual({
      False: 10,
      Verified: 13,
      Inaccurate: 7,
    });
    expect(selected.length).toBeGreaterThan(20);
    expect(selected.length).toBeLessThan(currentStressExtractedClaims.length);
    expect(selectedText.filter((claim) => claim.includes("generative ai accounted for $62"))).toHaveLength(1);
    expect(selectedText.some((claim) => claim.includes("1.87 trillion"))).toBe(true);
    expect(selectedText.some((claim) => claim.includes("indian ai market") && claim.includes("$25 billion"))).toBe(true);
    expect(selectedText.some((claim) => claim.includes("ml infrastructure spending grew"))).toBe(false);
    expect(selectedText.some((claim) => claim.includes("bing chat reached"))).toBe(false);
  });
});
