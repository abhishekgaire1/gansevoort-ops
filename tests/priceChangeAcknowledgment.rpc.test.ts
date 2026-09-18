import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { setupRpcTestFixtures, setupOtherOrgFixtures, type RpcTestFixtures, type OtherOrgFixtures } from "./testFixtures";
import { createDraftPurchaseDocumentWithLines, getLineKeys } from "./itemMasterTestHelpers";

/**
 * Durable price-change acknowledgment (20260811100155): idempotency,
 * fingerprint invalidation, audit, org isolation. MANUAL/ON-DEMAND (real
 * Postgres) -- see purchaseDocuments.rpc.test.ts header.
 */

let fx: RpcTestFixtures;
let otherOrg: OtherOrgFixtures;

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
  otherOrg = await setupOtherOrgFixtures(fx.supabase);
});

async function makeDoc(): Promise<{ purchaseDocumentId: string; lineKey: string }> {
  const { data: vendor } = await fx.supabase.from("vendors").select("id").eq("organization_id", fx.organizationId).limit(1).single();
  const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
    organizationId: fx.organizationId,
    vendorId: vendor!.id as string,
    uploadedByAppUserId: fx.changeableEmployeeAppUserId,
  });
  const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);
  return { purchaseDocumentId, lineKey };
}

function ackArgs(purchaseDocumentId: string, lineKey: string, fingerprint: string, overrides: Record<string, unknown> = {}) {
  return {
    p_organization_id: fx.organizationId,
    p_actor_app_user_id: fx.changeableEmployeeAppUserId,
    p_purchase_document_id: purchaseDocumentId,
    p_line_key: lineKey,
    p_inventory_item_id: randomUUID(),
    p_vendor_id: randomUUID(),
    p_vendor_sku: "40",
    p_currency: "USD",
    p_previous_purchase_document_id: randomUUID(),
    p_previous_unit_cost: 1.66,
    p_current_unit_cost: 2.18,
    p_delta_pct: 31.3,
    p_direction: "increase",
    p_base_unit_code: "LB",
    p_normalized_base_quantity: 20,
    p_fingerprint: fingerprint,
    p_note: null,
    ...overrides,
  };
}

describe("acknowledge_price_change", () => {
  it("scenario 41+42: persists actor/timestamp/values and is idempotent -- repeated same fingerprint never duplicates", async () => {
    const { purchaseDocumentId, lineKey } = await makeDoc();
    const fp = `fp-${randomUUID()}`;

    const first = await fx.supabase.rpc("acknowledge_price_change", ackArgs(purchaseDocumentId, lineKey, fp));
    expect(first.error).toBeNull();
    const second = await fx.supabase.rpc("acknowledge_price_change", ackArgs(purchaseDocumentId, lineKey, fp));
    expect(second.error).toBeNull();

    const { data: rows } = await fx.supabase
      .from("price_change_acknowledgments")
      .select("id, actor_app_user_id, current_unit_cost, previous_unit_cost, delta_pct, direction, fingerprint")
      .eq("purchase_document_id", purchaseDocumentId)
      .eq("line_key", lineKey);
    expect(rows).toHaveLength(1);
    expect(rows![0].actor_app_user_id).toBe(fx.changeableEmployeeAppUserId);
    expect(Number(rows![0].current_unit_cost)).toBe(2.18);
    expect(rows![0].fingerprint).toBe(fp);

    // Audited exactly once (the second, identical call adds no audit noise).
    const { data: audits } = await fx.supabase
      .from("audit_events").select("id").eq("entity_id", purchaseDocumentId).eq("action", "PRICE_CHANGE_ACKNOWLEDGED");
    expect(audits!.length).toBe(1);
  });

  it("scenario 43: a new fingerprint replaces the row in place (re-review), old fingerprint no longer stored", async () => {
    const { purchaseDocumentId, lineKey } = await makeDoc();
    const oldFp = `old-${randomUUID()}`;
    const newFp = `new-${randomUUID()}`;
    await fx.supabase.rpc("acknowledge_price_change", ackArgs(purchaseDocumentId, lineKey, oldFp));
    await fx.supabase.rpc("acknowledge_price_change", ackArgs(purchaseDocumentId, lineKey, newFp, { p_current_unit_cost: 2.5, p_delta_pct: 50.6 }));

    const { data: rows } = await fx.supabase
      .from("price_change_acknowledgments").select("fingerprint, current_unit_cost").eq("purchase_document_id", purchaseDocumentId).eq("line_key", lineKey);
    expect(rows).toHaveLength(1);
    expect(rows![0].fingerprint).toBe(newFp);
    expect(Number(rows![0].current_unit_cost)).toBe(2.5);

    // list_price_change_acknowledgments returns the current one.
    const { data: listed } = await fx.supabase.rpc("list_price_change_acknowledgments", { p_organization_id: fx.organizationId, p_purchase_document_id: purchaseDocumentId });
    expect(listed).toHaveLength(1);
    expect((listed as { out_fingerprint: string }[])[0].out_fingerprint).toBe(newFp);
  });

  it("rejects an invalid direction and a blank fingerprint", async () => {
    const { purchaseDocumentId, lineKey } = await makeDoc();
    const bad = await fx.supabase.rpc("acknowledge_price_change", ackArgs(purchaseDocumentId, lineKey, "fp", { p_direction: "sideways" }));
    expect(bad.error?.code).toBe("GA033");
    const blank = await fx.supabase.rpc("acknowledge_price_change", ackArgs(purchaseDocumentId, lineKey, "   "));
    expect(blank.error?.code).toBe("GA033");
  });

  it("scenario 45: cross-organization acknowledgment is rejected (document not in caller org)", async () => {
    const { purchaseDocumentId, lineKey } = await makeDoc();
    const res = await fx.supabase.rpc("acknowledge_price_change", ackArgs(purchaseDocumentId, lineKey, "fp", { p_organization_id: otherOrg.organizationId }));
    expect(res.error).not.toBeNull();
    expect(res.error?.code).toBe("GA054");
  });
});
