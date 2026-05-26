import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { NormalizedClaim, VerificationResult } from "@/lib/schemas";
import { DEFAULT_MODEL } from "@/lib/models";
import type { GeminiModel } from "@/lib/models";
import {
  runBatchedVerifications,
  verifyClaimWithRetries,
} from "@/services/verification";
import {
  applyVerificationGuardrails,
  assessEvidence,
  buildDeterministicRetrievalQuerySequence,
  buildRetrievalQuerySequence,
  buildUnverifiableFallbackQuerySequence,
  compareClaimToEvidence,
  countTopicTokenOverlap,
  extractAttributionLabel,
  fallbackVerification,
  isRankingMarketShareClaim,
  isPublicRankingOrSuperlativeClaim,
  metricSupportedInContext,
  generateRetrievalQueries,
  verificationFromGuardrailsOnly,
  htmlToEvidenceText,
  parseClaimFacts,
  sanitizeEvidenceSnippet,
  parseRateLimitRetryAfterMs,
  rateLimitDelayMs,
  shouldFastFailRateLimit,
  isDailyQuotaRateLimit,
} from "@/services/openai";

const claim: NormalizedClaim = {
  id: "claim-1",
  claim: "The company reached $17B revenue in 2025.",
  normalized_claim: "the company reached $17B revenue in 2025",
  type: "financial",
  importance_score: 90,
};

function resultFor(nextClaim: NormalizedClaim): VerificationResult {
  return {
    claim_id: nextClaim.id,
    claim: nextClaim.claim,
    type: nextClaim.type,
    verdict: "Verified",
    confidence: 91,
    explanation: "The claim is supported by grounded evidence.",
    corrected_fact: "",
    verified_at: new Date().toISOString(),
    sources: [
      {
        title: "Source",
        url: "https://data.gov/example",
        snippet: "Evidence snippet",
        retrieved_at: new Date().toISOString(),
        domain: "data.gov",
        credibility: "High",
      },
    ],
  };
}

describe("verification orchestration", () => {
  it("returns timeout fallback without retrying", async () => {
    const result = await verifyClaimWithRetries(claim, DEFAULT_MODEL, async () => {
      throw new Error("Verification timed out");
    });

    expect(result.verdict).toBe("Unverifiable");
    expect(result.explanation).toContain("Verification failed/unsupported");
  });

  it("backs off on repeated 429 errors and then falls back", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const promise = verifyClaimWithRetries(
      claim,
      DEFAULT_MODEL,
      async () => {
        attempts += 1;
        throw new Error("429 rate limit");
      },
    );

    await vi.advanceTimersByTimeAsync(14_000);
    const result = await promise;
    vi.useRealTimers();

    expect(attempts).toBe(4);
    expect(result.verdict).toBe("Unverifiable");
    expect(result.explanation).toContain("Verification failed/unsupported");
  });

  it("limits batch concurrency to 2 on paid models", async () => {
    const claims = Array.from({ length: 5 }).map((_, index) => ({
      ...claim,
      id: `claim-${index + 1}`,
    }));
    let active = 0;
    let maxActive = 0;

    const paidLikeModel = "google/gemini-2.5-flash" as GeminiModel;

    await runBatchedVerifications(
      claims,
      paidLikeModel,
      () => undefined,
      {
        batchSize: 5,
        concurrency: 2,
        batchDelayMs: 0,
        verifier: async (nextClaim) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 1));
          active -= 1;
          return resultFor(nextClaim);
        },
      },
    );

    expect(maxActive).toBe(2);
  });

  it("forces concurrency to 1 on free models to reduce rate-limit pressure", async () => {
    const claims = Array.from({ length: 5 }).map((_, index) => ({
      ...claim,
      id: `claim-${index + 1}`,
    }));
    let active = 0;
    let maxActive = 0;

    await runBatchedVerifications(
      claims,
      DEFAULT_MODEL,
      () => undefined,
      {
        batchSize: 5,
        concurrency: 2,
        batchDelayMs: 0,
        verifier: async (nextClaim) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 1));
          active -= 1;
          return resultFor(nextClaim);
        },
      },
    );

    expect(maxActive).toBe(1);
  });

  it("retries on rate limit error with same model", async () => {
    const attemptedModels: string[] = [];
    const result = await verifyClaimWithRetries(
      claim,
      DEFAULT_MODEL,
      async (nextClaim, currentModel) => {
        attemptedModels.push(currentModel);
        if (attemptedModels.length < 3) {
          throw new Error("429 rate limit");
        }
        return resultFor(nextClaim);
      },
    );

    expect(attemptedModels).toEqual([
      DEFAULT_MODEL,
      DEFAULT_MODEL,
      DEFAULT_MODEL,
    ]);
    expect(result.verdict).toBe("Verified");
  });

  it("parses Groq retry-after text and caps very long waits", () => {
    const error = new Error("429 Rate limit reached. Please try again in 7m8.7168s.");

    expect(parseRateLimitRetryAfterMs(error)).toBe(428717);
    expect(rateLimitDelayMs(error, 2_000)).toBe(60_000);
    expect(shouldFastFailRateLimit(error)).toBe(true);
  });

  it("uses guardrails immediately when daily quota is hit during synthesis", async () => {
    vi.useFakeTimers();
    const dailyQuotaError = new Error(
      "Rate limit reached for model llama-3.3-70b-versatile. Limit 100000, Used 98491, Requested 3292. Please try again in 25m40s.",
    );

    const promise = verifyClaimWithRetries(claim, DEFAULT_MODEL, async () => {
      throw dailyQuotaError;
    });

    await vi.runAllTimersAsync();
    const result = await promise;
    vi.useRealTimers();

    expect(result.verdict).toBe("Unverifiable");
    expect(result.explanation).toContain("Verification failed/unsupported");
  });

  it("fast-fails daily token quota errors without retrying", () => {
    const error = new Error(
      "Rate limit reached for model llama-3.3-70b-versatile. Limit 100000, Used 98491, Requested 3292. Please try again in 25m40s. Groq API error.",
    );

    expect(isDailyQuotaRateLimit(error)).toBe(true);
    expect(shouldFastFailRateLimit(error)).toBe(true);
  });
});

describe("generateRetrievalQueries fallback", () => {
  it("uses fallback queries when parsing fails or LLM throws", async () => {
    const result = await generateRetrievalQueries("Google AI Overviews broad search in 2024", DEFAULT_MODEL);
    expect(result.primary).toBe("Google AI Overviews broad search in 2024");
    expect(result.fallbackSimplified).toBe("Google AI Overviews broad search in 2024");
  });
});

describe("retrieval query construction", () => {
  it("keeps exact numbers and years in deterministic query variants", () => {
    const queries = buildRetrievalQuerySequence(
      "NVIDIA's data center revenue reached $47.5 billion for fiscal year 2024.",
    );

    expect(queries[0].query).toContain("$47.5 billion");
    expect(queries.some((query) => query.query.includes("2024"))).toBe(true);
    expect(queries.some((query) => query.query.includes("NVIDIA"))).toBe(true);
  });

  it("adds attribution-focused deterministic queries when a source label exists", () => {
    const queries = buildDeterministicRetrievalQuerySequence(
      "According to Acme Research, 55% of organizations adopted AI in 2023.",
    );

    expect(queries.some((query) => query.type === "attribution" && query.query.includes("Acme Research"))).toBe(true);
    expect(queries.some((query) => query.type === "source-domain" && query.query.includes("site:"))).toBe(true);
  });

  it("builds source-focused fallback queries before allowing Unverifiable", () => {
    const queries = buildUnverifiableFallbackQuerySequence(
      "According to Acme Research, revenue reached $10 billion in 2024.",
    );

    expect(queries[0].query).toContain("According to Acme Research");
    expect(queries.some((query) => query.query.includes("Acme Research"))).toBe(true);
    expect(queries.some((query) => query.query.includes("$10 billion"))).toBe(true);
  });
});

describe("verification guardrails", () => {
  const verifiedResult = {
    verdict: "Verified" as const,
    confidence: 90,
    explanation: "The claim is supported.",
    corrected_fact: "",
  };

  it("classifies exact metric contradictions from strong evidence as false", () => {
    const guarded = applyVerificationGuardrails(
      { claim: "Acme Corp revenue reached $10 billion in 2024." },
      verifiedResult,
      [
        {
          title: "Acme annual report",
          url: "https://investor.acme.example/report",
          snippet: "Acme Corp reported revenue of $8 billion in 2024.",
          credibility: "High",
        },
      ],
    );

    expect(guarded.verdict).toBe("False");
  });

  it("rejects evidence that confirms the value only in a different timeframe", () => {
    const guarded = applyVerificationGuardrails(
      { claim: "Acme App reached 200 million weekly users in Q2 2023." },
      verifiedResult,
      [
        {
          title: "Acme product update",
          url: "https://acme.example/news",
          snippet: "Acme App reached 200 million weekly users in August 2024.",
          credibility: "High",
        },
      ],
    );

    expect(guarded.verdict).toBe("Inaccurate");
  });

  it("classifies wrong or unsupported source attribution as inaccurate", () => {
    const guarded = applyVerificationGuardrails(
      { claim: "According to Acme Research, 55% of organizations adopted AI in 2023." },
      verifiedResult,
      [
        {
          title: "Acme Research adoption report",
          url: "https://acme.example/report",
          snippet: "Acme Research found 45% of organizations adopted AI in 2023.",
          credibility: "High",
        },
      ],
    );

    expect(guarded.verdict).toBe("Inaccurate");
  });

  it("uses fetched source text for exact matching", () => {
    const guarded = applyVerificationGuardrails(
      { claim: "Acme Processor shipped with 192GB memory in 2024." },
      { ...verifiedResult, verdict: "Unverifiable", confidence: 20 },
      [
        {
          title: "Acme technical brief",
          url: "https://acme.example/brief",
          snippet: "Product specifications are listed in the brief.",
          fetchedText: "The Acme Processor shipped with 192GB memory in 2024 for accelerator workloads.",
          credibility: "High",
        },
      ],
    );

    expect(guarded.verdict).toBe("Verified");
  });

  it("upgrades Unverifiable when exact fetched evidence supports the claim", () => {
    const guarded = applyVerificationGuardrails(
      { claim: "Acme Research reported 55% adoption in 2023." },
      { verdict: "Unverifiable", confidence: 10, explanation: "Evidence absent.", corrected_fact: "" },
      [
        {
          title: "Acme Research survey",
          url: "https://acme.example/survey",
          snippet: "The 2023 Acme Research survey reported 55% adoption.",
          credibility: "High",
        },
      ],
    );

    expect(guarded.verdict).toBe("Verified");
  });

  it("parses claim facts used by the evidence comparator", () => {
    const facts = parseClaimFacts(
      "According to Acme Research, revenue reached $10 billion in Q4 2024.",
    );

    expect(facts.attribution).toBe("Acme Research");
    expect(facts.values).toContain("$10 billion");
    expect(facts.timeframes.some((timeframe) => timeframe.includes("2024"))).toBe(true);
  });

  it("normalizes fetched HTML into searchable evidence text", () => {
    const text = htmlToEvidenceText("<html><script>bad()</script><h1>Report</h1><p>Revenue reached $10B.</p></html>");

    expect(text).toContain("Report");
    expect(text).toContain("Revenue reached $10B.");
    expect(text).not.toContain("bad()");
  });

  it("compares evidence without calling the model", () => {
    const comparison = compareClaimToEvidence(
      "Acme revenue reached $10 billion in 2024.",
      [
        {
          title: "Acme annual report",
          url: "https://acme.example/annual",
          snippet: "Acme revenue reached $10 billion in 2024.",
          credibility: "High",
        },
      ],
    );

    expect(comparison.verdict).toBe("Verified");
  });

  it("does not treat bare 'from Company' phrasing as named-source attribution", () => {
    expect(
      extractAttributionLabel("Anthropic raised $4 billion from Amazon in September 2023"),
    ).toBeNull();
  });

  it("uses guardrail-only verdict when model rate limit hits but evidence exists", () => {
    const evidence = {
      verifiedAt: new Date().toISOString(),
      searchResults: [
        {
          title: "Amazon invests up to $4B in Anthropic",
          url: "https://www.aboutamazon.com/news/company-news/amazon-anthropic-ai-investment",
          snippet: "Amazon announced it will invest up to $4 billion in Anthropic in September 2023.",
          domain: "aboutamazon.com",
          authorityScore: 7,
          credibility: "High" as const,
          matchedClaimTokens: 6,
        },
      ],
      rawSearchResults: [],
      contextBlock: "",
      technicalFailureOccurred: false,
      searchQueryCount: 0,
    };

    const result = verificationFromGuardrailsOnly(
      { claim: "Anthropic raised $4 billion from Amazon in September 2023", type: "financial", id: "c1", normalized_claim: "x", importance_score: 90 },
      evidence,
      "Rate limit reached (429)",
    );

    expect(result.verdict).not.toBe("Unverifiable");
    expect(result.sources.length).toBeGreaterThan(0);
  });

  it("downgrades unverifiable to inaccurate when credible sources match topic but not exact figure", () => {
    const sources = [
      {
        title: "The 2023 AI Index Report | Stanford HAI",
        url: "https://hai.stanford.edu/ai-index/2023",
        snippet: "[Skip to content] [About] Annual report on artificial intelligence trends in 2023.",
        credibility: "High" as const,
      },
      {
        title: "The state of AI in 2023 | McKinsey",
        url: "https://www.mckinsey.com/capabilities/quantumblack/our-insights/the-state-of-ai-in-2023",
        snippet: "Generative AI adoption accelerated across industries in 2023.",
        credibility: "High" as const,
      },
    ];

    expect(
      countTopicTokenOverlap(
        "The global AI market reached exactly $1.2 trillion in 2023.",
        sources.map((source) => `${source.title} ${sanitizeEvidenceSnippet(source.snippet)}`).join(" "),
      ),
    ).toBeGreaterThanOrEqual(2);

    const guarded = applyVerificationGuardrails(
      { claim: "The global AI market reached exactly $1.2 trillion in 2023." },
      {
        verdict: "Unverifiable",
        confidence: 40,
        explanation: "No direct confirmation of the exact market size.",
        corrected_fact: "",
      },
      sources,
    );

    expect(guarded.verdict).not.toBe("Unverifiable");
    expect(["False", "Inaccurate"]).toContain(guarded.verdict);
  });

  it("does not verify global AI market from unrelated snippets containing bare 1.2", () => {
    const sources = [
      {
        title: "Subprime mortgage crisis",
        url: "https://en.wikipedia.org/wiki/Subprime_mortgage_crisis",
        snippet: "The subprime mortgage crisis intensified in 2008.",
        credibility: "High" as const,
      },
      {
        title: "AI spending worldwide 2027",
        url: "https://www.statista.com/statistics/694638/worldwide-cognitive-and-artificial-intelligence-revenues",
        snippet:
          "Worldwide cognitive and artificial intelligence revenues could reach 1.2 by 2027.",
        credibility: "High" as const,
      },
    ];

    expect(
      metricSupportedInContext(
        "The global AI market reached exactly $1.2 trillion in 2023.",
        sources,
      ),
    ).toBe(false);

    const comparison = compareClaimToEvidence(
      "The global AI market reached exactly $1.2 trillion in 2023.",
      sources,
    );
    expect(comparison.verdict).not.toBe("Verified");
    expect(["False", "Inaccurate"]).toContain(comparison.verdict);
  });

  it("does not promote Unverifiable to Verified without metricSupportedInContext", () => {
    const sources = [
      {
        title: "AI spending worldwide 2027",
        url: "https://www.statista.com/statistics/694638/worldwide-cognitive-and-artificial-intelligence-revenues",
        snippet: "Forecasts mention 1.2 for 2027 cognitive AI revenue.",
        credibility: "High" as const,
      },
    ];

    const guarded = applyVerificationGuardrails(
      { claim: "The global AI market reached exactly $1.2 trillion in 2023." },
      {
        verdict: "Unverifiable",
        confidence: 20,
        explanation: "Could not verify.",
        corrected_fact: "",
      },
      sources,
    );

    expect(guarded.verdict).not.toBe("Verified");
  });

  it("flags perplexity market-share surpass claim as false without quantitative support", () => {
    expect(
      isRankingMarketShareClaim(
        "Perplexity AI surpassed Google Search in global market share in 2025.",
      ),
    ).toBe(true);

    const comparison = compareClaimToEvidence(
      "Perplexity AI surpassed Google Search in global market share in 2025.",
      [
        {
          title: "Perplexity AI vs Google Search Who Wins in 2025",
          url: "https://www.youtube.com/watch?v=example",
          snippet:
            "Perplexity AI and Google Search are competing search products in 2025.",
          credibility: "Low" as const,
        },
        {
          title: "Perplexity competes with Google",
          url: "https://brainandcode.tech/en/perplexity-google",
          snippet:
            "Perplexity AI is positioned as a competitor to Google Search in 2025.",
          credibility: "Low" as const,
        },
      ],
    );

    expect(comparison.verdict).toBe("False");
  });

  it("does not verify exact public market metrics from low-authority-only sources", () => {
    const guarded = applyVerificationGuardrails(
      { claim: "The national AI market was valued at $20 billion in 2022." },
      {
        verdict: "Verified",
        confidence: 80,
        explanation: "A social post supports the claim.",
        corrected_fact: "",
      },
      [
        {
          title: "AI investment social update",
          url: "https://www.linkedin.com/posts/example-ai-market",
          snippet: "A post claims the national AI market passed $20 billion in 2022.",
          credibility: "Low" as const,
        },
      ],
    );

    expect(guarded.verdict).not.toBe("Verified");
    expect(guarded.explanation).toContain("low-authority");
  });

  it("turns unsupported public ranking claims into false when related evidence exists", () => {
    const comparison = compareClaimToEvidence(
      "Acme became the world's largest company by revenue in 2024.",
      [
        {
          title: "Acme 2024 production and financial results",
          url: "https://www.acme.com/investors/2024-results",
          snippet: "Acme reported vehicle deliveries and annual revenue for 2024.",
          credibility: "High" as const,
        },
        {
          title: "Largest companies by revenue ranking",
          url: "https://data.gov/company-rankings",
          snippet: "The global revenue ranking lists other companies above Acme in 2024.",
          credibility: "High" as const,
        },
      ],
    );

    expect(isPublicRankingOrSuperlativeClaim("Acme became the world's largest company by revenue in 2024.")).toBe(true);
    expect(comparison.verdict).toBe("False");
  });

  it("keeps true retrieval failures unverifiable with explicit retrieval metadata", () => {
    const result = fallbackVerification(
      claim,
      "Search retrieval and model synthesis failed due to a network timeout.",
    );

    expect(result.verdict).toBe("Unverifiable");
    expect(result.retrieval_status).toBe("technical_failure");
    expect(result.reason_codes).toContain("verification_failed");
  });

  it("does not verify date claims when related sources only support a different year", () => {
    const comparison = compareClaimToEvidence(
      "Acme Model X was released in March 2022.",
      [
        {
          title: "Acme Model X release announcement",
          url: "https://www.acme.com/news/model-x",
          snippet: "Acme announced Model X in March 2023 for public availability.",
          credibility: "High" as const,
        },
      ],
    );

    expect(comparison.verdict).toBe("Inaccurate");
  });

  it("allows persistent threshold claims when a credible source confirms the threshold was crossed", () => {
    const comparison = compareClaimToEvidence(
      "The public debt exceeded $35 trillion in 2025.",
      [
        {
          title: "Public debt surpasses $35 trillion",
          url: "https://budget.house.gov/press-release/public-debt-surpasses-35-trillion",
          snippet: "The public debt surpassed $35 trillion and remained above that threshold.",
          credibility: "High" as const,
        },
        {
          title: "Federal debt and the debt limit in 2025",
          url: "https://www.congress.gov/crs-product/example",
          snippet: "Federal debt remained a major fiscal issue in 2025.",
          credibility: "High" as const,
        },
      ],
    );

    expect(comparison.verdict).toBe("Verified");
  });

  it("summarizes evidence assessment metadata for exact metric claims", () => {
    const assessment = assessEvidence(
      "Acme revenue reached $10 billion in 2024.",
      [
        {
          title: "Acme annual report",
          url: "https://www.acme.com/annual",
          snippet: "Acme reported revenue of $8 billion in 2024.",
          credibility: "High" as const,
        },
      ],
    );

    expect(assessment.evidenceStatus).toBe("related");
    expect(assessment.reasonCodes).toContain("exact_value_missing");
  });

  it("keeps benchmark claim literals out of production verification code", () => {
    const productionFiles = [
      join(process.cwd(), "services", "openai.ts"),
      join(process.cwd(), "utils", "claims.ts"),
    ].map((file) => readFileSync(file, "utf8"));

    const productionText = productionFiles.join("\n");
    expect(productionText).not.toContain("knownAiBenchmarkCorrection");
    expect(productionText).not.toContain("1.87 trillion");
    expect(productionText).not.toContain("LLaMA 2");
    expect(productionText).not.toContain("Claude 2");
    expect(productionText).not.toContain("10^26");
  });
});
