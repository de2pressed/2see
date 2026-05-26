import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { extractPdfText } from "@/services/pdf";

describe("PDF extraction", () => {
  it("extracts text from a fixture PDF without a missing worker failure", async () => {
    const fixture = readFileSync(path.join(process.cwd(), "2see_test_document.pdf"));
    const buffer = fixture.buffer.slice(
      fixture.byteOffset,
      fixture.byteOffset + fixture.byteLength,
    );

    const pages = await extractPdfText(buffer);
    const text = pages.map((page) => page.text).join("\n");

    expect(pages.length).toBeGreaterThan(0);
    expect(text.length).toBeGreaterThan(100);
  });
});
