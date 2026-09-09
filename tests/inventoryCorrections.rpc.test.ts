import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { setupRpcTestFixtures, setupOtherOrgFixtures, type RpcTestFixtures } from "./testFixtures";
import { createVerifiedPostingDocument } from "./inventoryPostingTestHelpers";
import { recordInventoryCorrection } from "@/app/lib/inventory/corrections";
import { setVendorPurchasePackage, listReceiptsUsingVendorPackage, correctReceiptPackageFactor } from "@/app/lib/admin/vendorPackages";
import { InvalidCorrectionInputError } from "@/app/lib/inventory/errors";
import { postPurchaseDocumentInventoryRpc } from "@/app/lib/inventory/postingRpcs";

/**
 * MANUAL / ON-DEMAND ONLY -- see adminItemMaster.rpc.test.ts's header
 * comment (same convention).
 *
 * Safe editing of confirmed items -- the two new inventory-affecting
 * correction RPCs: record_inventory_correction (generic "Adjust
 * Inventory," 20260811100141) and correct_receipt_package_factor (the
 * flagship "correct inventory from previous receipts" workflow,
 * 20260811100142). Every successful call here permanently writes to
 * append-only tables (inventory_movements, inventory_movement_lines,
 * inventory_corrections, audit_events) in the linked dev database, same
 * documented tradeoff every other posting/withdrawal .rpc.test.ts file
 * already accepts. Covers spec tests #7, #8, #9, #10, #11, #19, #24, #25.
 */

let fx: RpcTestFixtures;
let locationId: string;

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
  const { data: location } = await fx.supabase.from("locations").select("id").eq("organization_id", fx.organizationId).limit(1).single();
  locationId = location!.id as string;
});

/**
 * Scalar exact-balance read, deliberately NOT the shared getLocationBalance
 * helper (inventoryPostingTestHelpers.ts): that helper calls the set-
 * returning inventory_location_balances(p_organization_id), which returns
 * EVERY item/location combination for the whole organization with no
 * filter or pagination -- PostgREST's default row cap (1000) silently
 * truncates it once the shared "TEST RPC Fixture Org" (reused across
 * every .rpc.test.ts file, in this session and every prior one) has
 * enough historical activity, which it now does. This intermittently
 * dropped THIS test's own item/location row purely depending on which
 * 1000-of-N rows PostgREST happened to return, with no bug in the actual
 * correction RPCs at all (confirmed via the scalar function during
 * diagnosis: it always returned the exact right number).
 * inventory_location_item_balance(org, item, location) is the scalar,
 * per-(item, location) function every writer RPC itself uses under its
 * own advisory lock -- exact and immune to the row-cap issue.
 */
async function getScalarBalance(itemId: string): Promise<number> {
  const { data, error } = await fx.supabase.rpc("inventory_location_item_balance", {
    p_organization_id: fx.organizationId,
    p_inventory_item_id: itemId,
    p_location_id: locationId,
  });
  if (error) throw new Error(error.message);
  return Number(data);
}

async function createItemWithBalance(startingQuantity: number) {
  const runTag = randomUUID().slice(0, 8);
  const verified = await createVerifiedPostingDocument(fx.supabase, fx, locationId, [
    { description: `Correction Test ${runTag}`, receiving: { behavior: "SAME_UNIT", baseUnitCode: "PIECE", receivedQuantity: startingQuantity, receivedUnit: "PIECE", locationId } },
  ]);
  await postPurchaseDocumentInventoryRpc(fx.supabase, { purchaseDocumentId: verified.purchaseDocumentId, organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId });
  return verified.itemIds[0]!;
}

describe("record_inventory_correction -- generic Adjust Inventory action", () => {
  it("COUNTED mode creates the exact delta as a movement, never a direct balance mutation (spec #8/#19)", async () => {
    const itemId = await createItemWithBalance(20);
    const before = await getScalarBalance(itemId);
    expect(before).toBe(20);

    const result = await recordInventoryCorrection(fx.supabase, fx.changeableEmployeeAppUserId, itemId, locationId, "COUNTED", 25, null, "Physical recount found more stock", randomUUID());
    expect(result.previousBalance).toBe(20);
    expect(result.newBalance).toBe(25);
    expect(result.movementId).not.toBeNull();

    const after = await getScalarBalance(itemId);
    expect(after).toBe(25);

    const { data: movement } = await fx.supabase.from("inventory_movements").select("movement_type").eq("id", result.movementId!).single();
    expect(movement!.movement_type).toBe("INVENTORY_CORRECTION_IN");
  });

  it("DELTA mode applies a negative adjustment directly", async () => {
    const itemId = await createItemWithBalance(20);
    const result = await recordInventoryCorrection(fx.supabase, fx.changeableEmployeeAppUserId, itemId, locationId, "DELTA", null, -6, "Found damaged units not yet wasted", randomUUID());
    expect(result.newBalance).toBe(14);
    const { data: movement } = await fx.supabase.from("inventory_movements").select("movement_type").eq("id", result.movementId!).single();
    expect(movement!.movement_type).toBe("INVENTORY_CORRECTION_OUT");
  });

  it("zero-variance still writes an inventory_corrections history row but never an inventory_movements row", async () => {
    const itemId = await createItemWithBalance(20);
    const result = await recordInventoryCorrection(fx.supabase, fx.changeableEmployeeAppUserId, itemId, locationId, "COUNTED", 20, null, "Confirmed count matches system", randomUUID());
    expect(result.movementId).toBeNull();
    expect(result.previousBalance).toBe(20);
    expect(result.newBalance).toBe(20);

    const { data: correction } = await fx.supabase.from("inventory_corrections").select("movement_id, quantity_delta, reason").eq("id", result.correctionId).single();
    expect(correction!.movement_id).toBeNull();
    expect(Number(correction!.quantity_delta)).toBe(0);
  });

  it("is idempotent: a replay with the SAME client_request_id returns the same result without double-adjusting (spec #9)", async () => {
    const itemId = await createItemWithBalance(20);
    const clientRequestId = randomUUID();
    const first = await recordInventoryCorrection(fx.supabase, fx.changeableEmployeeAppUserId, itemId, locationId, "DELTA", null, 5, "Test idempotency", clientRequestId);
    expect(first.replayed).toBe(false);

    const second = await recordInventoryCorrection(fx.supabase, fx.changeableEmployeeAppUserId, itemId, locationId, "DELTA", null, 5, "Test idempotency", clientRequestId);
    expect(second.replayed).toBe(true);
    expect(second.correctionId).toBe(first.correctionId);

    const after = await getScalarBalance(itemId);
    expect(after).toBe(25); // 20 + 5, only once
  });

  it("two genuinely concurrent corrections with DIFFERENT client_request_ids on the same item/location both apply exactly once (spec #10)", async () => {
    const itemId = await createItemWithBalance(20);
    const [a, b] = await Promise.all([
      recordInventoryCorrection(fx.supabase, fx.changeableEmployeeAppUserId, itemId, locationId, "DELTA", null, 3, "Concurrent A", randomUUID()),
      recordInventoryCorrection(fx.supabase, fx.changeableEmployeeAppUserId, itemId, locationId, "DELTA", null, 2, "Concurrent B", randomUUID()),
    ]);
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(false);
    const after = await getScalarBalance(itemId);
    expect(after).toBe(25); // 20 + 3 + 2, neither lost
  });

  it("fails closed on an invalid quantity (spec #24)", async () => {
    const itemId = await createItemWithBalance(20);
    await expect(
      recordInventoryCorrection(fx.supabase, fx.changeableEmployeeAppUserId, itemId, locationId, "COUNTED", -1, null, "Invalid negative count", randomUUID())
    ).rejects.toBeInstanceOf(InvalidCorrectionInputError);
  });

  it("rejects a location that does not belong to the acting app user's organization (spec #11)", async () => {
    const itemId = await createItemWithBalance(20);
    const otherOrg = await setupOtherOrgFixtures(fx.supabase);
    await expect(
      recordInventoryCorrection(fx.supabase, otherOrg.appUserId, itemId, locationId, "DELTA", null, 5, "Cross-org attempt", randomUUID())
    ).rejects.toThrow();
  });

  it("records the reason and acting app user in inventory_corrections (spec #25)", async () => {
    const itemId = await createItemWithBalance(20);
    const result = await recordInventoryCorrection(fx.supabase, fx.changeableEmployeeAppUserId, itemId, locationId, "DELTA", null, 4, "Audit trail check", randomUUID());
    const { data: correction } = await fx.supabase.from("inventory_corrections").select("reason, performed_by_app_user_id").eq("id", result.correctionId).single();
    expect(correction!.reason).toBe("Audit trail check");
    expect(correction!.performed_by_app_user_id).toBe(fx.changeableEmployeeAppUserId);
  });
});

describe("correct_receipt_package_factor -- the flagship 'current inventory will change' workflow", () => {
  async function createPostedFixedConversionReceipt(factor: number, receivedQuantity: number) {
    const runTag = randomUUID().slice(0, 8);
    const verified = await createVerifiedPostingDocument(fx.supabase, fx, locationId, [
      {
        description: `Receipt Correction Test ${runTag}`,
        receiving: {
          behavior: "FIXED_CONVERSION",
          baseUnitCode: "PIECE",
          purchaseUnitCode: "CASE",
          fixedConversionFactor: factor,
          receivedQuantity,
          receivedUnit: "CASE",
          verifiedBaseQuantity: receivedQuantity * factor,
          locationId,
        },
      },
    ]);
    const itemId = verified.itemIds[0]!;
    await postPurchaseDocumentInventoryRpc(fx.supabase, { purchaseDocumentId: verified.purchaseDocumentId, organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId });

    const { data: classification } = await fx.supabase
      .from("purchase_document_line_classifications")
      .select("vendor_item_purchase_unit_id")
      .eq("organization_id", fx.organizationId)
      .eq("purchase_document_id", verified.purchaseDocumentId)
      .eq("line_key", verified.lineKeys[0])
      .single();
    const oldVpuId = classification!.vendor_item_purchase_unit_id as string;
    const { data: mapping } = await fx.supabase.from("vendor_item_purchase_units").select("vendor_item_mapping_id").eq("id", oldVpuId).single();

    return { itemId, oldVpuId, vendorItemMappingId: mapping!.vendor_item_mapping_id as string, purchaseDocumentId: verified.purchaseDocumentId };
  }

  it("lists the exact posted receipt for a package version, then corrects it to the exact delta, leaving the original posting line untouched (spec #7/#8/#23)", async () => {
    const { itemId, oldVpuId, vendorItemMappingId } = await createPostedFixedConversionReceipt(24, 2);
    const before = await getScalarBalance(itemId);
    expect(before).toBe(48); // 2 cases * 24

    const receipts = await listReceiptsUsingVendorPackage(fx.supabase, fx.organizationId, oldVpuId);
    expect(receipts).toHaveLength(1);
    const receipt = receipts[0];
    expect(receipt.originalReceivedPackageQuantity).toBe(2);
    expect(receipt.originalNormalizedBaseQuantity).toBe(48);

    const { data: originalPostingLine } = await fx.supabase.from("purchase_document_inventory_posting_lines").select("posted_base_quantity").eq("id", receipt.postingLineId).single();
    expect(originalPostingLine!.posted_base_quantity).toBe(48);

    // The vendor discovers the real case size was 30, not 24.
    const newPackage = await setVendorPurchasePackage(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, vendorItemMappingId, "CASE", "FIXED_CONVERSION", 30, false);

    const result = await correctReceiptPackageFactor(
      fx.supabase,
      fx.organizationId,
      fx.changeableEmployeeAppUserId,
      [receipt.postingLineId],
      newPackage.vendorItemPurchaseUnitId,
      "Vendor confirmed case size was actually 30, not 24",
      randomUUID()
    );
    expect(result.replayed).toBe(false);
    expect(result.correctionIds).toHaveLength(1);

    // 2 cases * 30 = 60 -- delta of +12 over the original 48.
    const after = await getScalarBalance(itemId);
    expect(after).toBe(60);

    // The ORIGINAL posting line/receipt is completely untouched -- never
    // rewritten, only a new correction row + movement inserted alongside it.
    const { data: originalPostingLineAfter } = await fx.supabase.from("purchase_document_inventory_posting_lines").select("posted_base_quantity").eq("id", receipt.postingLineId).single();
    expect(originalPostingLineAfter!.posted_base_quantity).toBe(48);

    const { data: correction } = await fx.supabase
      .from("inventory_corrections")
      .select("previous_quantity, new_quantity, quantity_delta, reason, performed_by_app_user_id, source_posting_line_id")
      .eq("id", result.correctionIds[0])
      .single();
    expect(correction!.previous_quantity).toBe(48);
    expect(correction!.new_quantity).toBe(60);
    expect(Number(correction!.quantity_delta)).toBe(12);
    expect(correction!.source_posting_line_id).toBe(receipt.postingLineId);
    expect(correction!.reason).toBe("Vendor confirmed case size was actually 30, not 24");
    expect(correction!.performed_by_app_user_id).toBe(fx.changeableEmployeeAppUserId);
  });

  it("is idempotent: replaying the same batch with the same client_request_id never double-adjusts (spec #9)", async () => {
    const { itemId, oldVpuId, vendorItemMappingId } = await createPostedFixedConversionReceipt(10, 3);
    const receipts = await listReceiptsUsingVendorPackage(fx.supabase, fx.organizationId, oldVpuId);
    const newPackage = await setVendorPurchasePackage(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, vendorItemMappingId, "CASE", "FIXED_CONVERSION", 15, false);
    const clientRequestId = randomUUID();

    const first = await correctReceiptPackageFactor(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, [receipts[0].postingLineId], newPackage.vendorItemPurchaseUnitId, "Test replay", clientRequestId);
    expect(first.replayed).toBe(false);
    const second = await correctReceiptPackageFactor(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, [receipts[0].postingLineId], newPackage.vendorItemPurchaseUnitId, "Test replay", clientRequestId);
    expect(second.replayed).toBe(true);
    expect(second.correctionIds).toEqual(first.correctionIds);

    const after = await getScalarBalance(itemId);
    expect(after).toBe(45); // 3 * 15, only once (not 3*10 + (3*15-3*10)*2)
  });

  it("fails closed when the target package version requires actual measurement (spec #24)", async () => {
    const { oldVpuId, vendorItemMappingId } = await createPostedFixedConversionReceipt(12, 1);
    const receipts = await listReceiptsUsingVendorPackage(fx.supabase, fx.organizationId, oldVpuId);
    const measuredPackage = await setVendorPurchasePackage(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, vendorItemMappingId, "CASE", "MEASURE_EACH_DELIVERY", null, true);

    await expect(
      correctReceiptPackageFactor(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, [receipts[0].postingLineId], measuredPackage.vendorItemPurchaseUnitId, "Invalid target", randomUUID())
    ).rejects.toThrow();
  });
});
