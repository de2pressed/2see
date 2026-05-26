export const runtime = "nodejs";
export const maxDuration = 60;

import { NextResponse } from "next/server";

import {
  extractClaimsRequestSchema,
  extractClaimsResponseSchema,
  type ExtractedClaim,
} from "@/lib/schemas";
import { delay } from "@/utils/async";
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
import { extractPdfText } from "@/services/pdf";

export async function POST(request: Request) {
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

    const isFree = true;
    let extractedClaims: ExtractedClaim[] = [];

    if (isFree) {
      // Sequential processing with safety delay for free models
      for (let i = 0; i < pages.length; i++) {
        const pageClaims = await extractClaimsWithRetries(
          pages[i].text,
          parsedRequest.data.model,
          pages[i].pageNumber,
        );
        extractedClaims = extractedClaims.concat(pageClaims);
        if (i < pages.length - 1) {
          await delay(2000); // 2 seconds safety delay between chunks
        }
      }
    } else {
      // Parallel execution for paid models
      extractedClaims = (
        await Promise.all(
          pages.map((page) =>
            extractClaimsWithRetries(page.text, parsedRequest.data.model, page.pageNumber),
          ),
        )
      ).flat();
    }

    const prepared = prepareClaims(extractedClaims);
    writeCachedClaims(pdfBuffer, parsedRequest.data.model, prepared.claims);

    const response = extractClaimsResponseSchema.parse({
      fileName,
      textLength,
      chunksProcessed: pages.length,
      totalClaimsFound: prepared.totalClaimsFound,
      claims: prepared.claims,
      wasCapped: prepared.wasCapped,
      capNotice: buildCapNotice(prepared),
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
