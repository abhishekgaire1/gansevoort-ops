import crypto from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { setupRpcTestFixtures, setupOtherOrgFixtures, type RpcTestFixtures, type OtherOrgFixtures } from "./testFixtures";
import { createDraftPurchaseDocumentWithLines, getLineKeys, findOrCreateThrowawaySpendCategory, findOrCreateNamedEmployee } from "./itemMasterTestHelpers";
import { approveLineClassificationNewItemRpc } from "@/app/lib/itemMaster/approveLineClassificationNewItemRpc";
import { approveLineClassificationExistingItemRpc } from "@/app/lib/itemMaster/approveLineClassificationExistingItemRpc";
import { correctDocumentDeliveryVerifierRpc } from "@/app/lib/itemMaster/correctDocumentDeliveryVerifierRpc";
import { recordReceiptRpc } from "@/app/lib/receiving/recordReceiptRpc";
import { submitPurchaseDocumentForVerificationRpc } from "@/app/lib/purchaseDocuments/submitPurchaseDocumentForVerificationRpc";
import { verifyPurchaseDocumentRpc } from "@/app/lib/purchaseDocuments/verifyPurchaseDocumentRpc";
import { postPurchaseDocumentInventoryRpc } from "@/app/lib/inventory/postingRpcs";

/**
 * The AUTHORITATIVE database posting-boundary guard for significant price
 * changes (trigger -> assert_price_review_acknowledged, 20260811100156/159).
 * MANUAL/ON-DEMAND (real Postgres). Proves a direct posting-RPC call cannot
 * bypass the check, that acknowledgment unblocks it, and that a stale
 * acknowledgment fails closed -- and that SKU/currency isolation prevents a
 * false baseline.
 */

let fx: RpcTestFixtures;
let otherOrg: OtherOrgFixtures;
let locationId: string;

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
  otherOrg = await setupOtherOrgFixtures(fx.supabase);
  const { data: loc } = await fx.supabase.from("locations").select("id").eq("organization_id", fx.organizationId).order("created_at", { ascending: true }).limit(1).single();
  locationId = loc!.id as string;
});

/** Build+verify a SAME_UNIT (LB) document at a chosen base-unit cost and
 * date, either creating a fresh item or reusing an existing item/sku. All
 * invoice facts (line_total, document_date) are set on the DRAFT before
 * submit -- a VERIFIED document's header/lines are locked. */
async function buildDoc(opts: { reuse?: { itemId: string; vendorSku: string }; unitCost: number; date: string; skuOverride?: string }): Promise<{ purchaseDocumentId: string; lineKey: string; itemId: string; vendorSku: string }> {
  const spendCategoryId = await findOrCreateThrowawaySpendCategory(fx.supabase, fx.organizationId);
  const categoryRow = (await fx.supabase.from("inventory_items").select("category_id").eq("id", fx.noRuleItemId).single()).data;
  const categoryId = categoryRow!.category_id as string;
  const deliveryVerifierEmployeeId = await findOrCreateNamedEmployee(fx.supabase, fx.organizationId, "TEST Delivery Verifier");
  const vendorSku = opts.skuOverride ?? opts.reuse?.vendorSku ?? `PG-${crypto.randomUUID().slice(0, 8)}`;

  const { purchaseDocumentId, documentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
    organizationId: fx.organizationId, vendorId: fx.vendorId, uploadedByAppUserId: fx.changeableEmployeeAppUserId,
    lines: [{ vendorSku, description: "PriceGuard", packageUnit: "LB", packageQuantity: 10 }],
  });
  const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);

  let itemId: string;
  if (opts.reuse) {
    await approveLineClassificationExistingItemRpc(fx.supabase, { purchaseDocumentId, lineKey, organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId, inventoryItemId: opts.reuse.itemId, rememberVendorMapping: false });
    itemId = opts.reuse.itemId;
  } else {
    const approved = await approveLineClassificationNewItemRpc(fx.supabase, { purchaseDocumentId, lineKey, organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId, finalName: `PriceGuard Item ${crypto.randomUUID().slice(0, 6)}`, disposition: "INVENTORY", categoryId, spendCategoryId, baseUnitCode: "LB", rememberVendorMapping: false });
    itemId = approved.inventoryItemId!;
  }

  await recordReceiptRpc(fx.supabase, {
    organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId, receiptKind: "DELIVERY", purchaseDocumentId,
    lines: [{ lineNumberSnapshot: 1, matchedLineKey: lineKey, vendorSkuSnapshot: vendorSku, descriptionSnapshot: "PriceGuard", invoicePackageQuantity: 10, invoicePackageUnit: "LB", invoiceMeasuredQuantity: null, invoiceMeasuredUnit: null, actualReceivedPackageQuantity: 10, actualReceivedPackageUnit: "LB", actualVerifiedBaseQuantity: null, actualVerifiedBaseUnitId: null, locationId }],
  });
  await correctDocumentDeliveryVerifierRpc(fx.supabase, { documentId, organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId, newEmployeeId: deliveryVerifierEmployeeId });
  // Set invoice facts on the DRAFT (before submit/verify lock them).
  await fx.supabase.from("purchase_document_lines").update({ line_total: opts.unitCost * 10 }).eq("purchase_document_id", purchaseDocumentId).eq("line_key", lineKey);
  await fx.supabase.from("purchase_documents").update({ document_date: opts.date }).eq("id", purchaseDocumentId);

  const submitted = await submitPurchaseDocumentForVerificationRpc(fx.supabase, { purchaseDocumentId, organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId, expectedVersion: 1 });
  await verifyPurchaseDocumentRpc(fx.supabase, { purchaseDocumentId, organizationId: fx.organizationId, appUserId: fx.lockedEmployeeAppUserId, expectedVersion: submitted.version });
  return { purchaseDocumentId, lineKey, itemId, vendorSku };
}

async function postPriorEvent(baseUnitCost: number): Promise<{ itemId: string; vendorSku: string; purchaseDocumentId: string }> {
  const doc = await buildDoc({ unitCost: baseUnitCost, date: "2026-01-01" });
  const posted = await postPurchaseDocumentInventoryRpc(fx.supabase, { purchaseDocumentId: doc.purchaseDocumentId, organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId });
  expect(posted.status).toBe("POSTED");
  return { itemId: doc.itemId, vendorSku: doc.vendorSku, purchaseDocumentId: doc.purchaseDocumentId };
}

async function buildCurrentDoc(itemId: string, vendorSku: string, unitCost: number): Promise<{ purchaseDocumentId: string; lineKey: string; currentUnitCost: number }> {
  const doc = await buildDoc({ reuse: { itemId, vendorSku }, unitCost, date: "2026-06-01", skuOverride: vendorSku });
  return { purchaseDocumentId: doc.purchaseDocumentId, lineKey: doc.lineKey, currentUnitCost: unitCost };
}

async function ack(purchaseDocumentId: string, lineKey: string, itemId: string, vendorSku: string, prevPd: string, prevCost: number, curCost: number, overrides: Record<string, unknown> = {}) {
  return fx.supabase.rpc("acknowledge_price_change", {
    p_organization_id: fx.organizationId, p_actor_app_user_id: fx.changeableEmployeeAppUserId, p_purchase_document_id: purchaseDocumentId, p_line_key: lineKey,
    p_inventory_item_id: itemId, p_vendor_id: fx.vendorId, p_vendor_sku: vendorSku, p_currency: "USD",
    p_previous_purchase_document_id: prevPd, p_previous_unit_cost: prevCost, p_current_unit_cost: curCost, p_delta_pct: ((curCost - prevCost) / prevCost) * 100,
    p_direction: curCost >= prevCost ? "increase" : "decrease", p_base_unit_code: "LB", p_normalized_base_quantity: 10, p_fingerprint: `fp-${crypto.randomUUID()}`, p_note: null, ...overrides,
  });
}

describe("posting-boundary price guard", () => {
  it("scenarios 28+30+33: the posting RPC rejects an unacknowledged +25% change, and posts once a valid acknowledgment exists", async () => {
    const prior = await postPriorEvent(2.0); // $2.00/LB posted
    const cur = await buildCurrentDoc(prior.itemId, prior.vendorSku, 2.5); // $2.50/LB = +25%

    // Direct posting-RPC call is blocked (GA079) -- not merely the action.
    await expect(
      postPurchaseDocumentInventoryRpc(fx.supabase, { purchaseDocumentId: cur.purchaseDocumentId, organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId })
    ).rejects.toThrow(/significant price change|GA079/i);

    const acked = await ack(cur.purchaseDocumentId, cur.lineKey, prior.itemId, prior.vendorSku, prior.purchaseDocumentId, 2.0, 2.5);
    expect(acked.error).toBeNull();

    const posted = await postPurchaseDocumentInventoryRpc(fx.supabase, { purchaseDocumentId: cur.purchaseDocumentId, organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId });
    expect(posted.status).toBe("POSTED");
  });

  it("scenario 29: a stale acknowledgment (recorded for a different current price) fails closed", async () => {
    const prior = await postPriorEvent(2.0);
    const cur = await buildCurrentDoc(prior.itemId, prior.vendorSku, 3.0); // +50%
    // Acknowledge the WRONG current price (2.5, not 3.0) -> stale vs recompute.
    await ack(cur.purchaseDocumentId, cur.lineKey, prior.itemId, prior.vendorSku, prior.purchaseDocumentId, 2.0, 2.5);
    await expect(
      postPurchaseDocumentInventoryRpc(fx.supabase, { purchaseDocumentId: cur.purchaseDocumentId, organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId })
    ).rejects.toThrow(/significant price change|GA079/i);
  });

  it("scenario 2: a different vendor SKU is not a comparable baseline -- no significant change, posts freely", async () => {
    const prior = await postPriorEvent(2.0);
    const cur = await buildCurrentDoc(prior.itemId, `DIFFERENT-${crypto.randomUUID().slice(0, 6)}`, 3.0); // +50% but different SKU
    const posted = await postPurchaseDocumentInventoryRpc(fx.supabase, { purchaseDocumentId: cur.purchaseDocumentId, organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId });
    expect(posted.status).toBe("POSTED");
  });

  it("scenario 45: cross-organization acknowledgment is rejected by the acknowledge RPC", async () => {
    const prior = await postPriorEvent(2.0);
    const cur = await buildCurrentDoc(prior.itemId, prior.vendorSku, 2.5);
    const res = await ack(cur.purchaseDocumentId, cur.lineKey, prior.itemId, prior.vendorSku, prior.purchaseDocumentId, 2.0, 2.5, { p_organization_id: otherOrg.organizationId });
    expect(res.error?.code).toBe("GA054");
  });
});
