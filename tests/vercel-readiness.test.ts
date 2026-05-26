import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("Vercel serverless readiness", () => {
  const nextConfig = readFileSync(path.join(process.cwd(), "next.config.ts"), "utf8");

  it("traces pdf.js dynamic assets needed by the extraction route", () => {
    expect(nextConfig).toContain("outputFileTracingIncludes");
    expect(nextConfig).toContain("/api/extract-claims");
    expect(nextConfig).toContain("pdf.worker.mjs");
    expect(nextConfig).toContain("@napi-rs/canvas*/**/*");
  });

  it("keeps pdf extraction packages available for normal Next tracing", () => {
    const externalPackages = /serverExternalPackages:\s*\[([\s\S]*?)\]/.exec(nextConfig)?.[1] ?? "";

    expect(externalPackages).not.toContain("pdfjs-dist");
    expect(externalPackages).not.toContain("@napi-rs/canvas");
  });
});
