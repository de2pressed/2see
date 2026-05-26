import type { ExtractedClaim, NormalizedClaim } from "@/lib/schemas";

export const MIN_MATERIALITY_SCORE = 118;

const currencyScale: Record<string, string> = {
  million: "M",
  billion: "B",
  trillion: "T",
};

export function normalizeClaimText(claim: string): string {
  return claim
    .toLowerCase()
    .replace(
      /(\d+(?:\.\d+)?)\s*(?:per cent|percent|percentage points?)/g,
      "$1%",
    )
    .replace(
      /(?:usd\s*)?(\d+(?:\.\d+)?)\s*(million|billion|trillion)\s+dollars?/g,
      (_, amount: string, scale: string) => `$${amount}${currencyScale[scale]}`,
    )
    .replace(
      /\$(\d+(?:\.\d+)?)\s*(million|billion|trillion)/g,
      (_, amount: string, scale: string) => `$${amount}${currencyScale[scale]}`,
    )
    .replace(/[^\w\s%$]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function prepareClaims(claims: ExtractedClaim[]): {
  claims: NormalizedClaim[];
  totalClaimsFound: number;
  wasCapped: boolean;
  totalClaimsExtracted: number;
} {
  const normalized = claims
    .flatMap(splitExtractedClaimAssertions)
    .map((claim, index) => ({
      ...claim,
      id: `claim-${index + 1}`,
      normalized_claim: normalizeClaimText(claim.claim),
    }))
    .filter((claim) => claim.normalized_claim.length > 0);

  const deduped = deduplicateClaims(normalized);
  const selected = selectMaterialClaims(deduped);
  const sorted = [...selected].sort((a, b) => {
    const pageA = a.page_number ?? 9_999;
    const pageB = b.page_number ?? 9_999;
    if (pageA !== pageB) {
      return pageA - pageB;
    }
    const textOrder = a.normalized_claim.localeCompare(b.normalized_claim);
    if (textOrder !== 0) {
      return textOrder;
    }
    return a.claim.localeCompare(b.claim);
  });

  return {
    claims: sorted.map((claim, index) => ({
      ...claim,
      id: `claim-${index + 1}`,
    })),
    totalClaimsFound: sorted.length,
    wasCapped: false,
    totalClaimsExtracted: deduped.length,
  };
}

export function splitExtractedClaimAssertions(claim: ExtractedClaim): ExtractedClaim[] {
  const parts = splitIndependentAssertions(claim.claim);
  if (parts.length <= 1) {
    return [claim];
  }

  return parts.map((part) => ({
    ...claim,
    claim: part,
  }));
}

export function splitIndependentAssertions(text: string): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  const pieces = normalized
    .split(/\s+(?:;|and|while|whereas)\s+/i)
    .map((piece) => piece.trim())
    .filter(Boolean);

  if (pieces.length < 2) {
    return [normalized];
  }

  const firstSubject = subjectPrefix(pieces[0]) || claimSubjectKey(pieces[0]);
  const splitPieces = pieces.map((piece, index) => {
    if (index === 0 || startsWithSubject(piece) || !firstSubject) {
      return piece;
    }
    return `${firstSubject} ${piece.charAt(0).toLowerCase()}${piece.slice(1)}`;
  });

  if (!splitPieces.every(isStandaloneAssertion)) {
    return [normalized];
  }

  return splitPieces;
}

export function selectMaterialClaims(
  claims: NormalizedClaim[],
): NormalizedClaim[] {
  const merged = mergeRelatedClaims(deduplicateClaims(claims));
  const candidates = merged
    .map((claim, originalIndex) => ({
      claim,
      originalIndex,
      score: scoreClaimMateriality(claim),
      profile: getClaimFeatureProfile(claim.claim),
    }));

  const strongestByGroup = new Map<string, (typeof candidates)[number]>();

  for (const candidate of candidates) {
    const existing = strongestByGroup.get(candidate.profile.semanticGroupKey);
    if (!existing || compareClaimCandidate(candidate, existing) > 0) {
      strongestByGroup.set(candidate.profile.semanticGroupKey, candidate);
    }
  }

  const grouped = Array.from(strongestByGroup.values());
  const denseDocument = grouped.length >= 18;
  const hasNoisyCandidates = grouped.some(({ profile }) =>
    profile.isLikelySupportingDetail ||
    profile.isIncompleteMetricClaim ||
    profile.isDerivativeMetricOnly ||
    profile.isLowMaterialityFragment,
  );
  const selected = grouped
    .filter((candidate) => {
      if (!denseDocument || !hasNoisyCandidates) {
        return true;
      }

      if (hasStrongerParentCoverage(candidate, grouped)) {
        return false;
      }

      return isLikelyMaterialClaim(candidate.claim, candidate.score);
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.profile.claimCompleteness - a.profile.claimCompleteness ||
        b.claim.importance_score - a.claim.importance_score ||
        a.originalIndex - b.originalIndex,
    );

  return selected.map(({ claim }, index) => ({
    ...claim,
    id: `claim-${index + 1}`,
  }));
}

export function mergeRelatedClaims(claims: NormalizedClaim[]): NormalizedClaim[] {
  const merged: NormalizedClaim[] = [];
  const consumed = new Set<number>();
  const groups = new Map<string, NormalizedClaim[]>();

  for (const claim of claims) {
    const key = claimGroupKey(claim.claim);
    const current = groups.get(key) ?? [];
    current.push(claim);
    groups.set(key, current);
  }

  for (const group of groups.values()) {
    if (group.length === 1 || !shouldMergeGroup(group)) {
      merged.push(...group);
      continue;
    }

    const ordered = [...group].sort(
      (a, b) => scoreClaimMateriality(b) - scoreClaimMateriality(a),
    );
    const base = ordered[0];
    const mergedText = mergeClaimTexts(ordered.map((claim) => claim.claim));
    consumed.add(claims.indexOf(base));
    merged.push({
      ...base,
      claim: mergedText,
      normalized_claim: normalizeClaimText(mergedText),
      importance_score: Math.max(...ordered.map((claim) => claim.importance_score)),
      page_number: base.page_number,
    });
  }

  return merged.map((claim, index) => ({
    ...claim,
    id: `claim-${index + 1}`,
  }));
}

export function scoreClaimMateriality(claim: Pick<NormalizedClaim, "claim" | "type" | "importance_score">): number {
  const profile = getClaimFeatureProfile(claim.claim);
  let score = claim.importance_score;

  score += Math.min(24, profile.metricCount * 8);
  score += Math.min(14, profile.yearCount * 7);
  score += Math.min(18, profile.namedEntityCount * 6);
  score += Math.min(12, Math.round(profile.metricDateValueDensity * 30));
  score += Math.min(18, Math.round(profile.claimCompleteness * 18));
  score += profile.sectionImportance;
  if (profile.hasAttribution) score += 12;
  if (profile.hasMaterialAction) score += 10;
  if (profile.hasFinancialOrMarketTerm) score += 8;
  if (profile.hasRegulatoryOrBenchmarkTerm) score += 8;
  if (profile.hasPublicFactPattern) score += 14;
  if (profile.hasComparativeOrSuperlative) score += 10;
  if (profile.hasAdoptionOrLicensingTerm) score += 8;
  if (profile.tableRelationship === "parent") score += 8;
  if (profile.hasCompleteSubjectMetricAndTimeframe) score += 12;
  if (profile.isProjectionOrGoal) score -= profile.hasAttribution ? 4 : 16;
  if (profile.isLikelySupportingDetail) score -= 24;
  if (profile.isIncompleteMetricClaim) score -= 30;
  if (profile.hasGenericSubjectOnly) score -= 18;
  if (profile.isDerivativeMetricOnly) score -= 18;
  if (profile.isLowMaterialityFragment) score -= 22;
  if (profile.tableRelationship === "row") score -= 14;

  if (claim.type === "financial") score += 4;
  if (claim.type === "date") score += 2;

  return score;
}

export function isLikelyMaterialClaim(
  claim: Pick<NormalizedClaim, "claim" | "type" | "importance_score">,
  score = scoreClaimMateriality(claim),
): boolean {
  const profile = getClaimFeatureProfile(claim.claim);

  if (
    profile.isLikelySupportingDetail &&
    !profile.hasAttribution &&
    !profile.hasCompleteSubjectMetricAndTimeframe
  ) {
    return false;
  }

  if (profile.isIncompleteMetricClaim && !profile.hasAttribution) {
    return false;
  }

  if (profile.isDerivativeMetricOnly && !profile.hasAttribution) {
    return false;
  }

  if (
    profile.isLowMaterialityFragment &&
    !profile.hasFinancialOrMarketTerm &&
    !profile.hasRegulatoryOrBenchmarkTerm
  ) {
    return false;
  }

  return (
    score >= MIN_MATERIALITY_SCORE &&
    (
      profile.metricCount > 0 ||
      profile.yearCount > 0 ||
      profile.hasPublicFactPattern ||
      profile.hasComparativeOrSuperlative
    ) &&
    (
      profile.namedEntityCount > 0 ||
      profile.hasAttribution ||
      profile.hasBroadQuantifiedSubject ||
      profile.hasPublicFactPattern
    )
  );
}

export type ClaimFeatureProfile = {
  metricCount: number;
  yearCount: number;
  namedEntityCount: number;
  metricDateValueDensity: number;
  sectionImportance: number;
  hasAttribution: boolean;
  hasMaterialAction: boolean;
  hasFinancialOrMarketTerm: boolean;
  hasRegulatoryOrBenchmarkTerm: boolean;
  hasPublicFactPattern: boolean;
  hasComparativeOrSuperlative: boolean;
  hasAdoptionOrLicensingTerm: boolean;
  hasCompleteSubjectMetricAndTimeframe: boolean;
  hasBroadQuantifiedSubject: boolean;
  isProjectionOrGoal: boolean;
  isLikelySupportingDetail: boolean;
  isIncompleteMetricClaim: boolean;
  hasGenericSubjectOnly: boolean;
  isDerivativeMetricOnly: boolean;
  isLowMaterialityFragment: boolean;
  claimCompleteness: number;
  tableRelationship: "parent" | "row" | "none";
  semanticGroupKey: string;
};

export function getClaimFeatureProfile(claim: string): ClaimFeatureProfile {
  const metrics = extractClaimMetrics(claim);
  const years = claim.match(/\b(?:19|20)\d{2}\b/g) ?? [];
  const namedEntities = extractNamedEntities(claim);
  const hasAttribution = /\b(?:according to|reported by|published by|estimated by|survey by|per|from|source:)\b/i.test(claim) || /^[A-Z][A-Za-z&.'-]+(?:\s+[A-Z][A-Za-z&.'-]+){0,5}\s+(?:estimated|reported|projected|forecast|said|stated)\b/.test(claim);
  const hasMaterialAction = /\b(?:reached|hit|rose|fell|increased|decreased|launched|released|introduced|adopted|issued|implemented|secured|raised|crossed|surpassed|overtook|accounted for|projected|forecast|estimated|reported|mandates?|requires?|trains?|trained|confirmed|classified|discovered|prevented|signed|became|reversed|replaced)\b/i.test(claim);
  const hasFinancialOrMarketTerm = /\b(?:market|share|valuation|revenue|funding|spending|investment|sales|profit|margin|cap|capitali[sz]ation|arr|price|cost)\b/i.test(claim);
  const hasRegulatoryOrBenchmarkTerm = /\b(?:act|order|regulation|measure|approval|benchmark|score|exam|context window|tokens?|flops?|memory|hbm|mmlu|therapy|clinical trial|vaccine|election|licensing|agreement|search overview|platform)\b/i.test(claim);
  const hasComparativeOrSuperlative = /\b(?:largest|most valuable|highest|first|major|definitive|commercial|worldwide|global|outperform(?:ed)?|overtook|surpassed|exceeded|replaced)\b/i.test(claim);
  const hasAdoptionOrLicensingTerm = /\b(?:adoption|adopted|deployed|licensing|agreements?|users?|traffic|platform|assistants?|interact|generated|misinformation)\b/i.test(claim);
  const hasPublicFactPattern =
    hasMaterialAction &&
    (
      hasComparativeOrSuperlative ||
      hasAdoptionOrLicensingTerm ||
      hasRegulatoryOrBenchmarkTerm ||
      /\b(?:scientists?|who|government|company|companies|researchers?|platforms?|vaccines?|computers?|architecture|search|misinformation)\b/i.test(claim)
    );
  const hasProjectionLanguage = /\b(?:projected|forecast|aims?|target|expects?|could|would|by\s+20\d{2})\b/i.test(claim);
  const isProjectionOrGoal =
    hasProjectionLanguage &&
    (
      /\b(?:projected|forecast|aims?|target|expects?|could|would)\b/i.test(claim) ||
      !/\b(?:reached|hit|launched|released|adopted|issued|implemented|secured|raised|crossed|surpassed)\b/i.test(claim)
    );
  const hasGenericSubjectOnly = namedEntities.length === 0 && /\b(?:organizations|organisations|companies|users|employees|products|systems|tools|workloads|vehicles)\b/i.test(claim);
  const tableRelationship = getTableRelationship(claim);
  const hasBroadQuantifiedSubject =
    /\b(?:global|worldwide|enterprise|national|international|market|sector|industry|economy|healthcare|chip|startup|funding|regulatory|regulation)\b/i.test(claim) &&
    (metrics.length > 0 || years.length > 0);
  const isDerivativeMetricOnly = isDerivativeMetricClaim(claim);
  const isLowMaterialityFragment = isLowPriorityFragment(claim);
  const isLikelySupportingDetail =
    tableRelationship === "row" ||
    isDerivativeMetricOnly ||
    (hasGenericSubjectOnly && !hasAttribution);
  const isIncompleteMetricClaim =
    metrics.length > 0 &&
    namedEntities.length === 0 &&
    !hasAttribution &&
    !hasBroadQuantifiedSubject;
  const metricDateValueDensity = (metrics.length + years.length) / Math.max(8, claim.split(/\s+/).filter(Boolean).length);
  const sectionImportance = inferSectionImportance(claim);
  const claimCompleteness = scoreClaimCompleteness({
    metricCount: metrics.length,
    yearCount: new Set(years).size,
    namedEntityCount: namedEntities.length,
    hasAttribution,
    hasMaterialAction,
    hasFinancialOrMarketTerm,
    hasRegulatoryOrBenchmarkTerm,
    hasBroadQuantifiedSubject,
  });
  const semanticGroupKey = claimSemanticGroupKey(claim);

  return {
    metricCount: metrics.length,
    yearCount: new Set(years).size,
    namedEntityCount: namedEntities.length,
    metricDateValueDensity,
    sectionImportance,
    hasAttribution,
    hasMaterialAction,
    hasFinancialOrMarketTerm,
    hasRegulatoryOrBenchmarkTerm,
    hasPublicFactPattern,
    hasComparativeOrSuperlative,
    hasAdoptionOrLicensingTerm,
    hasCompleteSubjectMetricAndTimeframe:
      metrics.length > 0 &&
      (years.length > 0 || /\b\d+(?:\.\d+)?\s*(?:days?|weeks?|months?|years?)\b/i.test(claim) || hasRegulatoryOrBenchmarkTerm) &&
      (namedEntities.length > 0 || hasAttribution || hasBroadQuantifiedSubject) &&
      hasMaterialAction,
    hasBroadQuantifiedSubject,
    isProjectionOrGoal,
    isLikelySupportingDetail,
    isIncompleteMetricClaim,
    hasGenericSubjectOnly,
    isDerivativeMetricOnly,
    isLowMaterialityFragment,
    claimCompleteness,
    tableRelationship,
    semanticGroupKey,
  };
}

function extractClaimMetrics(claim: string): string[] {
  const matches = claim.match(
    /\$?\d+(?:,\d{3})*(?:\.\d+)?\s*(?:%|percent|percentage points?|million|billion|trillion|mwh|twh|tokens?|flops?|gb|tb|x|monthly|weekly|daily)?|\b10\^\d+\b/gi,
  ) ?? [];

  return [...new Set(matches.map((match) => match.trim().toLowerCase()))];
}

function extractNamedEntities(claim: string): string[] {
  const ignored = new Set([
    "The",
    "This",
    "These",
    "Those",
    "A",
    "An",
    "By",
    "Global",
    "Companies",
    "Organisations",
    "Organizations",
    "Users",
  ]);
  const matches = claim.match(/\b[A-Z][A-Za-z0-9&.-]*(?:\s+[A-Z][A-Za-z0-9&.-]*){0,4}\b/g) ?? [];
  return [
    ...new Set(
      matches
        .map((match) => match.trim())
        .filter((match) => !ignored.has(match) && match.length > 1),
    ),
  ];
}

function isTableLikeBreakdown(claim: string): boolean {
  return (
    /\b(?:category|segment|sub-?segment|tools?|infrastructure|saas|services?)\b/i.test(claim) &&
    /\b(?:grew|growth|increase|decrease|year-over-year|yoy|cagr)\b/i.test(claim) &&
      extractClaimMetrics(claim).length >= 2 &&
      !/\b(?:according to|reported by|published by|source:)\b/i.test(claim)
  );
}

function getTableRelationship(claim: string): "parent" | "row" | "none" {
  if (isTableLikeBreakdown(claim)) {
    return "row";
  }

  if (
    /\b(?:total|overall|global|worldwide|enterprise|market|sector|industry)\b/i.test(claim) &&
    /\b(?:reached|hit|accounted for|valued at|projected|forecast|reported|estimated)\b/i.test(claim) &&
    extractClaimMetrics(claim).length > 0
  ) {
    return "parent";
  }

  return "none";
}

function isDerivativeMetricClaim(claim: string): boolean {
  const metrics = extractClaimMetrics(claim);
  const hasAbsoluteValue = metrics.some((metric) =>
    /\$|million|billion|trillion|users?|devices?|products?|miles?|rides?|jobs?|roles?|gb|mwh|twh|tokens?|flops?/i.test(metric),
  );

  return (
    /\b(?:grew|growth|increase|increased|decline|declined|fell|rose|year-over-year|yoy|over the past)\b/i.test(claim) &&
    /\d+(?:\.\d+)?\s*%/.test(claim) &&
    !hasAbsoluteValue
  );
}

function isLowPriorityFragment(claim: string): boolean {
  return (
    (
      /\b(?:respondents|internet users|employees|users aged|downloads?|queries|daily active users|monthly queries|applications|subscription|paid rides|countries)\b/i.test(claim) ||
      /\b(?:trust|used a|use ai-assisted|outperformed|profit margins|shareholder meeting|stated that|commitment)\b/i.test(claim)
    ) &&
    !/\b(?:according to|reported by|published by|estimated by|survey by|source:)\b/i.test(claim)
  );
}

function inferSectionImportance(claim: string): number {
  if (/^##\s+/.test(claim)) return 10;
  if (/\b(?:executive summary|market overview|financial performance|regulatory|funding|valuation|benchmark|technical specification)\b/i.test(claim)) {
    return 8;
  }
  if (/\b(?:market|revenue|funding|valuation|regulation|benchmark|launched|released|adopted|issued)\b/i.test(claim)) {
    return 4;
  }
  return 0;
}

function scoreClaimCompleteness(features: {
  metricCount: number;
  yearCount: number;
  namedEntityCount: number;
  hasAttribution: boolean;
  hasMaterialAction: boolean;
  hasFinancialOrMarketTerm: boolean;
  hasRegulatoryOrBenchmarkTerm: boolean;
  hasBroadQuantifiedSubject: boolean;
}): number {
  let score = 0;
  if (features.metricCount > 0) score += 0.22;
  if (features.yearCount > 0) score += 0.18;
  if (features.namedEntityCount > 0 || features.hasBroadQuantifiedSubject) score += 0.22;
  if (features.hasMaterialAction) score += 0.16;
  if (features.hasFinancialOrMarketTerm || features.hasRegulatoryOrBenchmarkTerm) score += 0.12;
  if (features.hasAttribution) score += 0.10;
  return Math.min(1, score);
}

function claimGroupKey(claim: string): string {
  const entities = extractNamedEntities(claim).slice(0, 2).join(" ");
  const family = factFamily(claim);
  return normalizeClaimText(`${entities || firstMeaningfulWords(claim)} ${family}`);
}

function claimSemanticGroupKey(claim: string): string {
  const subject = claimSubjectKey(claim);
  const metric = metricActionKey(claim);
  const timeframe = timeframeKey(claim);
  return normalizeClaimText(`${subject} ${metric} ${timeframe}`);
}

function claimSubjectKey(claim: string): string {
  const prefixSubject = subjectPrefix(claim);
  if (prefixSubject) {
    return prefixSubject;
  }

  const entities = extractNamedEntities(claim).slice(0, 3);
  if (entities.length > 0) {
    return entities.join(" ");
  }

  const broadMatch = claim.match(/\b(?:global|worldwide|enterprise|national|international)?\s*(?:[a-z]+(?:\s+[a-z]+){0,3})?\s*(?:market|sector|industry|funding|spending|revenue|regulation|act|order|measures?)\b/i);
  if (broadMatch) {
    return broadMatch[0];
  }

  return firstMeaningfulWords(claim);
}

function subjectPrefix(claim: string): string {
  const match = claim.match(/^(?:the\s+|a\s+|an\s+)?(.+?)\s+\b(?:reached|hit|rose|fell|increased|decreased|launched|released|adopted|issued|implemented|secured|raised|crossed|surpassed|accounted for|projected|forecast|estimated|reported|mandates?|requires?|was|were|had|has)\b/i);
  const raw = match?.[1]?.trim();
  if (!raw) {
    return "";
  }

  const cleaned = raw
    .replace(/\b(?:revenue|funding|spending|market|share|valuation|cost|price|score|benchmark|users?|downloads?|queries|jobs?|roles?|memory|threshold)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.split(/\s+/).length > 8) {
    return "";
  }

  return cleaned;
}

function startsWithSubject(claim: string): boolean {
  return /^(?:the\s+)?[A-Z][A-Za-z0-9&.'-]*(?:\s+[A-Z][A-Za-z0-9&.'-]*){0,4}\b/.test(claim);
}

function isStandaloneAssertion(claim: string): boolean {
  if (/^(?:representing|including|with|at|from|by)\b/i.test(claim)) {
    return false;
  }

  return extractClaimMetrics(claim).length > 0 &&
    /\b(?:reached|hit|rose|fell|increased|decreased|launched|released|adopted|issued|implemented|secured|raised|crossed|surpassed|accounted for|projected|forecast|estimated|reported|mandates?|requires?|trains?|trained|achieved|climbed)\b/i.test(claim);
}

function metricActionKey(claim: string): string {
  const lower = claim.toLowerCase();
  const family = factFamily(claim);
  const metricTerm =
    lower.match(/\b(?:market share|market cap|valuation|revenue|funding|spending|investment|users?|downloads?|queries|jobs?|roles?|context window|memory|mmlu|benchmark|threshold|fines?|approval|energy|cost|price|launch|release|adoption)\b/)?.[0] ??
    family;
  const action =
    lower.match(/\b(?:reached|hit|rose|fell|increased|decreased|launched|released|adopted|issued|implemented|secured|raised|crossed|surpassed|accounted for|projected|forecast|estimated|reported|mandates?|requires?)\b/)?.[0] ??
    "";
  return `${metricTerm} ${action}`.trim();
}

function timeframeKey(claim: string): string {
  const years = claim.match(/\b(?:19|20)\d{2}\b/g)?.slice(0, 2) ?? [];
  const quarters = claim.match(/\bQ[1-4]\s*(?:19|20)?\d{2}\b/gi) ?? [];
  const durations = claim.match(/\b\d+(?:\.\d+)?\s*(?:days?|weeks?|months?|years?)\b/gi) ?? [];
  return [...quarters, ...years, ...durations].join(" ");
}

function factFamily(claim: string): string {
  const lower = claim.toLowerCase();
  if (/\b(?:market|valuation|revenue|funding|spending|investment|share|cap|capitali[sz]ation)\b/.test(lower)) return "market-financial";
  if (/\b(?:launch|launched|released|release)\b/.test(lower)) return "launch-release";
  if (/\b(?:benchmark|score|exam|mmlu|accuracy|performance)\b/.test(lower)) return "benchmark";
  if (/\b(?:act|order|regulation|measures?|approval|threshold|fines?)\b/.test(lower)) return "regulatory";
  if (/\b(?:context|tokens?|flops?|memory|hbm|mwh|twh)\b/.test(lower)) return "technical-spec";
  return "general";
}

function firstMeaningfulWords(claim: string): string {
  return claim
    .split(/\s+/)
    .filter((word) => !/^(the|a|an|this|that|global)$/i.test(word))
    .slice(0, 4)
    .join(" ");
}

function shouldMergeGroup(group: NormalizedClaim[]): boolean {
  if (group.length < 2) return false;
  const profiles = group.map((claim) => getClaimFeatureProfile(claim.claim));
  const allSameFamily = new Set(group.map((claim) => factFamily(claim.claim))).size === 1;
  const hasComplementaryTimeline = profiles.some((profile) => profile.isProjectionOrGoal) &&
    profiles.some((profile) => !profile.isProjectionOrGoal);
  const allShort = group.every((claim) => claim.claim.length < 140);
  return allSameFamily && hasComplementaryTimeline && allShort;
}

function compareClaimCandidate<T extends {
  claim: Pick<NormalizedClaim, "importance_score">;
  score: number;
  profile: ClaimFeatureProfile;
  originalIndex: number;
}>(left: T, right: T): number {
  return (
    left.profile.claimCompleteness - right.profile.claimCompleteness ||
    left.score - right.score ||
    left.claim.importance_score - right.claim.importance_score ||
    right.originalIndex - left.originalIndex
  );
}

function hasStrongerParentCoverage<T extends {
  claim: NormalizedClaim;
  score: number;
  profile: ClaimFeatureProfile;
}>(candidate: T, all: T[]): boolean {
  if (
    candidate.profile.tableRelationship !== "row" &&
    !candidate.profile.isLikelySupportingDetail
  ) {
    return false;
  }

  return all.some((other) => {
    if (other === candidate) {
      return false;
    }
    if (other.profile.tableRelationship === "row") {
      return false;
    }
    if (other.profile.claimCompleteness < candidate.profile.claimCompleteness) {
      return false;
    }
    if (other.score < candidate.score + 8) {
      return false;
    }
    return sameSubjectAndFamily(other.claim.claim, candidate.claim.claim);
  });
}

function sameSubjectAndFamily(left: string, right: string): boolean {
  return (
    factFamily(left) === factFamily(right) &&
    similarityScore(
      normalizeClaimText(claimSubjectKey(left)),
      normalizeClaimText(claimSubjectKey(right)),
    ) > 0.54
  );
}

function mergeClaimTexts(claims: string[]): string {
  const [first, ...rest] = claims;
  return rest.reduce(
    (merged, claim) =>
      `${merged.replace(/\.$/, "")} and ${claim.charAt(0).toLowerCase()}${claim.slice(1)}`,
    first,
  );
}

export function buildCapNotice(prepared: {
  totalClaimsExtracted: number;
  totalClaimsFound: number;
  wasCapped: boolean;
}): string | undefined {
  if (!prepared.wasCapped) {
    return undefined;
  }

  return `Selected the ${prepared.totalClaimsFound} most material claims from ${prepared.totalClaimsExtracted} extracted candidates.`;
}

export function sortClaimsByImportance(claims: NormalizedClaim[]): NormalizedClaim[] {
  return [...claims].sort(
    (a, b) => b.importance_score - a.importance_score,
  );
}

export function deduplicateClaims(claims: NormalizedClaim[]): NormalizedClaim[] {
  const selected: NormalizedClaim[] = [];

  for (const claim of claims) {
    const duplicateIndex = selected.findIndex(
      (existing) =>
        similarityScore(existing.normalized_claim, claim.normalized_claim) > 0.88,
    );

    if (duplicateIndex === -1) {
      selected.push(claim);
      continue;
    }

    if (
      claim.importance_score > selected[duplicateIndex].importance_score
    ) {
      selected[duplicateIndex] = claim;
    }
  }

  return selected.map((claim, index) => ({
    ...claim,
    id: `claim-${index + 1}`,
  }));
}

export function similarityScore(left: string, right: string): number {
  if (left === right) {
    return 1;
  }

  const tokenScore = jaccard(tokenize(left), tokenize(right));
  const gramScore = diceCoefficient(toTrigrams(left), toTrigrams(right));
  return (tokenScore + gramScore) / 2;
}

function tokenize(value: string): string[] {
  return value.split(/\s+/).filter(Boolean);
}

function toTrigrams(value: string): string[] {
  const compact = value.replace(/\s+/g, " ");
  if (compact.length <= 3) {
    return [compact];
  }

  const grams: string[] = [];
  for (let index = 0; index <= compact.length - 3; index += 1) {
    grams.push(compact.slice(index, index + 3));
  }
  return grams;
}

function jaccard(left: string[], right: string[]): number {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const union = new Set([...leftSet, ...rightSet]);

  if (union.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) {
      intersection += 1;
    }
  }

  return intersection / union.size;
}

function diceCoefficient(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }

  const rightCounts = new Map<string, number>();
  for (const gram of right) {
    rightCounts.set(gram, (rightCounts.get(gram) ?? 0) + 1);
  }

  let overlap = 0;
  for (const gram of left) {
    const count = rightCounts.get(gram) ?? 0;
    if (count > 0) {
      overlap += 1;
      rightCounts.set(gram, count - 1);
    }
  }

  return (2 * overlap) / (left.length + right.length);
}
