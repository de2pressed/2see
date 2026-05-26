import { describe, expect, it } from "vitest";

import { chunkText } from "@/utils/chunk-text";

describe("PDF text chunking", () => {
  it("leaves short documents as a single chunk", () => {
    expect(chunkText("Short document with a factual claim.")).toHaveLength(1);
  });

  it("splits large documents without returning empty chunks", () => {
    const paragraph = "Revenue grew by 12 percent in 2025. ".repeat(900);
    const text = Array.from({ length: 80 }).map(() => paragraph).join("\n\n");
    const chunks = chunkText(text);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.trim().length > 0)).toBe(true);
  });
});
