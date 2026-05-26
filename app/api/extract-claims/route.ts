export const runtime = "nodejs";
export const maxDuration = 60;

import { NextResponse } from "next/server";

import {
  extractClaimsRequestSchema,
  extractClaimsResponseSchema,
  type ExtractedClaim,
} from "@/lib/schemas";
import { DEFAULT_MODEL } from "@/lib/models";
import {
  buildCapNotice,
  prepareClaims,
} from "@/utils/claims";
import {
  NON_PDF_ERROR,
  TEXT_EXTRACTION_ERROR,
  assertPdfFile,
  sanitizeFilename,
} from "@/utils/files";
import { readCachedClaims, writeCachedClaims } from "@/lib/claim-cache";
import { extractClaimsWithRetries } from "@/services/openai";
import { extractPdfText, type PageBlock } from "@/services/pdf";

const EXTRACTION_CONCURRENCY = 2;
const EXTRACTION_ROUTE_BUDGET_MS = 52_000;
const MIN_PAGE_EXTRACTION_BUDGET_MS = 12_000;
const MAX_PAGE_TEXT_CHARS = 12_000;

export async function POST(request: Request) {
  const startedAt = Date.now();

  try {
    const formData = await request.formData();
    const file = formData.get("file");
    const model = formData.get("model");
    const parsedRequest = extractClaimsRequestSchema.safeParse({ model });

    if (!parsedRequest.success) {
      return NextResponse.json(
        { error: "Unsupported OpenAI model selected." },
        { status: 400 },
      );
    }

    if (!(file instanceof File)) {
      return NextResponse.json({ error: NON_PDF_ERROR }, { status: 400 });
    }

    const fileError = assertPdfFile(file);
    if (fileError) {
      return NextResponse.json({ error: fileError }, { status: 400 });
    }

    const fileName = sanitizeFilename(file.name);
    // Copy bytes so pdf.js worker transfer cannot detach the buffer used for caching.
    const pdfBuffer = (await file.arrayBuffer()).slice(0);
    const cachedClaims = readCachedClaims(pdfBuffer, parsedRequest.data.model);
    if (cachedClaims) {
      const response = extractClaimsResponseSchema.parse({
        fileName,
        textLength: cachedClaims.reduce((acc, claim) => acc + claim.claim.length, 0),
        chunksProcessed: 1,
        totalClaimsFound: cachedClaims.length,
        claims: cachedClaims,
        wasCapped: false,
        capNotice: buildCapNotice({
          totalClaimsFound: cachedClaims.length,
          wasCapped: false,
          totalClaimsExtracted: cachedClaims.length,
        }),
      });
      return NextResponse.json(response);
    }

    const pages = await extractPdfText(pdfBuffer);
    const textLength = pages.reduce((acc, p) => acc + p.text.length, 0);

    const extraction = await extractClaimsFromPages(pages, startedAt);
    const extractedClaims = extraction.claims;

    const prepared = prepareClaims(extractedClaims);
    writeCachedClaims(pdfBuffer, parsedRequest.data.model, prepared.claims);

    const response = extractClaimsResponseSchema.parse({
      fileName,
      textLength,
      chunksProcessed: pages.length,
      totalClaimsFound: prepared.totalClaimsFound,
      claims: prepared.claims,
      wasCapped: prepared.wasCapped,
      capNotice: extraction.skippedPages > 0 || extraction.failedPages > 0
        ? buildPartialExtractionNotice(extraction)
        : buildCapNotice(prepared),
    });

    return NextResponse.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to parse PDF.";
    const status =
      message === TEXT_EXTRACTION_ERROR ||
      message === NON_PDF_ERROR ||
      message.includes("20MB")
        ? 400
        : 500;

    return NextResponse.json(
      {
        error: message,
      },
      { status },
    );
  }
}

async function extractClaimsFromPages(
  pages: PageBlock[],
  startedAt: number,
): Promise<{
  claims: ExtractedClaim[];
  attemptedPages: number;
  failedPages: number;
  skippedPages: number;
}> {
  const deadline = startedAt + EXTRACTION_ROUTE_BUDGET_MS;
  const claims: ExtractedClaim[] = [];
  const errors: Error[] = [];
  let attemptedPages = 0;
  let skippedPages = 0;
  let nextPageIndex = 0;

  async function worker() {
    while (nextPageIndex < pages.length) {
      if (deadline - Date.now() < MIN_PAGE_EXTRACTION_BUDGET_MS) {
        skippedPages += pages.length - nextPageIndex;
        nextPageIndex = pages.length;
        return;
      }

      const page = pages[nextPageIndex];
      nextPageIndex += 1;
      attemptedPages += 1;

      try {
        const pageClaims = await extractClaimsWithRetries(
          page.text.slice(0, MAX_PAGE_TEXT_CHARS),
          DEFAULT_MODEL,
          page.pageNumber,
          { maxAttempts: 1 },
        );
        claims.push(...pageClaims);
      } catch (error) {
        const nextError = error instanceof Error ? error : new Error(String(error));
        errors.push(nextError);
        console.warn(`Claim extraction failed for page ${page.pageNumber}:`, nextError.message);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(EXTRACTION_CONCURRENCY, pages.length) }, () => worker()),
  );

  if (claims.length === 0 && errors.length > 0) {
    throw errors[0];
  }

  return {
    claims,
    attemptedPages,
    failedPages: errors.length,
    skippedPages,
  };
}

function buildPartialExtractionNotice(extraction: {
  attemptedPages: number;
  failedPages: number;
  skippedPages: number;
}): string {
  const details = [
    extraction.failedPages > 0 ? `${extraction.failedPages} page extraction failed` : "",
    extraction.skippedPages > 0 ? `${extraction.skippedPages} pages skipped to avoid Vercel timeout` : "",
  ].filter(Boolean);

  return `Partial extraction completed from ${extraction.attemptedPages} page${
    extraction.attemptedPages === 1 ? "" : "s"
  }: ${details.join("; ")}.`;
}
