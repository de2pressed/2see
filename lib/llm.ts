/** Shared Groq/OpenAI completion params for reproducible outputs. */
export const EXTRACTION_COMPLETION_PARAMS = {
  temperature: 0,
  top_p: 1,
} as const;

export const VERIFICATION_COMPLETION_PARAMS = {
  temperature: 0,
  top_p: 1,
} as const;

export const RETRIEVAL_QUERY_COMPLETION_PARAMS = {
  temperature: 0,
  top_p: 1,
} as const;
