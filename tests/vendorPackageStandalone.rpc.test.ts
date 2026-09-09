import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { setupRpcTestFixtures, setupOtherOrgFixtures, type RpcTestFixtures } from "./testFixtures";
import { setVendorPurchasePackage, listItemVendorPackages } from "@/app/lib/admin/vendorPackages";
import { AdminActionError } from "@/app/lib/admin/errors";
import { createDraftPurchaseDocumentWithLines, getLineKeys, findOrCreateThrowawaySpendCategory } from "./itemMasterTestHelpers";
import { approveLineClassificationNewItemRpc } from "@/app/lib/itemMaster/approveLineClassificationNewItemRpc";
import { getLocationBalance } from "./inventoryPostingTestHelpers";
import { approveLineClassificationExistingItemRpc } from "@/app/lib/itemMaster/approveLineClassificationExistingItemRpc";
import { correctDocumentDeliveryVerifierRpc } from "@/app/lib/itemMaster/correctDocumentDeliveryVerifierRpc";
import { recordReceiptRpc } from "@/app/lib/receiving/recordReceiptRpc";
import { submitPurchaseDocumentForVerificationRpc } from "@/app/lib/purchaseDocuments/submitPurchaseDocumentForVerificationRpc";
import { verifyPurchaseDocumentRpc } from "@/app/lib/purchaseDocuments/verifyPurchaseDocumentRpc";
import { findOrCreateNamedEmployee } from "./itemMasterTestHelpers";

/**
 * MANUAL / ON-DEMAND ONLY -- see adminItemMaster.rpc.test.ts's header
 * comment (same convention).
 *
 * Safe editing of confirmed items -- the standalone vendor-purchase-
 * package management RPC (manager_set_vendor_purchase_package,
 * 20260811100140), the FIRST way to edit a vendor's package
 * independent of any purchase document, and the STALE-on-supersede
 * trigger (20260811100139) that reopens an open document line for
 * review when the package version it was confirmed against is
 * superseded. Covers spec tests #5, #6, #11, #22, #23, #24.
 */

let fx: RpcTestFixtures;
let categoryId: string;

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
  const { data: item } = await fx.supabase.from("inventory_items").select("category_id").eq("id", fx.noRuleItemId).single();
  categoryId = item!.category_id as string;
});

async function createConfirmedItemWithMapping(vendorId: string, appUserId: string) {
  const runTag = randomUUID().slice(0, 8);
  const spendCategoryId = await findOrCreateThrowawaySpendCategory(fx.supabase, fx.organizationId);
  const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
    organizationId: fx.organizationId,
    vendorId,
    uploadedByAppUserId: appUserId,
    lines: [{ vendorSku: `VPS-${runTag}`, description: `Vendor Package Standalone Item ${runTag}`, packageUnit: "CASE", measuredUnit: "PIECE" }],
  });
  const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);
  const result = await approveLineClassificationNewItemRpc(fx.supabase, {
    purchaseDocumentId,
    lineKey,
    organizationId: fx.organizationId,
    appUserId,
    finalName: `TEST Vendor Package Standalone Item ${runTag}`,
    disposition: "INVENTORY",
    categoryId,
    spendCategoryId,
    baseUnitCode: "PIECE",
    purchaseUnitCode: "CASE",
    receivingBehavior: "FIXED_CONVERSION",
    fixedConversionFactor: 12,
    rememberVendorMapping: true,
  });
  const { data: mapping } = await fx.supabase
    .from("vendor_item_mappings")
    .select("id")
    .eq("organization_id", fx.organizationId)
    .eq("vendor_id", vendorId)
    .eq("inventory_item_id", result.inventoryItemId)
    .eq("is_active", true)
    .single();
  return { purchaseDocumentId, lineKey, itemId: result.inventoryItemId as string, vendorItemMappingId: mapping!.id as string };
}

describe("manager_set_vendor_purchase_package -- standalone, future-transactions-only", () => {
  it("edits an existing package to a genuinely different factor: balances stay unchanged (spec #5/#6), and the old version's own row is untouched history", async () => {
    const { itemId, vendorItemMappingId } = await createConfirmedItemWithMapping(fx.vendorId, fx.changeableEmployeeAppUserId);
    const { data: location } = await fx.supabase.from("locations").select("id").eq("organization_id", fx.organizationId).limit(1).single();
    const locationId = location!.id as string;

    const before = await getLocationBalance(fx.supabase, fx.organizationId, itemId, locationId);
    expect(before ?? 0).toBe(0);

    const { data: oldPackage } = await fx.supabase
      .from("vendor_item_purchase_units")
      .select("id, conversion_factor")
      .eq("organization_id", fx.organizationId)
      .eq("vendor_item_mapping_id", vendorItemMappingId)
      .eq("is_active", true)
      .single();
    expect(oldPackage!.conversion_factor).toBe(12);

    const result = await setVendorPurchasePackage(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, vendorItemMappingId, "CASE", "FIXED_CONVERSION", 24, false);
    expect(result.vendorItemPurchaseUnitId).not.toBe(oldPackage!.id);

    // Current inventory never moved -- this is a configuration change,
    // not a correction.
    const after = await getLocationBalance(fx.supabase, fx.organizationId, itemId, locationId);
    expect(after ?? 0).toBe(before ?? 0);

    // The OLD package version's own row is untouched history -- never
    // rewritten, only superseded.
    const { data: oldPackageAfter } = await fx.supabase.from("vendor_item_purchase_units").select("conversion_factor, is_active").eq("id", oldPackage!.id).single();
    expect(oldPackageAfter!.conversion_factor).toBe(12);
    expect(oldPackageAfter!.is_active).toBe(false);

    const packages = await listItemVendorPackages(fx.supabase, fx.organizationId, itemId);
    const pkg = packages.find((p) => p.vendorItemMappingId === vendorItemMappingId);
    expect(pkg?.package?.conversionFactor).toBe(24);
  });

  it("fails closed on an invalid conversion factor (null/zero/negative) for FIXED_CONVERSION (spec #24)", async () => {
    const { vendorItemMappingId } = await createConfirmedItemWithMapping(fx.vendorId, fx.changeableEmployeeAppUserId);
    await expect(setVendorPurchasePackage(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, vendorItemMappingId, "CASE", "FIXED_CONVERSION", null, false)).rejects.toBeInstanceOf(
      AdminActionError
    );
    await expect(setVendorPurchasePackage(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, vendorItemMappingId, "CASE", "FIXED_CONVERSION", 0, false)).rejects.toBeInstanceOf(
      AdminActionError
    );
    await expect(setVendorPurchasePackage(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, vendorItemMappingId, "CASE", "FIXED_CONVERSION", -5, false)).rejects.toBeInstanceOf(
      AdminActionError
    );
  });

  it("rejects a vendor_item_mapping_id from a different organization (spec #11)", async () => {
    const otherOrg = await setupOtherOrgFixtures(fx.supabase);
    const { vendorItemMappingId } = await createConfirmedItemWithMapping(fx.vendorId, fx.changeableEmployeeAppUserId);

    await expect(setVendorPurchasePackage(fx.supabase, otherOrg.organizationId, otherOrg.appUserId, vendorItemMappingId, "CASE", "FIXED_CONVERSION", 24, false)).rejects.toBeInstanceOf(
      AdminActionError
    );
  });
});

describe("vendor package supersede reopens open document lines for review (spec #22/#23)", () => {
  it("an OPEN (DRAFT) line confirmed against the old package version flips to STALE when the package is superseded; a separately-VERIFIED document's classification never changes", async () => {
    const { vendorItemMappingId, itemId, purchaseDocumentId: draftDocId, lineKey: draftLineKey } = await createConfirmedItemWithMapping(fx.vendorId, fx.changeableEmployeeAppUserId);

    // A SECOND document, confirmed against the SAME item/vendor package,
    // taken all the way to VERIFIED -- the trigger must never touch this
    // one regardless of what happens to the package afterward.
    const runTag = randomUUID().slice(0, 8);
    const { data: location } = await fx.supabase.from("locations").select("id").eq("organization_id", fx.organizationId).limit(1).single();
    const locationId = location!.id as string;
    const deliveryVerifierEmployeeId = await findOrCreateNamedEmployee(fx.supabase, fx.organizationId, "TEST Delivery Verifier");
    const { purchaseDocumentId: verifiedDocId, documentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: `VPS-V-${runTag}`, description: `Verified Doc ${runTag}`, packageUnit: "CASE", packageQuantity: 2 }],
    });
    const [verifiedLineKey] = await getLineKeys(fx.supabase, verifiedDocId);
    await approveLineClassificationExistingItemRpc(fx.supabase, {
      purchaseDocumentId: verifiedDocId,
      lineKey: verifiedLineKey,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      inventoryItemId: itemId,
      rememberVendorMapping: false,
      purchaseUnitCode: "CASE",
      receivingBehavior: "FIXED_CONVERSION",
      fixedConversionFactor: 12,
    });
    await recordReceiptRpc(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      receiptKind: "DELIVERY",
      purchaseDocumentId: verifiedDocId,
      lines: [
        {
          lineNumberSnapshot: 1,
          matchedLineKey: verifiedLineKey,
          vendorSkuSnapshot: `VPS-V-${runTag}`,
          descriptionSnapshot: `Verified Doc ${runTag}`,
          invoicePackageQuantity: 2,
          invoicePackageUnit: "CASE",
          invoiceMeasuredQuantity: null,
          invoiceMeasuredUnit: null,
          actualReceivedPackageQuantity: 2,
          actualReceivedPackageUnit: "CASE",
          actualVerifiedBaseQuantity: 24,
          actualVerifiedBaseUnitId: null,
          locationId,
        },
      ],
    });
    await correctDocumentDeliveryVerifierRpc(fx.supabase, { documentId, organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId, newEmployeeId: deliveryVerifierEmployeeId });
    const submitted = await submitPurchaseDocumentForVerificationRpc(fx.supabase, { purchaseDocumentId: verifiedDocId, organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId, expectedVersion: 1 });
    await verifyPurchaseDocumentRpc(fx.supabase, { purchaseDocumentId: verifiedDocId, organizationId: fx.organizationId, appUserId: fx.lockedEmployeeAppUserId, expectedVersion: submitted.version });

    const { data: beforeDraftClassification } = await fx.supabase
      .from("purchase_document_line_classifications")
      .select("status")
      .eq("organization_id", fx.organizationId)
      .eq("purchase_document_id", draftDocId)
      .eq("line_key", draftLineKey)
      .single();
    expect(beforeDraftClassification!.status).toBe("CONFIRMED");

    await setVendorPurchasePackage(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, vendorItemMappingId, "CASE", "FIXED_CONVERSION", 30, false);

    const { data: afterDraftClassification } = await fx.supabase
      .from("purchase_document_line_classifications")
      .select("status")
      .eq("organization_id", fx.organizationId)
      .eq("purchase_document_id", draftDocId)
      .eq("line_key", draftLineKey)
      .single();
    expect(afterDraftClassification!.status).toBe("STALE");

    // Posted/VERIFIED document's classification is untouched.
    const { data: afterVerifiedClassification } = await fx.supabase
      .from("purchase_document_line_classifications")
      .select("status")
      .eq("organization_id", fx.organizationId)
      .eq("purchase_document_id", verifiedDocId)
      .eq("line_key", verifiedLineKey)
      .single();
    expect(afterVerifiedClassification!.status).toBe("CONFIRMED");
  });
});
