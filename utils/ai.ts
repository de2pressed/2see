import type { ZodSchema } from "zod";

export type SanitizedJsonResult<T> =
  | { ok: true; data: T; cleaned: string }
  | { ok: false; error: string; cleaned: string };

export function stripMarkdownFences(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }
  const withoutOpeningFence = trimmed.replace(/^```(?:json)?\s*/i, "");
  return withoutOpeningFence.replace(/\s*```$/g, "").trim();
}

export function stripThinkBlock(text: string): string {
  const thinkStart = text.toLowerCase().indexOf("<think>");
  if (thinkStart === -1) {
    return text.trim();
  }
  
  const thinkEnd = text.toLowerCase().indexOf("</think>");
  if (thinkEnd !== -1) {
    const before = text.slice(0, thinkStart);
    const after = text.slice(thinkEnd + 8); // 8 is length of </think>
    return (before + after).trim();
  } else {
    return text.slice(0, thinkStart).trim();
  }
}

/**
 * Multi-strategy JSON extractor that handles:
 * 1. Raw JSON (object or array)
 * 2. Markdown-fenced JSON blocks (```json ... ```)
 * 3. JSON embedded anywhere inside prose text
 * 4. Arrays or objects found anywhere in the blob
 */
export function extractJsonBlock(raw: string): string {
  const withoutThink = stripThinkBlock(raw);
  const trimmed = withoutThink.trim();

  // Strategy 1: direct parse — raw is already valid JSON
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    // continue
  }

  // Strategy 2: strip markdown fences then try again
  const stripped = stripMarkdownFences(trimmed);
  try {
    JSON.parse(stripped);
    return stripped;
  } catch {
    // continue
  }

  // Strategy 3: extract first {...} or [...] block (handles JSON inside prose)
  // Match the outermost balanced JSON object
  const objectMatch = extractBalanced(trimmed, "{", "}");
  if (objectMatch) {
    try {
      JSON.parse(objectMatch);
      return objectMatch;
    } catch {
      // continue
    }
  }

  // Strategy 4: extract first [...] array block
  const arrayMatch = extractBalanced(trimmed, "[", "]");
  if (arrayMatch) {
    try {
      JSON.parse(arrayMatch);
      return arrayMatch;
    } catch {
      // continue
    }
  }

  // Fallback: return stripped (will fail JSON.parse downstream)
  return stripped;
}

function extractBalanced(
  text: string,
  open: string,
  close: string,
): string | null {
  const start = text.indexOf(open);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === open) depth++;
    if (ch === close) {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

export function parseAndValidateGeminiJson<T>(
  raw: string,
  schema: ZodSchema<T>,
): SanitizedJsonResult<T> {
  const cleaned = extractJsonBlock(raw);

  try {
    const parsed = JSON.parse(cleaned);
    const validation = schema.safeParse(parsed);

    if (!validation.success) {
      return {
        ok: false,
        cleaned,
        error: validation.error.message,
      };
    }

    return {
      ok: true,
      cleaned,
      data: validation.data,
    };
  } catch (error) {
    return {
      ok: false,
      cleaned,
      error: error instanceof Error ? error.message : "Invalid JSON",
    };
  }
}

type NormalizedClaimJson = {
  claim: string;
  type: string;
  importance_score: number;
  page_number?: number;
};

export function normalizeClaimJson(data: unknown): NormalizedClaimJson[] {
  if (Array.isArray(data)) {
    return data.map(normalizeSingleClaim).filter(isNormalizedClaimJson);
  }
  if (isRecord(data)) {
    if (Array.isArray(data.claims)) {
      return data.claims.map(normalizeSingleClaim).filter(isNormalizedClaimJson);
    }
    for (const key of Object.keys(data)) {
      if (Array.isArray(data[key])) {
        const check = data[key].map(normalizeSingleClaim).filter(isNormalizedClaimJson);
        if (check.length > 0) return check;
      }
    }
    return [normalizeSingleClaim(data)].filter(isNormalizedClaimJson);
  }
  return [];
}

function isNormalizedClaimJson(value: NormalizedClaimJson | null): value is NormalizedClaimJson {
  return value !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isValidClaimText(claim: string): boolean {
  const trimmed = claim.trim();

  // 1. Minimum character length
  if (trimmed.length < 10) {
    return false;
  }

  // 2. Minimum word count (at least 3 words)
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length < 3) {
    return false;
  }

  // 3. Must contain alphabetical characters
  if (!/[a-zA-Z]/.test(trimmed)) {
    return false;
  }

  // 4. Must not consist purely of numbers, dates, currencies, or symbols
  const lettersOnly = trimmed.replace(/[\d\s\p{P}\p{Sc}%+=<>/\\|`~^&*_]/gu, "");
  if (lettersOnly.length < 5) {
    return false;
  }

  return true;
}

function normalizeSingleClaim(item: unknown): NormalizedClaimJson | null {
  if (!isRecord(item)) return null;

  let claim = firstString(item.claim, item.statement, item.text);
  if (typeof claim !== "string" || !isValidClaimText(claim)) {
    return null;
  }
  claim = claim.trim();

  let type = String(item.type || item.claim_type || "").toLowerCase().trim();
  if (type.includes("stat") || type.includes("percent") || type.includes("number") || type.includes("fig")) {
    type = "statistical";
  } else if (type.includes("fin") || type.includes("money") || type.includes("dollar") || type.includes("rev")) {
    type = "financial";
  } else if (type.includes("tech") || type.includes("bench") || type.includes("spec")) {
    type = "technical";
  } else if (type.includes("date") || type.includes("year") || type.includes("time")) {
    type = "date";
  } else {
    type = "technical";
  }

  const rawScore = item.importance_score !== undefined ? item.importance_score : item.importanceScore !== undefined ? item.importanceScore : item.score;
  let importance_score = 50;
  if (typeof rawScore === "number") {
    importance_score = Math.min(100, Math.max(0, rawScore));
  } else if (typeof rawScore === "string") {
    const parsedNum = parseFloat(rawScore);
    if (!isNaN(parsedNum)) {
      importance_score = Math.min(100, Math.max(0, parsedNum));
    } else {
      const lower = rawScore.toLowerCase();
      if (lower.includes("high")) importance_score = 80;
      else if (lower.includes("med")) importance_score = 50;
      else if (lower.includes("low")) importance_score = 20;
    }
  }

  const page_number = typeof item.page_number === "number" ? item.page_number : undefined;

  return {
    claim,
    type,
    importance_score,
    ...(page_number !== undefined ? { page_number } : {}),
  };
}

function firstString(...values: unknown[]): string {
  const value = values.find((item) => typeof item === "string");
  return typeof value === "string" ? value : "";
}

export function repairTruncatedJsonArray(raw: string): string {
  const withoutThink = stripThinkBlock(raw);
  const startIdx = withoutThink.indexOf("[");
  if (startIdx === -1) return raw;

  const text = withoutThink.slice(startIdx);
  let depth = 0;
  let inString = false;
  let escape = false;
  let lastValidEnd = -1;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === "[") {
      depth++;
    } else if (ch === "]") {
      depth--;
      if (depth === 0) {
        return text.slice(0, i + 1);
      }
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 1) {
        lastValidEnd = i;
      }
    }
  }

  if (lastValidEnd !== -1) {
    return text.slice(0, lastValidEnd + 1) + "]";
  }

  return raw;
}
