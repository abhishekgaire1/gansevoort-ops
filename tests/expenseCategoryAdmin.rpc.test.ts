import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { setupRpcTestFixtures, setupOtherOrgFixtures, type RpcTestFixtures, type OtherOrgFixtures } from "./testFixtures";

/**
 * MANUAL / ON-DEMAND ONLY -- see purchaseDocuments.rpc.test.ts's header.
 * Proves the expense-category admin RPCs (20260811100181): description
 * updates + audit, usage counts, catch-all explanation enforcement
 * (GA086), idempotent creation (GA014 on duplicate name), and cross-org
 * isolation (GA034).
 */

let fx: RpcTestFixtures;
let otherOrg: OtherOrgFixtures;

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
  otherOrg = await setupOtherOrgFixtures(fx.supabase);
});

function name() {
  return `TEST Expense ${randomUUID().slice(0, 8)}`;
}

async function createExpense(n: string): Promise<string> {
  const { data, error } = await fx.supabase.rpc("create_spend_category", { p_organization_id: fx.organizationId, p_app_user_id: fx.changeableEmployeeAppUserId, p_name: n });
  expect(error).toBeNull();
  return (data as { out_category_id: string }[])[0].out_category_id;
}

describe("update_spend_category_description", () => {
  it("stores the description and audits it", async () => {
    const id = await createExpense(name());
    const { error } = await fx.supabase.rpc("update_spend_category_description", {
      p_organization_id: fx.organizationId, p_actor_app_user_id: fx.changeableEmployeeAppUserId, p_category_id: id, p_description: "Delivery charges and fuel surcharges.",
    });
    expect(error).toBeNull();
    const { data: row } = await fx.supabase.from("spend_categories").select("description").eq("id", id).single();
    expect(row!.description).toBe("Delivery charges and fuel surcharges.");
    const { data: audit } = await fx.supabase.from("audit_events").select("action").eq("entity_id", id).eq("action", "SPEND_CATEGORY_DESCRIPTION_UPDATED").maybeSingle();
    expect(audit).not.toBeNull();
  });

  it("returns GA034 for a category in another organization", async () => {
    const id = await createExpense(name());
    const { error } = await fx.supabase.rpc("update_spend_category_description", {
      p_organization_id: otherOrg.organizationId, p_actor_app_user_id: fx.changeableEmployeeAppUserId, p_category_id: id, p_description: "x",
    });
    expect(error!.code).toBe("GA034");
  });
});

describe("create_spend_category idempotency", () => {
  it("rejects a duplicate name with GA014 (name is the stable key -- reruns create no duplicates)", async () => {
    const n = name();
    await createExpense(n);
    const { error } = await fx.supabase.rpc("create_spend_category", { p_organization_id: fx.organizationId, p_app_user_id: fx.changeableEmployeeAppUserId, p_name: `  ${n.toUpperCase()}  ` });
    expect(error!.code).toBe("GA014");
  });
});

describe("get_spend_category_usage_counts", () => {
  it("returns a count row shape and does not include an unused new category", async () => {
    const id = await createExpense(name());
    const { data, error } = await fx.supabase.rpc("get_spend_category_usage_counts", { p_organization_id: fx.organizationId });
    expect(error).toBeNull();
    const rows = data as { out_category_id: string; out_usage_count: number }[];
    expect(rows.find((r) => r.out_category_id === id)).toBeUndefined(); // no non-inventory items use it yet
  });
});

describe("set_line_classification_explanation", () => {
  it("rejects a blank explanation with GA086", async () => {
    const { error } = await fx.supabase.rpc("set_line_classification_explanation", {
      p_organization_id: fx.organizationId, p_actor_app_user_id: fx.changeableEmployeeAppUserId,
      p_purchase_document_id: randomUUID(), p_line_key: randomUUID(), p_explanation: "   ",
    });
    expect(error!.code).toBe("GA086");
  });
});
