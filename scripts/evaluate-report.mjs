import { readFileSync } from "node:fs";
import { basename } from "node:path";

function usage() {
  console.error("Usage: node scripts/evaluate-report.mjs <gold.json> <exported-report.json>");
  process.exit(1);
}

const [goldPath, reportPath] = process.argv.slice(2);
if (!goldPath || !reportPath) {
  usage();
}

const gold = JSON.parse(readFileSync(goldPath, "utf8"));
const report = JSON.parse(readFileSync(reportPath, "utf8"));

function normalizeClaimText(claim) {
  return String(claim)
    .toLowerCase()
    .replace(/(\d+(?:\.\d+)?)\s*(?:per cent|percent|percentage points?)/g, "$1%")
    .replace(/(?:usd\s*)?(\d+(?:\.\d+)?)\s*(million|billion|trillion)\s+dollars?/g, (_, amount, scale) => {
      const suffix = scale === "million" ? "m" : scale === "billion" ? "b" : "t";
      return `$${amount}${suffix}`;
    })
    .replace(/[^\w\s%$]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const reportByClaim = new Map(
  (report.results ?? []).map((result) => [normalizeClaimText(result.claim), result]),
);

const summary = {
  file: report.fileName ?? basename(reportPath),
  expectedClaims: gold.claims.length,
  reportedClaims: report.results?.length ?? 0,
  matchedClaims: 0,
  missingClaims: 0,
  verdictMatches: 0,
  forbiddenVerdictHits: 0,
  unverifiableCount: 0,
  lowOnlyVerifiedCount: 0,
  quotaFallbackCount: 0,
  sourceAuthority: { High: 0, Medium: 0, Low: 0 },
  averageDurationMs: 0,
  failures: [],
};

let durationTotal = 0;
let durationCount = 0;

for (const result of report.results ?? []) {
  if (result.verdict === "Unverifiable") summary.unverifiableCount += 1;
  const sources = result.sources ?? [];
  for (const source of sources) {
    if (source.credibility in summary.sourceAuthority) {
      summary.sourceAuthority[source.credibility] += 1;
    }
  }
  if (
    result.verdict === "Verified" &&
    sources.length > 0 &&
    sources.every((source) => source.credibility === "Low")
  ) {
    summary.lowOnlyVerifiedCount += 1;
  }
  if ((result.reason_codes ?? []).some((code) => /quota/.test(code))) {
    summary.quotaFallbackCount += 1;
  }
  if (typeof result.duration_ms === "number") {
    durationTotal += result.duration_ms;
    durationCount += 1;
  }
}

summary.averageDurationMs = durationCount > 0 ? Math.round(durationTotal / durationCount) : 0;

for (const expected of gold.claims) {
  const key = expected.normalizedClaim ?? normalizeClaimText(expected.claim);
  const actual = reportByClaim.get(key);
  if (!actual) {
    summary.missingClaims += 1;
    summary.failures.push({ claim: key, issue: "missing_claim" });
    continue;
  }

  summary.matchedClaims += 1;
  const allowed = expected.allowedVerdicts ?? [expected.verdict];
  if (allowed.includes(actual.verdict)) {
    summary.verdictMatches += 1;
  } else {
    summary.failures.push({
      claim: key,
      issue: "verdict_mismatch",
      expected: allowed,
      actual: actual.verdict,
    });
  }

  if ((expected.forbiddenVerdicts ?? []).includes(actual.verdict)) {
    summary.forbiddenVerdictHits += 1;
    summary.failures.push({
      claim: key,
      issue: "forbidden_verdict",
      forbidden: expected.forbiddenVerdicts,
      actual: actual.verdict,
    });
  }
}

console.log(JSON.stringify(summary, null, 2));

if (summary.failures.length > 0 || summary.forbiddenVerdictHits > 0) {
  process.exitCode = 1;
}
