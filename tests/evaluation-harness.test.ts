import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const evaluationDir = join(process.cwd(), "tests", "fixtures", "evaluation");

describe("report evaluation fixtures", () => {
  it("ships gold labels for the three supplied benchmark PDFs outside runtime code", () => {
    const files = [
      "2see_test_document.gold.json",
      "2see_advanced_stress_test.gold.json",
      "2see_stress_test_v2.gold.json",
    ];

    for (const file of files) {
      const path = join(evaluationDir, file);
      expect(existsSync(path)).toBe(true);
      const fixture = JSON.parse(readFileSync(path, "utf8")) as {
        sourceFile?: string;
        claims?: Array<{ normalizedClaim?: string; verdict?: string }>;
      };
      expect(fixture.sourceFile).toMatch(/\.pdf$/);
      expect(fixture.claims?.length).toBeGreaterThan(0);
      expect(fixture.claims?.every((claim) => claim.normalizedClaim && claim.verdict)).toBe(true);
    }
  });

  it("keeps evaluation fixtures out of runtime source files", () => {
    const runtimeFiles = [
      "services/openai.ts",
      "utils/claims.ts",
      "app/api/extract-claims/route.ts",
      "app/api/verify-claims/route.ts",
      "components/verification-app.tsx",
    ].map((file) => readFileSync(join(process.cwd(), file), "utf8"));

    const runtimeText = runtimeFiles.join("\n");
    expect(runtimeText).not.toContain("tests/fixtures/evaluation");
    expect(runtimeText).not.toContain("2see_stress_test_v2.gold");
    expect(runtimeText).not.toContain("2see_advanced_stress_test.gold");
    expect(runtimeText).not.toContain("2see_test_document.gold");
  });
});
