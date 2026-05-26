import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NormalizedClaim } from "@/lib/schemas";

const CACHE_DIR = process.env.VERCEL
  ? join(tmpdir(), "2see-claim-cache")
  : join(process.cwd(), ".next", "cache", "claims");
const MEMORY_CACHE = new Map<string, NormalizedClaim[]>();

function pdfHash(buffer: ArrayBuffer): string {
  const copy =
    buffer.byteLength === 0 ? Buffer.alloc(0) : Buffer.from(buffer.slice(0));
  return createHash("sha256").update(copy).digest("hex");
}

function cachePath(hash: string, model: string): string {
  const safeModel = model.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(CACHE_DIR, `${hash}-${safeModel}.json`);
}

export function readCachedClaims(
  buffer: ArrayBuffer,
  model: string,
): NormalizedClaim[] | null {
  if (process.env.DISABLE_CLAIM_CACHE === "1") {
    return null;
  }

  const hash = pdfHash(buffer);
  const memoryKey = `${hash}:${model}`;
  const memoryValue = MEMORY_CACHE.get(memoryKey);
  if (memoryValue) {
    return memoryValue;
  }

  const path = cachePath(hash, model);
  if (!existsSync(path)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { claims?: NormalizedClaim[] };
    if (!parsed.claims || !Array.isArray(parsed.claims)) {
      return null;
    }
    MEMORY_CACHE.set(memoryKey, parsed.claims);
    return parsed.claims;
  } catch {
    return null;
  }
}

export function writeCachedClaims(
  buffer: ArrayBuffer,
  model: string,
  claims: NormalizedClaim[],
): void {
  if (process.env.DISABLE_CLAIM_CACHE === "1") {
    return;
  }

  const hash = pdfHash(buffer);
  MEMORY_CACHE.set(`${hash}:${model}`, claims);

  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const path = cachePath(hash, model);
    writeFileSync(path, JSON.stringify({ claims, cachedAt: new Date().toISOString() }, null, 2));
  } catch (error) {
    console.warn(
      `Claim cache write skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
