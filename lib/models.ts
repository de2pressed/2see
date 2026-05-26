export const FAST_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct" as const;
export const THOROUGH_MODEL = "llama-3.3-70b-versatile" as const;

/** Default to the faster model; users can switch to 70B for dense reports. */
export const DEFAULT_MODEL = FAST_MODEL;

export const MODEL_OPTIONS = [
  {
    id: FAST_MODEL,
    label: "Llama 4 Scout 17B",
    note: "Fast — best for smaller PDFs and fewer claims",
  },
  {
    id: THOROUGH_MODEL,
    label: "Llama 3.3 70B (Versatile)",
    note: "Slower — better for large files with many claims",
  },
] as const;

export type OpenAIModel = (typeof MODEL_OPTIONS)[number]["id"];
export type GeminiModel = OpenAIModel;

export function isOpenAIModel(value: unknown): value is OpenAIModel {
  return MODEL_OPTIONS.some((option) => option.id === value);
}
export const isGeminiModel = isOpenAIModel;

export function isGroqFreeTierModel(model: OpenAIModel): boolean {
  return model === FAST_MODEL || model === THOROUGH_MODEL;
}

export function isFastGroqModel(model: OpenAIModel): boolean {
  return model === FAST_MODEL;
}
