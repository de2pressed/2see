import { describe, expect, it } from "vitest";
import { z } from "zod";

import { parseAndValidateGeminiJson, stripMarkdownFences, isValidClaimText, stripThinkBlock, repairTruncatedJsonArray } from "@/utils/ai";

describe("Gemini JSON sanitation", () => {
  it("strips markdown JSON fences", () => {
    expect(stripMarkdownFences("```json\n{\"ok\":true}\n```")).toBe(
      "{\"ok\":true}",
    );
  });

  it("validates parsed JSON through Zod", () => {
    const schema = z.object({ ok: z.boolean() });
    const result = parseAndValidateGeminiJson("{\"ok\":true}", schema);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.ok).toBe(true);
    }
  });

  it("rejects invalid JSON without exposing raw data", () => {
    const schema = z.object({ ok: z.boolean() });
    const result = parseAndValidateGeminiJson("{ok:true}", schema);

    expect(result.ok).toBe(false);
  });

  it("strips think blocks closed and unclosed", () => {
    expect(stripThinkBlock("<think>reasoning</think>[1,2,3]")).toBe("[1,2,3]");
    expect(stripThinkBlock("<think>unclosed reasoning [1,2,3]")).toBe("");
    expect(stripThinkBlock("no think block")).toBe("no think block");
  });

  it("repairs truncated JSON arrays", () => {
    expect(repairTruncatedJsonArray("[{\"claim\":\"a\"}, {\"claim\":\"b\"")).toBe("[{\"claim\":\"a\"}]");
    expect(repairTruncatedJsonArray("[{\"claim\":\"a\"}, {\"claim\":\"b\",\"type\":\"date\"")).toBe("[{\"claim\":\"a\"}]");
    expect(repairTruncatedJsonArray("[{\"claim\":\"a\"}]")).toBe("[{\"claim\":\"a\"}]");
  });
});

describe("isValidClaimText validation rules", () => {
  it("rejects short fragments and years", () => {
    expect(isValidClaimText("2024")).toBe(false);
    expect(isValidClaimText("2025")).toBe(false);
    expect(isValidClaimText("June 2024")).toBe(false);
    expect(isValidClaimText("")).toBe(false);
    expect(isValidClaimText("AI")).toBe(false);
  });

  it("rejects simple number and percentage assertions", () => {
    expect(isValidClaimText("90 percent")).toBe(false);
    expect(isValidClaimText("90%")).toBe(false);
    expect(isValidClaimText("$35 trillion")).toBe(false);
  });

  it("accepts complete factual assertions", () => {
    expect(isValidClaimText("Meta released Llama 3 in 2024")).toBe(true);
    expect(isValidClaimText("Google introduced AI Overviews broadly in Search in 2024.")).toBe(true);
    expect(isValidClaimText("GitHub Copilot was initially released as a technical preview in 2021.")).toBe(true);
  });
});
