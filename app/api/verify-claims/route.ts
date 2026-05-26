export const runtime = "nodejs";
export const maxDuration = 60;

import { verifyClaimsRequestSchema } from "@/lib/schemas";
import { runBatchedVerifications } from "@/services/verification";

export async function POST(request: Request) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON request." }, { status: 400 });
  }

  const parsed = verifyClaimsRequestSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Verification request failed validation." },
      { status: 400 },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: unknown) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
        );
      };

      try {
        send({
          type: "verification_started",
          totalClaims: parsed.data.claims.length,
        });

        await runBatchedVerifications(
          parsed.data.claims,
          parsed.data.model,
          async (event) => send(event),
          { signal: request.signal },
        );

        send({
          type: "verification_completed",
        });
      } catch (error) {
        if (
          error instanceof DOMException && error.name === "AbortError" ||
          error instanceof Error && error.name === "AbortError"
        ) {
          console.log("Client aborted verification request.");
          send({
            type: "verification_cancelled",
          });
        } else {
          send({
            type: "verification_error",
            error:
              error instanceof Error
                ? error.message
                : "Verification failed unexpectedly.",
          });
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      "Content-Type": "text/event-stream; charset=utf-8",
      Connection: "keep-alive",
    },
  });
}
