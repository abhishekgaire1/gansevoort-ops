import "server-only";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import type { AIProvider } from "@/app/lib/ai/provider";
import { AIProviderError } from "@/app/lib/ai/provider";
import type { AIUsageTaskKey } from "@/app/lib/ai/taskKeys";
import { instantiateProvider, AIProviderUnavailableError } from "@/app/lib/ai/router/providerRegistry";
import { normalizeProviderUsage } from "@/app/lib/ai/router/normalizeUsage";

/**
 * AI Configuration + Usage/Cost Tracking milestone -- the central
 * execution wrapper every AI call passes through (Part 20). It:
 *
 *   1. instantiates the resolved provider adapter (already-resolved --
 *      see resolveAIConfig.ts's own comment for why resolution is a
 *      separate step, not folded in here)
 *   2. starts timing
 *   3. calls the caller-supplied task function
 *   4. normalizes provider usage from the raw response
 *   5. records a durable ai_usage_events row (best-effort -- Part 59)
 *   6. returns the validated business result, or rethrows the original
 *      provider error after recording a FAILED usage event
 *
 * Business features never calculate cost themselves (Part 20) and never
 * write directly to ai_usage_events -- this is the only writer.
 */
export interface ExecuteAITaskResult<T> {
  data: T;
  model: string;
  provider: string;
}

export interface ExecuteAITaskParams<T> {
  organizationId: string;
  task: AIUsageTaskKey;
  provider: string;
  model: string;
  /** Idempotency key for this one real provider attempt (Part 60) -- a
   * document_extractions.id, a classification claim id, or a fresh id
   * per Test Configuration click. Never reused across genuinely distinct
   * attempts (a retry after failure uses its OWN key, so its cost is
   * recorded separately -- Part 52). */
  requestKey: string;
  sourceType?: string | null;
  sourceId?: string | null;
  actorAppUserId?: string | null;
  run: (provider: AIProvider, model: string) => Promise<{ data: T; raw: unknown; model: string; provider: string }>;
}

export async function executeAITask<T>(params: ExecuteAITaskParams<T>): Promise<T> {
  // Not configured -- fails before any call is attempted, before any
  // usage event is written (there was no real provider attempt).
  const providerAdapter = instantiateProvider(params.provider);

  const startedAt = new Date();
  let resultModel = params.model;
  let resultProvider = params.provider;

  try {
    const result = await params.run(providerAdapter, params.model);
    resultModel = result.model;
    resultProvider = result.provider;

    const usage = normalizeProviderUsage(resultProvider, result.raw);
    await recordUsageEvent({
      ...params,
      provider: resultProvider,
      model: resultModel,
      status: "SUCCESS",
      startedAt,
      completedAt: new Date(),
      usage,
      errorCode: null,
    });

    return result.data;
  } catch (err) {
    const errorCode = err instanceof AIProviderError ? err.code : "UNKNOWN";
    await recordUsageEvent({
      ...params,
      provider: resultProvider,
      model: resultModel,
      status: "FAILED",
      startedAt,
      completedAt: new Date(),
      usage: null,
      errorCode,
    });
    throw err;
  }
}

export { AIProviderUnavailableError };

interface RecordUsageInput {
  organizationId: string;
  task: AIUsageTaskKey;
  provider: string;
  model: string;
  requestKey: string;
  sourceType?: string | null;
  sourceId?: string | null;
  actorAppUserId?: string | null;
  status: "SUCCESS" | "FAILED";
  startedAt: Date;
  completedAt: Date;
  usage: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; cachedInputTokens: number | null; thoughtsTokens: number | null } | null;
  errorCode: string | null;
}

/** Best-effort, never throws (Part 59): a transient usage-write failure
 * must never destroy an otherwise-successful AI business result, but the
 * gap is logged loudly server-side so it's not silently invisible. */
async function recordUsageEvent(input: RecordUsageInput): Promise<void> {
  try {
    const supabase = getServiceRoleClient();
    const { error } = await supabase.rpc("record_ai_usage_event", {
      p_organization_id: input.organizationId,
      p_task_key: input.task,
      p_provider: input.provider,
      p_model: input.model,
      p_status: input.status,
      p_started_at: input.startedAt.toISOString(),
      p_completed_at: input.completedAt.toISOString(),
      p_input_tokens: input.usage?.inputTokens ?? null,
      p_output_tokens: input.usage?.outputTokens ?? null,
      p_total_tokens: input.usage?.totalTokens ?? null,
      p_cached_input_tokens: input.usage?.cachedInputTokens ?? null,
      p_thoughts_tokens: input.usage?.thoughtsTokens ?? null,
      p_error_code: input.errorCode,
      p_source_type: input.sourceType ?? null,
      p_source_id: input.sourceId ?? null,
      p_actor_app_user_id: input.actorAppUserId ?? null,
      p_request_key: input.requestKey,
    });
    if (error) {
      console.error("[ai-usage] record_ai_usage_event failed", { requestKey: input.requestKey, task: input.task, message: error.message });
    }
  } catch (err) {
    console.error("[ai-usage] record_ai_usage_event threw", { requestKey: input.requestKey, task: input.task, err });
  }
}
