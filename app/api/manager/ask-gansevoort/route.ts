import { NextResponse, type NextRequest } from "next/server";
import crypto from "node:crypto";
import { z } from "zod";
import { requireManagerOrAdmin, AuthInfrastructureError } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { resolveOrganizationTimezone } from "@/app/lib/dateRanges/organizationTimezone";
import { checkAskGansevoortRateLimit } from "@/app/lib/ai/chatRateLimit";
import { runAskGansevoort, AskGansevoortTimeoutError } from "@/app/lib/ai/tasks/chat/orchestrate";
import { AIProviderError } from "@/app/lib/ai/provider";
import { AIProviderUnavailableError } from "@/app/lib/ai/router/providerRegistry";
import { ASK_GANSEVOORT_MAX_QUESTION_LENGTH, ASK_GANSEVOORT_MAX_HISTORY_TURNS, type AskGansevoortResponse } from "@/app/lib/ai/tasks/chat/contract";

/**
 * Manager/admin-only Ask Gansevoort chat endpoint (Section 13). The model
 * never touches Supabase directly -- this route resolves the trusted
 * organization/actor context ONCE via requireManagerOrAdmin(), applies a
 * durable rate limit, then hands control to runAskGansevoort(), which is
 * the only thing that talks to the AI provider.
 *
 * A Route Handler (not a Server Action) is used for the same reason
 * app/manager/(app)/reports/export/route.ts already is: this needs a
 * plain POST/JSON contract driven from a client-side fetch, with full
 * control over status codes and headers (no-store) -- not a file
 * download here, but the same "one auth call, not a React render" note
 * applies (requireManagerOrAdmin()'s cache() memoization does nothing
 * extra here and costs nothing extra either).
 */

const MAX_BODY_BYTES = 20_000;

const requestBodySchema = z
  .object({
    question: z.string().min(1).max(ASK_GANSEVOORT_MAX_QUESTION_LENGTH),
    history: z
      .array(
        z.object({
          role: z.enum(["user", "assistant"]),
          content: z.string().max(4000),
        })
      )
      .max(ASK_GANSEVOORT_MAX_HISTORY_TURNS),
  })
  .strict();

function fail(status: number, body: AskGansevoortResponse) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();

  // Basic size guard BEFORE reading/parsing the body, and before auth --
  // deliberately cheap, header-only (Section 13: "reject oversized
  // requests"). The real authorization check still happens before any
  // request CONTENT is used for anything.
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BODY_BYTES) {
    return fail(413, { ok: false, reason: "invalid_request", message: "Request too large.", requestId });
  }

  let auth: Awaited<ReturnType<typeof requireManagerOrAdmin>>;
  try {
    auth = await requireManagerOrAdmin();
  } catch (err) {
    if (err instanceof AuthInfrastructureError) {
      console.error(`[ask-gansevoort:${requestId}] AUTH_INFRA_FAILURE error=${err.message}`);
      return fail(503, { ok: false, reason: "provider_unavailable", message: "Ask Gansevoort is temporarily unavailable. Try again shortly.", requestId });
    }
    throw err;
  }
  if (!auth.ok) {
    return fail(auth.reason === "not_authenticated" ? 401 : 403, {
      ok: false,
      reason: auth.reason,
      message: auth.reason === "not_authenticated" ? "Your session expired. Please sign in again." : "You must be signed in as a manager or admin.",
      requestId,
    });
  }
  const { organizationId, appUserId } = auth.manager;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return fail(400, { ok: false, reason: "invalid_request", message: "Invalid request.", requestId });
  }
  const parsedBody = requestBodySchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return fail(400, { ok: false, reason: "invalid_request", message: "Invalid question or conversation history.", requestId });
  }
  const { question, history } = parsedBody.data;

  const supabase = getServiceRoleClient();

  try {
    const rateLimit = await checkAskGansevoortRateLimit(supabase, organizationId, appUserId);
    if (!rateLimit.allowed) {
      console.log(`[ask-gansevoort:${requestId}] RATE_LIMITED organizationId=${organizationId} appUserId=${appUserId}`);
      return fail(429, {
        ok: false,
        reason: "rate_limited",
        message: "You've reached the question limit. Try again in a few minutes.",
        retryAfterSeconds: rateLimit.retryAfterSeconds,
        requestId,
      });
    }
  } catch (err) {
    console.error(`[ask-gansevoort:${requestId}] RATE_LIMIT_CHECK_FAILED error=${err instanceof Error ? err.message : String(err)}`);
    return fail(503, { ok: false, reason: "provider_unavailable", message: "Ask Gansevoort is temporarily unavailable. Try again shortly.", requestId });
  }

  const timeZone = await resolveOrganizationTimezone(supabase, organizationId);

  try {
    const result = await runAskGansevoort({
      supabase,
      organizationId,
      actorAppUserId: appUserId,
      timeZone,
      question,
      history,
      requestId,
    });

    console.log(
      `[ask-gansevoort:${requestId}] SUCCESS organizationId=${organizationId} appUserId=${appUserId} tools=${result.toolsUsed.join(",")} durationMs=${Date.now() - startedAt}`
    );

    return NextResponse.json(
      {
        ok: true,
        answer: result.answer,
        evidence: result.evidence,
        period: result.period,
        toolsUsed: result.toolsUsed,
        generatedAt: new Date().toISOString(),
        warning: result.warning,
        requestId,
        downloads: result.downloads,
      } satisfies AskGansevoortResponse,
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    if (err instanceof AskGansevoortTimeoutError) {
      console.error(`[ask-gansevoort:${requestId}] TIMEOUT durationMs=${Date.now() - startedAt}`);
      return fail(504, { ok: false, reason: "timeout", message: "Ask Gansevoort didn't respond in time. Try again.", requestId });
    }
    if (err instanceof AIProviderUnavailableError) {
      console.error(`[ask-gansevoort:${requestId}] PROVIDER_UNAVAILABLE providerKey=${err.providerKey}`);
      return fail(503, { ok: false, reason: "provider_unavailable", message: "Ask Gansevoort is temporarily unavailable. Try again shortly.", requestId });
    }
    if (err instanceof AIProviderError) {
      console.error(`[ask-gansevoort:${requestId}] PROVIDER_ERROR code=${err.code} message=${err.message}`);
      return fail(503, { ok: false, reason: "provider_unavailable", message: "Ask Gansevoort is temporarily unavailable. Try again shortly.", requestId });
    }
    console.error(`[ask-gansevoort:${requestId}] UNEXPECTED_ERROR`, {
      error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : err,
    });
    return fail(500, { ok: false, reason: "unexpected_error", message: "Something went wrong. Try again.", requestId });
  }
}
