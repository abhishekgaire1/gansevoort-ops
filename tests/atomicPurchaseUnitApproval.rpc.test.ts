import { beforeAll, describe, expect, it } from "vitest";
import { approveLineClassificationNewItemRpc } from "@/app/lib/itemMaster/approveLineClassificationNewItemRpc";
import { setupRpcTestFixtures, type RpcTestFixtures } from "./testFixtures";
import { createDraftPurchaseDocumentWithLines, findOrCreateThrowawaySpendCategory } from "./itemMasterTestHelpers";

/**
 * MANUAL / ON-DEMAND ONLY -- see purchaseDocuments.rpc.test.ts's header
 * comment.
 *
 * Proves the atomic new-item + purchase-unit approval (20260811100045)
 * against real Postgres -- specifically the Korean-Radish-shaped case: a
 * base unit (LB) distinct from the vendor purchase unit (BOX), where the
 * relationship between them is NOT a fixed, learnable conversion (a box of
 * produce weighs something different every delivery). One manager action
 * must atomically produce:
 *   - the item itself, CONFIRMED
 *   - the mandatory self-referencing base-unit row (is_default_entry_unit)
 *   - a SEPARATE purchase-unit row with requires_actual_measurement=true,
 *     conversion_factor NULL -- never a fabricated BOX->LB rate
 * and, separately, that FIXED_CONVERSION correctly stores a real factor
 * for a genuinely fixed-count case.
 */

let fx: RpcTestFixtures;
let categoryId: string;
let spendCategoryId: string;

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
  const { data: item } = await fx.supabase.from("inventory_items").select("category_id").eq("id", fx.noRuleItemId).single();
  categoryId = item!.category_id as string;
  spendCategoryId = await findOrCreateThrowawaySpendCategory(fx.supabase, fx.organizationId);
});

describe("approve_line_classification_new_item -- purchase unit / receiving behavior", () => {
  it("MEASURE_EACH_DELIVERY creates a distinct purchase-unit row requiring measurement, with no fixed conversion factor", async () => {
    const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: "KOR-RADISH", description: "Korean Radish", packageUnit: "BOX", measuredUnit: "LB" }],
    });
    const { data: line } = await fx.supabase
      .from("purchase_document_lines")
      .select("line_key")
      .eq("purchase_document_id", purchaseDocumentId)
      .single();

    const result = await approveLineClassificationNewItemRpc(fx.supabase, {
      purchaseDocumentId,
      lineKey: line!.line_key as string,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      finalName: `Korean Radish ${purchaseDocumentId.slice(0, 8)}`,
      disposition: "INVENTORY",
      categoryId,
      spendCategoryId,
      baseUnitCode: "LB",
      purchaseUnitCode: "BOX",
      receivingBehavior: "MEASURE_EACH_DELIVERY",
      rememberVendorMapping: false,
    });

    const { data: units } = await fx.supabase
      .from("inventory_item_units")
      .select("unit_id, conversion_factor, requires_actual_measurement, is_default_entry_unit, units(code)")
      .eq("inventory_item_id", result.inventoryItemId);

    expect(units).toHaveLength(2);
    const baseRow = units!.find((u) => (Array.isArray(u.units) ? u.units[0] : u.units)?.code === "LB");
    const purchaseRow = units!.find((u) => (Array.isArray(u.units) ? u.units[0] : u.units)?.code === "BOX");

    expect(baseRow).toMatchObject({ conversion_factor: 1, requires_actual_measurement: false, is_default_entry_unit: true });
    expect(purchaseRow).toMatchObject({ conversion_factor: null, requires_actual_measurement: true, is_default_entry_unit: false });
  });

  it("FIXED_CONVERSION stores the real factor and never requires measurement", async () => {
    const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: "BOTTLE-CASE", description: "Bottled Water Case of 24", packageUnit: "CASE", measuredUnit: "PIECE" }],
    });
    const { data: line } = await fx.supabase
      .from("purchase_document_lines")
      .select("line_key")
      .eq("purchase_document_id", purchaseDocumentId)
      .single();

    const result = await approveLineClassificationNewItemRpc(fx.supabase, {
      purchaseDocumentId,
      lineKey: line!.line_key as string,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      finalName: `Bottled Water ${purchaseDocumentId.slice(0, 8)}`,
      disposition: "INVENTORY",
      categoryId,
      spendCategoryId,
      baseUnitCode: "PIECE",
      purchaseUnitCode: "CASE",
      receivingBehavior: "FIXED_CONVERSION",
      fixedConversionFactor: 24,
      rememberVendorMapping: false,
    });

    const { data: units } = await fx.supabase
      .from("inventory_item_units")
      .select("unit_id, conversion_factor, requires_actual_measurement, units(code)")
      .eq("inventory_item_id", result.inventoryItemId);

    const purchaseRow = units!.find((u) => (Array.isArray(u.units) ? u.units[0] : u.units)?.code === "CASE");
    expect(purchaseRow).toMatchObject({ conversion_factor: 24, requires_actual_measurement: false });
  });

  it("rejects FIXED_CONVERSION with no factor", async () => {
    const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: "BAD-FIXED", description: "Missing Factor Item", packageUnit: "CASE", measuredUnit: "PIECE" }],
    });
    const { data: line } = await fx.supabase
      .from("purchase_document_lines")
      .select("line_key")
      .eq("purchase_document_id", purchaseDocumentId)
      .single();

    await expect(
      approveLineClassificationNewItemRpc(fx.supabase, {
        purchaseDocumentId,
        lineKey: line!.line_key as string,
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId,
        finalName: "Missing Factor Item",
        disposition: "INVENTORY",
        categoryId,
        spendCategoryId,
        baseUnitCode: "PIECE",
        purchaseUnitCode: "CASE",
        receivingBehavior: "FIXED_CONVERSION",
        rememberVendorMapping: false,
      })
    ).rejects.toThrow();
  });

  it("SAME_UNIT creates no distinct purchase-unit row", async () => {
    const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: "SAME-UNIT", description: "Same Unit Item", packageUnit: "LB", measuredUnit: "LB" }],
    });
    const { data: line } = await fx.supabase
      .from("purchase_document_lines")
      .select("line_key")
      .eq("purchase_document_id", purchaseDocumentId)
      .single();

    const result = await approveLineClassificationNewItemRpc(fx.supabase, {
      purchaseDocumentId,
      lineKey: line!.line_key as string,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      finalName: `Same Unit Item ${purchaseDocumentId.slice(0, 8)}`,
      disposition: "INVENTORY",
      categoryId,
      spendCategoryId,
      baseUnitCode: "LB",
      purchaseUnitCode: "LB",
      receivingBehavior: "SAME_UNIT",
      rememberVendorMapping: false,
    });

    const { data: units } = await fx.supabase.from("inventory_item_units").select("unit_id").eq("inventory_item_id", result.inventoryItemId);
    expect(units).toHaveLength(1);
  });
});
