import OpenAI from "openai";
import { z } from "zod";
import {
  aiVerificationSchema,
  extractedClaimsSchema,
  type ExtractedClaim,
  type EvidenceStatus,
  type NormalizedClaim,
  type RetrievalStatus,
  type Verdict,
  type VerificationResult,
} from "@/lib/schemas";
import { DEFAULT_MODEL, type OpenAIModel } from "@/lib/models";
import {
  EXTRACTION_COMPLETION_PARAMS,
  RETRIEVAL_QUERY_COMPLETION_PARAMS,
  VERIFICATION_COMPLETION_PARAMS,
} from "@/lib/llm";
import { loadSearchFixture } from "@/lib/search-fixtures";
import { parseAndValidateGeminiJson, normalizeClaimJson, extractJsonBlock } from "@/utils/ai";
import { getDomain, scoreSourceCredibility, getSourcePriorityScore } from "@/utils/sources";
import { delay } from "@/utils/async";

export type DecisionPath = "guardrail" | "llm" | "fallback" | "knowledge";

const BACKOFF_MS = [2_000, 4_000, 8_000];
const MAX_RATE_LIMIT_WAIT_MS = 60_000;
const FAST_FAIL_RATE_LIMIT_AFTER_MS = 15_000;
const MAX_SEARCH_RESULTS_PER_CLAIM = 8;
const MAX_SEARCH_STEPS_DEFAULT = 4;
const SEARCH_STEP_CONCURRENCY = 2;
const SEARCH_CACHE_TTL_MS = 15 * 60_000;
const SOURCE_TEXT_CACHE_TTL_MS = 30 * 60_000;

export const DEPLOYED_MODEL_TARGET = DEFAULT_MODEL;

type RawSearchResult = {
  title: string;
  url: string;
  snippet: string;
  queryType?: string;
};

export type ProcessedSearchResult = RawSearchResult & {
  domain: string;
  authorityScore: number;
  credibility: ReturnType<typeof scoreSourceCredibility>;
  matchedClaimTokens: number;
  fetchedText?: string;
};

type EvidenceSource = {
  title: string;
  snippet: string;
  url: string;
  fetchedText?: string;
  credibility?: ReturnType<typeof scoreSourceCredibility>;
};

const SEARCH_RESULT_CACHE = new Map<string, { results: RawSearchResult[]; expiresAt: number }>();
const SOURCE_TEXT_CACHE = new Map<string, { text: string; expiresAt: number }>();
const MAX_FETCHED_SOURCE_CHARS = 18_000;

export function assertOpenAIConfigured(): string {
  const apiKey = process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing GROQ_API_KEY or OPENAI_API_KEY.");
  }
  return apiKey;
}

export function getOpenAIClient(): OpenAI {
  return new OpenAI({
    apiKey: assertOpenAIConfigured(),
    baseURL: "https://api.groq.com/openai/v1",
  });
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs = 5000,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();

  if (signal) {
    if (signal.aborted) {
      throw new DOMException("The user aborted a request.", "AbortError");
    }
    signal.addEventListener("abort", onAbort);
  }

  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } catch (error) {
    if (signal?.aborted) {
      throw new DOMException("The user aborted a request.", "AbortError");
    }
    if (controller.signal.aborted) {
      throw new Error(`Request timeout after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    if (signal) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

// Scrapes Mojeek Search results (highly reliable, free, and CAPTCHA-free)
export async function searchMojeek(
  query: string,
  signal?: AbortSignal,
): Promise<Array<{ title: string; url: string; snippet: string }>> {
  try {
    const response = await fetchWithTimeout(
      `https://www.mojeek.com/search?q=${encodeURIComponent(query)}`,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
      },
      5000,
      signal,
    );

    if (!response.ok) {
      console.warn(`Mojeek Search request failed with status: ${response.status}`);
      return [];
    }

    const html = await response.text();
    const results: Array<{ title: string; url: string; snippet: string }> = [];

    // Search results are wrapped in <li> inside <ul class="results">
    const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    let match;

    while ((match = liRegex.exec(html)) !== null) {
      const block = match[1];

      // Mojeek title links have an href and the title text
      // e.g. <h2><a class="title" href="https://...">Title</a></h2> or similar
      const titleLinkRegex = /<a[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/i;
      const titleLinkMatch = titleLinkRegex.exec(block);

      // Mojeek snippets are wrapped in <p class="s">...</p>
      const snippetRegex = /<p class=["']s["']>([\s\S]*?)<\/p>/i;
      const snippetMatch = snippetRegex.exec(block);

      if (titleLinkMatch) {
        const url = titleLinkMatch[1];

        // Ignore mojeek internal links and buttondown email references
        if (url.includes("mojeek.com") || url.includes("buttondown.email")) {
          continue;
        }

        const title = stripHtml(titleLinkMatch[2]);
        const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : "";

        if (url && title) {
          results.push({ url, title, snippet });
        }
      }
    }

    return results.slice(0, 6);
  } catch (error) {
    console.error("searchMojeek failed:", error);
    return [];
  }
}

// Orchestrator: Cascades semantic search to Serper, then to Mojeek if empty
export async function searchWeb(
  query: string,
  signal?: AbortSignal,
): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const fixtureResults = loadSearchFixture(query);
  if (fixtureResults) {
    return fixtureResults;
  }

  let searchEvidence: Array<{ title: string; url: string; snippet: string }> = [];

  // Step 1: Execute primary semantic Tavily lookup
  if (process.env.TAVILY_API_KEY) {
    try {
      searchEvidence = await searchTavily(query, signal);
    } catch (error) {
      console.warn("Tavily network error caught, routing fallback...", error);
    }
  }

  // CRITICAL FAIL-SAFE: If Tavily returns an empty payload array, force Serper engagement
  if (!searchEvidence || searchEvidence.length === 0) {
    if (process.env.SERPER_API_KEY) {
      console.log(`Tavily yielded 0 results for query: "${query}". Routing to Serper API...`);
      try {
        searchEvidence = await searchSerper(query, signal);
      } catch (error) {
        console.error("Serper fallback execution failed:", error);
      }
    }
  }

  // Step 2: Legacy fallback sequence for zero-credit resilience
  if (!searchEvidence || searchEvidence.length === 0) {
    searchEvidence = await searchMojeek(query, signal);
  }

  return searchEvidence;
}

export async function searchTavily(
  query: string,
  signal?: AbortSignal,
): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return [];

  try {
    const response = await fetchWithTimeout(
      "https://api.tavily.com/search",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query,
          api_key: apiKey,
          max_results: 5,
        }),
      },
      5000,
      signal,
    );

    if (!response.ok) {
      console.warn(`Tavily search failed with status: ${response.status}`);
      return [];
    }

    const data: unknown = await response.json();
    if (isRecord(data) && Array.isArray(data.results)) {
      return data.results.map((r: unknown) => {
        const item = isRecord(r) ? r : {};
        return {
          title: stringOr(item.title, "No Title"),
          url: stringOr(item.url, ""),
          snippet: stringOr(item.content, ""),
        };
      });
    }
    return [];
  } catch (error) {
    console.error("Tavily search failed:", error);
    return [];
  }
}

export async function searchSerper(
  query: string,
  signal?: AbortSignal,
): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) return [];

  try {
    const response = await fetchWithTimeout(
      "https://google.serper.dev/search",
      {
        method: "POST",
        headers: {
          "X-API-KEY": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          q: query,
          num: 5,
        }),
      },
      5000,
      signal,
    );

    if (!response.ok) {
      console.warn(`Serper search failed with status: ${response.status}`);
      return [];
    }

    const data: unknown = await response.json();
    if (isRecord(data) && Array.isArray(data.organic)) {
      return data.organic.map((r: unknown) => {
        const item = isRecord(r) ? r : {};
        return {
          title: stringOr(item.title, "No Title"),
          url: stringOr(item.link, stringOr(item.url, "")),
          snippet: stringOr(item.snippet, ""),
        };
      });
    }
    return [];
  } catch (error) {
    console.error("Serper search failed:", error);
    return [];
  }
}

export async function searchWikipedia(
  query: string,
): Promise<Array<{ title: string; url: string; snippet: string }>> {
  try {
    const response = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&origin=*`,
      {
        headers: {
          "User-Agent": "2see/1.0 (contact@2see.ai)",
        },
      }
    );

    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    const results: Array<{ title: string; url: string; snippet: string }> = [];

    if (data.query && data.query.search) {
      for (const item of data.query.search) {
        results.push({
          title: item.title,
          url: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/\s+/g, "_"))}`,
          snippet: stripHtml(item.snippet),
        });
      }
    }

    return results.slice(0, 5);
  } catch (error) {
    console.error("searchWikipedia failed:", error);
    return [];
  }
}



function stripHtml(text: string): string {
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

export function htmlToEvidenceText(html: string): string {
  return stripHtml(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<\/(?:p|div|section|article|li|tr|h[1-6])>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n"),
  )
    .replace(/\s+/g, " ")
    .trim();
}

export async function fetchSourceText(
  url: string,
  signal?: AbortSignal,
  options: { timeoutMs?: number; maxChars?: number } = {},
): Promise<string> {
  const cached = SOURCE_TEXT_CACHE.get(url);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.text;
  }
  if (cached) {
    SOURCE_TEXT_CACHE.delete(url);
  }

  const timeoutMs = options.timeoutMs ?? 6500;
  const maxChars = options.maxChars ?? MAX_FETCHED_SOURCE_CHARS;

  try {
    const response = await fetchWithTimeout(
      url,
      {
        headers: {
          "User-Agent": "2see/1.0 fact verification evidence fetcher",
          Accept: "text/html,text/plain,application/json;q=0.8,*/*;q=0.5",
        },
      },
      timeoutMs,
      signal,
    );

    if (!response.ok) {
      SOURCE_TEXT_CACHE.set(url, { text: "", expiresAt: Date.now() + SOURCE_TEXT_CACHE_TTL_MS });
      return "";
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!/text|html|json|xml/i.test(contentType)) {
      SOURCE_TEXT_CACHE.set(url, { text: "", expiresAt: Date.now() + SOURCE_TEXT_CACHE_TTL_MS });
      return "";
    }

    const rawText = await readResponseTextWithLimit(response, maxChars * 3);
    const evidenceText = htmlToEvidenceText(rawText).slice(0, maxChars);
    SOURCE_TEXT_CACHE.set(url, { text: evidenceText, expiresAt: Date.now() + SOURCE_TEXT_CACHE_TTL_MS });
    return evidenceText;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
    console.warn(
      `Failed to fetch source text for ${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
    SOURCE_TEXT_CACHE.set(url, { text: "", expiresAt: Date.now() + SOURCE_TEXT_CACHE_TTL_MS });
    return "";
  }
}

async function readResponseTextWithLimit(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    return (await response.text()).slice(0, maxBytes);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let received = 0;

  while (received < maxBytes) {
    const { done, value } = await reader.read();
    if (done || !value) {
      break;
    }
    received += value.byteLength;
    chunks.push(decoder.decode(value, { stream: true }));
  }

  try {
    await reader.cancel();
  } catch {
    // ignore cancellation errors after the bounded read
  }

  return `${chunks.join("")}${decoder.decode()}`.slice(0, maxBytes);
}

export async function enrichSearchResultsWithFetchedText(
  results: ProcessedSearchResult[],
  signal?: AbortSignal,
): Promise<ProcessedSearchResult[]> {
  const eligible = results
    .filter((result) => result.credibility !== "Low")
    .slice(0, 2);
  const textByUrl = new Map<string, string>();

  await Promise.all(
    eligible.map(async (result) => {
      const text = await fetchSourceText(result.url, signal, { timeoutMs: 4500 });
      if (text) {
        textByUrl.set(result.url, text);
      }
    }),
  );

  return results.map((result) => ({
    ...result,
    fetchedText: textByUrl.get(result.url),
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

export async function extractClaimsWithOpenAI(
  text: string,
  model: OpenAIModel,
  pageNumber?: number,
): Promise<ExtractedClaim[]> {
  const openai = getOpenAIClient();
  const docRef = pageNumber !== undefined ? `document page ${pageNumber}` : "document text";

  const systemMessage =
    "You are 2see, an elite fact-verification preprocessor. " +
    "Your ONLY output must be a raw JSON array — no markdown fences, no prose, no commentary. " +
    "Output format: [{\"claim\":\"string\",\"type\":\"statistical|financial|technical|date\",\"importance_score\":0-100}]";

  const userPrompt = [
    `Extract all material, independently verifiable factual claims from the ${docRef} below.`,
    "Target key statistical/financial metrics, launches, acquisitions, funding rounds, market valuations, benchmark results, named regulatory actions, and specific historical events.",
    "CRITICAL rules for selective, production-grade extraction:",
    "- Extract all material claims in the document; do not target or force a fixed count.",
    "- Split independent assertions in one sentence when each assertion needs separate verification.",
    "- Preserve attribution in the claim text when attribution affects truth, including phrases like 'according to', 'reported by', 'estimated by', source report names, and survey names.",
    "- Preserve essential values, units, years, dates, regions, and technical specifications. Do not shorten a claim in a way that drops a key number or spec.",
    "- Keep market-size, market-share, launch-date, benchmark, funding, regulatory, and technical-spec claims as separate objects when they assert different facts.",
    "- Extract the strongest parent claim instead of every supporting row or sub-metric when a row only restates a covered parent total.",
    "- Reject duplicate table rows, repeated projections, generic context statements, marketing filler, weak unattributed survey fragments, and secondary claims that only support a stronger parent claim.",
    "- Extract all material claims in the document, whether that is fewer or more than 30; do not impose a fixed count.",
    "- Process the text from header to footer so late-page material claims are not skipped.",
    "- Consolidate related metrics only when they describe the same entity and same fact pattern in the same source sentence, such as a value plus its year-over-year change.",
    "- Never merge unrelated claims simply because they mention the same entity.",
    "- Every claim MUST be complete and self-contained (include subject, event/metric, values, and year/timeframe) so it can be verified independently.",
    "- NEVER extract standalone numbers, percentages, or fragments without their full context.",
    "Rank importance_score higher for claims that are specific, numerical, recent, or critical to the company's valuation or performance.",
    "Format: [{\"claim\":\"Claim text string\",\"type\":\"statistical|financial|technical|date\",\"importance_score\":0-100}]",
    "CRITICAL: Output ONLY the raw JSON array. No markdown, no explanation.",
    "Document text:",
    text,
  ].join("\n\n");

  const response = await openai.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemMessage },
      { role: "user", content: userPrompt },
    ],
    max_tokens: 8192,
    ...EXTRACTION_COMPLETION_PARAMS,
  });

  const raw = response.choices[0]?.message?.content || "";
  let extracted: ExtractedClaim[] = [];

  const normalizeText = (text: string) => {
    return text
      .toLowerCase()
      .replace(/\\/g, "")          // Strip out backslashes (fixes structural escaping)
      .replace(/[^a-z0-9]/g, "")   // Remove all non-alphanumeric characters (punctuation, currencies)
      .trim();
  };

  const deduplicate = (list: ExtractedClaim[]) => {
    return list.filter((item, index, self) =>
      index === self.findIndex((t) => (
        normalizeText(t.claim) === normalizeText(item.claim)
      ))
    );
  };

  // 1. Multi-strategy parse, normalize, and validate with Zod
  try {
    const { extractJsonBlock, repairTruncatedJsonArray } = await import("@/utils/ai");
    let cleaned = extractJsonBlock(raw);
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      console.warn("JSON.parse failed on initial extraction, applying repairTruncatedJsonArray...");
      const repaired = repairTruncatedJsonArray(raw);
      cleaned = extractJsonBlock(repaired);
      parsed = JSON.parse(cleaned);
    }
    const normalized = normalizeClaimJson(parsed);
    const validation = extractedClaimsSchema.safeParse(normalized);
    if (validation.success) {
      extracted = validation.data.map((claim) => ({
        ...claim,
        ...(pageNumber !== undefined ? { page_number: pageNumber } : {}),
      }));
      return deduplicate(extracted);
    } else {
      console.warn("Zod validation failed for normalized claims:", validation.error.message);
    }
  } catch (parseError) {
    console.error("JSON parsing failed, attempting fallback parsing strategies", parseError);
  }

  // Fallback A: expect a raw array
  const validation = parseAndValidateGeminiJson(raw, extractedClaimsSchema);
  if (validation.ok) {
    extracted = validation.data.map((claim) => ({
      ...claim,
      ...(pageNumber !== undefined ? { page_number: pageNumber } : {}),
    }));
    return deduplicate(extracted);
  }

  // Fallback B: some models wrap the array as {"claims": [...]}
  const wrappedSchema = z
    .object({ claims: extractedClaimsSchema })
    .transform((v) => v.claims);
  const wrappedValidation = parseAndValidateGeminiJson(raw, wrappedSchema);
  if (wrappedValidation.ok) {
    extracted = wrappedValidation.data.map((claim) => ({
      ...claim,
      ...(pageNumber !== undefined ? { page_number: pageNumber } : {}),
    }));
    return deduplicate(extracted);
  }

  // Fallback C: model returned a single-object wrapper with a different key
  // Try to find any array value in a top-level JSON object
  try {
    const parsed = JSON.parse(validation.cleaned);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const val of Object.values(parsed)) {
        const arrCheck = extractedClaimsSchema.safeParse(val);
        if (arrCheck.success) {
          extracted = arrCheck.data.map((claim) => ({
            ...claim,
            ...(pageNumber !== undefined ? { page_number: pageNumber } : {}),
          }));
          return deduplicate(extracted);
        }
      }
    }
  } catch {
    // ignore
  }

  console.error(
    "OpenAI claim extraction failed all fallbacks.",
    validation.error,
    "Raw (first 300):",
    raw.slice(0, 300),
  );
  return [];
}

export async function extractClaimsWithRetries(
  text: string,
  initialModel: OpenAIModel,
  pageNumber?: number,
): Promise<ExtractedClaim[]> {
  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt += 1) {
    try {
      return await extractClaimsWithOpenAI(text, initialModel, pageNumber);
    } catch (error) {
      if (isRateLimitError(error)) {
        const msg = summarizeRateLimitReason(error);

        if (shouldFastFailRateLimit(error) || attempt === BACKOFF_MS.length) {
          throw new Error(`Rate limit reached during claim extraction: ${msg}`);
        }
        console.warn(`Rate limit reached on ${initialModel}. Retrying after delay...`);
        await delay(rateLimitDelayMs(error, BACKOFF_MS[attempt]));
        continue;
      }
      throw error;
    }
  }
  throw new Error("Claim extraction failed after retries.");
}

export function processSearchResults(
  results: RawSearchResult[],
  options: { claimText?: string } = {},
): ProcessedSearchResult[] {
  if (!results || results.length === 0) {
    return [];
  }

  const claimYears = extractYears(options.claimText ?? "");

  // 1. Map results to domain authority scores and claim-token overlap.
  const mapped = results.map((res) => {
    const domain = getDomain(res.url);
    const futureYearPenalty = hasFutureOnlyYear(res, claimYears) ? 3 : 0;
    const authorityScore = Math.max(
      0,
      getSourcePriorityScore(res.url) - futureYearPenalty,
    );

    return {
      ...res,
      domain,
      authorityScore,
      credibility: scoreSourceCredibility(res.url),
      matchedClaimTokens: countClaimTokenMatches(options.claimText ?? "", res),
    };
  });

  // 2. Deduplicate: keep the strongest result per unique domain.
  const byDomain = new Map<string, (typeof mapped)[number]>();

  for (const item of mapped) {
    if (!item.domain) {
      byDomain.set(`${item.url}-${byDomain.size}`, item);
      continue;
    }
    const existing = byDomain.get(item.domain);
    if (
      !existing ||
      item.authorityScore > existing.authorityScore ||
      item.matchedClaimTokens > existing.matchedClaimTokens
    ) {
      byDomain.set(item.domain, item);
    }
  }

  let uniqueResults = Array.from(byDomain.values());

  // 3. If high or medium authority evidence exists, remove low-authority noise.
  if (uniqueResults.some((item) => item.credibility !== "Low")) {
    const nonLow = uniqueResults.filter((item) => item.credibility !== "Low");
    const low = uniqueResults.filter((item) => item.credibility === "Low");
    uniqueResults = nonLow.length > 0 ? [...nonLow, ...low.slice(0, 1)] : low;
  }

  if (options.claimText) {
    uniqueResults = uniqueResults.filter((item) =>
      passesClaimRelevanceGate(options.claimText!, item, claimYears),
    );
  }

  // 4. Sort by authority, then by claim-token overlap.
  uniqueResults.sort(
    (a, b) =>
      b.authorityScore - a.authorityScore ||
      b.matchedClaimTokens - a.matchedClaimTokens,
  );

  // 5. Limit: keep the top 6 strongest items to improve evidence coverage.
  const selected = uniqueResults.slice(0, 6);

  // 6. Trim snippets to keep the verification prompt bounded.
  return selected.map((item) => {
    let cleanSnippet = sanitizeEvidenceSnippet(item.snippet);
    if (cleanSnippet.length > 360) {
      cleanSnippet = cleanSnippet.slice(0, 357) + "...";
    }
    return {
      title: item.title,
      url: item.url,
      snippet: cleanSnippet || "Evidence retrieved.",
      queryType: item.queryType,
      domain: item.domain,
      authorityScore: item.authorityScore,
      credibility: item.credibility,
      matchedClaimTokens: item.matchedClaimTokens,
    };
  });
}

function extractYears(text: string): number[] {
  const matches = text.match(/\b(?:19|20)\d{2}\b/g) ?? [];
  return [...new Set(matches.map(Number))];
}

function hasFutureOnlyYear(result: RawSearchResult, claimYears: number[]): boolean {
  if (claimYears.length === 0) {
    return false;
  }

  const resultText = `${result.title} ${result.snippet}`;
  const resultYears = extractYears(resultText);
  if (resultYears.length === 0) {
    return false;
  }

  const earliestClaimYear = Math.min(...claimYears);
  const containsClaimYear = claimYears.some((year) => resultYears.includes(year));
  const onlyFutureYears = resultYears.every((year) => year > earliestClaimYear);

  return onlyFutureYears && !containsClaimYear;
}

function passesClaimRelevanceGate(
  claimText: string,
  item: ProcessedSearchResult,
  claimYears: number[],
): boolean {
  const facts = parseClaimFacts(claimText);
  const evidence = normalizeFactToken(`${item.title} ${item.snippet}`);

  if (item.matchedClaimTokens < 2) {
    const entityHit = facts.entities.some(
      (entity) =>
        normalizeFactToken(entity).length >= 3 &&
        evidence.includes(normalizeFactToken(entity)),
    );
    if (!entityHit) {
      return false;
    }
  }

  if (claimYears.length > 0) {
    const hasClaimYear = claimYears.some((year) => evidence.includes(String(year)));
    if (!hasClaimYear && item.matchedClaimTokens < 3) {
      return false;
    }
  }

  return true;
}

function countClaimTokenMatches(claimText: string, result: RawSearchResult): number {
  if (!claimText) {
    return 0;
  }

  const evidence = normalizeSearchText(`${result.title} ${result.snippet}`);
  const tokens = new Set(
    normalizeSearchText(claimText)
      .split(/\s+/)
      .filter((token) => token.length >= 3 || /\d/.test(token)),
  );

  let matches = 0;
  for (const token of tokens) {
    if (evidence.includes(token)) {
      matches += 1;
    }
  }

  return matches;
}

function normalizeSearchText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[$,]/g, "")
    .replace(/[^\w\s.%^]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface RetrievalQueries {
  primary: string;
  fallbackSimplified: string;
  fallbackEntity: string;
  fallbackOfficial: string;
}

type QueryStep = {
  type: "literal" | "metrics" | "entity" | "attribution" | "source-domain" | "official" | "generated-primary" | "generated-simplified" | "generated-entity" | "generated-official";
  query: string;
};

export function buildRetrievalQuerySequence(
  claimText: string,
  generated?: RetrievalQueries,
): QueryStep[] {
  const deterministicSteps = buildDeterministicRetrievalQuerySequence(claimText);

  if (!generated) {
    return deterministicSteps;
  }

  return dedupeQuerySteps([
    ...deterministicSteps,
    { type: "generated-primary", query: generated.primary },
    { type: "generated-simplified", query: generated.fallbackSimplified },
    { type: "generated-entity", query: generated.fallbackEntity },
    { type: "generated-official", query: generated.fallbackOfficial },
  ]);
}

export function buildDeterministicRetrievalQuerySequence(
  claimText: string,
): QueryStep[] {
  const numbers = extractMetricTokens(claimText);
  const years = extractYears(claimText).map(String);
  const entities = extractEntityTokens(claimText);
  const attribution = extractAttributionLabel(claimText);
  const sourceDomain = attribution ? sourceLabelToDomainQuery(attribution) : "";
  const compactClaim = claimText.replace(/\s+/g, " ").trim();
  const metricQuery = [...entities, ...numbers, ...years].join(" ").trim();
  const attributionQuery = attribution
    ? [attribution, ...entities, ...numbers, ...years].join(" ").trim()
    : "";
  const sourceDomainQuery = sourceDomain
    ? [`site:${sourceDomain}`, ...numbers, ...years].join(" ").trim()
    : "";
  const officialQuery = [...entities, ...numbers, ...years, "official report source"].join(" ").trim();

  return dedupeQuerySteps([
    { type: "literal", query: compactClaim },
    { type: "metrics", query: metricQuery || compactClaim },
    { type: "attribution", query: attributionQuery },
    { type: "source-domain", query: sourceDomainQuery },
    { type: "entity", query: [...entities, ...years].join(" ").trim() || compactClaim },
    { type: "official", query: officialQuery || compactClaim },
  ]);
}

function dedupeQuerySteps(steps: QueryStep[]): QueryStep[] {
  const seen = new Set<string>();
  return steps.filter((step) => {
    const normalized = step.query.toLowerCase().replace(/\s+/g, " ").trim();
    if (!normalized || seen.has(normalized)) {
      return false;
    }
    seen.add(normalized);
    return true;
  });
}

function extractMetricTokens(text: string): string[] {
  const matches = text.match(
    /\$?\d+(?:,\d{3})*(?:\.\d+)?\s*(?:%|percent|percentage points?|million|billion|trillion|mwh|twh|tokens?|flops?|gb|tb|x|users?|devices?|jobs?|roles?|deals?|miles?|rides?)?|\b10\^\d+\b/gi,
  ) ?? [];

  return [...new Set(matches.map((match) => match.replace(/\s+/g, " ").trim()))];
}

function extractEntityTokens(text: string): string[] {
  const attribution = extractAttributionLabel(text);
  const capitalized = text.match(/\b[A-Z][A-Za-z0-9&.'-]*(?:\s+[A-Z][A-Za-z0-9&.'-]*){0,4}\b/g) ?? [];
  const acronymLike = text.match(/\b[A-Z]{2,}(?:-[A-Z0-9]+)?\b/g) ?? [];
  const modelLike = text.match(/\b[A-Za-z]+-\d+(?:\.\d+)?\b/g) ?? [];
  return [...new Set([attribution, ...capitalized, ...acronymLike, ...modelLike].filter(Boolean) as string[])]
    .filter((entity) => !/^(The|This|These|Those|Global|United|European|Companies|Users)$/i.test(entity))
    .slice(0, 8);
}

export function extractAttributionLabel(text: string): string | null {
  const patterns = [
    /\b(?:according to|reported by|published by|estimated by|survey by|source:)\s+([^,.;:()]+(?:\s+(?:report|survey|study|forecast|tracker|index))?)/i,
    /\b([A-Z][A-Za-z&.'-]+(?:\s+[A-Z][A-Za-z&.'-]+){0,5})\s+(?:report|survey|study|forecast|tracker|index)\b/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const label = match?.[1]?.trim().replace(/\s+/g, " ");
    if (label && label.length > 1) {
      return label;
    }
  }

  return null;
}

function sourceLabelToDomainQuery(label: string): string {
  const normalized = label
    .toLowerCase()
    .replace(/\b(the|report|survey|study|forecast|tracker|index|future|jobs)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const words = normalized.split(/\s+/).filter((word) => word.length > 1);

  if (words.length === 0) {
    return "";
  }

  const compact = words.join("");
  const acronym = words.map((word) => word[0]).join("");
  const domainStem = compact.length <= 14 ? compact : acronym.length >= 3 ? acronym : words[0];
  const tld = /\b(university|institute|forum|foundation|organization|organisation)\b/i.test(label)
    ? "org"
    : "com";

  return `${domainStem}.${tld}`;
}

async function collectSearchEvidence(
  claimId: string,
  querySequence: QueryStep[],
  signal?: AbortSignal,
  options: { maxSteps?: number; maxResults?: number } = {},
): Promise<{ results: RawSearchResult[]; technicalFailureOccurred: boolean }> {
  const maxSteps = options.maxSteps ?? querySequence.length;
  const maxResults = options.maxResults ?? MAX_SEARCH_RESULTS_PER_CLAIM;
  let technicalFailureOccurred = false;
  const results: RawSearchResult[] = [];
  const steps = querySequence.slice(0, maxSteps).filter((step) => step.query);

  for (let index = 0; index < steps.length; index += SEARCH_STEP_CONCURRENCY) {
    if (signal?.aborted) {
      throw new DOMException("The user aborted a request.", "AbortError");
    }

    const batch = steps.slice(index, index + SEARCH_STEP_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (step) => {
        try {
          console.log(`Attempting searchWeb lookup for claim [${claimId}] query: "${step.query}"`);
          const raw = await searchWebCached(step.query, signal);
          if (raw.length > 0) {
            console.log(`Retrieved ${raw.length} evidence candidates for claim [${claimId}] using query: "${step.query}"`);
          }
          return {
            ok: true as const,
            results: raw.map((result) => ({ ...result, queryType: step.type })),
          };
        } catch (err) {
          if (err instanceof Error && err.name === "AbortError") {
            throw err;
          }
          console.warn(`searchWeb search failed for query "${step.query}":`, err);
          return { ok: false as const, results: [] };
        }
      }),
    );

    for (const item of batchResults) {
      if (!item.ok) {
        technicalFailureOccurred = true;
        continue;
      }
      if (item.results.length > 0) {
        results.push(...item.results);
      }
    }

    if (results.length >= maxResults) {
      break;
    }
  }

  return { results, technicalFailureOccurred };
}

async function searchWebCached(
  query: string,
  signal?: AbortSignal,
): Promise<RawSearchResult[]> {
  const normalized = query.toLowerCase().replace(/\s+/g, " ").trim();
  const cached = SEARCH_RESULT_CACHE.get(normalized);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.results;
  }
  if (cached) {
    SEARCH_RESULT_CACHE.delete(normalized);
  }

  const results = await searchWeb(query, signal);
  SEARCH_RESULT_CACHE.set(normalized, {
    results,
    expiresAt: Date.now() + SEARCH_CACHE_TTL_MS,
  });
  return results;
}

function evidenceLooksWeak(claimText: string, results: ProcessedSearchResult[]): boolean {
  if (results.length === 0) {
    return true;
  }

  const facts = parseClaimFacts(claimText);
  const strongestOverlap = Math.max(...results.map((result) => result.matchedClaimTokens), 0);
  const hasStrongSource = results.some((result) => result.credibility !== "Low");
  const evidenceText = joinEvidenceText(results);
  const hasAnyExactValue = facts.values.length === 0 ||
    facts.values.some((value) => normalizeFactToken(evidenceText).includes(normalizeFactToken(value)));
  const hasAttributionHit = !facts.attribution ||
    normalizeFactToken(evidenceText).includes(normalizeFactToken(facts.attribution));

  return !hasStrongSource || strongestOverlap < 3 || !hasAnyExactValue || !hasAttributionHit;
}

export async function cleanSearchQuery(rawClaim: string): Promise<string> {
  try {
    const openai = getOpenAIClient();
    const response = await openai.chat.completions.create({
      model: DEFAULT_MODEL,
      messages: [
        {
          role: "user",
          content: `Convert this claim into a clean, short keyword search query for Google: "${rawClaim}". Output only the search string.`,
        },
      ],
      ...RETRIEVAL_QUERY_COMPLETION_PARAMS,
    });
    return response.choices[0]?.message?.content?.trim().replace(/^["']|["']$/g, "") || rawClaim;
  } catch (error) {
    console.warn("cleanSearchQuery failed, falling back to raw claim:", error);
    return rawClaim;
  }
}

export async function generateRetrievalQueries(
  claimText: string,
  model: OpenAIModel,
): Promise<RetrievalQueries> {
  try {
    const openai = getOpenAIClient();
    const systemPrompt =
      "You are 2see, an elite search query engineer. Given a claim, generate 4 distinct search queries for search engines. " +
      "Format output ONLY as a raw JSON object with keys: 'primary', 'fallbackSimplified', 'fallbackEntity', 'fallbackOfficial'. No markdown fences, prose, or explanation.\n" +
      "Constraints:\n" +
      "1. 'primary': Key concepts, entities, and any years/timeframes mentioned (e.g., 'OpenAI 200 million users 2024').\n" +
      "2. 'fallbackSimplified': Extremely simple main assertion.\n" +
      "3. 'fallbackEntity': Main entities and the core action.\n" +
      "4. 'fallbackOfficial': Targets official announcements, company blogs, or documentation (include domains like 'blog.openai.com', 'who.int' as keywords). No search operators.";

    const userPrompt = `Claim to rewrite: "${claimText}"`;

    const response = await openai.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 300,
      ...RETRIEVAL_QUERY_COMPLETION_PARAMS,
    });

    const raw = response.choices[0]?.message?.content || "";
    const cleaned = extractJsonBlock(raw);
    const parsed = JSON.parse(cleaned);
    if (parsed.primary && parsed.fallbackSimplified && parsed.fallbackEntity && parsed.fallbackOfficial) {
      return {
        primary: String(parsed.primary).trim(),
        fallbackSimplified: String(parsed.fallbackSimplified).trim(),
        fallbackEntity: String(parsed.fallbackEntity).trim(),
        fallbackOfficial: String(parsed.fallbackOfficial).trim(),
      };
    }
  } catch (error) {
    console.error("Failed to generate or parse retrieval queries, using fallbacks:", error);
  }

  return {
    primary: claimText,
    fallbackSimplified: claimText.replace(/[^\w\s]/g, ""),
    fallbackEntity: claimText,
    fallbackOfficial: claimText,
  };
}

export async function knowledgeBasedVerification(
  claim: NormalizedClaim,
  model: OpenAIModel,
  verifiedAt: string,
): Promise<VerificationResult> {
  const openai = getOpenAIClient();

  const prompt = [
    "You are 2see, an elite, objective fact verifier running on Llama 3.3 70B.",
    "Verify the claim strictly using your own training data and parametric knowledge since NO search engine results are available. Follow these constraints:",
    "",
    "1. VERDICT SELECTION:",
    "   - 'Verified': The claim is a widely known, undisputed public fact that is highly documented in your training data.",
    "   - 'False': The claim is directly contradicted by well-established facts.",
    "   - 'Inaccurate': The claim contains minor errors, exaggerations, or timeline mismatches.",
    "   - 'Unverifiable': You do not have sufficient training knowledge or confidence to evaluate this claim.",
    "",
    "2. CONFIDENCE CAP:",
    "   - You MUST cap confidence at a maximum of 65%. Never exceed 65% since you are not verifying against live sources.",
    "",
    "3. EXPLANATION REQUIREMENT:",
    "   - Your explanation MUST start with the phrase: 'Based on model knowledge, not live evidence: '.",
    "",
    "JSON schema:",
    "{\"verdict\":\"Verified | Inaccurate | False | Unverifiable\",\"confidence\":0-65,\"explanation\":\"string (detailed explanation starting with 'Based on model knowledge, not live evidence: ')\",\"corrected_fact\":\"string (corrected statement if verdict is Inaccurate or False, otherwise empty)\"}",
    `Claim type: ${claim.type}`,
    `Claim: ${claim.claim}`
  ].join("\n");

  const response = await openai.chat.completions.create({
    model,
    messages: [
      {
        role: "system",
        content:
          "You are 2see, an elite fact verifier. " +
          "Your ONLY output must be a raw JSON object matching the requested schema.",
      },
      { role: "user", content: prompt },
    ],
    max_tokens: 1024,
    ...VERIFICATION_COMPLETION_PARAMS,
  });

  const raw = response.choices[0]?.message?.content || "";
  const validation = parseAndValidateGeminiJson(raw, aiVerificationSchema);

  if (!validation.ok) {
    return withVerificationMeta(
      fallbackVerification(
        claim,
        "Knowledge-based verification failed to return valid JSON.",
        verifiedAt,
      ),
      { decision_path: "fallback" },
    );
  }

  // Ensure confidence is capped at 65% and explanation starts with the disclaimer
  const confidence = Math.min(65, validation.data.confidence);
  let explanation = validation.data.explanation;
  const disclaimer = "Based on model knowledge, not live evidence:";
  if (!explanation.toLowerCase().includes(disclaimer.toLowerCase())) {
    explanation = `${disclaimer} ${explanation}`;
  }

  return withVerificationMeta(
    {
      claim_id: claim.id,
      claim: claim.claim,
      type: claim.type,
      verdict: validation.data.verdict,
      confidence,
      explanation,
      corrected_fact: validation.data.corrected_fact || "",
      verified_at: verifiedAt,
      sources: [],
      page_number: claim.page_number,
    },
    {
      decision_path: "knowledge",
      evidence_status: "absent",
      retrieval_status: "exhausted",
      reason_codes: ["knowledge_fallback_no_live_evidence"],
    },
  );
}

export type ClaimEvidenceBundle = {
  verifiedAt: string;
  searchResults: ProcessedSearchResult[];
  rawSearchResults: RawSearchResult[];
  contextBlock: string;
  technicalFailureOccurred: boolean;
  searchQueryCount: number;
};

function withVerificationMeta(
  result: VerificationResult,
  meta: {
    decision_path?: DecisionPath;
    comparator_verdict?: Verdict | null;
    search_query_count?: number;
    evidence_status?: EvidenceStatus;
    retrieval_status?: RetrievalStatus;
    reason_codes?: string[];
    duration_ms?: number;
  },
): VerificationResult {
  return {
    ...result,
    ...meta,
  };
}

function shouldUseDeterministicRetrievalOnly(claim: NormalizedClaim): boolean {
  return hasExactMetricClaim(claim.claim) || claim.type === "financial";
}

export async function gatherClaimEvidence(
  claim: NormalizedClaim,
  model: OpenAIModel = DEFAULT_MODEL,
  signal?: AbortSignal,
): Promise<ClaimEvidenceBundle> {
  const verifiedAt = new Date().toISOString();

  if (signal?.aborted) {
    throw new DOMException("The user aborted a request.", "AbortError");
  }

  let rawSearchResults: RawSearchResult[] = [];
  let searchResults: ProcessedSearchResult[] = [];
  let technicalFailureOccurred = false;
  let searchQueryCount = 0;

  const deterministicQuerySequence = buildDeterministicRetrievalQuerySequence(claim.claim);
  const deterministicEvidence = await collectSearchEvidence(
    claim.id,
    deterministicQuerySequence,
    signal,
    { maxSteps: MAX_SEARCH_STEPS_DEFAULT, maxResults: MAX_SEARCH_RESULTS_PER_CLAIM },
  );
  searchQueryCount += Math.min(
    deterministicQuerySequence.length,
    MAX_SEARCH_STEPS_DEFAULT,
  );
  rawSearchResults = rawSearchResults.concat(deterministicEvidence.results);
  technicalFailureOccurred = technicalFailureOccurred || deterministicEvidence.technicalFailureOccurred;
  searchResults = processSearchResults(rawSearchResults, { claimText: claim.claim });
  searchResults = await enrichSearchResultsWithFetchedText(searchResults, signal);

  const hasAdequateEvidence =
    searchResults.length >= 3 &&
    searchResults.some((result) => result.credibility !== "Low") &&
    Math.max(...searchResults.map((result) => result.matchedClaimTokens), 0) >= 2;

  const skipGeneratedQueries = shouldUseDeterministicRetrievalOnly(claim);

  if (
    !skipGeneratedQueries &&
    !hasAdequateEvidence &&
    evidenceLooksWeak(claim.claim, searchResults) &&
    rawSearchResults.length < MAX_SEARCH_RESULTS_PER_CLAIM
  ) {
    let generatedQueries: RetrievalQueries | undefined;
    try {
      generatedQueries = await generateRetrievalQueries(claim.claim, model);
    } catch (err) {
      console.warn("generateRetrievalQueries failed, using deterministic queries only:", err);
    }

    if (generatedQueries) {
      const generatedSteps = buildRetrievalQuerySequence(claim.claim, generatedQueries)
        .filter((step) => step.type.startsWith("generated-"))
        .slice(0, 2);
      const generatedEvidence = await collectSearchEvidence(
        claim.id,
        generatedSteps,
        signal,
        { maxSteps: 2, maxResults: MAX_SEARCH_RESULTS_PER_CLAIM },
      );
      searchQueryCount += generatedSteps.length;
      rawSearchResults = rawSearchResults.concat(generatedEvidence.results);
      technicalFailureOccurred = technicalFailureOccurred || generatedEvidence.technicalFailureOccurred;
      searchResults = processSearchResults(rawSearchResults, { claimText: claim.claim });
      searchResults = await enrichSearchResultsWithFetchedText(searchResults, signal);
    }
  }

  // Wikipedia fallback if main search returned 0 results
  if (searchResults.length < 2) {
    console.log(`Main searchWeb returned limited results for claim [${claim.id}]. Attempting Wikipedia fallback...`);
    for (const step of deterministicQuerySequence) {
      if (signal?.aborted) {
        throw new DOMException("The user aborted a request.", "AbortError");
      }
      if (!step.query) continue;
      searchQueryCount += 1;
      try {
        const raw = await searchWikipedia(step.query);
        if (raw.length > 0) {
          rawSearchResults = rawSearchResults.concat(
            raw.map((result) => ({ ...result, queryType: `wikipedia-${step.type}` })),
          );
        }
      } catch (err) {
        console.warn(`Wikipedia search failed for query "${step.query}":`, err);
      }
    }
    searchResults = processSearchResults(rawSearchResults, { claimText: claim.claim });
    searchResults = await enrichSearchResultsWithFetchedText(searchResults, signal);
  }

  const contextBlock = buildEvidenceContextBlock(searchResults);

  return {
    verifiedAt,
    searchResults,
    rawSearchResults,
    contextBlock,
    technicalFailureOccurred,
    searchQueryCount,
  };
}

function buildEvidenceContextBlock(searchResults: ProcessedSearchResult[]): string {
  return searchResults
    .map(
      (res, idx) =>
        [
          `Source [${idx + 1}]`,
          `Title: ${res.title}`,
          `URL: ${res.url}`,
          `Domain: ${res.domain}`,
          `Credibility: ${res.credibility}`,
          `Authority score: ${res.authorityScore}`,
          `Query type: ${res.queryType ?? "unknown"}`,
          `Claim token matches: ${res.matchedClaimTokens}`,
          `Evidence: ${res.snippet}`,
          res.fetchedText ? `Fetched source text excerpt: ${res.fetchedText.slice(0, 800)}` : "",
        ].join("\n"),
    )
    .join("\n\n");
}

function buildGuardrailSourcesFromSearch(
  searchResults: ProcessedSearchResult[],
): EvidenceSource[] {
  return searchResults.map((res) => ({
    title: res.title,
    url: res.url,
    snippet: res.snippet,
    fetchedText: res.fetchedText,
    credibility: res.credibility,
  }));
}

function buildGroundedSourcesFromSearch(
  searchResults: ProcessedSearchResult[],
  verifiedAt: string,
) {
  return searchResults.slice(0, 8).map((res) => ({
    title: res.title,
    url: res.url,
    snippet: res.snippet,
    retrieved_at: verifiedAt,
    domain: getDomain(res.url),
    credibility: scoreSourceCredibility(res.url),
  }));
}

export function verificationFromGuardrailsOnly(
  claim: NormalizedClaim,
  evidence: ClaimEvidenceBundle,
  reason: string,
): VerificationResult {
  const guardrailSources = buildGuardrailSourcesFromSearch(evidence.searchResults);
  const groundedSources = buildGroundedSourcesFromSearch(
    evidence.searchResults,
    evidence.verifiedAt,
  );

  if (guardrailSources.length === 0) {
    return fallbackVerification(claim, reason, evidence.verifiedAt);
  }

  const assessment = assessEvidence(claim.claim, guardrailSources, {
    technicalFailureOccurred: evidence.technicalFailureOccurred,
    quotaLimited: /quota|rate limit|429|tpm|tokens per/i.test(reason),
  });
  const comparison = assessment.comparison;
  if (comparison.verdict && comparison.verdict !== "Unverifiable") {
    return withVerificationMeta(
      {
        claim_id: claim.id,
        claim: claim.claim,
        type: claim.type,
        verdict: comparison.verdict,
        confidence: comparison.confidenceCap,
        explanation: `${comparison.explanation} (${reason})`,
        corrected_fact: comparison.correctedFact,
        verified_at: evidence.verifiedAt,
        sources: groundedSources,
        page_number: claim.page_number,
      },
      evidenceMetaFromAssessment(assessment),
    );
  }

  const topicOverlap = countTopicTokenOverlap(
    claim.claim,
    normalizeFactToken(joinEvidenceText(guardrailSources)),
  );
  const hasStrongSource = guardrailSources.some((source) => source.credibility !== "Low");
  const hasMetric = parseClaimFacts(claim.claim).values.length > 0;

  if (hasStrongSource && hasMetric && topicOverlap >= 2) {
    return withVerificationMeta(
      {
        claim_id: claim.id,
        claim: claim.claim,
        type: claim.type,
        verdict: "Inaccurate",
        confidence: 58,
        explanation:
          `Retrieved credible sources discuss the same topic and timeframe, but the exact figure in the claim could not be confirmed after ${reason}.`,
        corrected_fact: "The exact metric should be corrected to match authoritative sources.",
        verified_at: evidence.verifiedAt,
        sources: groundedSources,
        page_number: claim.page_number,
      },
      evidenceMetaFromAssessment(assessment),
    );
  }

  return fallbackVerification(claim, reason, evidence.verifiedAt);
}

export async function synthesizeClaimVerdict(
  claim: NormalizedClaim,
  evidence: ClaimEvidenceBundle,
  model: OpenAIModel = DEFAULT_MODEL,
  signal?: AbortSignal,
): Promise<VerificationResult> {
  const { verifiedAt, searchResults, rawSearchResults, contextBlock } = evidence;
  let technicalFailureOccurred = evidence.technicalFailureOccurred;
  let fallbackSearched = false;
  const guardrailSources = buildGuardrailSourcesFromSearch(searchResults);
  const preComparison = compareClaimToEvidence(claim.claim, guardrailSources);

  if (
    searchResults.length > 0 &&
    shouldUseGuardrailVerdictDirectly(claim.claim, guardrailSources, preComparison)
  ) {
    return buildVerificationResultFromComparison(claim, preComparison, evidence);
  }

  if (searchResults.length === 0) {
    console.log(`All search engines failed to retrieve results for claim [${claim.id}]. Attempting knowledge-based fallback...`);
    try {
      if (signal?.aborted) {
        throw new DOMException("The user aborted a request.", "AbortError");
      }
      return await knowledgeBasedVerification(claim, model, verifiedAt);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw err;
      }
      console.error(`Knowledge-based verification failed for claim [${claim.id}]:`, err);
      const errorText = technicalFailureOccurred
        ? "Search retrieval and knowledge fallback failed due to technical issues."
        : "No matching search evidence was found for this claim, and knowledge-based fallback failed.";
      return withVerificationMeta(fallbackVerification(claim, errorText, verifiedAt), {
        decision_path: "fallback",
        comparator_verdict: preComparison.verdict,
        search_query_count: evidence.searchQueryCount,
      });
    }
  }

  if (signal?.aborted) {
    throw new DOMException("The user aborted a request.", "AbortError");
  }

  const openai = getOpenAIClient();
  const verificationContext =
    contextBlock || buildEvidenceContextBlock(searchResults);
  const prompt = verificationPrompt(
    claim,
    verifiedAt,
    verificationContext,
    preComparison,
  );

  const response = await openai.chat.completions.create({
    model,
    messages: [
      {
        role: "system",
        content:
          "You are 2see, an elite fact verifier. " +
          "Your ONLY output must be a raw JSON object — no markdown fences, no prose, no commentary outside the JSON. " +
          "CRITICAL: Keep your 'explanation' string concise and under 3 sentences. Do not generate lengthy paragraphs. This ensures the output payload stays well within token return limits and avoids generating malformed JSON code blocks. " +
          "Output format: {\"verdict\":\"Verified|Inaccurate|False|Unverifiable\",\"confidence\":0-100,\"explanation\":\"string\",\"corrected_fact\":\"string\",\"sources\":[...]}",
      },
      { role: "user", content: prompt },
    ],
    max_tokens: 1024,
    ...VERIFICATION_COMPLETION_PARAMS,
  });

  let raw = response.choices[0]?.message?.content || "";
  let validation = parseAndValidateGeminiJson(raw, aiVerificationSchema);

  if (!validation.ok) {
    console.warn("OpenAI verification validation failed, retrying with compact evidence.", validation.error);
    const compactContext = searchResults
      .slice(0, 2)
      .map(
        (res, idx) =>
          `Source [${idx + 1}]\nTitle: ${res.title}\nURL: ${res.url}\nDomain: ${res.domain}\nEvidence: ${res.snippet.slice(0, 180)}${res.fetchedText ? `\nFetched source text excerpt: ${res.fetchedText.slice(0, 600)}` : ""}`,
      )
      .join("\n\n");
    const retryResponse = await openai.chat.completions.create({
      model,
      messages: [
        {
          role: "system",
          content:
            "Return only valid JSON. No markdown, no prose, no trailing commas. " +
            "Use keys verdict, confidence, explanation, corrected_fact, sources.",
        },
        { role: "user", content: verificationPrompt(claim, verifiedAt, compactContext, preComparison) },
      ],
      max_tokens: 800,
      ...VERIFICATION_COMPLETION_PARAMS,
    });
    raw = retryResponse.choices[0]?.message?.content || "";
    validation = parseAndValidateGeminiJson(raw, aiVerificationSchema);

    if (!validation.ok) {
      console.error("OpenAI verification validation failed after retry", validation.error);
      return verificationFromGuardrailsOnly(
        claim,
        evidence,
        "AI response validation failed; used evidence guardrails instead.",
      );
    }
  }

  // 4. Match and score sources
  const rawSourcesMap = new Map<string, { title: string; url: string; snippet: string; fetchedText?: string }>();

  // Initialize raw sources from search results to resolve snippets if needed
  for (const res of searchResults) {
    rawSourcesMap.set(getDomain(res.url), {
      title: res.title,
      url: res.url,
      snippet: res.snippet || "Evidence retrieved.",
      fetchedText: res.fetchedText,
    });
  }

  // Override/add using sources returned by the model
  if (validation.data.sources && Array.isArray(validation.data.sources)) {
    for (const source of validation.data.sources) {
      if (source && source.url) {
        const domain = getDomain(source.url);
        const existing = rawSourcesMap.get(domain);
        rawSourcesMap.set(domain, {
          title: source.title || existing?.title || domain || "Source",
          url: source.url,
          snippet: source.snippet || existing?.snippet || "Evidence retrieved.",
          fetchedText: existing?.fetchedText,
        });
      }
    }
  }

  let groundedSources = Array.from(rawSourcesMap.values())
    .filter((src) => {
      // Keep sources that the model explicitly cited or that match top search results
      if (validation.data.sources && Array.isArray(validation.data.sources)) {
        return validation.data.sources.some(
          (s) => s && s.url && getDomain(s.url) === getDomain(src.url),
        );
      }
      return true;
    })
    .map((src) => {
      return {
        title: src.title,
        url: src.url,
        snippet: src.snippet,
        retrieved_at: verifiedAt,
        domain: getDomain(src.url),
        credibility: scoreSourceCredibility(src.url),
      };
    });

  const llmGuardrailSources: EvidenceSource[] = Array.from(rawSourcesMap.values()).map((src) => ({
    title: src.title,
    url: src.url,
    snippet: src.snippet,
    fetchedText: src.fetchedText,
    credibility: scoreSourceCredibility(src.url),
  }));

  if (groundedSources.length === 0 && validation.data.verdict !== "Unverifiable") {
    return withVerificationMeta(
      fallbackVerification(
        claim,
        "Grounding returned insufficient source evidence.",
        verifiedAt,
      ),
      {
        decision_path: "fallback",
        comparator_verdict: preComparison.verdict,
        search_query_count: evidence.searchQueryCount,
      },
    );
  }

  let calibrated = applyVerificationGuardrails(
    claim,
    {
      verdict: validation.data.verdict,
      confidence: validation.data.confidence,
      explanation: validation.data.explanation,
      corrected_fact: validation.data.corrected_fact,
    },
    llmGuardrailSources,
  );

  if (
    calibrated.verdict === "Unverifiable" &&
    (searchResults.length < 4 || isPublicRankingOrSuperlativeClaim(claim.claim) || hasExactMetricClaim(claim.claim)) &&
    shouldRunUnverifiableFallback(claim.claim, llmGuardrailSources)
  ) {
    fallbackSearched = true;
    const fallbackSteps = buildUnverifiableFallbackQuerySequence(claim.claim);
    const fallbackEvidence = await collectSearchEvidence(claim.id, fallbackSteps, signal, {
      maxSteps: 4,
      maxResults: MAX_SEARCH_RESULTS_PER_CLAIM,
    });
    technicalFailureOccurred = technicalFailureOccurred || fallbackEvidence.technicalFailureOccurred;
    if (fallbackEvidence.results.length > 0) {
      const fallbackSearchResults = await enrichSearchResultsWithFetchedText(
        processSearchResults([...rawSearchResults, ...fallbackEvidence.results], { claimText: claim.claim }),
        signal,
      );
      const fallbackGroundedSources = fallbackSearchResults.map((src) => ({
        title: src.title,
        url: src.url,
        snippet: src.snippet,
        retrieved_at: verifiedAt,
        domain: getDomain(src.url),
        credibility: scoreSourceCredibility(src.url),
      }));
      groundedSources = mergeGroundedSources(groundedSources, fallbackGroundedSources);
      const fallbackGuardrailSources = fallbackSearchResults.map((src) => ({
        title: src.title,
        url: src.url,
        snippet: src.snippet,
        fetchedText: src.fetchedText,
        credibility: scoreSourceCredibility(src.url),
      }));
      calibrated = applyVerificationGuardrails(claim, calibrated, fallbackGuardrailSources);
    }
  }

  const finalAssessment = assessEvidence(
    claim.claim,
    groundedSources.map((source) => ({
      title: source.title,
      url: source.url,
      snippet: source.snippet,
      credibility: source.credibility,
    })),
    {
      technicalFailureOccurred,
      fallbackSearched,
    },
  );

  return withVerificationMeta(
    {
      claim_id: claim.id,
      claim: claim.claim,
      type: claim.type,
      verdict: calibrated.verdict,
      confidence: calibrated.confidence,
      explanation: calibrated.explanation,
      corrected_fact: calibrated.corrected_fact,
      verified_at: verifiedAt,
      sources: groundedSources,
      page_number: claim.page_number,
    },
    {
      decision_path: "llm",
      comparator_verdict: preComparison.verdict,
      search_query_count: evidence.searchQueryCount,
      ...evidenceMetaFromAssessment(finalAssessment),
    },
  );
}

export async function verifyClaimWithOpenAI(
  claim: NormalizedClaim,
  model: OpenAIModel,
  signal?: AbortSignal,
): Promise<VerificationResult> {
  const evidence = await gatherClaimEvidence(claim, model, signal);
  return synthesizeClaimVerdict(claim, evidence, model, signal);
}

export function buildUnverifiableFallbackQuerySequence(claimText: string): QueryStep[] {
  const facts = parseClaimFacts(claimText);
  const sourceQuery = facts.attribution
    ? [facts.attribution, ...facts.metricWords, ...facts.values, ...facts.years].join(" ")
    : "";
  const entityMetricQuery = [...facts.entities.slice(0, 3), ...facts.metricWords, ...facts.values, ...facts.years].join(" ");
  const exactQuery = `"${claimText.replace(/"/g, "")}"`;
  const rankingQuery = isPublicRankingOrSuperlativeClaim(claimText)
    ? [...facts.entities.slice(0, 3), "ranking market share revenue active users comparative", ...facts.years].join(" ")
    : "";

  return dedupeQuerySteps([
    { type: "literal", query: exactQuery },
    { type: "attribution", query: sourceQuery },
    { type: "metrics", query: entityMetricQuery },
    { type: "entity", query: rankingQuery },
    { type: "official", query: [...facts.entities.slice(0, 3), "annual report official source", ...facts.years].join(" ") },
  ]);
}

function shouldRunUnverifiableFallback(claimText: string, sources: EvidenceSource[]): boolean {
  const facts = parseClaimFacts(claimText);
  const evidenceText = joinEvidenceText(sources);
  if (sources.length === 0) {
    return true;
  }
  if (facts.attribution && !normalizeFactToken(evidenceText).includes(normalizeFactToken(facts.attribution))) {
    return true;
  }
  if (isPublicRankingOrSuperlativeClaim(claimText)) {
    return true;
  }
  return facts.values.length > 0 && !facts.values.some((value) =>
    normalizeFactToken(evidenceText).includes(normalizeFactToken(value)),
  );
}

function mergeGroundedSources<T extends { url: string; domain: string; credibility: ReturnType<typeof scoreSourceCredibility> }>(
  current: T[],
  next: T[],
): T[] {
  const byDomain = new Map<string, T>();
  for (const source of [...current, ...next]) {
    const existing = byDomain.get(source.domain);
    if (!existing || source.credibility !== "Low") {
      byDomain.set(source.domain, source);
    }
  }
  return Array.from(byDomain.values()).slice(0, 8);
}

export function sanitizeEvidenceSnippet(snippet: string): string {
  return snippet
    .replace(/\[[^\]]{1,48}\]/g, " ")
    .replace(
      /\b(skip to content|about us|contact us|sign in|log in|main menu|navigation)\b/gi,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

export function applyVerificationGuardrails(
  claim: Pick<NormalizedClaim, "claim">,
  result: Pick<VerificationResult, "verdict" | "confidence" | "explanation" | "corrected_fact">,
  sources: EvidenceSource[],
): Pick<VerificationResult, "verdict" | "confidence" | "explanation" | "corrected_fact"> {
  const assessment = assessEvidence(claim.claim, sources);
  const comparison = assessment.comparison;

  if (
    result.verdict === "Verified" &&
    assessment.hasOnlyLowAuthority &&
    (assessment.publicExactMetric || assessment.rankingOrSuperlative || requiresStrongEvidence(claim.claim))
  ) {
    return {
      verdict: assessment.relatedEvidence || assessment.exactValueSupported ? "Inaccurate" : "Unverifiable",
      confidence: assessment.relatedEvidence || assessment.exactValueSupported ? 52 : 20,
      explanation:
        "Only low-authority evidence was found, which is not enough to verify this public metric or ranking claim.",
      corrected_fact: assessment.relatedEvidence || assessment.exactValueSupported
        ? "The claim requires confirmation from authoritative or primary sources."
        : "",
    };
  }

  if (
    result.verdict === "Verified" &&
    comparison.verdict &&
    comparison.verdict !== "Verified"
  ) {
    return {
      verdict: comparison.verdict,
      confidence: Math.min(result.confidence, comparison.confidenceCap),
      explanation: comparison.explanation,
      corrected_fact: result.corrected_fact || comparison.correctedFact,
    };
  }

  if (
    result.verdict === "Unverifiable" &&
    comparison.verdict &&
    comparison.verdict !== "Unverifiable"
  ) {
    return {
      verdict: comparison.verdict,
      confidence: Math.max(50, Math.min(result.confidence || 60, comparison.confidenceCap)),
      explanation: comparison.explanation,
      corrected_fact: result.corrected_fact || comparison.correctedFact,
    };
  }

  if (
    result.verdict === "Unverifiable" &&
    (assessment.publicExactMetric || assessment.rankingOrSuperlative) &&
    assessment.hasStrongSource &&
    (assessment.relatedEvidence || assessment.topicOverlap >= 2)
  ) {
    return {
      verdict: assessment.rankingOrSuperlative ? "False" : "Inaccurate",
      confidence: assessment.rankingOrSuperlative ? 60 : 58,
      explanation: assessment.rankingOrSuperlative
        ? "Credible sources cover the subject, but they do not support the claimed ranking or superlative."
        : "Credible sources cover the subject, but they do not confirm the exact public metric.",
      corrected_fact: assessment.rankingOrSuperlative
        ? "The ranking or superlative should be removed unless authoritative comparative evidence supports it."
        : "The exact metric should be corrected to match authoritative sources.",
    };
  }

  if (
    comparison.verdict === "Verified" &&
    result.verdict === "Verified"
  ) {
    return {
      ...result,
      confidence: Math.max(result.confidence, 80),
    };
  }

  if (
    comparison.verdict === "Verified" &&
    result.verdict === "Unverifiable" &&
    metricSupportedInContext(claim.claim, sources)
  ) {
    return {
      verdict: "Verified",
      confidence: 82,
      explanation: comparison.explanation,
      corrected_fact: "",
    };
  }

  return result;
}

export function shouldUseGuardrailVerdictDirectly(
  claimText: string,
  sources: EvidenceSource[],
  comparison: EvidenceComparison,
): boolean {
  if (!comparison.verdict || comparison.verdict === "Unverifiable") {
    return false;
  }

  const strongEvidence = sources.some((source) => source.credibility !== "Low");
  if (!strongEvidence) {
    return false;
  }

  if (comparison.verdict === "Verified") {
    return metricSupportedInContext(claimText, sources);
  }

  const facts = parseClaimFacts(claimText);
  const relatedEvidence = evidenceIsRelated(
    facts,
    normalizeFactToken(joinEvidenceText(sources)),
    claimText,
  );

  return comparison.verdict === "False" || comparison.verdict === "Inaccurate"
    ? relatedEvidence || isRankingMarketShareClaim(claimText)
    : false;
}

function buildVerificationResultFromComparison(
  claim: NormalizedClaim,
  comparison: EvidenceComparison,
  evidence: ClaimEvidenceBundle,
  reasonSuffix?: string,
): VerificationResult {
  const groundedSources = buildGroundedSourcesFromSearch(
    evidence.searchResults,
    evidence.verifiedAt,
  );
  const explanation = reasonSuffix
    ? `${comparison.explanation} (${reasonSuffix})`
    : comparison.explanation;
  const assessment = assessEvidence(claim.claim, buildGuardrailSourcesFromSearch(evidence.searchResults), {
    technicalFailureOccurred: evidence.technicalFailureOccurred,
  });

  return withVerificationMeta(
    {
      claim_id: claim.id,
      claim: claim.claim,
      type: claim.type,
      verdict: comparison.verdict!,
      confidence: comparison.confidenceCap,
      explanation,
      corrected_fact: comparison.correctedFact,
      verified_at: evidence.verifiedAt,
      sources: groundedSources,
      page_number: claim.page_number,
    },
    {
      decision_path: "guardrail",
      comparator_verdict: comparison.verdict,
      search_query_count: evidence.searchQueryCount,
      ...evidenceMetaFromAssessment(assessment),
    },
  );
}

function hasExactMetricClaim(claimText: string): boolean {
  return extractMetricTokens(claimText).length > 0;
}

type ParsedClaimFacts = {
  values: string[];
  years: string[];
  timeframes: string[];
  entities: string[];
  metricWords: string[];
  attribution: string | null;
  normalizedText: string;
};

type EvidenceComparison = {
  verdict: Verdict | null;
  confidenceCap: number;
  explanation: string;
  correctedFact: string;
};

export type EvidenceAssessment = {
  exactValueSupported: boolean;
  exactTimeframeSupported: boolean;
  attributionSupported: boolean;
  hasStrongSource: boolean;
  hasOnlyLowAuthority: boolean;
  relatedEvidence: boolean;
  topicOverlap: number;
  sourceAuthority: "high" | "medium" | "low" | "none";
  rankingOrSuperlative: boolean;
  rankingSupported: boolean;
  publicExactMetric: boolean;
  evidenceStatus: EvidenceStatus;
  retrievalStatus: RetrievalStatus;
  reasonCodes: string[];
  comparison: EvidenceComparison;
};

export function assessEvidence(
  claimText: string,
  sources: EvidenceSource[],
  options: {
    technicalFailureOccurred?: boolean;
    fallbackSearched?: boolean;
    quotaLimited?: boolean;
  } = {},
): EvidenceAssessment {
  const facts = parseClaimFacts(claimText);
  const evidenceText = joinEvidenceText(sources);
  const normalizedEvidence = normalizeFactToken(evidenceText);
  const comparison = compareClaimToEvidence(claimText, sources);
  const sourceAuthority = sourceAuthorityTier(sources);
  const hasStrongSource = sources.some((source) => source.credibility !== "Low");
  const hasOnlyLowAuthority = sources.length > 0 && sources.every((source) => source.credibility === "Low");
  const relatedEvidence = evidenceIsRelated(facts, normalizedEvidence, claimText);
  const topicOverlap = countTopicTokenOverlap(claimText, normalizedEvidence);
  const exactValueSupported =
    facts.values.length === 0 ||
    metricSupportedInContext(claimText, sources) ||
    facts.values.every((value) => normalizedEvidence.includes(normalizeFactToken(value)));
  const exactTimeframeSupported =
    facts.timeframes.length === 0 ||
    facts.timeframes.every((timeframe) => normalizedEvidence.includes(normalizeFactToken(timeframe)));
  const attributionSupported =
    !facts.attribution ||
    normalizedEvidence.includes(normalizeFactToken(facts.attribution)) ||
    sources.some((source) =>
      normalizeFactToken(source.url).includes(normalizeFactToken(facts.attribution ?? "")),
    );
  const rankingOrSuperlative = isPublicRankingOrSuperlativeClaim(claimText);
  const rankingSupported = rankingOrSuperlative && rankingEvidenceSupportsClaim(claimText, evidenceText);
  const publicExactMetric = hasExactMetricClaim(claimText) && requiresStrongEvidence(claimText);

  const reasonCodes: string[] = [];
  if (sources.length === 0) reasonCodes.push("no_sources");
  if (hasOnlyLowAuthority) reasonCodes.push("low_authority_only");
  if (facts.values.length > 0 && !exactValueSupported) reasonCodes.push("exact_value_missing");
  if (facts.timeframes.length > 0 && !exactTimeframeSupported) reasonCodes.push("timeframe_missing");
  if (!attributionSupported) reasonCodes.push("attribution_missing");
  if (rankingOrSuperlative && !rankingSupported) reasonCodes.push("ranking_support_missing");
  if (options.technicalFailureOccurred) reasonCodes.push("retrieval_technical_failure");
  if (options.fallbackSearched) reasonCodes.push("fallback_retrieval_used");
  if (options.quotaLimited) reasonCodes.push("quota_limited");

  const evidenceStatus: EvidenceStatus =
    sources.length === 0
      ? options.technicalFailureOccurred ? "technical_failure" : "absent"
      : comparison.verdict === "Verified" || rankingSupported
        ? "direct"
        : relatedEvidence || topicOverlap >= 2
          ? "related"
          : hasStrongSource
            ? "weak"
            : "absent";

  const retrievalStatus: RetrievalStatus =
    options.quotaLimited
      ? "quota_limited"
      : options.technicalFailureOccurred && sources.length === 0
        ? "technical_failure"
        : options.fallbackSearched
          ? "fallback_searched"
          : sources.length > 0
            ? "searched"
            : "exhausted";

  return {
    exactValueSupported,
    exactTimeframeSupported,
    attributionSupported,
    hasStrongSource,
    hasOnlyLowAuthority,
    relatedEvidence,
    topicOverlap,
    sourceAuthority,
    rankingOrSuperlative,
    rankingSupported,
    publicExactMetric,
    evidenceStatus,
    retrievalStatus,
    reasonCodes: [...new Set(reasonCodes)],
    comparison,
  };
}

function sourceAuthorityTier(sources: EvidenceSource[]): EvidenceAssessment["sourceAuthority"] {
  if (sources.some((source) => source.credibility === "High")) return "high";
  if (sources.some((source) => source.credibility === "Medium")) return "medium";
  if (sources.some((source) => source.credibility === "Low")) return "low";
  return "none";
}

function requiresStrongEvidence(claimText: string): boolean {
  return /\b(?:market|share|valuation|revenue|funding|spending|investment|benchmark|score|launched|released|adopted|approval|regulatory|users?|developers?|engineers?|companies?|fortune|semiconductor|chip|debt|gdp|inflation|traffic|platform)\b/i.test(claimText);
}

export function isPublicRankingOrSuperlativeClaim(claimText: string): boolean {
  return (
    isRankingMarketShareClaim(claimText) ||
    /\b(?:largest|most valuable|highest|first|number one|#1|top\s+\d+|overtook|outperform(?:ed)?|became the world'?s)\b/i.test(claimText) ||
    (
      /\b(?:surpassed|exceeded)\s+(?!\$?\d)/i.test(claimText) &&
      !isPersistentThresholdClaim(claimText)
    )
  );
}

function rankingEvidenceSupportsClaim(claimText: string, evidenceText: string): boolean {
  if (rankingEvidenceContradictsClaim(evidenceText)) {
    return false;
  }

  const normalizedClaim = normalizeFactToken(claimText);
  const normalizedEvidence = normalizeFactToken(evidenceText);
  const rankingTerms = normalizedClaim.match(
    /\b(?:largest|most valuable|highest|first|number one|top\s+\d+|overtook|surpassed|exceeded|outperform(?:ed)?)\b/g,
  ) ?? [];

  if (rankingTerms.length === 0) {
    return false;
  }

  return rankingTerms.some((term) => normalizedEvidence.includes(normalizeFactToken(term))) &&
    countTopicTokenOverlap(claimText, normalizedEvidence) >= 2;
}

function rankingEvidenceContradictsClaim(evidenceText: string): boolean {
  return /\b(?:not the largest|not largest|ranked below|behind other|other companies above|did not surpass|failed to surpass|below .* ranking)\b/i.test(evidenceText);
}

function isPersistentThresholdClaim(claimText: string): boolean {
  return /\b(?:exceeded|surpassed|crossed|topped|above|over|more than)\b/i.test(claimText) &&
    hasExactMetricClaim(claimText) &&
    /\b(?:debt|market cap|valuation|revenue|users?|downloads?|price|bitcoin|threshold)\b/i.test(claimText);
}

function evidenceMetaFromAssessment(assessment: EvidenceAssessment) {
  return {
    evidence_status: assessment.evidenceStatus,
    retrieval_status: assessment.retrievalStatus,
    reason_codes: assessment.reasonCodes.length > 0 ? assessment.reasonCodes : undefined,
  };
}

export function parseClaimFacts(text: string): ParsedClaimFacts {
  const years = extractYears(text).map(String);
  const values = extractMetricTokens(text)
    .filter((metric) => !years.includes(metric.trim()))
    .filter((metric) => /\d/.test(metric));
  const timeframes = [
    ...years,
    ...(text.match(/\bQ[1-4]\s*(?:19|20)?\d{2}\b/gi) ?? []),
    ...(text.match(/\b\d+(?:\.\d+)?\s*(?:days?|weeks?|months?|years?)\b/gi) ?? []),
  ];
  const metricWords = extractMetricWords(text);

  return {
    values: [...new Set(values)],
    years: [...new Set(years)],
    timeframes: [...new Set(timeframes)],
    entities: extractEntityTokens(text),
    metricWords,
    attribution: extractAttributionLabel(text),
    normalizedText: normalizeFactToken(text),
  };
}

const METRIC_CONTEXT_WINDOW_CHARS = 140;

export function isRankingMarketShareClaim(claimText: string): boolean {
  return (
    /\b(surpassed|overtook|larger than|more than|beat|exceed(?:ed)?|outrank(?:ed)?)\b/i.test(
      claimText,
    ) && /\bmarket share\b/i.test(claimText)
  );
}

function claimRequiresTrillionScale(claimText: string): boolean {
  return /\btrillion\b/i.test(claimText) || /\$\d+(?:\.\d+)?\s*t\b/i.test(claimText.toLowerCase());
}

function evidenceWindowSupportsValue(
  evidenceText: string,
  value: string,
  facts: ParsedClaimFacts,
): boolean {
  const normalizedEvidence = normalizeFactToken(evidenceText);
  const normalizedValue = normalizeFactToken(value);
  if (!normalizedValue) {
    return false;
  }

  let index = normalizedEvidence.indexOf(normalizedValue);
  if (index < 0 && /\d/.test(normalizedValue)) {
    const numericCore = normalizedValue.replace(/[^\d.]/g, "");
    if (numericCore) {
      index = normalizedEvidence.indexOf(numericCore);
    }
  }
  if (index < 0) {
    return false;
  }

  const window = evidenceText.slice(
    Math.max(0, index - METRIC_CONTEXT_WINDOW_CHARS),
    Math.min(evidenceText.length, index + METRIC_CONTEXT_WINDOW_CHARS),
  );
  const windowNorm = normalizeFactToken(window);

  if (claimRequiresTrillionScale(value) || claimRequiresTrillionScale(evidenceText)) {
    if (!/\btrillion\b/i.test(window) && !windowNorm.includes("1t")) {
      return false;
    }
  }

  if (facts.years.length > 0 && !facts.years.some((year) => windowNorm.includes(year))) {
    return false;
  }

  if (facts.metricWords.length > 0) {
    const metricInWindow = facts.metricWords.some((word) =>
      windowNorm.includes(normalizeFactToken(word)),
    );
    if (!metricInWindow) {
      return false;
    }
  }

  if (facts.entities.length > 0) {
    const entityInWindow = facts.entities.some(
      (entity) =>
        normalizeFactToken(entity).length >= 3 &&
        windowNorm.includes(normalizeFactToken(entity)),
    );
    if (!entityInWindow) {
      return false;
    }
  }

  return true;
}

export function metricSupportedInContext(
  claimText: string,
  sources: EvidenceSource[],
): boolean {
  if (!hasExactMetricClaim(claimText)) {
    return false;
  }

  const facts = parseClaimFacts(claimText);
  if (facts.values.length === 0) {
    return false;
  }

  for (const source of sources) {
    const evidenceText = `${source.title} ${sanitizeEvidenceSnippet(source.snippet)} ${source.fetchedText ?? ""}`;
    if (facts.values.every((value) => evidenceWindowSupportsValue(evidenceText, value, facts))) {
      return true;
    }
  }

  return false;
}

function compareRankingClaimToEvidence(
  claimText: string,
  sources: EvidenceSource[],
): EvidenceComparison | null {
  if (!isRankingMarketShareClaim(claimText)) {
    return null;
  }

  const facts = parseClaimFacts(claimText);
  if (facts.values.length > 0) {
    return null;
  }

  const evidenceText = joinEvidenceText(sources);
  const normalizedEvidence = normalizeFactToken(evidenceText);
  if (!evidenceText.trim() || sources.length === 0) {
    return null;
  }

  const relatedEvidence = evidenceIsRelated(facts, normalizedEvidence, claimText);
  const hasShareMetric = /\b\d+(?:\.\d+)?\s*%|\bpercent\b|\bmarket share\b/i.test(
    evidenceText,
  );
  const supportsSurpassing = /\b(surpassed|overtook|larger market share|more market share|#1|number one)\b/i.test(
    evidenceText,
  );

  if (relatedEvidence && !hasShareMetric && !supportsSurpassing) {
    return {
      verdict: "False",
      confidenceCap: 65,
      explanation:
        "Sources discuss competition between the named products but provide no quantitative evidence that market share was surpassed.",
      correctedFact:
        "There is no verified evidence that the claim's market-share ranking occurred.",
    };
  }

  return null;
}

function comparePublicRankingClaimToEvidence(
  claimText: string,
  sources: EvidenceSource[],
): EvidenceComparison | null {
  if (!isPublicRankingOrSuperlativeClaim(claimText)) {
    return null;
  }

  const facts = parseClaimFacts(claimText);
  const evidenceText = joinEvidenceText(sources);
  const normalizedEvidence = normalizeFactToken(evidenceText);
  const relatedEvidence = evidenceIsRelated(facts, normalizedEvidence, claimText);
  const hasStrongSource = sources.some((source) => source.credibility !== "Low");
  const supported = rankingEvidenceSupportsClaim(claimText, evidenceText);

  if (supported && hasStrongSource) {
    return {
      verdict: "Verified",
      confidenceCap: 82,
      explanation:
        "Credible evidence supports the claim's ranking or superlative framing.",
      correctedFact: "",
    };
  }

  if ((hasStrongSource || sources.length > 1) && relatedEvidence && !supported) {
    return {
      verdict: "False",
      confidenceCap: hasStrongSource ? 68 : 55,
      explanation:
        "Sources discuss the same subject but do not support the claimed ranking or superlative outcome.",
      correctedFact:
        "The ranking or superlative should be removed unless supported by authoritative comparative evidence.",
    };
  }

  return null;
}

export function compareClaimToEvidence(
  claimText: string,
  sources: EvidenceSource[],
): EvidenceComparison {
  const facts = parseClaimFacts(claimText);
  const evidenceText = joinEvidenceText(sources);
  const normalizedEvidence = normalizeFactToken(evidenceText);
  const strongEvidence = sources.some((source) => source.credibility !== "Low");

  if (!evidenceText.trim()) {
    return {
      verdict: null,
      confidenceCap: 15,
      explanation: "No evidence text was available to compare against the claim.",
      correctedFact: "",
    };
  }

  const rankingComparison = compareRankingClaimToEvidence(claimText, sources);
  if (rankingComparison) {
    return rankingComparison;
  }

  const publicRankingComparison = comparePublicRankingClaimToEvidence(claimText, sources);
  if (publicRankingComparison) {
    return publicRankingComparison;
  }

  const exactValuesSupported = facts.values.every((value) =>
    normalizedEvidence.includes(normalizeFactToken(value)),
  );
  const metricInContext = metricSupportedInContext(claimText, sources);
  const exactTimeframesSupported = facts.timeframes.every((timeframe) =>
    normalizedEvidence.includes(normalizeFactToken(timeframe)),
  );
  const attributionSupported = !facts.attribution ||
    normalizedEvidence.includes(normalizeFactToken(facts.attribution)) ||
    sources.some((source) => normalizeFactToken(source.url).includes(normalizeFactToken(facts.attribution ?? "")));
  const relatedEvidence = evidenceIsRelated(facts, normalizedEvidence, claimText);
  const topicOverlap = countTopicTokenOverlap(claimText, normalizedEvidence);
  const persistentThresholdSupported =
    isPersistentThresholdClaim(claimText) &&
    facts.values.length > 0 &&
    facts.values.every((value) => normalizedEvidence.includes(normalizeFactToken(value))) &&
    (relatedEvidence || topicOverlap >= 2) &&
    strongEvidence;

  if (persistentThresholdSupported) {
    return {
      verdict: "Verified",
      confidenceCap: 78,
      explanation:
        "Credible evidence confirms the threshold was crossed and does not contradict the later timeframe.",
      correctedFact: "",
    };
  }

  if (
    hasExactMetricClaim(claimText) &&
    metricInContext &&
    (facts.timeframes.length === 0 || exactTimeframesSupported || isPersistentThresholdClaim(claimText)) &&
    attributionSupported &&
    strongEvidence
  ) {
    return {
      verdict: "Verified",
      confidenceCap: 90,
      explanation:
        "The fetched or snippet evidence directly supports the claim's exact value, timeframe, and source context.",
      correctedFact: "",
    };
  }

  if (facts.attribution && !attributionSupported && relatedEvidence) {
    return {
      verdict: "Inaccurate",
      confidenceCap: 72,
      explanation: "Evidence discusses the same fact pattern, but it does not support the claim's named attribution.",
      correctedFact: "The factual claim needs attribution correction against the cited source.",
    };
  }

  if (
    facts.timeframes.length > 0 &&
    facts.values.length === 0 &&
    !exactTimeframesSupported &&
    (relatedEvidence || topicOverlap >= 2) &&
    strongEvidence
  ) {
    return {
      verdict: "Inaccurate",
      confidenceCap: 68,
      explanation: "Credible evidence discusses the same event, but it does not support the stated date or timeframe.",
      correctedFact: "The date or timeframe should be corrected to match authoritative sources.",
    };
  }

  if (facts.timeframes.length > 0 && facts.values.length > 0 && exactValuesSupported && !exactTimeframesSupported) {
    return {
      verdict: "Inaccurate",
      confidenceCap: 68,
      explanation: "The evidence supports the numeric value only in a different timeframe than the claim states.",
      correctedFact: "The timeframe should be corrected to match the evidence.",
    };
  }

  if (
    facts.values.length > 0 &&
    !exactValuesSupported &&
    strongEvidence &&
    (relatedEvidence || topicOverlap >= 2)
  ) {
    const majorMismatch = isMajorMetricMismatch(facts, normalizedEvidence);
    return {
      verdict: majorMismatch ? "False" : "Inaccurate",
      confidenceCap: majorMismatch ? 78 : 65,
      explanation: majorMismatch
        ? "Authoritative sources discuss the same topic and timeframe but cite a different figure than the claim."
        : "Credible sources cover the same topic and timeframe, but none support the claim's exact figure.",
      correctedFact: "The exact metric should be corrected to match authoritative sources.",
    };
  }

  if (facts.values.length > 0 && !exactValuesSupported && !relatedEvidence && topicOverlap < 2 && strongEvidence) {
    return {
      verdict: "Unverifiable",
      confidenceCap: 20,
      explanation: "Evidence was retrieved but appears unrelated to the exact metric and source context in the claim.",
      correctedFact: "",
    };
  }

  return {
    verdict: null,
    confidenceCap: 35,
    explanation: "Evidence is insufficient or conflicting for the exact claim.",
    correctedFact: "",
  };
}

function joinEvidenceText(sources: EvidenceSource[]): string {
  return sources
    .map(
      (source) =>
        `${source.title} ${sanitizeEvidenceSnippet(source.snippet)} ${source.fetchedText ?? ""} ${source.url}`,
    )
    .join(" ");
}

function extractMetricWords(text: string): string[] {
  const matches = text.toLowerCase().match(
    /\b(?:market|share|valuation|revenue|funding|spending|investment|users?|adoption|launched|released|benchmark|score|context|window|memory|threshold|fines?|jobs?|roles?|energy|cost|price|approval|reported|estimated|forecast|projected)\b/g,
  ) ?? [];
  return [...new Set(matches)];
}

function evidenceIsRelated(
  facts: ParsedClaimFacts,
  normalizedEvidence: string,
  claimText: string,
): boolean {
  const entityHits = facts.entities.filter((entity) =>
    normalizeFactToken(entity).length >= 2 &&
    normalizedEvidence.includes(normalizeFactToken(entity)),
  ).length;
  const metricHits = facts.metricWords.filter((metric) =>
    normalizedEvidence.includes(normalizeFactToken(metric)),
  ).length;
  const yearHits = facts.years.filter((year) => normalizedEvidence.includes(year)).length;
  const topicOverlap = countTopicTokenOverlap(claimText, normalizedEvidence);

  if (entityHits > 0 && (metricHits > 0 || yearHits > 0)) {
    return true;
  }
  if (metricHits > 0 && yearHits > 0) {
    return true;
  }
  if (yearHits > 0 && topicOverlap >= 2) {
    return true;
  }
  if (metricHits > 0 && topicOverlap >= 2) {
    return true;
  }

  return false;
}

const CLAIM_TOPIC_STOPWORDS = new Set([
  "the",
  "global",
  "exactly",
  "reached",
  "valued",
  "was",
  "were",
  "been",
  "being",
  "have",
  "has",
  "had",
  "will",
  "would",
  "could",
  "should",
  "into",
  "from",
  "with",
  "that",
  "this",
  "than",
  "then",
  "when",
  "where",
  "which",
  "while",
  "their",
  "there",
  "about",
  "after",
  "before",
  "during",
  "across",
  "between",
  "among",
  "world",
  "most",
  "more",
  "less",
  "over",
  "under",
  "only",
  "also",
  "just",
  "very",
  "such",
  "each",
  "both",
  "all",
  "any",
  "some",
  "many",
  "much",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
]);

export function countTopicTokenOverlap(claimText: string, normalizedEvidence: string): number {
  const topics = extractTopicTokens(claimText);
  return topics.filter((token) => normalizedEvidence.includes(token)).length;
}

function extractTopicTokens(claimText: string): string[] {
  const tokens = normalizeFactToken(claimText).split(/\s+/);
  return [
    ...new Set(
      tokens.filter(
        (token) =>
          token.length >= 2 &&
          !CLAIM_TOPIC_STOPWORDS.has(token) &&
          (token.length >= 3 || /^[a-z]{2}$/.test(token)),
      ),
    ),
  ];
}

function isMajorMetricMismatch(facts: ParsedClaimFacts, normalizedEvidence: string): boolean {
  const financialOrMarketMetric = facts.metricWords.some((word) =>
    /market|share|valuation|revenue|funding|spending|investment|price|cost/.test(word),
  );
  const hasSameYear = facts.years.length === 0 ||
    facts.years.some((year) => normalizedEvidence.includes(year));
  const hasAnyEvidenceNumber = extractMetricTokens(normalizedEvidence).some((metric) =>
    !facts.years.includes(metric.trim()) && /\d/.test(metric),
  );

  return financialOrMarketMetric && hasSameYear && hasAnyEvidenceNumber;
}

function normalizeFactToken(text: string): string {
  return text
    .toLowerCase()
    .replace(/usd\s*/g, "$")
    .replace(/(\d+(?:\.\d+)?)\s*(?:per cent|percent|percentage points?)/g, "$1%")
    .replace(/(\d+(?:\.\d+)?)\s*million\b/g, "$1m")
    .replace(/(\d+(?:\.\d+)?)\s*billion\b/g, "$1b")
    .replace(/(\d+(?:\.\d+)?)\s*trillion\b/g, "$1t")
    .replace(/[,$]/g, "")
    .replace(/[^\w.%^]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function fallbackVerification(
  claim: NormalizedClaim,
  reason: string,
  verifiedAt = new Date().toISOString(),
): VerificationResult {
  const quotaLimited = /quota|rate limit|429|tpm|tokens per/i.test(reason);
  return {
    claim_id: claim.id,
    claim: claim.claim,
    type: claim.type,
    verdict: "Unverifiable",
    confidence: 0,
    explanation: `Verification failed/unsupported: ${reason}. Insufficient evidence is available to fact check this statement.`,
    corrected_fact: "",
    verified_at: verifiedAt,
    sources: [],
    page_number: claim.page_number,
    evidence_status: quotaLimited ? "technical_failure" : "absent",
    retrieval_status: quotaLimited ? "quota_limited" : "technical_failure",
    reason_codes: [quotaLimited ? "quota_limited" : "verification_failed"],
  };
}

export function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("429") ||
    message.includes("413") ||
    /rate limit|tpm|tokens per minute|tokens per day|\btpd\b|request too large/i.test(message)
  );
}

export function isDailyQuotaRateLimit(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /tokens per day|\btpd\b|daily token/i.test(message) ||
    (/rate limit/i.test(message) &&
      /Limit\s+\d+,\s*Used\s+\d+,\s*Requested/i.test(message))
  );
}

/** Skip LLM retries when quota resets far in the future (e.g. daily TPD exhausted). */
export function shouldFastFailRateLimit(error: unknown): boolean {
  if (isDailyQuotaRateLimit(error)) {
    return true;
  }
  const retryAfterMs = parseRateLimitRetryAfterMs(error);
  return retryAfterMs !== null && retryAfterMs > FAST_FAIL_RATE_LIMIT_AFTER_MS;
}

export function summarizeRateLimitReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (isDailyQuotaRateLimit(message)) {
    return "Groq daily token quota reached for this model. Verdict derived from retrieved web evidence only.";
  }
  return message.length > 240 ? `${message.slice(0, 237)}...` : message;
}

export function parseRateLimitRetryAfterMs(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error);
  const retryAfterMatch = message.match(/retry-after[:=\s]+(\d+(?:\.\d+)?)/i);
  if (retryAfterMatch) {
    return Math.round(Number(retryAfterMatch[1]) * 1000);
  }

  const tryAgainMatch = message.match(/try again in\s+(?:(\d+(?:\.\d+)?)m)?\s*(\d+(?:\.\d+)?)?s/i);
  if (tryAgainMatch) {
    const minutes = tryAgainMatch[1] ? Number(tryAgainMatch[1]) : 0;
    const seconds = tryAgainMatch[2] ? Number(tryAgainMatch[2]) : 0;
    return Math.round((minutes * 60 + seconds) * 1000);
  }

  return null;
}

export function rateLimitDelayMs(error: unknown, fallbackMs: number): number {
  const parsed = parseRateLimitRetryAfterMs(error);
  if (!parsed) {
    return fallbackMs;
  }

  return Math.min(MAX_RATE_LIMIT_WAIT_MS, Math.max(fallbackMs, parsed));
}

export function isTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|abort/i.test(message);
}

function verificationPrompt(
  claim: NormalizedClaim,
  verifiedAt: string,
  searchResultsText: string,
  preComparison?: EvidenceComparison,
): string {
  const comparatorHint =
    preComparison?.verdict && preComparison.verdict !== "Unverifiable"
      ? `Deterministic evidence pre-score: ${preComparison.verdict} (confidence cap ${preComparison.confidenceCap}). If this is False or Inaccurate with strong topic-related sources, prefer that verdict over Unverifiable.`
      : preComparison?.verdict === null
        ? "Deterministic evidence pre-score: inconclusive — use the search context carefully."
        : "";

  return [
    "You are 2see, an elite, objective fact verifier running on Llama 4 Scout 17B.",
    "Verify the claim strictly against the provided search evidence context block. Follow these operational constraints:",
    comparatorHint,
    "Before choosing a verdict, compare the claim's exact subject, number, unit, date/timeframe, attribution, and scope against the evidence. A source about the same broad topic is not enough.",
    "If the claim asserts an exact market size, market share, benchmark score, launch date, funding amount, model context window, regulatory adoption date, or reporting threshold, the evidence must directly support that exact value or a clearly equivalent value.",
    "When an exact value/date is contradicted, choose False for a material contradiction and Inaccurate for a partially correct claim with the wrong number, date, attribution, or scope.",
    "",
    "1. EVIDENCE CONSTRAINTS & VERDICT SAFEGUARDS:",
    "   - CRITICAL SEARCH INTERPRETATION RULE:",
    "     * If a claim asserts highly specific corporate financial metrics (like ARR, Market Share, or Active Profiles) for a specific product entity, and the live web search data returns absolutely no matching results, text, or corporate records for that entity, do NOT mark it as Unverifiable.",
    "     * Instead, classify the claim as 'False' and state in the explanation: 'No credible web evidence or market tracking exists to support the existence of these financial metrics.'",
    "     * Only use 'Unverifiable' if search results show the company exists but the specific date/metric threshold cannot be conclusively cross-referenced.",
    "   - CRITICAL VERDICT ASSIGNMENT GUIDELINES:",
    "     * If a claim asserts an absolute achievement (e.g., 'Science confirmed room-temperature superconductivity' or 'Fusion reached commercial generation') and your live search snippets explicitly frame the topic as an ongoing scientific 'hunt', an 'unproven hypothesis', or an unresolved 'future goal', you MUST mark the verdict as 'False' or 'Inaccurate'. Do not default to 'Unverifiable' simply because an exact matching denial sentence is missing.",
    "     * Reserve 'Unverifiable' strictly for scenarios where the search data returns completely empty, entirely unrelated context, or mixed data pools where no analytical conclusion can be reasoned.",
    "   - Use 'Unverifiable' ONLY when you genuinely cannot determine truth from the evidence AND the claim is about an obscure, niche, or unverifiable-by-nature topic.",
    "   - The following are NOT valid reasons for 'Unverifiable':",
    "     * Search returned weak results (use your best judgment and parametric knowledge to evaluate).",
    "     * Claim is about a well-known public event but evidence is sparse (use Verified or Inaccurate).",
    "     * Evidence exists but is slightly ambiguous (use Inaccurate or False with lower confidence).",
    "     * Authoritative evidence exists for the cited source or subject but lacks the claimed exact metric (classify by mismatch severity instead).",
    "   - Do not soften obviously false claims into merely inaccurate ones. If the claim is flatly contradicted by high-authority sources, mark it 'False'.",
    "   - Unsupported exact market-size, market-share, benchmark, launch-date, and regulatory-adoption claims must not be marked Verified just because sources discuss the same topic.",
    "   - If attribution is part of the claim, verify the attribution too. A true metric with the wrong named source is Inaccurate.",
    "   - If source X is named and source X is found but the asserted metric is absent or contradicted, choose False or Inaccurate instead of Unverifiable.",
    "   - EXAGGERATED & INFLATED QUANTITATIVE METRICS:",
    "     * If a claim provides a highly specific, exaggerated, or inflated quantitative metric (e.g., token speeds like 3,200 tokens/sec, multi-billion valuations, or high-performance numbers), and the verified search snippets or standard industry metrics show values that are significantly lower (e.g., 800-1200 tokens/sec) or completely absent, you MUST flag the statement as 'False' (or 'Inaccurate' if minor), rather than choosing 'Unverifiable'.",
    "     * Never default to 'Unverifiable' due to a strict syntax match failure if the claimed metric is blatantly and widely outside the bounds of verified industry data.",
    "",
    "2. TEMPORAL TRUTH PRESERVATION & HISTORICAL MILESTONES (2024-2026):",
    "   - Carefully distinguish between: historical truth (true at the claimed time/year), current truth, outdated truth, and contradicted truth.",
    "   - A subsequent updated statistic or larger number from a later date (e.g., '900M weekly active users in 2025') does NOT invalidate or contradict an earlier historical milestone (e.g., 'OpenAI reached 200M weekly active users in 2024').",
    "   - If the search evidence confirms the claim was true at the specific timeframe or year stated in the claim, you MUST mark it 'Verified'.",
    "   - For claims about events in 2024-2026, note that search index coverage may be partial. If even one credible source confirms the event occurred, lean toward Verified or Inaccurate rather than Unverifiable.",
    "",
    "3. WORDING & QUANTIFIER SENSITIVITY:",
    "   - Pay extreme attention to wording precision:",
    "     * 'classified as' vs 'discussed as' — if the claim uses stronger language than what sources support, mark Inaccurate, not Verified.",
    "     * 'widely studied' vs 'being studied' — quantifier/state mismatch = Inaccurate.",
    "     * 'worldwide' or 'global' when evidence only covers specific regions = Inaccurate.",
    "",
    "4. VERDICT DEFINITIONS:",
    "   - 'Verified': The claim is fully and directly supported by clear evidence in highly reliable, authoritative sources.",
    "   - 'False': The claim is directly contradicted by clear evidence in authoritative sources, OR there is an absolute lack of web presence or mismatched metrics for a highly specific company/product entity asserting specific financial metrics (ARR, market share, active users/profiles).",
    "   - 'Inaccurate': The claim is partially correct, outdated, contains slight exaggerations, or features minor numerical or date discrepancies.",
    "   - 'Unverifiable': There is insufficient evidence, completely missing data, or highly conflicting data in the search context to verify the claim (except for fabricated entities/financial metrics as outlined in the CRITICAL SEARCH INTERPRETATION RULE).",
    "     * Under 'Unverifiable', you MUST explicitly identify whether evidence is absent, conflicting, or unrelated, and describe the specific discrepancy or gap.",
    "",
    "5. CONFIDENCE CALIBRATION & SCOPES:",
    "   - Map your confidence scores strictly to the following ranges based on the evidence status:",
    "     * 80% - 100%: Strong, direct, undisputed support from high-credibility authoritative sources.",
    "     * 50% - 79%: Verified/False with moderate evidence, partial support, or minor corroboration gaps.",
    "     * 16% - 30%: Unverifiable due to direct, unresolved conflicting evidence between reputable sources.",
    "     * 0% - 15%: Unverifiable due to weak or completely missing evidence.",
    "   - A verdict of 'Verified' or 'False' REQUIRES a confidence of 50% - 100%. If you cannot justify a confidence >= 50%, you MUST choose 'Unverifiable'.",
    "",
    "6. RECITATION & SECURITY GUIDELINES:",
    "   - Do NOT copy any search result text verbatim. Paraphrase all facts and write explanations, corrected facts, and snippets in your own words to prevent recitation safety blocks.",
    "   - Never fabricate citations, URLs, or snippets.",
    "",
    "JSON schema:",
    "{\"verdict\":\"Verified | Inaccurate | False | Unverifiable\",\"confidence\":0-100,\"explanation\":\"string (CRITICAL: Keep your 'explanation' string concise and under 3 sentences. Do not generate lengthy paragraphs. This ensures the output payload stays well within token return limits and avoids generating malformed JSON code blocks.)\",\"corrected_fact\":\"string (corrected factual statement if verdict is Inaccurate or False, otherwise empty)\",\"sources\":[{\"title\":\"string\",\"url\":\"https://...\",\"snippet\":\"string (1-2 sentence summary of key evidence in your own words, NEVER a verbatim quote)\"}]}",
    `Claim type: ${claim.type}`,
    `Claim: ${claim.claim}`,
    `Search evidence context:`,
    searchResultsText,
  ].join("\n");
}
