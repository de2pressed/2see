export const runtime = "nodejs";

import { NextResponse } from "next/server";

export async function GET() {
  const apiKey = process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return NextResponse.json({
      hasKey: false,
      isValid: false,
      error: "Groq API key is missing in environment variables (.env file). Set GROQ_API_KEY.",
    });
  }

  try {
    const response = await fetch("https://api.groq.com/openai/v1/models", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      next: { revalidate: 0 },
    });

    if (response.status === 401) {
      return NextResponse.json({
        hasKey: true,
        isValid: false,
        error: "Invalid Groq API key.",
      });
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Groq key verification failed with status ${response.status}: ${text}`);
    }

    return NextResponse.json({
      hasKey: true,
      isValid: true,
      label: "Groq Free API Key",
      limit: "Free tier limits (14.4k TPM, 30 RPM)",
      usage: 0,
      limitRemaining: null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "API key verification failed.";
    return NextResponse.json({
      hasKey: true,
      isValid: false,
      error: message,
    });
  }
}
