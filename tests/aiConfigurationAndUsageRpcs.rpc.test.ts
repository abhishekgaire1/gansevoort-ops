import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { setupRpcTestFixtures, setupOtherOrgFixtures, type RpcTestFixtures, type OtherOrgFixtures } from "./testFixtures";

/**
 * MANUAL / ON-DEMAND ONLY -- see purchaseDocuments.rpc.test.ts's header
 * comment. Proves the AI Configuration + Usage/Cost Tracking milestone's
 * RPCs (20260811100101) against real Postgres: configuration
 * save/audit/precedence, usage-event idempotency, versioned pricing/cost
 * calculation, aggregation correctness, and cross-org isolation.
 */

let fx: RpcTestFixtures;
let otherOrg: OtherOrgFixtures;

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
  otherOrg = await setupOtherOrgFixtures(fx.supabase);
});

describe("set_ai_default_configuration / set_ai_task_configuration", () => {
  it("saves the organization default and audits AI_DEFAULT_CONFIGURATION_CHANGED with before/after", async () => {
    const { error } = await fx.supabase.rpc("set_ai_default_configuration", {
      p_organization_id: fx.organizationId,
      p_actor_app_user_id: fx.changeableEmployeeAppUserId,
      p_provider: "gemini",
      p_model: "gemini-3.6-flash",
    });
    expect(error).toBeNull();

    const { data: row } = await fx.supabase.from("organization_ai_settings").select("default_provider, default_model").eq("organization_id", fx.organizationId).single();
    expect(row).toMatchObject({ default_provider: "gemini", default_model: "gemini-3.6-flash" });

    const { error: error2 } = await fx.supabase.rpc("set_ai_default_configuration", {
      p_organization_id: fx.organizationId,
      p_actor_app_user_id: fx.changeableEmployeeAppUserId,
      p_provider: "gemini",
      p_model: "gemini-3.5-flash-lite",
    });
    expect(error2).toBeNull();

    const { data: audit } = await fx.supabase
      .from("audit_events")
      .select("before_state, after_state")
      .eq("organization_id", fx.organizationId)
      .eq("action", "AI_DEFAULT_CONFIGURATION_CHANGED")
      .order("occurred_at", { ascending: false })
      .limit(1)
      .single();
    expect(audit!.after_state).toMatchObject({ provider: "gemini", model: "gemini-3.5-flash-lite" });
    expect(audit!.before_state).toMatchObject({ provider: "gemini", model: "gemini-3.6-flash" });
  });

  it("a task override, when set, is what organization_ai_task_settings stores; 'Use Default' (both null) deletes the row", async () => {
    const { error } = await fx.supabase.rpc("set_ai_task_configuration", {
      p_organization_id: fx.organizationId,
      p_actor_app_user_id: fx.changeableEmployeeAppUserId,
      p_task_key: "ITEM_CLASSIFICATION",
      p_provider: "gemini",
      p_model: "gemini-3.5-flash-lite",
    });
    expect(error).toBeNull();

    let { data: row } = await fx.supabase
      .from("organization_ai_task_settings")
      .select("provider, model")
      .eq("organization_id", fx.organizationId)
      .eq("task_key", "ITEM_CLASSIFICATION")
      .maybeSingle();
    expect(row).toMatchObject({ provider: "gemini", model: "gemini-3.5-flash-lite" });

    const { error: clearError } = await fx.supabase.rpc("set_ai_task_configuration", {
      p_organization_id: fx.organizationId,
      p_actor_app_user_id: fx.changeableEmployeeAppUserId,
      p_task_key: "ITEM_CLASSIFICATION",
      p_provider: null,
      p_model: null,
    });
    expect(clearError).toBeNull();

    ({ data: row } = await fx.supabase.from("organization_ai_task_settings").select("provider, model").eq("organization_id", fx.organizationId).eq("task_key", "ITEM_CLASSIFICATION").maybeSingle());
    expect(row).toBeNull();
  });

  it("rejects an unsupported task key", async () => {
    const { error } = await fx.supabase.rpc("set_ai_task_configuration", {
      p_organization_id: fx.organizationId,
      p_actor_app_user_id: fx.changeableEmployeeAppUserId,
      p_task_key: "NOT_A_REAL_TASK",
      p_provider: "gemini",
      p_model: "gemini-3.6-flash",
    });
    expect(error).not.toBeNull();
  });
});

describe("record_ai_usage_event -- idempotency", () => {
  it("a duplicate request_key within the same organization inserts only ONE row and returns the SAME event id", async () => {
    const requestKey = `req-${randomUUID()}`;
    const startedAt = new Date().toISOString();
    const completedAt = new Date(Date.now() + 500).toISOString();

    const call = () =>
      fx.supabase.rpc("record_ai_usage_event", {
        p_organization_id: fx.organizationId,
        p_task_key: "INVOICE_EXTRACTION",
        p_provider: "gemini",
        p_model: "gemini-3.6-flash",
        p_status: "SUCCESS",
        p_started_at: startedAt,
        p_completed_at: completedAt,
        p_input_tokens: 100,
        p_output_tokens: 20,
        p_total_tokens: 120,
        p_cached_input_tokens: null,
        p_thoughts_tokens: null,
        p_error_code: null,
        p_source_type: "document_extraction",
        p_source_id: null,
        p_actor_app_user_id: fx.changeableEmployeeAppUserId,
        p_request_key: requestKey,
      });

    const first = await call();
    const second = await call();
    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    const firstId = (first.data as { out_event_id: string }[])[0].out_event_id;
    const secondId = (second.data as { out_event_id: string }[])[0].out_event_id;
    expect(secondId).toBe(firstId);

    const { count } = await fx.supabase.from("ai_usage_events").select("id", { count: "exact", head: true }).eq("organization_id", fx.organizationId).eq("request_key", requestKey);
    expect(count).toBe(1);
  });

  it("a genuinely different request_key (e.g. a retry attempt) records a SEPARATE row, never deduplicated away", async () => {
    const startedAt = new Date().toISOString();
    const completedAt = new Date(Date.now() + 100).toISOString();
    const base = {
      p_organization_id: fx.organizationId,
      p_task_key: "INVOICE_EXTRACTION" as const,
      p_provider: "gemini",
      p_model: "gemini-3.6-flash",
      p_started_at: startedAt,
      p_completed_at: completedAt,
      p_input_tokens: null,
      p_output_tokens: null,
      p_total_tokens: null,
      p_cached_input_tokens: null,
      p_thoughts_tokens: null,
      p_source_type: null,
      p_source_id: null,
      p_actor_app_user_id: fx.changeableEmployeeAppUserId,
    };

    const attempt1 = await fx.supabase.rpc("record_ai_usage_event", { ...base, p_status: "FAILED", p_error_code: "TIMEOUT", p_request_key: `attempt-1-${randomUUID()}` });
    const attempt2 = await fx.supabase.rpc("record_ai_usage_event", { ...base, p_status: "SUCCESS", p_error_code: null, p_request_key: `attempt-2-${randomUUID()}` });

    expect(attempt1.error).toBeNull();
    expect(attempt2.error).toBeNull();
    const id1 = (attempt1.data as { out_event_id: string }[])[0].out_event_id;
    const id2 = (attempt2.data as { out_event_id: string }[])[0].out_event_id;
    expect(id1).not.toBe(id2);
  });
});

describe("record_ai_usage_event -- versioned pricing / cost calculation", () => {
  it("computes cost from the pricing row effective at started_at, never a later or earlier one", async () => {
    const model = `test-versioned-model-${randomUUID().slice(0, 8)}`;

    await fx.supabase.from("ai_model_pricing").insert({
      provider: "gemini",
      model,
      effective_from: "2026-01-01T00:00:00Z",
      input_cost_per_million: 1_000_000, // $1 per token, deliberately large so the math is easy to check
      output_cost_per_million: 2_000_000, // $2 per token
    });
    await fx.supabase.from("ai_model_pricing").insert({
      provider: "gemini",
      model,
      effective_from: "2026-06-01T00:00:00Z",
      input_cost_per_million: 500_000, // $0.50 per token
      output_cost_per_million: 1_000_000, // $1 per token
    });

    // A call in March 2026 -- must use the JANUARY price, not the June one.
    const marchResult = await fx.supabase.rpc("record_ai_usage_event", {
      p_organization_id: fx.organizationId,
      p_task_key: "INVOICE_EXTRACTION",
      p_provider: "gemini",
      p_model: model,
      p_status: "SUCCESS",
      p_started_at: "2026-03-15T00:00:00Z",
      p_completed_at: "2026-03-15T00:00:01Z",
      p_input_tokens: 10,
      p_output_tokens: 5,
      p_total_tokens: 15,
      p_cached_input_tokens: null,
      p_thoughts_tokens: null,
      p_error_code: null,
      p_source_type: null,
      p_source_id: null,
      p_actor_app_user_id: fx.changeableEmployeeAppUserId,
      p_request_key: `march-${randomUUID()}`,
    });
    expect(marchResult.error).toBeNull();
    const marchId = (marchResult.data as { out_event_id: string }[])[0].out_event_id;
    const { data: marchRow } = await fx.supabase.from("ai_usage_events").select("estimated_cost_usd").eq("id", marchId).single();
    // 10 tokens * $1/tok + 5 tokens * $2/tok = $10 + $10 = $20
    expect(Number(marchRow!.estimated_cost_usd)).toBeCloseTo(20, 6);

    // A call in July 2026 -- must use the JUNE price.
    const julyResult = await fx.supabase.rpc("record_ai_usage_event", {
      p_organization_id: fx.organizationId,
      p_task_key: "INVOICE_EXTRACTION",
      p_provider: "gemini",
      p_model: model,
      p_status: "SUCCESS",
      p_started_at: "2026-07-15T00:00:00Z",
      p_completed_at: "2026-07-15T00:00:01Z",
      p_input_tokens: 10,
      p_output_tokens: 5,
      p_total_tokens: 15,
      p_cached_input_tokens: null,
      p_thoughts_tokens: null,
      p_error_code: null,
      p_source_type: null,
      p_source_id: null,
      p_actor_app_user_id: fx.changeableEmployeeAppUserId,
      p_request_key: `july-${randomUUID()}`,
    });
    const julyId = (julyResult.data as { out_event_id: string }[])[0].out_event_id;
    const { data: julyRow } = await fx.supabase.from("ai_usage_events").select("estimated_cost_usd").eq("id", julyId).single();
    // 10 tokens * $0.50/tok + 5 tokens * $1/tok = $5 + $5 = $10
    expect(Number(julyRow!.estimated_cost_usd)).toBeCloseTo(10, 6);
  });

  it("never fabricates a cost when no pricing row exists for the model -- estimated_cost_usd stays NULL, not 0", async () => {
    const unpricedModel = `test-unpriced-model-${randomUUID().slice(0, 8)}`;
    const result = await fx.supabase.rpc("record_ai_usage_event", {
      p_organization_id: fx.organizationId,
      p_task_key: "INVOICE_EXTRACTION",
      p_provider: "gemini",
      p_model: unpricedModel,
      p_status: "SUCCESS",
      p_started_at: new Date().toISOString(),
      p_completed_at: new Date().toISOString(),
      p_input_tokens: 100,
      p_output_tokens: 50,
      p_total_tokens: 150,
      p_cached_input_tokens: null,
      p_thoughts_tokens: null,
      p_error_code: null,
      p_source_type: null,
      p_source_id: null,
      p_actor_app_user_id: fx.changeableEmployeeAppUserId,
      p_request_key: `unpriced-${randomUUID()}`,
    });
    const id = (result.data as { out_event_id: string }[])[0].out_event_id;
    const { data: row } = await fx.supabase.from("ai_usage_events").select("estimated_cost_usd, pricing_id").eq("id", id).single();
    expect(row!.estimated_cost_usd).toBeNull();
    expect(row!.pricing_id).toBeNull();
  });

  it("never fabricates a cost when tokens are unavailable, even if pricing exists for the model", async () => {
    const model = `test-no-tokens-model-${randomUUID().slice(0, 8)}`;
    await fx.supabase.from("ai_model_pricing").insert({ provider: "gemini", model, effective_from: "2026-01-01T00:00:00Z", input_cost_per_million: 100, output_cost_per_million: 100 });

    const result = await fx.supabase.rpc("record_ai_usage_event", {
      p_organization_id: fx.organizationId,
      p_task_key: "INVOICE_EXTRACTION",
      p_provider: "gemini",
      p_model: model,
      p_status: "FAILED",
      p_started_at: new Date().toISOString(),
      p_completed_at: new Date().toISOString(),
      p_input_tokens: null,
      p_output_tokens: null,
      p_total_tokens: null,
      p_cached_input_tokens: null,
      p_thoughts_tokens: null,
      p_error_code: "PROVIDER_REQUEST_FAILED",
      p_source_type: null,
      p_source_id: null,
      p_actor_app_user_id: fx.changeableEmployeeAppUserId,
      p_request_key: `no-tokens-${randomUUID()}`,
    });
    const id = (result.data as { out_event_id: string }[])[0].out_event_id;
    const { data: row } = await fx.supabase.from("ai_usage_events").select("estimated_cost_usd").eq("id", id).single();
    expect(row!.estimated_cost_usd).toBeNull();
  });
});

describe("get_ai_usage_summary / by_task / by_model / by_provider -- aggregation + cross-org isolation", () => {
  it("aggregates only this organization's events within the period, and by-task/by-model totals reconcile with the summary's known-cost total", async () => {
    const model = `test-agg-model-${randomUUID().slice(0, 8)}`;
    await fx.supabase.from("ai_model_pricing").insert({ provider: "gemini", model, effective_from: "2026-01-01T00:00:00Z", input_cost_per_million: 1_000_000, output_cost_per_million: 1_000_000 });

    const periodStart = new Date("2026-05-01T00:00:00Z");
    const periodEnd = new Date("2026-05-02T00:00:00Z");
    const within = new Date("2026-05-01T12:00:00Z").toISOString();

    async function record(orgId: string, actorId: string, tokens: number, requestKey: string) {
      return fx.supabase.rpc("record_ai_usage_event", {
        p_organization_id: orgId,
        p_task_key: "INVOICE_EXTRACTION",
        p_provider: "gemini",
        p_model: model,
        p_status: "SUCCESS",
        p_started_at: within,
        p_completed_at: within,
        p_input_tokens: tokens,
        p_output_tokens: 0,
        p_total_tokens: tokens,
        p_cached_input_tokens: null,
        p_thoughts_tokens: null,
        p_error_code: null,
        p_source_type: null,
        p_source_id: null,
        p_actor_app_user_id: actorId,
        p_request_key: requestKey,
      });
    }

    await record(fx.organizationId, fx.changeableEmployeeAppUserId, 5, `agg-a-${randomUUID()}`); // $5
    await record(fx.organizationId, fx.changeableEmployeeAppUserId, 3, `agg-b-${randomUUID()}`); // $3
    await record(otherOrg.organizationId, otherOrg.appUserId, 1000, `agg-otherorg-${randomUUID()}`); // must never leak into fx.organizationId's totals

    const { data: summaryData, error: summaryError } = await fx.supabase.rpc("get_ai_usage_summary", {
      p_organization_id: fx.organizationId,
      p_period_start: periodStart.toISOString(),
      p_period_end: periodEnd.toISOString(),
    });
    expect(summaryError).toBeNull();
    const summary = (summaryData as { out_total_cost_usd: number; out_total_requests: number }[])[0];
    expect(Number(summary.out_total_cost_usd)).toBeCloseTo(8, 6);
    expect(Number(summary.out_total_requests)).toBe(2);

    const { data: byTaskData } = await fx.supabase.rpc("get_ai_usage_by_task", {
      p_organization_id: fx.organizationId,
      p_period_start: periodStart.toISOString(),
      p_period_end: periodEnd.toISOString(),
    });
    const invoiceExtractionRow = (byTaskData as { out_task_key: string; out_cost_usd: number }[]).find((r) => r.out_task_key === "INVOICE_EXTRACTION");
    expect(Number(invoiceExtractionRow!.out_cost_usd)).toBeCloseTo(8, 6);

    const { data: byModelData } = await fx.supabase.rpc("get_ai_usage_by_model", {
      p_organization_id: fx.organizationId,
      p_period_start: periodStart.toISOString(),
      p_period_end: periodEnd.toISOString(),
    });
    const modelRow = (byModelData as { out_model: string; out_cost_usd: number }[]).find((r) => r.out_model === model);
    expect(Number(modelRow!.out_cost_usd)).toBeCloseTo(8, 6);
  });

  it("a request outside the period is excluded", async () => {
    const requestKey = `outside-period-${randomUUID()}`;
    await fx.supabase.rpc("record_ai_usage_event", {
      p_organization_id: fx.organizationId,
      p_task_key: "ITEM_CLASSIFICATION",
      p_provider: "gemini",
      p_model: "gemini-3.6-flash",
      p_status: "SUCCESS",
      p_started_at: "2020-01-01T00:00:00Z",
      p_completed_at: "2020-01-01T00:00:00Z",
      p_input_tokens: null,
      p_output_tokens: null,
      p_total_tokens: null,
      p_cached_input_tokens: null,
      p_thoughts_tokens: null,
      p_error_code: null,
      p_source_type: null,
      p_source_id: null,
      p_actor_app_user_id: fx.changeableEmployeeAppUserId,
      p_request_key: requestKey,
    });

    const { data: recentData } = await fx.supabase.rpc("get_ai_usage_recent", {
      p_organization_id: fx.organizationId,
      p_period_start: "2026-01-01T00:00:00Z",
      p_period_end: "2026-01-02T00:00:00Z",
      p_limit: 50,
    });
    expect((recentData as { out_event_id: string }[]).length).toBe(0);
  });
});
