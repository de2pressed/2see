import { isFastGroqModel, isGroqFreeTierModel, type GeminiModel } from "@/lib/models";
import type { NormalizedClaim, VerificationResult } from "@/lib/schemas";
import { delay, mapWithConcurrency } from "@/utils/async";
import {
  fallbackVerification,
  gatherClaimEvidence,
  isRateLimitError,
  isTimeoutError,
  rateLimitDelayMs,
  shouldFastFailRateLimit,
  summarizeRateLimitReason,
  synthesizeClaimVerdict,
  verificationFromGuardrailsOnly,
  verifyClaimWithOpenAI,
} from "@/services/openai";
import type { ClaimEvidenceBundle } from "@/services/openai";

const DEFAULT_BATCH_SIZE = 4;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_BATCH_DELAY_MS = 1_000;
const BACKOFF_MS = [2_000, 4_000, 8_000];

function hasSearchEvidence(
  bundle: ClaimEvidenceBundle | null,
): bundle is ClaimEvidenceBundle {
  return bundle !== null && bundle.searchResults.length > 0;
}

export type VerificationEvent =
  | {
      type: "claim_started";
      claimId: string;
      batchIndex: number;
      totalBatches: number;
    }
  | {
      type: "claim_completed";
      result: VerificationResult;
      batchIndex: number;
      totalBatches: number;
    }
  | {
      type: "batch_completed";
      batchIndex: number;
      totalBatches: number;
    };

export async function verifyClaimWithRetries(
  claim: NormalizedClaim,
  initialModel: GeminiModel,
  verifier: (
    claim: NormalizedClaim,
    model: GeminiModel,
    signal?: AbortSignal,
  ) => Promise<VerificationResult> = verifyClaimWithOpenAI,
  signal?: AbortSignal,
): Promise<VerificationResult> {
  const startedAt = Date.now();
  let evidenceBundle: ClaimEvidenceBundle | null = null;

  const runVerifier = verifier === verifyClaimWithOpenAI
    ? async () => {
        if (!evidenceBundle) {
          evidenceBundle = await gatherClaimEvidence(claim, initialModel, signal);
        }
        return synthesizeClaimVerdict(claim, evidenceBundle, initialModel, signal);
      }
    : async () => verifier(claim, initialModel, signal);

  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt += 1) {
    try {
      return withDuration(await runVerifier(), startedAt);
    } catch (error) {
      if (errIsAbort(error)) {
        throw error;
      }
      if (isTimeoutError(error)) {
        const msg = error instanceof Error ? error.message : String(error);
        if (hasSearchEvidence(evidenceBundle)) {
          return withDuration(
            verificationFromGuardrailsOnly(
              claim,
              evidenceBundle,
              `Verification timed out: ${msg}`,
            ),
            startedAt,
          );
        }
        return withDuration(fallbackVerification(claim, `Verification timed out: ${msg}`), startedAt);
      }

      if (isRateLimitError(error)) {
        const summary = summarizeRateLimitReason(error);

        if (shouldFastFailRateLimit(error) || attempt === BACKOFF_MS.length) {
          if (hasSearchEvidence(evidenceBundle)) {
            return withDuration(verificationFromGuardrailsOnly(claim, evidenceBundle, summary), startedAt);
          }
          return withDuration(fallbackVerification(claim, summary), startedAt);
        }

        console.warn(
          `Rate limit reached on ${initialModel} during verification. Retrying LLM synthesis only...`,
        );
        await delay(rateLimitDelayMs(error, BACKOFF_MS[attempt]));
        continue;
      }

      console.error("Groq verification failed", error);
      const msg = error instanceof Error ? error.message : String(error);
      if (hasSearchEvidence(evidenceBundle)) {
        return withDuration(
          verificationFromGuardrailsOnly(claim, evidenceBundle, `Verification failed: ${msg}`),
          startedAt,
        );
      }
      return withDuration(fallbackVerification(claim, `Verification failed: ${msg}`), startedAt);
    }
  }

  if (hasSearchEvidence(evidenceBundle)) {
    return withDuration(
      verificationFromGuardrailsOnly(claim, evidenceBundle, "Verification failed after retries."),
      startedAt,
    );
  }

  return withDuration(fallbackVerification(claim, "Verification failed after retries."), startedAt);
}

function withDuration(result: VerificationResult, startedAt: number): VerificationResult {
  return {
    ...result,
    duration_ms: result.duration_ms ?? Math.max(0, Date.now() - startedAt),
  };
}

function errIsAbort(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === "AbortError" ||
    error instanceof Error && error.name === "AbortError"
  );
}

export async function runBatchedVerifications(
  claims: NormalizedClaim[],
  model: GeminiModel,
  emit: (event: VerificationEvent) => void | Promise<void>,
  options: {
    batchSize?: number;
    concurrency?: number;
    batchDelayMs?: number;
    verifier?: (
      claim: NormalizedClaim,
      model: GeminiModel,
      signal?: AbortSignal,
    ) => Promise<VerificationResult>;
    signal?: AbortSignal;
  } = {},
): Promise<void> {
  const isFree = isGroqFreeTierModel(model);
  const batchSize = options.batchSize ?? (isFree ? 2 : DEFAULT_BATCH_SIZE);
  const concurrency = isFree ? 1 : Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, 2);
  const batchDelayMs =
    options.batchDelayMs ??
    (isFree ? (isFastGroqModel(model) ? 2000 : 4000) : DEFAULT_BATCH_DELAY_MS);
  const batches = chunkClaims(claims, batchSize);

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    if (options.signal?.aborted) {
      throw new DOMException("The user aborted a request.", "AbortError");
    }
    const batch = batches[batchIndex];
    const totalBatches = batches.length;

    await mapWithConcurrency(batch, concurrency, async (claim) => {
      if (options.signal?.aborted) {
        throw new DOMException("The user aborted a request.", "AbortError");
      }
      await emit({
        type: "claim_started",
        claimId: claim.id,
        batchIndex,
        totalBatches,
      });

      const result = await verifyClaimWithRetries(
        claim,
        model,
        options.verifier,
        options.signal,
      );

      await emit({
        type: "claim_completed",
        result,
        batchIndex,
        totalBatches,
      });

      return result;
    });

    await emit({
      type: "batch_completed",
      batchIndex,
      totalBatches,
    });

    if (batchIndex < batches.length - 1) {
      if (options.signal?.aborted) {
        throw new DOMException("The user aborted a request.", "AbortError");
      }
      await delay(batchDelayMs);
    }
  }
}

function chunkClaims<T>(claims: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < claims.length; index += size) {
    chunks.push(claims.slice(index, index + size));
  }
  return chunks;
}
