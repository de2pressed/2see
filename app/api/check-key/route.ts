export const runtime = "nodejs";

import { NextResponse } from "next/server";

export async function GET() {
  const groqKey = process.env.GROQ_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const tavilyKey = process.env.TAVILY_API_KEY;
  const serperKey = process.env.SERPER_API_KEY;

  let groqStatus = {
    hasKey: false,
    isValid: false,
    error: null as string | null,
    label: null as string | null,
    limit: "Free tier limits (14.4k TPM, 30 RPM)" as string | null,
    rateLimits: null as {
      remainingRequests: number | null;
      limitRequests: number | null;
      resetRequests: string | null;
      remainingTokens: number | null;
      limitTokens: number | null;
      resetTokens: string | null;
    } | null,
  };

  let openaiStatus = {
    hasKey: false,
    isValid: false,
    error: null as string | null,
    label: null as string | null,
    rateLimits: null as {
      remainingRequests: number | null;
      limitRequests: number | null;
      resetRequests: string | null;
      remainingTokens: number | null;
      limitTokens: number | null;
      resetTokens: string | null;
    } | null,
  };

  let tavilyStatus = {
    hasKey: false,
    isValid: false,
    error: null as string | null,
    label: null as string | null,
  };

  let serperStatus = {
    hasKey: false,
    isValid: false,
    error: null as string | null,
    label: null as string | null,
  };

  // 1. Verify Groq API Key
  if (groqKey) {
    groqStatus.hasKey = true;
    try {
      const response = await fetch("https://api.groq.com/openai/v1/models", {
        headers: {
          Authorization: `Bearer ${groqKey}`,
        },
        next: { revalidate: 0 },
      });

      if (response.status === 401) {
        groqStatus.isValid = false;
        groqStatus.error = "Invalid Groq API key.";
      } else if (!response.ok) {
        const text = await response.text();
        groqStatus.isValid = false;
        groqStatus.error = `Groq status check failed (${response.status}): ${text.slice(0, 100)}`;
      } else {
        groqStatus.isValid = true;
        groqStatus.label = "Groq API Key";

        const remainingRequests = response.headers.get("x-ratelimit-remaining-requests");
        const limitRequests = response.headers.get("x-ratelimit-limit-requests");
        const resetRequests = response.headers.get("x-ratelimit-reset-requests");
        const remainingTokens = response.headers.get("x-ratelimit-remaining-tokens");
        const limitTokens = response.headers.get("x-ratelimit-limit-tokens");
        const resetTokens = response.headers.get("x-ratelimit-reset-tokens");

        if (remainingRequests || remainingTokens) {
          groqStatus.rateLimits = {
            remainingRequests: remainingRequests ? parseInt(remainingRequests, 10) : null,
            limitRequests: limitRequests ? parseInt(limitRequests, 10) : null,
            resetRequests: resetRequests || null,
            remainingTokens: remainingTokens ? parseInt(remainingTokens, 10) : null,
            limitTokens: limitTokens ? parseInt(limitTokens, 10) : null,
            resetTokens: resetTokens || null,
          };
        }
      }
    } catch (error) {
      groqStatus.isValid = false;
      groqStatus.error = error instanceof Error ? error.message : "Groq API key verification failed.";
    }
  }

  // 2. Verify OpenAI API Key
  if (openaiKey) {
    openaiStatus.hasKey = true;
    try {
      const response = await fetch("https://api.openai.com/v1/models", {
        headers: {
          Authorization: `Bearer ${openaiKey}`,
        },
        next: { revalidate: 0 },
      });

      if (response.status === 401) {
        openaiStatus.isValid = false;
        openaiStatus.error = "Invalid OpenAI API key.";
      } else if (!response.ok) {
        const text = await response.text();
        openaiStatus.isValid = false;
        openaiStatus.error = `OpenAI status check failed (${response.status}): ${text.slice(0, 100)}`;
      } else {
        openaiStatus.isValid = true;
        openaiStatus.label = "OpenAI API Key";

        const remainingRequests = response.headers.get("x-ratelimit-remaining-requests");
        const limitRequests = response.headers.get("x-ratelimit-limit-requests");
        const resetRequests = response.headers.get("x-ratelimit-reset-requests");
        const remainingTokens = response.headers.get("x-ratelimit-remaining-tokens");
        const limitTokens = response.headers.get("x-ratelimit-limit-tokens");
        const resetTokens = response.headers.get("x-ratelimit-reset-tokens");

        if (remainingRequests || remainingTokens) {
          openaiStatus.rateLimits = {
            remainingRequests: remainingRequests ? parseInt(remainingRequests, 10) : null,
            limitRequests: limitRequests ? parseInt(limitRequests, 10) : null,
            resetRequests: resetRequests || null,
            remainingTokens: remainingTokens ? parseInt(remainingTokens, 10) : null,
            limitTokens: limitTokens ? parseInt(limitTokens, 10) : null,
            resetTokens: resetTokens || null,
          };
        }
      }
    } catch (error) {
      openaiStatus.isValid = false;
      openaiStatus.error = error instanceof Error ? error.message : "OpenAI API key verification failed.";
    }
  }

  // 3. Verify Tavily API Key
  if (tavilyKey) {
    tavilyStatus.hasKey = true;
    try {
      const response = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          api_key: tavilyKey,
          query: "test",
          max_results: 1,
        }),
        next: { revalidate: 0 },
      });

      if (response.status === 401 || response.status === 403) {
        tavilyStatus.isValid = false;
        tavilyStatus.error = "Invalid Tavily API key.";
      } else if (!response.ok) {
        const text = await response.text();
        tavilyStatus.isValid = false;
        tavilyStatus.error = `Tavily status check failed (${response.status}): ${text.slice(0, 100)}`;
      } else {
        tavilyStatus.isValid = true;
        tavilyStatus.label = "Tavily API Key";
      }
    } catch (error) {
      tavilyStatus.isValid = false;
      tavilyStatus.error = error instanceof Error ? error.message : "Tavily API key verification failed.";
    }
  }

  // 4. Verify Serper API Key
  if (serperKey) {
    serperStatus.hasKey = true;
    try {
      const response = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: {
          "X-API-KEY": serperKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          q: "test",
        }),
        next: { revalidate: 0 },
      });

      if (response.status === 401 || response.status === 403) {
        serperStatus.isValid = false;
        serperStatus.error = "Invalid Serper API key.";
      } else if (!response.ok) {
        const text = await response.text();
        serperStatus.isValid = false;
        serperStatus.error = `Serper status check failed (${response.status}): ${text.slice(0, 100)}`;
      } else {
        serperStatus.isValid = true;
        serperStatus.label = "Serper API Key";
      }
    } catch (error) {
      serperStatus.isValid = false;
      serperStatus.error = error instanceof Error ? error.message : "Serper API key verification failed.";
    }
  }

  // Root levels are populated for compatibility
  const hasKey = groqStatus.hasKey || openaiStatus.hasKey || tavilyStatus.hasKey || serperStatus.hasKey;
  const isValid = groqStatus.isValid || openaiStatus.isValid || tavilyStatus.isValid || serperStatus.isValid;
  const error = groqStatus.error || openaiStatus.error || tavilyStatus.error || serperStatus.error;
  const label = groqStatus.label || openaiStatus.label || tavilyStatus.label || serperStatus.label;

  return NextResponse.json({
    hasKey,
    isValid,
    error,
    label,
    limit: groqStatus.limit,
    usage: 0,
    limitRemaining: null,
    groq: groqStatus,
    openai: openaiStatus,
    tavily: tavilyStatus,
    serper: serperStatus,
  });
}
