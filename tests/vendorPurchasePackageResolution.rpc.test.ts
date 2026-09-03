import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { setupRpcTestFixtures, type RpcTestFixtures } from "./testFixtures";
import { createDraftPurchaseDocumentWithLines, getLineKeys, findOrCreateThrowawaySpendCategory } from "./itemMasterTestHelpers";
import { approveLineClassificationNewItemRpc } from "@/app/lib/itemMaster/approveLineClassificationNewItemRpc";
import { getReceivingLines } from "@/app/lib/receiving/getReceivingLines";
import { resolveVendorPurchasePackages } from "@/app/lib/purchaseDocuments/resolveVendorPurchasePackage";

/**
 * MANUAL / ON-DEMAND ONLY -- see purchaseDocuments.rpc.test.ts's header
 * comment.
 *
 * Test 13: Step 3 (getReceivingLines.ts) must be consistent with Step 2
 * (getPurchaseDocumentLineClassifications, itemClassification.ts) -- both
 * now call the SAME shared resolveVendorPurchasePackages, which is what
 * this file proves against a real "legacy" item shaped exactly like the
 * real Bartlett/Farmland Sour Cream case found during read-only DEV
 * inspection: a confirmed, non-SAME_UNIT purchase package that lives only
 * in vendor_item_mappings.confirmed_invoice_unit_id + inventory_item_units
 * (never a vendor_item_purchase_units row) -- either because the
 * classification was approved before that model existed, or because it
 * was later auto-classified via VENDOR_SKU_MAPPING, which never sets
 * vendor_item_purchase_unit_id at all (system_classification_resolution_
 * rpcs, 20260811100042).
 */

let fx: RpcTestFixtures;
let spendCategoryId: string;
let categoryId: string;

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
  spendCategoryId = await findOrCreateThrowawaySpendCategory(fx.supabase, fx.organizationId);
  const { data: item } = await fx.supabase.from("inventory_items").select("category_id").eq("id", fx.noRuleItemId).single();
  categoryId = item!.category_id as string;
});

describe("Step 2 and Step 3 resolve the same effective purchase package (legacy pre-vendor-package-model item)", () => {
  it("test 13: a classification with no vendor_item_purchase_unit_id, whose confirmed package lives only in legacy tables, resolves identically for getReceivingLines (Step 3) and the Step 2 resolver", async () => {
    const runTag = randomUUID().slice(0, 8);
    const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: `LEGACY-${runTag}`, description: `Legacy Package Item ${runTag}`, packageUnit: "PACK" }],
    });
    const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);

    const approved = await approveLineClassificationNewItemRpc(fx.supabase, {
      purchaseDocumentId,
      lineKey,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      finalName: `Legacy Package Item ${runTag}`,
      disposition: "INVENTORY",
      categoryId,
      spendCategoryId,
      baseUnitCode: "LB",
      purchaseUnitCode: "PACK",
      receivingBehavior: "FIXED_CONVERSION",
      fixedConversionFactor: 10,
      rememberVendorMapping: false,
    });

    // Simulate the legacy shape: the classification's own
    // vendor_item_purchase_unit_id pointer is cleared, and the row it
    // pointed to is deactivated -- so ONLY vendor_item_mappings.
    // confirmed_invoice_unit_id + inventory_item_units carry the
    // confirmed "PACK, 1 PACK = 10 LB" package, exactly like the real
    // Bartlett/Farmland Sour Cream item found during DEV inspection.
    const { data: classificationBefore } = await fx.supabase
      .from("purchase_document_line_classifications")
      .select("vendor_item_purchase_unit_id")
      .eq("purchase_document_id", purchaseDocumentId)
      .eq("line_key", lineKey)
      .single();
    expect(classificationBefore!.vendor_item_purchase_unit_id).not.toBeNull();

    const { data: packUnit } = await fx.supabase.from("units").select("id").eq("code", "PACK").single();

    await fx.supabase
      .from("vendor_item_purchase_units")
      .update({ is_active: false })
      .eq("id", classificationBefore!.vendor_item_purchase_unit_id as string);
    await fx.supabase
      .from("purchase_document_line_classifications")
      .update({ vendor_item_purchase_unit_id: null })
      .eq("purchase_document_id", purchaseDocumentId)
      .eq("line_key", lineKey);
    // vendor_item_mappings.confirmed_invoice_unit_id is set by a SEPARATE
    // write path (confirm_receiving_line_invoice_unit, Step 3's "Correct
    // invoice unit"), not by the item-approval RPC itself -- set directly
    // here to reproduce the real Bartlett/Farmland Sour Cream row shape
    // without depending on that unrelated flow.
    const { error: mappingUpdateError } = await fx.supabase
      .from("vendor_item_mappings")
      .update({ confirmed_invoice_unit_id: packUnit!.id })
      .eq("organization_id", fx.organizationId)
      .eq("vendor_id", fx.vendorId)
      .eq("inventory_item_id", approved.inventoryItemId);
    expect(mappingUpdateError).toBeNull();

    // Confirm the legacy tables now carry the real confirmed package.
    const { data: mapping } = await fx.supabase
      .from("vendor_item_mappings")
      .select("confirmed_invoice_unit_id")
      .eq("organization_id", fx.organizationId)
      .eq("vendor_id", fx.vendorId)
      .eq("inventory_item_id", approved.inventoryItemId)
      .single();
    expect(mapping!.confirmed_invoice_unit_id).not.toBeNull();

    // Step 3's own read model.
    const receivingLines = await getReceivingLines(fx.supabase, purchaseDocumentId, fx.organizationId);
    const receivingLine = receivingLines.find((l) => l.lineKey === lineKey)!;
    expect(receivingLine.purchaseUnitCode).toBe("PACK");
    expect(receivingLine.receivingBehavior).toBe("FIXED_CONVERSION");
    expect(receivingLine.fixedConversionFactor).toBe(10);

    // Step 2's own resolver, called the same way itemClassification.ts
    // calls it.
    const step2Result = await resolveVendorPurchasePackages(fx.supabase, fx.organizationId, fx.vendorId, [
      { key: lineKey, inventoryItemId: approved.inventoryItemId, vendorItemPurchaseUnitId: null },
    ]);
    const step2Package = step2Result.get(lineKey);
    expect(step2Package?.unitCode).toBe(receivingLine.purchaseUnitCode);
    expect(step2Package?.receivingBehavior).toBe(receivingLine.receivingBehavior);
    expect(step2Package?.conversionFactor).toBe(receivingLine.fixedConversionFactor);
  });
});
