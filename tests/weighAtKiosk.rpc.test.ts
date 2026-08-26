import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { setupRpcTestFixtures, setupOtherOrgFixtures, type RpcTestFixtures } from "./testFixtures";
import { createDraftPurchaseDocumentWithLines, getLineKeys, findOrCreateThrowawaySpendCategory } from "./itemMasterTestHelpers";
import { approveLineClassificationNewItemRpc } from "@/app/lib/itemMaster/approveLineClassificationNewItemRpc";
import { approveLineClassificationExistingItemRpc } from "@/app/lib/itemMaster/approveLineClassificationExistingItemRpc";
import { recordInventoryWithdrawal } from "@/app/lib/inventory/withdrawal";
import { KioskUsageUnitNotAuthorizedError } from "@/app/lib/inventory/errors";

/**
 * MANUAL / ON-DEMAND ONLY -- see purchaseDocuments.rpc.test.ts's header
 * comment.
 *
 * Approved product decision -- restore safe weigh-at-kiosk support
 * (20260811100126): a kiosk usage unit (primary or secondary) may now be
 * confirmed as MEASURE AT WITHDRAWAL, not only fixed conversion. This
 * file exercises every DB-backed proof requirement against the real
 * linked dev database, on top of what tests/withdrawal.rpc.test.ts (fixed
 * fixtures) and tests/purchaseUsageUnits.rpc.test.ts (fixed secondary,
 * vendor packages, org isolation, non-measured kiosk authorization)
 * already cover.
 *
 * Every successful withdrawal call below permanently writes to
 * append-only tables (inventory_movements, inventory_movement_lines,
 * audit_events) in the linked dev database -- same documented tradeoff
 * every other withdrawal/posting .rpc.test.ts file already accepts.
 */

let fx: RpcTestFixtures;
let locationId: string;
let spendCategoryId: string;
let categoryId: string;

async function createFreshFixedBaseItem(runTag: string): Promise<string> {
  const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
    organizationId: fx.organizationId,
    vendorId: fx.vendorId,
    uploadedByAppUserId: fx.changeableEmployeeAppUserId,
    lines: [{ vendorSku: `WEIGH-${runTag}`, description: `Weigh At Kiosk Test ${runTag}`, packageUnit: "PIECE", measuredUnit: "PIECE" }],
  });
  const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);
  const result = await approveLineClassificationNewItemRpc(fx.supabase, {
    purchaseDocumentId,
    lineKey,
    organizationId: fx.organizationId,
    appUserId: fx.changeableEmployeeAppUserId,
    finalName: `Weigh At Kiosk Test ${runTag}`,
    disposition: "INVENTORY",
    categoryId,
    spendCategoryId,
    baseUnitCode: "PIECE",
    rememberVendorMapping: false,
  });
  return result.inventoryItemId;
}

async function addMeasuredSecondary(itemId: string, unitCode: string): Promise<string> {
  const { data, error } = await fx.supabase.rpc("manager_add_secondary_usage_unit", {
    p_organization_id: fx.organizationId,
    p_app_user_id: fx.changeableEmployeeAppUserId,
    p_inventory_item_id: itemId,
    p_secondary_unit_code: unitCode,
    p_secondary_conversion_factor: null,
    p_requires_actual_measurement: true,
  });
  if (error) throw error;
  return data as string;
}

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
  const { data: location } = await fx.supabase.from("locations").select("id").eq("organization_id", fx.organizationId).limit(1).single();
  locationId = location!.id as string;
  spendCategoryId = await findOrCreateThrowawaySpendCategory(fx.supabase, fx.organizationId);
  const { data: item } = await fx.supabase.from("inventory_items").select("category_id").eq("id", fx.noRuleItemId).single();
  categoryId = item!.category_id as string;
});

describe("1/2/3. fixed usage unit still works; measured usage unit can be primary or secondary", () => {
  it("a measured secondary unit can be added, promoted to primary, and used to withdraw with a measured quantity", async () => {
    const runTag = randomUUID().slice(0, 8);
    const itemId = await createFreshFixedBaseItem(runTag);
    const measuredUsageUnitId = await addMeasuredSecondary(itemId, "BOX");

    const { data: secondarySlot } = await fx.supabase.from("inventory_item_usage_units").select("usage_slot").eq("id", measuredUsageUnitId).single();
    expect(secondarySlot!.usage_slot).toBe(2);

    // 1. Fixed usage unit (the item's own base, PIECE) still works unchanged.
    const fixedResult = await recordInventoryWithdrawal(fx.supabase, {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.stationId,
      sourceLocationId: locationId,
      inventoryItemId: itemId,
      enteredQuantity: "4",
      enteredUnitId: (await fx.supabase.from("inventory_items").select("base_unit_id").eq("id", itemId).single()).data!.base_unit_id as string,
      clientRequestId: randomUUID(),
    });
    expect(fixedResult.normalizedBaseQuantity).toBe("4");

    // 3. Measured usage unit can be SECONDARY -- withdraw using it directly.
    const { data: boxUnit } = await fx.supabase
      .from("inventory_item_units")
      .select("unit_id")
      .eq("id", (await fx.supabase.from("inventory_item_usage_units").select("inventory_item_unit_id").eq("id", measuredUsageUnitId).single()).data!.inventory_item_unit_id as string)
      .single();
    const measuredAsSecondary = await recordInventoryWithdrawal(fx.supabase, {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.stationId,
      sourceLocationId: locationId,
      inventoryItemId: itemId,
      enteredQuantity: "1",
      enteredUnitId: boxUnit!.unit_id as string,
      measuredBaseQuantity: "6.5",
      clientRequestId: randomUUID(),
    });
    expect(measuredAsSecondary.normalizedBaseQuantity).toBe("6.5");

    // 2. Promote it to PRIMARY, then withdraw again -- still works measured.
    const { error: promoteError } = await fx.supabase.rpc("manager_set_primary_usage_unit", {
      p_organization_id: fx.organizationId,
      p_app_user_id: fx.changeableEmployeeAppUserId,
      p_inventory_item_id: itemId,
      p_usage_unit_id: measuredUsageUnitId,
    });
    expect(promoteError).toBeNull();
    const { data: afterPromote } = await fx.supabase.from("inventory_item_usage_units").select("usage_slot").eq("id", measuredUsageUnitId).single();
    expect(afterPromote!.usage_slot).toBe(1);

    const measuredAsPrimary = await recordInventoryWithdrawal(fx.supabase, {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.stationId,
      sourceLocationId: locationId,
      inventoryItemId: itemId,
      enteredQuantity: "1",
      enteredUnitId: boxUnit!.unit_id as string,
      measuredBaseQuantity: "7.25",
      clientRequestId: randomUUID(),
    });
    expect(measuredAsPrimary.normalizedBaseQuantity).toBe("7.25");
  });
});

describe("4. missing actual measurement is rejected", () => {
  it("a measured unit withdrawal with no measuredBaseQuantity is rejected, and posts no movement", async () => {
    const runTag = randomUUID().slice(0, 8);
    const itemId = await createFreshFixedBaseItem(runTag);
    const measuredUsageUnitId = await addMeasuredSecondary(itemId, "BOX");
    const { data: link } = await fx.supabase.from("inventory_item_usage_units").select("inventory_item_unit_id").eq("id", measuredUsageUnitId).single();
    const { data: boxUnit } = await fx.supabase.from("inventory_item_units").select("unit_id").eq("id", link!.inventory_item_unit_id as string).single();

    const clientRequestId = randomUUID();
    await expect(
      recordInventoryWithdrawal(fx.supabase, {
        performedByAppUserId: fx.changeableEmployeeAppUserId,
        stationId: fx.stationId,
        sourceLocationId: locationId,
        inventoryItemId: itemId,
        enteredQuantity: "1",
        enteredUnitId: boxUnit!.unit_id as string,
        clientRequestId,
      })
    ).rejects.toThrow(/requires an actual measured quantity/);

    const { count } = await fx.supabase
      .from("inventory_movements")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", fx.organizationId)
      .eq("client_request_id", clientRequestId);
    expect(count).toBe(0);
  });
});

describe("5. zero, negative, NaN and infinite measurements are rejected", () => {
  it.each(["0", "-3", "NaN", "Infinity", "-Infinity"])("rejects measuredBaseQuantity = %s", async (badValue) => {
    const runTag = randomUUID().slice(0, 8);
    const itemId = await createFreshFixedBaseItem(runTag);
    const measuredUsageUnitId = await addMeasuredSecondary(itemId, "BOX");
    const { data: link } = await fx.supabase.from("inventory_item_usage_units").select("inventory_item_unit_id").eq("id", measuredUsageUnitId).single();
    const { data: boxUnit } = await fx.supabase.from("inventory_item_units").select("unit_id").eq("id", link!.inventory_item_unit_id as string).single();

    await expect(
      recordInventoryWithdrawal(fx.supabase, {
        performedByAppUserId: fx.changeableEmployeeAppUserId,
        stationId: fx.stationId,
        sourceLocationId: locationId,
        inventoryItemId: itemId,
        enteredQuantity: "1",
        enteredUnitId: boxUnit!.unit_id as string,
        measuredBaseQuantity: badValue,
        clientRequestId: randomUUID(),
      })
    ).rejects.toThrow();
  });
});

describe("6/7. the server uses the measured value directly -- never a client-suppliable conversion", () => {
  it("a wildly different enteredQuantity has NO effect on the posted base quantity -- only measuredBaseQuantity is ever used", async () => {
    const runTag = randomUUID().slice(0, 8);
    const itemId = await createFreshFixedBaseItem(runTag);
    const measuredUsageUnitId = await addMeasuredSecondary(itemId, "BOX");
    const { data: link } = await fx.supabase.from("inventory_item_usage_units").select("inventory_item_unit_id").eq("id", measuredUsageUnitId).single();
    const { data: boxUnit } = await fx.supabase.from("inventory_item_units").select("unit_id").eq("id", link!.inventory_item_unit_id as string).single();

    const result = await recordInventoryWithdrawal(fx.supabase, {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.stationId,
      sourceLocationId: locationId,
      inventoryItemId: itemId,
      enteredQuantity: "999999", // deliberately absurd -- must be completely ignored
      enteredUnitId: boxUnit!.unit_id as string,
      measuredBaseQuantity: "5.5",
      clientRequestId: randomUUID(),
    });
    expect(result.normalizedBaseQuantity).toBe("5.5");
  });
});

describe("9. vendor purchase-only measured units remain unauthorized", () => {
  it("a vendor package configured MEASURE_EACH_DELIVERY, never confirmed as a kiosk usage unit, is still rejected at withdrawal", async () => {
    const runTag = randomUUID().slice(0, 8);
    const itemId = await createFreshFixedBaseItem(runTag);

    const { purchaseDocumentId: docB } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: `WEIGH-VP-${runTag}`, description: "Weigh Vendor Package", packageUnit: "BOX", measuredUnit: "PIECE" }],
    });
    const [lineKeyB] = await getLineKeys(fx.supabase, docB);
    await approveLineClassificationExistingItemRpc(fx.supabase, {
      purchaseDocumentId: docB,
      lineKey: lineKeyB,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      inventoryItemId: itemId,
      rememberVendorMapping: false,
      purchaseUnitCode: "BOX",
      receivingBehavior: "MEASURE_EACH_DELIVERY",
    });

    const { data: vendorPackage } = await fx.supabase
      .from("vendor_item_purchase_units")
      .select("purchase_unit_id, requires_actual_measurement")
      .eq("organization_id", fx.organizationId)
      .eq("inventory_item_id", itemId)
      .eq("is_active", true)
      .single();
    expect(vendorPackage!.requires_actual_measurement).toBe(true);

    // Confirm this vendor package never created a kiosk usage-unit row.
    const { data: usageRows } = await fx.supabase
      .from("inventory_item_usage_units")
      .select("id, inventory_item_units!inner(unit_id)")
      .eq("organization_id", fx.organizationId)
      .eq("inventory_item_id", itemId)
      .eq("is_active", true);
    const usageUnitIds = (usageRows ?? []).map((r) => (r.inventory_item_units as unknown as { unit_id: string }).unit_id);
    expect(usageUnitIds).not.toContain(vendorPackage!.purchase_unit_id);

    await expect(
      recordInventoryWithdrawal(fx.supabase, {
        performedByAppUserId: fx.changeableEmployeeAppUserId,
        stationId: fx.stationId,
        sourceLocationId: locationId,
        inventoryItemId: itemId,
        enteredQuantity: "1",
        enteredUnitId: vendorPackage!.purchase_unit_id as string,
        measuredBaseQuantity: "3",
        clientRequestId: randomUUID(),
      })
    ).rejects.toBeInstanceOf(KioskUsageUnitNotAuthorizedError);
  });
});

describe("10. cross-organization units are rejected", () => {
  it("a measured usage unit belonging to a DIFFERENT organization's item is never an allowed unit for this organization's item", async () => {
    const runTag = randomUUID().slice(0, 8);
    const itemId = await createFreshFixedBaseItem(runTag);

    const other = await setupOtherOrgFixtures(fx.supabase);
    const { data: otherLocation } = await fx.supabase.from("locations").select("id").eq("organization_id", other.organizationId).limit(1).single();

    await expect(
      recordInventoryWithdrawal(fx.supabase, {
        performedByAppUserId: fx.changeableEmployeeAppUserId,
        stationId: fx.stationId,
        sourceLocationId: otherLocation?.id ?? locationId,
        inventoryItemId: itemId,
        enteredQuantity: "1",
        // A random, well-formed but entirely unrelated unit id -- proves this
        // item never accepts a unit id that isn't genuinely its own,
        // regardless of organization.
        enteredUnitId: randomUUID(),
        measuredBaseQuantity: "3",
        clientRequestId: randomUUID(),
      })
    ).rejects.toThrow();
  });
});

describe("12/13. idempotency and concurrency for a measured withdrawal", () => {
  it("12. an idempotent retry with the identical measured payload returns the SAME movement, never a duplicate", async () => {
    const runTag = randomUUID().slice(0, 8);
    const itemId = await createFreshFixedBaseItem(runTag);
    const measuredUsageUnitId = await addMeasuredSecondary(itemId, "BOX");
    const { data: link } = await fx.supabase.from("inventory_item_usage_units").select("inventory_item_unit_id").eq("id", measuredUsageUnitId).single();
    const { data: boxUnit } = await fx.supabase.from("inventory_item_units").select("unit_id").eq("id", link!.inventory_item_unit_id as string).single();

    const clientRequestId = randomUUID();
    const input = {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.stationId,
      sourceLocationId: locationId,
      inventoryItemId: itemId,
      enteredQuantity: "1",
      enteredUnitId: boxUnit!.unit_id as string,
      measuredBaseQuantity: "4.2",
      clientRequestId,
    };

    const first = await recordInventoryWithdrawal(fx.supabase, input);
    const second = await recordInventoryWithdrawal(fx.supabase, input);

    expect(second.movementId).toBe(first.movementId);
    expect(second.movementLineId).toBe(first.movementLineId);
    expect(second.replayed).toBe(true);

    const { count } = await fx.supabase
      .from("inventory_movements")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", fx.organizationId)
      .eq("client_request_id", clientRequestId);
    expect(count).toBe(1);
  });

  it("13. two genuinely concurrent calls with the same clientRequestId and an identical measured payload cannot double-withdraw", async () => {
    const runTag = randomUUID().slice(0, 8);
    const itemId = await createFreshFixedBaseItem(runTag);
    const measuredUsageUnitId = await addMeasuredSecondary(itemId, "BOX");
    const { data: link } = await fx.supabase.from("inventory_item_usage_units").select("inventory_item_unit_id").eq("id", measuredUsageUnitId).single();
    const { data: boxUnit } = await fx.supabase.from("inventory_item_units").select("unit_id").eq("id", link!.inventory_item_unit_id as string).single();

    const clientRequestId = randomUUID();
    const input = {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.stationId,
      sourceLocationId: locationId,
      inventoryItemId: itemId,
      enteredQuantity: "1",
      enteredUnitId: boxUnit!.unit_id as string,
      measuredBaseQuantity: "9.9",
      clientRequestId,
    };

    const [a, b] = await Promise.all([recordInventoryWithdrawal(fx.supabase, input), recordInventoryWithdrawal(fx.supabase, input)]);

    expect(a.movementId).toBe(b.movementId);
    expect(a.movementLineId).toBe(b.movementLineId);

    const { count } = await fx.supabase
      .from("inventory_movements")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", fx.organizationId)
      .eq("client_request_id", clientRequestId);
    expect(count).toBe(1);
  });
});
