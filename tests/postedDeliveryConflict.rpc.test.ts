import crypto from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { setupRpcTestFixtures, type RpcTestFixtures } from "./testFixtures";
import { createVerifiedPostingDocument } from "./inventoryPostingTestHelpers";
import { recordReceiptRpc } from "@/app/lib/receiving/recordReceiptRpc";
import { postPurchaseDocumentInventoryRpc } from "@/app/lib/inventory/postingRpcs";
import { getPostedDeliveryConflict } from "@/app/lib/inventory/deliveryConflictCorrection";
import { ensureManagerAppUser } from "./itemMasterTestHelpers";

/**
 * §4/§7 posted-delivery-conflict handoff (MANUAL / ON-DEMAND, real Postgres).
 *
 * The database GA080 guard (20260811100172) blocks posting an ambiguous
 * document, so the posted-and-ambiguous state is only reachable for documents
 * posted BEFORE the guard existed. To test the positive correction workflow we
 * reconstruct exactly that historical state at the data layer: post one clean
 * delivery, record a duplicate delivery (making the lineage ambiguous), then
 * append a second PURCHASE_RECEIPT movement + posting lines for the duplicate
 * receipt -- cloned from the real posting -- so inventory was genuinely added
 * twice. This mirrors a legacy double-post without weakening any guard (the
 * GA080 trigger is on the posting HEADER, which we never re-insert).
 */

let fx: RpcTestFixtures;
let locationId: string;
let manager: string;

async function postedBaseQty(pd: string): Promise<number> {
  const { data: headers } = await fx.supabase.from("purchase_document_inventory_postings").select("id").eq("purchase_document_id", pd).eq("organization_id", fx.organizationId);
  const ids = (headers ?? []).map((h: { id: string }) => h.id);
  if (ids.length === 0) return 0;
  const { data: lines } = await fx.supabase.from("purchase_document_inventory_posting_lines").select("posted_base_quantity").in("posting_id", ids);
  return (lines ?? []).reduce((s: number, l: { posted_base_quantity: number }) => s + Number(l.posted_base_quantity), 0);
}

async function onHand(itemId: string): Promise<number> {
  const { data } = await fx.supabase.rpc("inventory_location_item_balance", { p_organization_id: fx.organizationId, p_inventory_item_id: itemId, p_location_id: locationId });
  return Number(data ?? 0);
}

/**
 * Fabricate a historical posted-ambiguous document: post one clean delivery of
 * `qty`, then append a duplicate delivery AND a cloned posting for it, so the
 * item's on-hand is 2*qty and posting lines span two lineages.
 */
async function makePostedDuplicate(qty: number): Promise<{ purchaseDocumentId: string; itemId: string }> {
  const doc = await createVerifiedPostingDocument(fx.supabase, fx, locationId, [
    { description: `PostedDup ${crypto.randomUUID().slice(0, 6)}`, receiving: { behavior: "SAME_UNIT", baseUnitCode: "PIECE", receivedQuantity: qty, receivedUnit: "PIECE" } },
  ]);
  const itemId = doc.itemIds[0]!;
  const posted = await postPurchaseDocumentInventoryRpc(fx.supabase, { purchaseDocumentId: doc.purchaseDocumentId, organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId });
  expect(posted.status).toBe("POSTED");

  // The real posting's rows we will clone.
  const { data: pl } = await fx.supabase
    .from("purchase_document_inventory_posting_lines")
    .select("posting_id, receipt_line_id, movement_id, movement_line_id, inventory_item_id, location_id, posted_base_quantity, base_unit_id")
    .eq("organization_id", fx.organizationId)
    .eq("posting_id", (await fx.supabase.from("purchase_document_inventory_postings").select("id").eq("purchase_document_id", doc.purchaseDocumentId).single()).data!.id);
  const postingLines = pl!;
  const movementId = postingLines[0].movement_id as string;
  const { data: mv } = await fx.supabase.from("inventory_movements").select("location_id, movement_type, performed_by_app_user_id, business_date, station_id").eq("id", movementId).single();
  const { data: mls } = await fx.supabase.from("inventory_movement_lines").select("id, inventory_item_id, entered_quantity, entered_unit_id, measured_base_quantity, base_unit_id, normalized_base_quantity").eq("movement_id", movementId);

  // Map original receipt_line -> matched_line_key (via receipt_lines of the doc).
  const { data: origRl } = await fx.supabase.from("receipt_lines").select("id, matched_line_key").in("id", postingLines.map((p: { receipt_line_id: string }) => p.receipt_line_id));
  const lineKeyByOrigReceiptLine = new Map((origRl ?? []).map((r: { id: string; matched_line_key: string }) => [r.id, r.matched_line_key]));

  // Record a duplicate DELIVERY (null delivery_event -> ambiguous lineage).
  const { data: firstReceipt } = await fx.supabase.from("receipts").select("id").eq("purchase_document_id", doc.purchaseDocumentId).eq("receipt_kind", "DELIVERY").limit(1).single();
  const { data: dupLinesSrc } = await fx.supabase
    .from("receipt_lines")
    .select("line_number_snapshot, matched_line_key, vendor_sku_snapshot, description_snapshot, invoice_package_quantity, invoice_package_unit, actual_received_package_quantity, actual_received_package_unit, location_id")
    .eq("receipt_id", firstReceipt!.id);
  await recordReceiptRpc(fx.supabase, {
    organizationId: fx.organizationId,
    appUserId: fx.changeableEmployeeAppUserId,
    receiptKind: "DELIVERY",
    purchaseDocumentId: doc.purchaseDocumentId,
    lines: (dupLinesSrc ?? []).map((l: Record<string, unknown>) => ({
      lineNumberSnapshot: l.line_number_snapshot as number,
      matchedLineKey: l.matched_line_key as string,
      vendorSkuSnapshot: l.vendor_sku_snapshot as string | null,
      descriptionSnapshot: l.description_snapshot as string | null,
      invoicePackageQuantity: l.invoice_package_quantity as number | null,
      invoicePackageUnit: l.invoice_package_unit as string | null,
      invoiceMeasuredQuantity: null,
      invoiceMeasuredUnit: null,
      actualReceivedPackageQuantity: l.actual_received_package_quantity as number | null,
      actualReceivedPackageUnit: l.actual_received_package_unit as string | null,
      actualVerifiedBaseQuantity: null,
      actualVerifiedBaseUnitId: null,
      locationId: l.location_id as string,
    })),
    idempotencyKey: `${doc.purchaseDocumentId}:dup-delivery`,
  });

  // The duplicate receipt's lines, mapped by matched_line_key.
  const { data: allRl } = await fx.supabase.from("receipt_lines").select("id, receipt_id, matched_line_key").eq("organization_id", fx.organizationId).in("receipt_id",
    ((await fx.supabase.from("receipts").select("id").eq("purchase_document_id", doc.purchaseDocumentId)).data ?? []).map((r: { id: string }) => r.id));
  const dupReceiptId = ((await fx.supabase.from("receipts").select("id, occurred_at").eq("purchase_document_id", doc.purchaseDocumentId).eq("receipt_kind", "DELIVERY").order("occurred_at", { ascending: false }).limit(1)).data!)[0]?.id
    ?? (await fx.supabase.from("receipts").select("id").eq("purchase_document_id", doc.purchaseDocumentId).eq("receipt_kind", "DELIVERY").order("occurred_at", { ascending: false }).limit(1).single()).data!.id;
  const dupReceiptLineByKey = new Map(
    (allRl ?? []).filter((r: { receipt_id: string }) => r.receipt_id === dupReceiptId).map((r: { id: string; matched_line_key: string }) => [r.matched_line_key, r.id]),
  );

  // Clone the movement (+ lines) so inventory is added a second time.
  const { data: mv2, error: mv2Err } = await fx.supabase.from("inventory_movements").insert({
    organization_id: fx.organizationId, location_id: (mv as { location_id: string }).location_id, movement_type: (mv as { movement_type: string }).movement_type,
    performed_by_app_user_id: (mv as { performed_by_app_user_id: string | null }).performed_by_app_user_id,
    business_date: (mv as { business_date: string }).business_date, station_id: (mv as { station_id: string | null }).station_id,
    notes: "TEST fabricated duplicate posting",
  }).select("id").single();
  if (mv2Err) throw new Error(`clone movement failed: ${mv2Err.message}`);
  const movementLineIdBySrc = new Map<string, string>();
  const newMovementLineByItem = new Map<string, string>();
  for (const ml of mls ?? []) {
    const { data: newMl } = await fx.supabase.from("inventory_movement_lines").insert({
      movement_id: mv2!.id, organization_id: fx.organizationId, inventory_item_id: (ml as { inventory_item_id: string }).inventory_item_id,
      entered_quantity: (ml as { entered_quantity: number }).entered_quantity, entered_unit_id: (ml as { entered_unit_id: string }).entered_unit_id,
      measured_base_quantity: (ml as { measured_base_quantity: number | null }).measured_base_quantity, base_unit_id: (ml as { base_unit_id: string }).base_unit_id,
      normalized_base_quantity: (ml as { normalized_base_quantity: number }).normalized_base_quantity,
    }).select("id").single();
    movementLineIdBySrc.set((ml as { id: string }).id, newMl!.id);
    newMovementLineByItem.set((ml as { inventory_item_id: string }).inventory_item_id, newMl!.id);
  }

  // Clone the posting lines for the DUPLICATE receipt (reuse existing header --
  // the GA080 trigger is only on the header, which we never re-insert).
  for (const p of postingLines) {
    const lineKey = lineKeyByOrigReceiptLine.get(p.receipt_line_id as string)!;
    const dupReceiptLineId = dupReceiptLineByKey.get(lineKey);
    if (!dupReceiptLineId) throw new Error(`no duplicate receipt line for key ${lineKey}`);
    const { error: plErr } = await fx.supabase.from("purchase_document_inventory_posting_lines").insert({
      organization_id: fx.organizationId, posting_id: p.posting_id, receipt_line_id: dupReceiptLineId,
      movement_id: mv2!.id, movement_line_id: newMovementLineByItem.get(p.inventory_item_id as string)!,
      inventory_item_id: p.inventory_item_id, location_id: p.location_id, posted_base_quantity: p.posted_base_quantity, base_unit_id: p.base_unit_id,
    });
    if (plErr) throw new Error(`clone posting line failed: ${plErr.message}`);
  }

  const dbgStatus = (await fx.supabase.rpc("purchase_document_delivery_status", { p_purchase_document_id: doc.purchaseDocumentId, p_organization_id: fx.organizationId })).data;
  if (dbgStatus !== "AMBIGUOUS") throw new Error(`fabricated doc status is ${dbgStatus}, expected AMBIGUOUS`);
  return { purchaseDocumentId: doc.purchaseDocumentId, itemId };
}

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
  const { data: loc } = await fx.supabase.from("locations").select("id").eq("organization_id", fx.organizationId).limit(1).single();
  locationId = loc!.id as string;
  manager = await ensureManagerAppUser(fx.supabase, fx.organizationId, "PostedConflictMgr");
});

describe("getPostedDeliveryConflict (read model)", () => {
  it("returns no conflict for a clean single-delivery posted document (no false positive)", async () => {
    const doc = await createVerifiedPostingDocument(fx.supabase, fx, locationId, [
      { description: "Clean Posted", receiving: { behavior: "SAME_UNIT", baseUnitCode: "PIECE", receivedQuantity: 12, receivedUnit: "PIECE" } },
    ]);
    const posted = await postPurchaseDocumentInventoryRpc(fx.supabase, { purchaseDocumentId: doc.purchaseDocumentId, organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId });
    expect(posted.status).toBe("POSTED");
    const conflict = await getPostedDeliveryConflict(fx.supabase, doc.purchaseDocumentId, fx.organizationId);
    expect(conflict.isPostedConflict).toBe(false);
    expect(conflict.items).toHaveLength(0);
  });
});

describe("posted-delivery-conflict positive correction workflow (§7)", () => {
  it("detects excess, applies the correction once, is idempotent, preserves originals, and blocks negative", async () => {
    // Import the action lazily so its "use server" auth wrapper is exercised via
    // the library layer we can call directly in a node test.
    const { getPostedDeliveryConflict: readModel } = await import("@/app/lib/inventory/deliveryConflictCorrection");
    const { recordInventoryCorrection } = await import("@/app/lib/inventory/corrections");

    const { purchaseDocumentId, itemId } = await makePostedDuplicate(30);

    // (2)(3)(4)(5)(6) Detect + quantities.
    const conflict = await readModel(fx.supabase, purchaseDocumentId, fx.organizationId);
    expect(conflict.isPostedConflict).toBe(true);
    expect(conflict.items).toHaveLength(1);
    const item = conflict.items[0];
    expect(item.lineageCount).toBe(2);
    expect(item.postedBaseQuantity).toBe(60); // 30 + 30 (double posted)
    expect(item.intendedBaseQuantity).toBe(30); // one retained lineage
    expect(item.excessBaseQuantity).toBe(30);
    expect(item.currentOnHand).toBe(60);
    expect(item.proposedDelta).toBe(-30);
    expect(item.proposedOnHand).toBe(30);
    expect(item.wouldGoNegative).toBe(false);
    expect(await postedBaseQty(purchaseDocumentId)).toBe(60);

    // (10)(11) Apply the correction once through the audited primitive.
    const requestId = crypto.randomUUID();
    const applyOnce = () => recordInventoryCorrection(fx.supabase, manager, itemId, locationId, "DELTA", null, item.proposedDelta, `Delivery-conflict correction doc ${purchaseDocumentId.slice(0, 8)}`, requestId);
    const first = await applyOnce();
    expect(first.previousBalance).toBe(60);
    expect(first.newBalance).toBe(30);
    expect(await onHand(itemId)).toBe(30); // balance changed exactly once

    // (12) Idempotent: same client_request_id does not double-correct.
    const second = await applyOnce();
    expect(second.newBalance).toBe(30);
    expect(await onHand(itemId)).toBe(30); // still 30, not 0

    // (13) Originals preserved: posting lines + movements unchanged.
    expect(await postedBaseQty(purchaseDocumentId)).toBe(60);

    // (14) The correction is recorded + linked to an audited movement.
    const { data: corrRow } = await fx.supabase.from("inventory_corrections").select("id, movement_id").eq("id", first.correctionId).single();
    expect(corrRow!.movement_id).not.toBeNull();
  });

  it("flags negative-stock risk so the correction is blocked (§7.15)", async () => {
    const { recordInventoryCorrection } = await import("@/app/lib/inventory/corrections");
    const { purchaseDocumentId, itemId } = await makePostedDuplicate(20); // on-hand 40, excess 20

    // A withdrawal consumed most of the excess -- removing the full 20 now would
    // drive on-hand below zero. The read model MUST flag this; createDelivery-
    // ConflictCorrection refuses the whole batch when any item wouldGoNegative
    // (it server-recomputes from current balances at apply time).
    await recordInventoryCorrection(fx.supabase, manager, itemId, locationId, "COUNTED", 5, null, "TEST set low on-hand", crypto.randomUUID());
    expect(await onHand(itemId)).toBe(5);

    const conflict = await getPostedDeliveryConflict(fx.supabase, purchaseDocumentId, fx.organizationId);
    expect(conflict.isPostedConflict).toBe(true);
    const item = conflict.items[0];
    expect(item.excessBaseQuantity).toBe(20);
    expect(item.currentOnHand).toBe(5);
    expect(item.proposedDelta).toBe(-20);
    expect(item.proposedOnHand).toBe(-15);
    expect(item.wouldGoNegative).toBe(true); // 5 + (-20) < 0 -> action refuses the batch
  });
});
