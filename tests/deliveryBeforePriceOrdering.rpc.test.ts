import crypto from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { setupRpcTestFixtures, type RpcTestFixtures } from "./testFixtures";
import { createDraftPurchaseDocumentWithLines, getLineKeys, findOrCreateThrowawaySpendCategory, findOrCreateNamedEmployee } from "./itemMasterTestHelpers";
import { approveLineClassificationNewItemRpc } from "@/app/lib/itemMaster/approveLineClassificationNewItemRpc";
import { approveLineClassificationExistingItemRpc } from "@/app/lib/itemMaster/approveLineClassificationExistingItemRpc";
import { correctDocumentDeliveryVerifierRpc } from "@/app/lib/itemMaster/correctDocumentDeliveryVerifierRpc";
import { recordReceiptRpc } from "@/app/lib/receiving/recordReceiptRpc";
import { submitPurchaseDocumentForVerificationRpc } from "@/app/lib/purchaseDocuments/submitPurchaseDocumentForVerificationRpc";
import { verifyPurchaseDocumentRpc } from "@/app/lib/purchaseDocuments/verifyPurchaseDocumentRpc";
import { postPurchaseDocumentInventoryRpc } from "@/app/lib/inventory/postingRpcs";
import { DeliveryConflictError, PriceReviewRequiredError } from "@/app/lib/purchaseDocuments/errors";

/**
 * §3 ordering proof (MANUAL / ON-DEMAND, real Postgres): when a document is BOTH
 * ambiguous (duplicate delivery lineage) AND carries a significant price change,
 * the delivery-lineage guard (GA080) must fire BEFORE the price-review guard
 * (GA079). A manager must never be asked to acknowledge a price computed from
 * ambiguous/duplicated quantities. The database triggers enforce this by name
 * ordering (assert_delivery_lineage_before_posting < assert_price_review_before_
 * posting); this proves the observable behavior end to end.
 */

let fx: RpcTestFixtures;
let locationId: string;

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
  const { data: loc } = await fx.supabase.from("locations").select("id").eq("organization_id", fx.organizationId).order("created_at", { ascending: true }).limit(1).single();
  locationId = loc!.id as string;
});

async function buildDoc(opts: { reuse?: { itemId: string; vendorSku: string }; unitCost: number; date: string; ambiguous?: boolean }): Promise<{ purchaseDocumentId: string; lineKey: string; itemId: string; vendorSku: string }> {
  const spendCategoryId = await findOrCreateThrowawaySpendCategory(fx.supabase, fx.organizationId);
  const categoryId = (await fx.supabase.from("inventory_items").select("category_id").eq("id", fx.noRuleItemId).single()).data!.category_id as string;
  const deliveryVerifierEmployeeId = await findOrCreateNamedEmployee(fx.supabase, fx.organizationId, "TEST Delivery Verifier");
  const vendorSku = opts.reuse?.vendorSku ?? `ORD-${crypto.randomUUID().slice(0, 8)}`;
  const runTag = crypto.randomUUID().slice(0, 8);

  const { purchaseDocumentId, documentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
    organizationId: fx.organizationId, vendorId: fx.vendorId, uploadedByAppUserId: fx.changeableEmployeeAppUserId,
    lines: [{ vendorSku, description: "Ordering", packageUnit: "LB", packageQuantity: 10 }],
  });
  const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);

  let itemId: string;
  if (opts.reuse) {
    await approveLineClassificationExistingItemRpc(fx.supabase, { purchaseDocumentId, lineKey, organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId, inventoryItemId: opts.reuse.itemId, rememberVendorMapping: false });
    itemId = opts.reuse.itemId;
  } else {
    const approved = await approveLineClassificationNewItemRpc(fx.supabase, { purchaseDocumentId, lineKey, organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId, finalName: `Ordering Item ${crypto.randomUUID().slice(0, 6)}`, disposition: "INVENTORY", categoryId, spendCategoryId, baseUnitCode: "LB", rememberVendorMapping: false });
    itemId = approved.inventoryItemId!;
  }

  const deliveryLine = { lineNumberSnapshot: 1, matchedLineKey: lineKey, vendorSkuSnapshot: vendorSku, descriptionSnapshot: "Ordering", invoicePackageQuantity: 10, invoicePackageUnit: "LB", invoiceMeasuredQuantity: null, invoiceMeasuredUnit: null, actualReceivedPackageQuantity: 10, actualReceivedPackageUnit: "LB", actualVerifiedBaseQuantity: null, actualVerifiedBaseUnitId: null, locationId };
  await recordReceiptRpc(fx.supabase, { organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId, receiptKind: "DELIVERY", purchaseDocumentId, lines: [deliveryLine], idempotencyKey: `${runTag}:d0` });
  if (opts.ambiguous) {
    // A second null-event DELIVERY of the same line -> ambiguous lineage.
    await recordReceiptRpc(fx.supabase, { organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId, receiptKind: "DELIVERY", purchaseDocumentId, lines: [deliveryLine], idempotencyKey: `${runTag}:d1` });
  }
  await correctDocumentDeliveryVerifierRpc(fx.supabase, { documentId, organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId, newEmployeeId: deliveryVerifierEmployeeId });
  await fx.supabase.from("purchase_document_lines").update({ line_total: opts.unitCost * 10 }).eq("purchase_document_id", purchaseDocumentId).eq("line_key", lineKey);
  await fx.supabase.from("purchase_documents").update({ document_date: opts.date }).eq("id", purchaseDocumentId);

  const submitted = await submitPurchaseDocumentForVerificationRpc(fx.supabase, { purchaseDocumentId, organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId, expectedVersion: 1 });
  await verifyPurchaseDocumentRpc(fx.supabase, { purchaseDocumentId, organizationId: fx.organizationId, appUserId: fx.lockedEmployeeAppUserId, expectedVersion: submitted.version });
  return { purchaseDocumentId, lineKey, itemId, vendorSku };
}

describe("GA080 (delivery) is enforced before GA079 (price) at the posting boundary", () => {
  it("an ambiguous document with a significant price change is rejected with GA080, not GA079", async () => {
    // Establish a $2.00/LB baseline so the current doc is a clear +25% change.
    const prior = await buildDoc({ unitCost: 2.0, date: "2026-01-01" });
    const posted = await postPurchaseDocumentInventoryRpc(fx.supabase, { purchaseDocumentId: prior.purchaseDocumentId, organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId });
    expect(posted.status).toBe("POSTED");

    // Current doc: SAME item/sku at $2.50/LB (+25%, significant) AND ambiguous.
    const cur = await buildDoc({ reuse: { itemId: prior.itemId, vendorSku: prior.vendorSku }, unitCost: 2.5, date: "2026-06-01", ambiguous: true });

    let caught: unknown;
    try {
      await postPurchaseDocumentInventoryRpc(fx.supabase, { purchaseDocumentId: cur.purchaseDocumentId, organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId });
    } catch (e) {
      caught = e;
    }
    // Delivery ambiguity must win: GA080, never GA079.
    expect(caught).toBeInstanceOf(DeliveryConflictError);
    expect(caught).not.toBeInstanceOf(PriceReviewRequiredError);

    // Nothing posted.
    const { count } = await fx.supabase.from("purchase_document_inventory_postings").select("id", { count: "exact", head: true }).eq("purchase_document_id", cur.purchaseDocumentId);
    expect(count ?? 0).toBe(0);
  });
});
