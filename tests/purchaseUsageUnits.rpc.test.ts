import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { setupRpcTestFixtures, setupOtherOrgFixtures, type RpcTestFixtures } from "./testFixtures";
import { createVerifiedPostingDocument, getLocationBalance } from "./inventoryPostingTestHelpers";
import { createDraftPurchaseDocumentWithLines, getLineKeys, findOrCreateThrowawaySpendCategory } from "./itemMasterTestHelpers";
import { approveLineClassificationNewItemRpc } from "@/app/lib/itemMaster/approveLineClassificationNewItemRpc";
import { approveLineClassificationExistingItemRpc } from "@/app/lib/itemMaster/approveLineClassificationExistingItemRpc";
import { postPurchaseDocumentInventoryRpc } from "@/app/lib/inventory/postingRpcs";
import { recordInventoryWithdrawal } from "@/app/lib/inventory/withdrawal";
import { KioskUsageUnitNotAuthorizedError } from "@/app/lib/inventory/errors";
import { normalizeVendorName } from "@/app/lib/vendors/normalizeVendorName";

/**
 * MANUAL / ON-DEMAND ONLY -- see purchaseDocuments.rpc.test.ts's header
 * comment.
 *
 * Purchase-versus-usage unit model (20260811100119-100123), against the
 * real linked dev database. No prior .rpc.test.ts file exercises
 * vendor_item_purchase_units, inventory_item_usage_units, the
 * manager_*_usage_unit RPCs, or enforce_movement_line_measurement's new
 * kiosk-authorization branch directly -- atomicPurchaseUnitApproval.rpc.test.ts
 * (pre-existing) already proves the OLD inventory_item_units-based shape
 * this migration's approval-RPC extension preserves for backward
 * compatibility.
 *
 * Every successful withdrawal/posting call below permanently writes to
 * append-only tables (inventory_movements, inventory_movement_lines,
 * vendor_item_purchase_units' history, audit_events) in the linked dev
 * database -- same documented tradeoff every other posting/withdrawal
 * .rpc.test.ts file already accepts.
 */

let fx: RpcTestFixtures;
let locationId: string;
let spendCategoryId: string;
let categoryId: string;

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
  const { data: location } = await fx.supabase.from("locations").select("id").eq("organization_id", fx.organizationId).limit(1).single();
  locationId = location!.id as string;
  spendCategoryId = await findOrCreateThrowawaySpendCategory(fx.supabase, fx.organizationId);
  const { data: item } = await fx.supabase.from("inventory_items").select("category_id").eq("id", fx.noRuleItemId).single();
  categoryId = item!.category_id as string;
});

describe("primary/secondary kiosk usage units (manager_add / manager_set_primary / manager_deactivate)", () => {
  it("a freshly-confirmed item has exactly one active (primary) usage unit; adding a secondary makes both selectable, and it can be promoted or deactivated", async () => {
    // A brand-new, dedicated item -- never the shared fx.noRuleItemId
    // fixture (reused, unmutated, by many other test files): this test
    // deliberately mutates primary/secondary usage-unit configuration, so
    // it must own an item nobody else depends on.
    const runTag = randomUUID().slice(0, 8);
    const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: `USG-${runTag}`, description: `Usage Unit Test Item ${runTag}`, packageUnit: "PIECE", measuredUnit: "PIECE" }],
    });
    const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);

    const result = await approveLineClassificationNewItemRpc(fx.supabase, {
      purchaseDocumentId,
      lineKey,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      finalName: `Usage Unit Test Item ${runTag}`,
      disposition: "INVENTORY",
      categoryId,
      spendCategoryId,
      baseUnitCode: "PIECE",
      rememberVendorMapping: false,
    });
    const itemId = result.inventoryItemId;

    const { data: initialUnits } = await fx.supabase
      .from("inventory_item_usage_units")
      .select("id, usage_slot, is_active")
      .eq("organization_id", fx.organizationId)
      .eq("inventory_item_id", itemId)
      .eq("is_active", true);
    expect(initialUnits).toHaveLength(1);
    expect(initialUnits![0].usage_slot).toBe(1);

    const { error: addError } = await fx.supabase.rpc("manager_add_secondary_usage_unit", {
      p_organization_id: fx.organizationId,
      p_app_user_id: fx.changeableEmployeeAppUserId,
      p_inventory_item_id: itemId,
      p_secondary_unit_code: "CASE",
      p_secondary_conversion_factor: 12,
    });
    expect(addError).toBeNull();

    const { data: withSecondary } = await fx.supabase
      .from("inventory_item_usage_units")
      .select("id, usage_slot")
      .eq("organization_id", fx.organizationId)
      .eq("inventory_item_id", itemId)
      .eq("is_active", true)
      .order("usage_slot", { ascending: true });
    expect(withSecondary!.map((u) => u.usage_slot)).toEqual(expect.arrayContaining([1, 2]));
    const secondary = withSecondary!.find((u) => u.usage_slot === 2)!;

    const { error: promoteError } = await fx.supabase.rpc("manager_set_primary_usage_unit", {
      p_organization_id: fx.organizationId,
      p_app_user_id: fx.changeableEmployeeAppUserId,
      p_inventory_item_id: itemId,
      p_usage_unit_id: secondary.id,
    });
    expect(promoteError).toBeNull();

    const { data: afterPromote } = await fx.supabase
      .from("inventory_item_usage_units")
      .select("id, usage_slot")
      .eq("id", secondary.id)
      .single();
    expect(afterPromote!.usage_slot).toBe(1);

    const { error: deactivateError } = await fx.supabase.rpc("manager_deactivate_secondary_usage_unit", {
      p_organization_id: fx.organizationId,
      p_app_user_id: fx.changeableEmployeeAppUserId,
      p_inventory_item_id: itemId,
    });
    expect(deactivateError).toBeNull();

    const { data: afterDeactivate } = await fx.supabase
      .from("inventory_item_usage_units")
      .select("id")
      .eq("organization_id", fx.organizationId)
      .eq("inventory_item_id", itemId)
      .eq("is_active", true);
    expect(afterDeactivate).toHaveLength(1);
  });
});

describe("vendor/SKU-specific purchase packages -- per-vendor isolation and vendor-package-aware posting", () => {
  it("two different vendors selling the SAME item with different case sizes each get their own vendor_item_purchase_units row, and posting resolves the actual vendor's factor", async () => {
    const runTag = randomUUID().slice(0, 8);

    // A brand-new, dedicated item for this test (never shared/mutated by
    // any other concurrent test file) -- posted via vendor A's package
    // (CASE = 24) to prove posting itself resolves the correct factor.
    const verified = await createVerifiedPostingDocument(fx.supabase, fx, locationId, [
      {
        description: `Vendor Package Test ${runTag}`,
        receiving: {
          behavior: "FIXED_CONVERSION",
          baseUnitCode: "PIECE",
          purchaseUnitCode: "CASE",
          fixedConversionFactor: 24,
          receivedQuantity: 2,
          receivedUnit: "CASE",
          verifiedBaseQuantity: 48,
          locationId,
        },
      },
    ]);
    const itemId = verified.itemIds[0]!;

    await postPurchaseDocumentInventoryRpc(fx.supabase, {
      purchaseDocumentId: verified.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
    });

    const balanceAfterVendorA = await getLocationBalance(fx.supabase, fx.organizationId, itemId, locationId);
    // 2 cases * 24 pieces/case = 48 pieces posted using vendor A's factor.
    expect(Number(balanceAfterVendorA)).toBe(48);

    const { data: vendorAPackage } = await fx.supabase
      .from("vendor_item_purchase_units")
      .select("id, vendor_id, conversion_factor, is_active")
      .eq("organization_id", fx.organizationId)
      .eq("inventory_item_id", itemId)
      .eq("vendor_id", fx.vendorId)
      .eq("is_active", true)
      .single();
    expect(vendorAPackage!.conversion_factor).toBe(24);

    // A SECOND, brand-new vendor sells the SAME item, also coded "CASE",
    // but with a genuinely different case size (18, not 24) -- registered
    // via the same approval RPC against the already-confirmed item.
    const vendorBName = `TEST Vendor B ${runTag}`;
    const { data: vendorB, error: vendorBError } = await fx.supabase
      .from("vendors")
      .insert({ organization_id: fx.organizationId, name: vendorBName, normalized_name: normalizeVendorName(vendorBName) })
      .select("id")
      .single();
    expect(vendorBError).toBeNull();

    const { purchaseDocumentId: docB } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: vendorB!.id as string,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: `VENDB-${runTag}`, description: "Vendor B Package", packageUnit: "CASE", measuredUnit: "PIECE" }],
    });
    const [lineKeyB] = await getLineKeys(fx.supabase, docB);

    await approveLineClassificationExistingItemRpc(fx.supabase, {
      purchaseDocumentId: docB,
      lineKey: lineKeyB,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      inventoryItemId: itemId,
      rememberVendorMapping: false,
      purchaseUnitCode: "CASE",
      receivingBehavior: "FIXED_CONVERSION",
      fixedConversionFactor: 18,
    });

    const { data: vendorBPackage } = await fx.supabase
      .from("vendor_item_purchase_units")
      .select("id, vendor_id, conversion_factor, is_active")
      .eq("organization_id", fx.organizationId)
      .eq("inventory_item_id", itemId)
      .eq("vendor_id", vendorB!.id)
      .eq("is_active", true)
      .single();
    expect(vendorBPackage!.conversion_factor).toBe(18);

    // Vendor A's own package is completely untouched by vendor B's
    // registration -- neither vendor's case size leaked into the other's.
    const { data: vendorAPackageAfter } = await fx.supabase
      .from("vendor_item_purchase_units")
      .select("conversion_factor")
      .eq("id", vendorAPackage!.id)
      .single();
    expect(vendorAPackageAfter!.conversion_factor).toBe(24);
    expect(vendorAPackage!.id).not.toBe(vendorBPackage!.id);
  });
});

describe("kiosk withdrawal-unit authorization (enforce_movement_line_measurement)", () => {
  it("rejects a withdrawal entered in a unit that is not an active, confirmed kiosk usage unit for the item, and accepts the authorized primary unit", async () => {
    const runTag = randomUUID().slice(0, 8);
    const verified = await createVerifiedPostingDocument(fx.supabase, fx, locationId, [
      {
        description: `Kiosk Authorization Test ${runTag}`,
        receiving: {
          behavior: "FIXED_CONVERSION",
          baseUnitCode: "PIECE",
          purchaseUnitCode: "CASE",
          fixedConversionFactor: 10,
          receivedQuantity: 5,
          receivedUnit: "CASE",
          verifiedBaseQuantity: 50,
          locationId,
        },
      },
    ]);
    const itemId = verified.itemIds[0]!;
    await postPurchaseDocumentInventoryRpc(fx.supabase, {
      purchaseDocumentId: verified.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
    });

    const { data: caseUnit } = await fx.supabase
      .from("inventory_item_units")
      .select("id, unit_id, units!inner(code)")
      .eq("inventory_item_id", itemId)
      .eq("units.code", "CASE")
      .single();
    const { data: pieceUnit } = await fx.supabase
      .from("inventory_item_units")
      .select("id, unit_id, units!inner(code)")
      .eq("inventory_item_id", itemId)
      .eq("units.code", "PIECE")
      .single();

    // CASE is a vendor purchase-only unit here (never confirmed as a
    // kiosk usage unit) -- a withdrawal attempting to use it directly must
    // be rejected, even though it is a perfectly valid, active
    // inventory_item_units row for receiving purposes.
    await expect(
      recordInventoryWithdrawal(fx.supabase, {
        performedByAppUserId: fx.changeableEmployeeAppUserId,
        stationId: fx.stationId,
        inventoryItemId: itemId,
        sourceLocationId: locationId,
        enteredQuantity: "1",
        enteredUnitId: caseUnit!.unit_id as string,
        clientRequestId: randomUUID(),
      })
    ).rejects.toBeInstanceOf(KioskUsageUnitNotAuthorizedError);

    // PIECE is this item's base unit, backfilled as the primary kiosk
    // usage unit by 20260811100119 -- a withdrawal using it succeeds.
    const result = await recordInventoryWithdrawal(fx.supabase, {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.stationId,
      inventoryItemId: itemId,
      sourceLocationId: locationId,
      enteredQuantity: "3",
      enteredUnitId: pieceUnit!.unit_id as string,
      clientRequestId: randomUUID(),
    });
    expect(result.movementId).toBeTruthy();
  });
});

describe("organization isolation -- purchase/usage-unit model", () => {
  it("a usage unit / vendor package confirmed in one organization is invisible to, and cannot be referenced from, a different organization", async () => {
    const other = await setupOtherOrgFixtures(fx.supabase);

    const { data: crossOrgUnits } = await fx.supabase
      .from("inventory_item_usage_units")
      .select("id")
      .eq("organization_id", other.organizationId)
      .eq("inventory_item_id", fx.noRuleItemId);
    expect(crossOrgUnits).toHaveLength(0);

    const { data: crossOrgPackages } = await fx.supabase
      .from("vendor_item_purchase_units")
      .select("id")
      .eq("organization_id", other.organizationId)
      .eq("inventory_item_id", fx.noRuleItemId);
    expect(crossOrgPackages).toHaveLength(0);

    // Attempting to manage a usage unit for fx's item using the OTHER
    // organization's id is rejected, not silently reinterpreted.
    const { error } = await fx.supabase.rpc("manager_add_secondary_usage_unit", {
      p_organization_id: other.organizationId,
      p_app_user_id: other.appUserId,
      p_inventory_item_id: fx.noRuleItemId,
      p_secondary_unit_code: "CASE",
      p_secondary_conversion_factor: 6,
    });
    expect(error).not.toBeNull();
  });
});
