import { z } from "zod";

export const openaiModelSchema = z.enum([
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "llama-3.3-70b-versatile",
]);

export const geminiModelSchema = openaiModelSchema;

export const claimTypeSchema = z.enum([
  "statistical",
  "financial",
  "technical",
  "date",
]);

export const verdictSchema = z.enum([
  "Verified",
  "Inaccurate",
  "False",
  "Unverifiable",
]);

export const credibilitySchema = z.enum(["High", "Medium", "Low"]);

export const extractedClaimSchema = z.object({
  claim: z.string().trim().min(3),
  type: claimTypeSchema,
  importance_score: z.number().min(0).max(100),
  page_number: z.number().int().positive().optional(),
});

export const extractedClaimsSchema = z.array(extractedClaimSchema);

export const normalizedClaimSchema = extractedClaimSchema.extend({
  id: z.string().min(1),
  normalized_claim: z.string().min(1),
});

export const sourceSchema = z.object({
  title: z.string().trim().min(1),
  url: z.string().trim().url(),
  snippet: z.string().trim().min(1),
  retrieved_at: z.string().datetime(),
  domain: z.string().trim().min(1),
  credibility: credibilitySchema,
});

export const decisionPathSchema = z.enum([
  "guardrail",
  "llm",
  "fallback",
  "knowledge",
]);

export const evidenceStatusSchema = z.enum([
  "direct",
  "related",
  "weak",
  "absent",
  "conflicting",
  "technical_failure",
]);

export const retrievalStatusSchema = z.enum([
  "not_needed",
  "searched",
  "fallback_searched",
  "exhausted",
  "technical_failure",
  "quota_limited",
]);

export const verificationResultSchema = z.object({
  claim_id: z.string().min(1),
  claim: z.string().trim().min(3),
  type: claimTypeSchema,
  verdict: verdictSchema,
  confidence: z.number().min(0).max(100),
  explanation: z.string().trim().min(1),
  corrected_fact: z.string(),
  verified_at: z.string().datetime(),
  sources: z.array(sourceSchema),
  page_number: z.number().int().positive().optional(),
  decision_path: decisionPathSchema.optional(),
  comparator_verdict: verdictSchema.nullable().optional(),
  search_query_count: z.number().int().min(0).optional(),
  evidence_status: evidenceStatusSchema.optional(),
  retrieval_status: retrievalStatusSchema.optional(),
  reason_codes: z.array(z.string().trim().min(1)).optional(),
  duration_ms: z.number().int().min(0).optional(),
});

export const aiVerificationSchema = z.object({
  verdict: verdictSchema,
  confidence: z.number().min(0).max(100),
  explanation: z.string().trim().min(1),
  corrected_fact: z.string(),
  verified_at: z.string().optional(),
  sources: z
    .array(
      z.object({
        title: z.string().trim().min(1),
        url: z.string().trim(),
        snippet: z.string().trim().min(1).optional().nullable(),
        retrieved_at: z.string().optional(),
        domain: z.string().trim().min(1).optional(),
      }),
    )
    .optional()
    .nullable(),
});

export const extractClaimsRequestSchema = z.object({
  model: geminiModelSchema,
});

export const extractClaimsResponseSchema = z.object({
  fileName: z.string(),
  textLength: z.number().int().min(0),
  chunksProcessed: z.number().int().min(1),
  totalClaimsFound: z.number().int().min(0),
  claims: z.array(normalizedClaimSchema),
  wasCapped: z.boolean(),
  capNotice: z.string().optional(),
});

export const verifyClaimsRequestSchema = z.object({
  model: geminiModelSchema,
  claims: z.array(normalizedClaimSchema),
});

export const reportSchema = z.object({
  fileName: z.string(),
  model: geminiModelSchema,
  totalClaimsFound: z.number().int().min(0),
  wasCapped: z.boolean(),
  generatedAt: z.string().datetime(),
  results: z.array(verificationResultSchema),
});

export const apiErrorSchema = z.object({
  error: z.string().min(1),
  detail: z.string().optional(),
});

export type ClaimType = z.infer<typeof claimTypeSchema>;
export type Verdict = z.infer<typeof verdictSchema>;
export type DecisionPath = z.infer<typeof decisionPathSchema>;
export type EvidenceStatus = z.infer<typeof evidenceStatusSchema>;
export type RetrievalStatus = z.infer<typeof retrievalStatusSchema>;
export type Credibility = z.infer<typeof credibilitySchema>;
export type ExtractedClaim = z.infer<typeof extractedClaimSchema>;
export type NormalizedClaim = z.infer<typeof normalizedClaimSchema>;
export type VerificationResult = z.infer<typeof verificationResultSchema>;
export type Report = z.infer<typeof reportSchema>;
