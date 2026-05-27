import type { Verdict, VerificationResult } from "@/lib/schemas";

const VERDICT_SCORE: Record<Verdict, number> = {
  Verified: 100,
  Inaccurate: 50,
  False: 0,
  Unverifiable: 25,
};

export function calculateReportScore(
  results: Pick<VerificationResult, "verdict">[],
): number | null {
  if (results.length === 0) {
    return null;
  }

  const total = results.reduce(
    (sum, result) => sum + VERDICT_SCORE[result.verdict],
    0,
  );

  return Math.round(total / results.length);
}
