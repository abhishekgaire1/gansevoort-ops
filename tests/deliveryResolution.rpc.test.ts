import { beforeAll, describe, expect, it } from "vitest";
import { postPurchaseDocumentInventoryRpc } from "@/app/lib/inventory/postingRpcs";
import { DeliveryConflictError } from "@/app/lib/purchaseDocuments/errors";
import { setupRpcTestFixtures, type RpcTestFixtures } from "./testFixtures";
import { createVerifiedPostingDocument } from "./inventoryPostingTestHelpers";
import { ensureManagerAppUser } from "./itemMasterTestHelpers";

/**
 * MANUAL / ON-DEMAND (shared DEV DB). The append-only delivery-lineage
 * resolution model (20260811100173/100174) + posting consuming the shared
 * effective-delivery definition (100175): a resolved-DUPLICATE document posts
 * only the retained delivery's quantity; a resolved-SEPARATE document sums.
 */

let fx: RpcTestFixtures;
let locationId: string;
let manager: string;

async function lineage(pd: string): Promise<{ receiptIds: string[]; fingerprint: string }> {
  const eff = await fx.supabase.rpc("purchase_document_effective_delivery_receipts", { p_purchase_document_id: pd, p_organization_id: fx.organizationId });
  const fp = await fx.supabase.rpc("purchase_document_delivery_fingerprint", { p_purchase_document_id: pd, p_organization_id: fx.organizationId });
  return { receiptIds: (eff.data ?? []).map((r: { out_receipt_id: string }) => r.out_receipt_id).sort(), fingerprint: fp.data as string };
}

async function status(pd: string): Promise<string> {
  const { data } = await fx.supabase.rpc("purchase_document_delivery_status", { p_purchase_document_id: pd, p_organization_id: fx.organizationId });
  return data as string;
}

/** Deterministic effective quantity actually posted (sum of posting-line base
 * quantities) -- avoids the shared-DEV inventory_location_balances read-model
 * flakiness while proving the effective quantity. */
async function postedBaseQty(pd: string): Promise<number> {
  const { data: headers } = await fx.supabase.from("purchase_document_inventory_postings").select("id").eq("purchase_document_id", pd).eq("organization_id", fx.organizationId);
  const ids = (headers ?? []).map((h: { id: string }) => h.id);
  if (ids.length === 0) return 0;
  const { data: lines } = await fx.supabase.from("purchase_document_inventory_posting_lines").select("posted_base_quantity").in("posting_id", ids);
  return (lines ?? []).reduce((s: number, l: { posted_base_quantity: number }) => s + Number(l.posted_base_quantity), 0);
}

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
  const { data: location } = await fx.supabase.from("locations").select("id").eq("organization_id", fx.organizationId).limit(1).single();
  locationId = location!.id as string;
  manager = await ensureManagerAppUser(fx.supabase, fx.organizationId, "DeliveryResolver");
});

function ambiguousDoc(desc: string, qty: number) {
  return createVerifiedPostingDocument(
    fx.supabase,
    fx,
    locationId,
    [{ description: desc, receiving: { behavior: "SAME_UNIT", baseUnitCode: "PIECE", receivedQuantity: qty, receivedUnit: "PIECE" } }],
    { extraNullEventDeliveries: 1 },
  );
}

describe("delivery-lineage resolution", () => {
  it("duplicate resolution: posts only the retained delivery's quantity, exactly once", async () => {
    const doc = await ambiguousDoc("Dup Resolve", 30);
    expect(await status(doc.purchaseDocumentId)).toBe("AMBIGUOUS");
    await expect(
      postPurchaseDocumentInventoryRpc(fx.supabase, { purchaseDocumentId: doc.purchaseDocumentId, organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId }),
    ).rejects.toBeInstanceOf(DeliveryConflictError);

    const { receiptIds, fingerprint } = await lineage(doc.purchaseDocumentId);
    expect(receiptIds).toHaveLength(2);
    const res = await fx.supabase.rpc("resolve_delivery_lineage", {
      p_purchase_document_id: doc.purchaseDocumentId,
      p_organization_id: fx.organizationId,
      p_app_user_id: manager,
      p_expected_fingerprint: fingerprint,
      p_reason: "Same delivery entered twice",
      p_acknowledged: true,
      p_decisions: [
        { receiptId: receiptIds[0], decision: "CANONICAL", duplicateOfReceiptId: null },
        { receiptId: receiptIds[1], decision: "DUPLICATE", duplicateOfReceiptId: receiptIds[0] },
      ],
    });
    expect(res.error).toBeNull();
    expect(res.data[0].out_status).toBe("RESOLVED");
    expect(res.data[0].out_routed_to_correction).toBe(false);

    const posted = await postPurchaseDocumentInventoryRpc(fx.supabase, { purchaseDocumentId: doc.purchaseDocumentId, organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId });
    expect(posted.status).toBe("POSTED");
    expect(await postedBaseQty(doc.purchaseDocumentId)).toBe(30); // retained, not 60

    // Append-only + audited.
    const { data: rows } = await fx.supabase.from("delivery_resolutions").select("id, resolution_version").eq("purchase_document_id", doc.purchaseDocumentId);
    expect(rows).toHaveLength(1);
    const upd = await fx.supabase.from("delivery_resolutions").update({ reason: "x" }).eq("id", rows![0].id);
    expect(upd.error).not.toBeNull(); // append-only
    const { data: audit } = await fx.supabase.from("audit_events").select("id").eq("organization_id", fx.organizationId).eq("entity_id", doc.purchaseDocumentId).eq("action", "DELIVERY_LINEAGE_RESOLVED");
    expect((audit ?? []).length).toBeGreaterThan(0);
  });

  it("separate-delivery resolution: sums both retained deliveries and posts once", async () => {
    const doc = await ambiguousDoc("Sep Resolve", 20);
    const { receiptIds, fingerprint } = await lineage(doc.purchaseDocumentId);
    const res = await fx.supabase.rpc("resolve_delivery_lineage", {
      p_purchase_document_id: doc.purchaseDocumentId,
      p_organization_id: fx.organizationId,
      p_app_user_id: manager,
      p_expected_fingerprint: fingerprint,
      p_reason: "Two genuine deliveries",
      p_acknowledged: true,
      p_decisions: receiptIds.map((id) => ({ receiptId: id, decision: "CANONICAL", duplicateOfReceiptId: null })),
    });
    expect(res.error).toBeNull();
    const posted = await postPurchaseDocumentInventoryRpc(fx.supabase, { purchaseDocumentId: doc.purchaseDocumentId, organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId });
    expect(posted.status).toBe("POSTED");
    expect(await postedBaseQty(doc.purchaseDocumentId)).toBe(40); // 20 + 20 summed
  });

  it("rejects an incomplete resolution (a current lineage is missing)", async () => {
    const doc = await ambiguousDoc("Incomplete", 5);
    const { receiptIds, fingerprint } = await lineage(doc.purchaseDocumentId);
    const res = await fx.supabase.rpc("resolve_delivery_lineage", {
      p_purchase_document_id: doc.purchaseDocumentId, p_organization_id: fx.organizationId, p_app_user_id: manager,
      p_expected_fingerprint: fingerprint, p_reason: "partial", p_acknowledged: true,
      p_decisions: [{ receiptId: receiptIds[0], decision: "CANONICAL", duplicateOfReceiptId: null }],
    });
    expect(res.error?.code).toBe("GA033");
  });

  it("rejects an unauthorized (non-manager) actor", async () => {
    const doc = await ambiguousDoc("Unauth", 5);
    const { receiptIds, fingerprint } = await lineage(doc.purchaseDocumentId);
    const res = await fx.supabase.rpc("resolve_delivery_lineage", {
      p_purchase_document_id: doc.purchaseDocumentId, p_organization_id: fx.organizationId, p_app_user_id: fx.lockedEmployeeAppUserId,
      p_expected_fingerprint: fingerprint, p_reason: "nope", p_acknowledged: true,
      p_decisions: receiptIds.map((id) => ({ receiptId: id, decision: "CANONICAL", duplicateOfReceiptId: null })),
    });
    expect(res.error?.code).toBe("GA006");
  });

  it("rejects a stale resolution (fingerprint mismatch)", async () => {
    const doc = await ambiguousDoc("Stale", 5);
    const { receiptIds } = await lineage(doc.purchaseDocumentId);
    const res = await fx.supabase.rpc("resolve_delivery_lineage", {
      p_purchase_document_id: doc.purchaseDocumentId, p_organization_id: fx.organizationId, p_app_user_id: manager,
      p_expected_fingerprint: "stale-fingerprint", p_reason: "stale", p_acknowledged: true,
      p_decisions: receiptIds.map((id) => ({ receiptId: id, decision: "CANONICAL", duplicateOfReceiptId: null })),
    });
    expect(res.error?.code).toBe("GA002");
  });
});
