import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * AI Configuration + Usage/Cost Tracking milestone -- the read model over
 * ai_usage_events (Part 44). Every aggregate is computed in Postgres
 * (get_ai_usage_* RPCs, migration 20260811100101) -- this file only
 * shapes rows into TypeScript, never loads raw events to sum client-side
 * (Part 34/69).
 *
 * totalCostUsd is always the SUM OF KNOWN costs (defaults to 0 when there
 * are zero events, via the RPC's own COALESCE) -- unknownCostRequestCount
 * is what actually distinguishes "genuinely $0" from "some/all requests
 * have no cost data" (Part 22/72). Callers must render both together,
 * never totalCostUsd alone.
 */

export interface AIUsageSummary {
  totalCostUsd: number;
  unknownCostRequestCount: number;
  totalRequests: number;
  successRequests: number;
  failedRequests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface AIUsageBreakdownRow {
  costUsd: number;
  unknownCostRequestCount: number;
  requestCount: number;
}

export interface AIUsageByTaskRow extends AIUsageBreakdownRow {
  taskKey: string;
}

export interface AIUsageByModelRow extends AIUsageBreakdownRow {
  provider: string;
  model: string;
}

export interface AIUsageByProviderRow extends AIUsageBreakdownRow {
  provider: string;
}

export interface AIUsageRecentRow {
  eventId: string;
  occurredAt: string;
  taskKey: string;
  provider: string;
  model: string;
  status: "SUCCESS" | "FAILED";
  costUsd: number | null;
  costKnown: boolean;
  sourceType: string | null;
  sourceId: string | null;
}

export interface AIUsageReport {
  summary: AIUsageSummary;
  byTask: AIUsageByTaskRow[];
  byModel: AIUsageByModelRow[];
  byProvider: AIUsageByProviderRow[];
  recent: AIUsageRecentRow[];
}

export async function getAIUsageReport(supabase: SupabaseClient, organizationId: string, periodStart: Date, periodEnd: Date): Promise<AIUsageReport> {
  const startIso = periodStart.toISOString();
  const endIso = periodEnd.toISOString();

  const [summaryRes, byTaskRes, byModelRes, byProviderRes, recentRes] = await Promise.all([
    supabase.rpc("get_ai_usage_summary", { p_organization_id: organizationId, p_period_start: startIso, p_period_end: endIso }),
    supabase.rpc("get_ai_usage_by_task", { p_organization_id: organizationId, p_period_start: startIso, p_period_end: endIso }),
    supabase.rpc("get_ai_usage_by_model", { p_organization_id: organizationId, p_period_start: startIso, p_period_end: endIso }),
    supabase.rpc("get_ai_usage_by_provider", { p_organization_id: organizationId, p_period_start: startIso, p_period_end: endIso }),
    supabase.rpc("get_ai_usage_recent", { p_organization_id: organizationId, p_period_start: startIso, p_period_end: endIso, p_limit: 50 }),
  ]);

  if (summaryRes.error) throw new Error(summaryRes.error.message);
  if (byTaskRes.error) throw new Error(byTaskRes.error.message);
  if (byModelRes.error) throw new Error(byModelRes.error.message);
  if (byProviderRes.error) throw new Error(byProviderRes.error.message);
  if (recentRes.error) throw new Error(recentRes.error.message);

  const summaryRow = (Array.isArray(summaryRes.data) ? summaryRes.data[0] : summaryRes.data) as
    | {
        out_total_cost_usd: number;
        out_unknown_cost_request_count: number;
        out_total_requests: number;
        out_success_requests: number;
        out_failed_requests: number;
        out_input_tokens: number;
        out_output_tokens: number;
        out_total_tokens: number;
      }
    | undefined;

  const summary: AIUsageSummary = {
    totalCostUsd: Number(summaryRow?.out_total_cost_usd ?? 0),
    unknownCostRequestCount: Number(summaryRow?.out_unknown_cost_request_count ?? 0),
    totalRequests: Number(summaryRow?.out_total_requests ?? 0),
    successRequests: Number(summaryRow?.out_success_requests ?? 0),
    failedRequests: Number(summaryRow?.out_failed_requests ?? 0),
    inputTokens: Number(summaryRow?.out_input_tokens ?? 0),
    outputTokens: Number(summaryRow?.out_output_tokens ?? 0),
    totalTokens: Number(summaryRow?.out_total_tokens ?? 0),
  };

  const byTask: AIUsageByTaskRow[] = ((byTaskRes.data ?? []) as { out_task_key: string; out_cost_usd: number; out_unknown_cost_request_count: number; out_request_count: number }[]).map((r) => ({
    taskKey: r.out_task_key,
    costUsd: Number(r.out_cost_usd),
    unknownCostRequestCount: Number(r.out_unknown_cost_request_count),
    requestCount: Number(r.out_request_count),
  }));

  const byModel: AIUsageByModelRow[] = ((byModelRes.data ?? []) as { out_provider: string; out_model: string; out_cost_usd: number; out_unknown_cost_request_count: number; out_request_count: number }[]).map((r) => ({
    provider: r.out_provider,
    model: r.out_model,
    costUsd: Number(r.out_cost_usd),
    unknownCostRequestCount: Number(r.out_unknown_cost_request_count),
    requestCount: Number(r.out_request_count),
  }));

  const byProvider: AIUsageByProviderRow[] = ((byProviderRes.data ?? []) as { out_provider: string; out_cost_usd: number; out_unknown_cost_request_count: number; out_request_count: number }[]).map((r) => ({
    provider: r.out_provider,
    costUsd: Number(r.out_cost_usd),
    unknownCostRequestCount: Number(r.out_unknown_cost_request_count),
    requestCount: Number(r.out_request_count),
  }));

  const recent: AIUsageRecentRow[] = (
    (recentRes.data ?? []) as {
      out_event_id: string;
      out_created_at: string;
      out_task_key: string;
      out_provider: string;
      out_model: string;
      out_status: "SUCCESS" | "FAILED";
      out_cost_usd: number | null;
      out_cost_known: boolean;
      out_source_type: string | null;
      out_source_id: string | null;
    }[]
  ).map((r) => ({
    eventId: r.out_event_id,
    occurredAt: r.out_created_at,
    taskKey: r.out_task_key,
    provider: r.out_provider,
    model: r.out_model,
    status: r.out_status,
    costUsd: r.out_cost_usd === null ? null : Number(r.out_cost_usd),
    costKnown: r.out_cost_known,
    sourceType: r.out_source_type,
    sourceId: r.out_source_id,
  }));

  return { summary, byTask, byModel, byProvider, recent };
}
