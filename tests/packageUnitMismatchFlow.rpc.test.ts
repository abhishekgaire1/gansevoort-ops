import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { setupRpcTestFixtures, type RpcTestFixtures } from "./testFixtures";
import { createDraftPurchaseDocumentWithLines, getLineKeys, findOrCreateThrowawaySpendCategory, findOrCreateNamedEmployee } from "./itemMasterTestHelpers";
import { createVerifiedPostingDocument } from "./inventoryPostingTestHelpers";
import { approveLineClassificationNewItemRpc } from "@/app/lib/itemMaster/approveLineClassificationNewItemRpc";
import { approveLineClassificationExistingItemRpc } from "@/app/lib/itemMaster/approveLineClassificationExistingItemRpc";
import { postPurchaseDocumentInventoryRpc } from "@/app/lib/inventory/postingRpcs";
import { InventoryPostingBlockedError } from "@/app/lib/inventory/errors";
import { getPreparationStatus } from "@/app/lib/purchaseDocuments/getPreparationStatus";
import { recordReceiptRpc } from "@/app/lib/receiving/recordReceiptRpc";
import { correctDocumentDeliveryVerifierRpc } from "@/app/lib/itemMaster/correctDocumentDeliveryVerifierRpc";
import { lineLevelBlockers } from "@/app/lib/purchaseDocuments/preparationBlockers";
import { resolveLineMismatchFields, type LineMismatchResolutionInput } from "@/app/lib/purchaseDocuments/packageUnitMismatch";

/**
 * MANUAL / ON-DEMAND ONLY -- see purchaseDocuments.rpc.test.ts's header
 * comment.
 *
 * Fix for a confirmed defect: during owner UAT, an invoice line
 * (FARMLAND SOUR CREAM 10LB) was approved through all four review steps,
 * and only at "Ready to Post" did the app reveal "received unit PACK does
 * not match the confirmed purchase package for this vendor/SKU". This
 * file proves the mismatch now surfaces during Step 2 (Confirm Items) --
 * fetching REAL classification/vendor-package rows and piping them
 * through the exact resolver getPurchaseDocumentLineClassifications
 * itself calls (resolveLineMismatchFields) -- and that the authoritative
 * posting RPC (post_purchase_document_inventory, 20260811100123,
 * completely untouched by this fix) still independently rejects the same
 * mismatch if it ever reaches posting regardless.
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

/** Fetches the exact same shape of rows getPurchaseDocumentLineClassifications
 * queries for one line, and pipes them through the same shared resolver
 * it calls -- proving the real DB wiring (not a reimplementation) drives
 * the mismatch fields correctly. */
async function fetchMismatchFieldsForLine(purchaseDocumentId: string, lineKey: string) {
  const { data: line } = await fx.supabase
    .from("purchase_document_lines")
    .select("package_unit")
    .eq("purchase_document_id", purchaseDocumentId)
    .eq("line_key", lineKey)
    .single();
  const { data: classification } = await fx.supabase
    .from("purchase_document_line_classifications")
    .select(
      "status, disposition, inventory_items!purchase_document_line_classifications_item_org_fk(units(code, name)), vendor_item_purchase_units!purchase_document_line_classifications_vendor_package_org_fk(purchase_unit_id, conversion_factor, receiving_behavior, units(code, name))"
    )
    .eq("purchase_document_id", purchaseDocumentId)
    .eq("line_key", lineKey)
    .single();
  const { data: allUnits } = await fx.supabase.from("units").select("code");
  const recognizedUnitCodes = new Set((allUnits ?? []).map((u) => (u.code as string).trim().toUpperCase()));

  // Untyped Supabase embed shape, same loose-cast convention
  // itemClassification.ts itself uses for these exact embeds.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = classification as any;
  const item = Array.isArray(c.inventory_items) ? c.inventory_items[0] : c.inventory_items;
  const itemUnit = item ? (Array.isArray(item.units) ? item.units[0] : item.units) : null;
  const vendorPackageRow = Array.isArray(c.vendor_item_purchase_units) ? c.vendor_item_purchase_units[0] : c.vendor_item_purchase_units;
  const vendorPackageUnit = vendorPackageRow ? (Array.isArray(vendorPackageRow.units) ? vendorPackageRow.units[0] : vendorPackageRow.units) : null;

  const input: LineMismatchResolutionInput = {
    status: c.status,
    disposition: c.disposition,
    invoicePackageUnitText: line!.package_unit as string | null,
    vendorPackage: vendorPackageRow
      ? {
          unitCode: vendorPackageUnit?.code ?? null,
          unitName: vendorPackageUnit?.name ?? null,
          receivingBehavior: vendorPackageRow.receiving_behavior,
          conversionFactor: vendorPackageRow.conversion_factor,
        }
      : null,
    itemBaseUnit: itemUnit ? { code: itemUnit.code ?? null, name: itemUnit.name ?? null } : null,
    recognizedUnitCodes,
  };
  return resolveLineMismatchFields(input);
}

describe("purchase-package mismatch surfaces during Step 2 (real classification/vendor-package data)", () => {
  it("appears as soon as the invoice unit and the confirmed purchase package are both known, and clears once the invoice unit is corrected", async () => {
    const runTag = randomUUID().slice(0, 8);
    const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: `PKG-${runTag}`, description: `Package Mismatch Test ${runTag}`, packageUnit: "PACK" }],
    });
    const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);

    await approveLineClassificationNewItemRpc(fx.supabase, {
      purchaseDocumentId,
      lineKey,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      finalName: `Package Mismatch Item ${runTag}`,
      disposition: "INVENTORY",
      categoryId,
      spendCategoryId,
      baseUnitCode: "BOTTLE",
      purchaseUnitCode: "CASE",
      receivingBehavior: "FIXED_CONVERSION",
      fixedConversionFactor: 4,
      rememberVendorMapping: false,
    });

    // Test 1 + 2: appears as soon as both are known, showing the received
    // (PACK) and expected (CASE, with its confirmed conversion) units.
    const before = await fetchMismatchFieldsForLine(purchaseDocumentId, lineKey);
    expect(before.hasPackageMismatch).toBe(true);
    expect(before.resolvedInvoiceUnitCode).toBe("PACK");
    expect(before.effectivePurchaseUnitCode).toBe("CASE");
    expect(before.effectiveConversionFactor).toBe(4);

    // Test 9 (implicit control): a second, unrelated line on the SAME
    // document with matching units passes normally throughout.
    // (No separate line needed here -- covered directly by
    // packageUnitMismatch.unit.test.ts's "passes normally" cases.)

    // Test 5: correcting the invoice unit's raw text (Step 1's own field
    // -- exactly what "Correct invoice unit" edits) clears the issue
    // immediately, from the SAME confirmed classification, no
    // re-classification or document restart required. Updated directly
    // (rather than through the full save-draft round trip, which also
    // exercises the pre-existing, unrelated STALE-invalidation trigger)
    // to isolate exactly what's being proven: given the corrected row,
    // the resolver recomputes correctly.
    const { error: updateError } = await fx.supabase
      .from("purchase_document_lines")
      .update({ package_unit: "CASE" })
      .eq("purchase_document_id", purchaseDocumentId)
      .eq("line_key", lineKey);
    expect(updateError).toBeNull();

    const afterInvoiceFix = await fetchMismatchFieldsForLine(purchaseDocumentId, lineKey);
    expect(afterInvoiceFix.hasPackageMismatch).toBe(false);
    expect(afterInvoiceFix.resolvedInvoiceUnitCode).toBe("CASE");
  });

  it("test 8 (Part 1): a live purchase-package mismatch blocks getPreparationStatus -- the same gate Send for Second Review and the Stepper's step-2-complete signal both read from, never a second, laxer check that lets a mismatch through", async () => {
    const runTag = randomUUID().slice(0, 8);
    const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: `PKG-GATE-${runTag}`, description: `Package Mismatch Gate Test ${runTag}`, packageUnit: "PACK" }],
    });
    const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);

    await approveLineClassificationNewItemRpc(fx.supabase, {
      purchaseDocumentId,
      lineKey,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      finalName: `Package Mismatch Gate Item ${runTag}`,
      disposition: "INVENTORY",
      categoryId,
      spendCategoryId,
      baseUnitCode: "BOTTLE",
      purchaseUnitCode: "CASE",
      receivingBehavior: "FIXED_CONVERSION",
      fixedConversionFactor: 4,
      rememberVendorMapping: false,
    });

    // Fully received (quantity/location/measurement all present) so the
    // ONLY remaining issue is the mismatch itself -- proving it blocks
    // even when receiving is otherwise complete, exactly like Step 2's
    // own combinedLineReadiness.ts already requires.
    await recordReceiptRpc(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      receiptKind: "DELIVERY",
      purchaseDocumentId,
      lines: [
        {
          lineNumberSnapshot: 1,
          matchedLineKey: lineKey,
          vendorSkuSnapshot: `PKG-GATE-${runTag}`,
          descriptionSnapshot: `Package Mismatch Gate Test ${runTag}`,
          // invoicePackageUnit is just a snapshot of the raw invoice text
          // (still "PACK", never corrected) -- actualReceivedPackageUnit is
          // what the manager actually entered/received, matching the
          // confirmed CASE package so record_receipt's own validation
          // passes. hasPackageMismatch compares the FORMER against the
          // confirmed package, which is exactly what stays wrong here.
          invoicePackageQuantity: 2,
          invoicePackageUnit: "PACK",
          invoiceMeasuredQuantity: null,
          invoiceMeasuredUnit: null,
          actualReceivedPackageQuantity: 2,
          actualReceivedPackageUnit: "CASE",
          actualVerifiedBaseQuantity: null,
          actualVerifiedBaseUnitId: null,
          locationId,
        },
      ],
    });
    const deliveryVerifierEmployeeId = await findOrCreateNamedEmployee(fx.supabase, fx.organizationId, "TEST Package Mismatch Gate Verifier");
    const { data: doc } = await fx.supabase.from("purchase_documents").select("source_document_id").eq("id", purchaseDocumentId).single();
    await correctDocumentDeliveryVerifierRpc(fx.supabase, {
      documentId: doc!.source_document_id as string,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      newEmployeeId: deliveryVerifierEmployeeId,
    });

    const blocked = await getPreparationStatus(fx.supabase, purchaseDocumentId, fx.organizationId);
    expect(blocked.ready).toBe(false);
    expect(blocked.blockers.some((b) => b.lineKey === lineKey && /purchase package needs review/i.test(b.reason))).toBe(true);

    // test 9 (Part 1): correcting the mismatch updates the gate immediately.
    const { error: updateError } = await fx.supabase.from("purchase_document_lines").update({ package_unit: "CASE" }).eq("purchase_document_id", purchaseDocumentId).eq("line_key", lineKey);
    expect(updateError).toBeNull();

    const afterFix = await getPreparationStatus(fx.supabase, purchaseDocumentId, fx.organizationId);
    expect(afterFix.blockers.some((b) => b.lineKey === lineKey && /purchase package needs review/i.test(b.reason))).toBe(false);
  });

  it("correctly updating the vendor/SKU purchase package (through the existing verified approval workflow) clears the issue, and other lines/classifications are untouched", async () => {
    const runTag = randomUUID().slice(0, 8);
    const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [
        { vendorSku: `PKG2-${runTag}`, description: `Package Mismatch Test 2 ${runTag}`, packageUnit: "PACK" },
        { vendorSku: `OTHER-${runTag}`, description: `Unrelated Confirmed Line ${runTag}`, packageUnit: "LB" },
      ],
    });
    const [mismatchLineKey, otherLineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);

    const mismatchResult = await approveLineClassificationNewItemRpc(fx.supabase, {
      purchaseDocumentId,
      lineKey: mismatchLineKey,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      finalName: `Package Mismatch Item 2 ${runTag}`,
      disposition: "INVENTORY",
      categoryId,
      spendCategoryId,
      baseUnitCode: "BOTTLE",
      purchaseUnitCode: "CASE",
      receivingBehavior: "FIXED_CONVERSION",
      fixedConversionFactor: 4,
      rememberVendorMapping: false,
    });

    await approveLineClassificationNewItemRpc(fx.supabase, {
      purchaseDocumentId,
      lineKey: otherLineKey,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      finalName: `Unrelated Confirmed Item ${runTag}`,
      disposition: "INVENTORY",
      categoryId,
      spendCategoryId,
      baseUnitCode: "LB",
      rememberVendorMapping: false,
    });

    expect((await fetchMismatchFieldsForLine(purchaseDocumentId, mismatchLineKey)).hasPackageMismatch).toBe(true);
    const otherBefore = await fetchMismatchFieldsForLine(purchaseDocumentId, otherLineKey);
    expect(otherBefore.hasPackageMismatch).toBe(false);

    // Test 6: "Review purchase package" -> ExistingItemOverrideForm ->
    // approveExistingItemClassification -> this exact RPC, re-confirming
    // the SAME item against the vendor's ACTUAL package (PACK, matching
    // the invoice) rather than silently overwriting anything.
    await approveLineClassificationExistingItemRpc(fx.supabase, {
      purchaseDocumentId,
      lineKey: mismatchLineKey,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      inventoryItemId: mismatchResult.inventoryItemId,
      rememberVendorMapping: false,
      purchaseUnitCode: "PACK",
      receivingBehavior: "FIXED_CONVERSION",
      fixedConversionFactor: 1,
    });

    // Test 7: the correction clears the issue on this line...
    const afterFix = await fetchMismatchFieldsForLine(purchaseDocumentId, mismatchLineKey);
    expect(afterFix.hasPackageMismatch).toBe(false);
    expect(afterFix.effectivePurchaseUnitCode).toBe("PACK");

    // ...and preserves the OTHER already-completed line's resolution
    // untouched.
    const otherAfter = await fetchMismatchFieldsForLine(purchaseDocumentId, otherLineKey);
    expect(otherAfter.hasPackageMismatch).toBe(false);
    expect(otherAfter.effectivePurchaseUnitCode).toBe("LB");
  });

  it("test 8: an expense (NON_INVENTORY) line with a disagreeing invoice unit is never blocked -- expense lines never post inventory", async () => {
    const runTag = randomUUID().slice(0, 8);
    const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: `EXP-${runTag}`, description: `Expense Line ${runTag}`, packageUnit: "PACK" }],
    });
    const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);

    await approveLineClassificationNewItemRpc(fx.supabase, {
      purchaseDocumentId,
      lineKey,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      finalName: `Expense Item ${runTag}`,
      disposition: "NON_INVENTORY",
      categoryId: null,
      spendCategoryId,
      baseUnitCode: null,
      rememberVendorMapping: false,
    });

    const resolution = await fetchMismatchFieldsForLine(purchaseDocumentId, lineKey);
    expect(resolution.hasPackageMismatch).toBe(false);
  });
});

describe("final posting screen re-check (getPreparationStatus, reused unmodified by VerifiedPurchaseDocumentSummary)", () => {
  it("test 10: a document whose purchase-package configuration is unchanged since verification shows no configuration-changed blocker", async () => {
    const verified = await createVerifiedPostingDocument(fx.supabase, fx, locationId, [
      {
        description: `Final Screen Clean ${randomUUID().slice(0, 8)}`,
        receiving: {
          behavior: "FIXED_CONVERSION",
          baseUnitCode: "PIECE",
          purchaseUnitCode: "CASE",
          fixedConversionFactor: 6,
          receivedQuantity: 2,
          receivedUnit: "CASE",
          verifiedBaseQuantity: 12,
          locationId,
        },
      },
    ]);

    const status = await getPreparationStatus(fx.supabase, verified.purchaseDocumentId, fx.organizationId);
    const mismatchBlockers = lineLevelBlockers(status.blockers).filter((b) => /unit configuration changed/i.test(b.reason));
    expect(mismatchBlockers).toHaveLength(0);
  });

  it("test 11: a purchase-package configuration change AFTER verification is caught, with a reason pointing back to the affected line", async () => {
    const verified = await createVerifiedPostingDocument(fx.supabase, fx, locationId, [
      {
        description: `Final Screen Changed ${randomUUID().slice(0, 8)}`,
        receiving: {
          behavior: "FIXED_CONVERSION",
          baseUnitCode: "PIECE",
          purchaseUnitCode: "CASE",
          fixedConversionFactor: 6,
          receivedQuantity: 2,
          receivedUnit: "CASE",
          verifiedBaseQuantity: 12,
          locationId,
        },
      },
    ]);

    // Simulates the vendor/SKU's confirmed purchase package genuinely
    // changing after this document was already verified (e.g. a
    // corrected registration elsewhere) -- never something this fix
    // silently overwrites; a real administrative change to the row.
    const { error: mutateError } = await fx.supabase
      .from("vendor_item_purchase_units")
      .update({ conversion_factor: 12 })
      .eq("organization_id", fx.organizationId)
      .eq("inventory_item_id", verified.itemIds[0]!)
      .eq("is_active", true);
    expect(mutateError).toBeNull();

    const status = await getPreparationStatus(fx.supabase, verified.purchaseDocumentId, fx.organizationId);
    const mismatchBlockers = lineLevelBlockers(status.blockers).filter((b) => /unit configuration changed/i.test(b.reason));
    expect(mismatchBlockers.length).toBeGreaterThan(0);
    expect(mismatchBlockers[0].lineKey).toBe(verified.lineKeys[0]);
  });
});

describe("server-side posting enforcement (post_purchase_document_inventory, untouched by this fix)", () => {
  it("test 12: still rejects a tampered/stale received-unit mismatch at posting time, exactly as before -- this fix only moves EARLIER detection, never removes the final check", async () => {
    // Built with MATCHING units throughout (recordReceiptRpc itself
    // already independently validates a FIXED_CONVERSION line's received
    // unit against the confirmed package at receipt time, 20260811100061 --
    // a separate, pre-existing, earlier check this fix doesn't touch, and
    // receipt_lines is append-only besides -- there is no way to directly
    // tamper the recorded receipt itself). Instead, the vendor/SKU's
    // CONFIRMED package is changed to point at a genuinely different unit
    // AFTER the document was verified -- the "changed vendor/SKU
    // configuration" case the task explicitly calls out, and the only real
    // way a mismatch can still reach posting once both the earlier receipt
    // check and this fix's own Step 2 check exist.
    const { data: packUnit } = await fx.supabase.from("units").select("id").eq("code", "PACK").single();
    const verified = await createVerifiedPostingDocument(fx.supabase, fx, locationId, [
      {
        description: `Server Enforcement ${randomUUID().slice(0, 8)}`,
        receiving: {
          behavior: "FIXED_CONVERSION",
          baseUnitCode: "BOTTLE",
          purchaseUnitCode: "CASE",
          fixedConversionFactor: 4,
          receivedQuantity: 2,
          receivedUnit: "CASE",
          verifiedBaseQuantity: null,
          locationId,
        },
      },
    ]);

    const { error: tamperError } = await fx.supabase
      .from("vendor_item_purchase_units")
      .update({ purchase_unit_id: packUnit!.id })
      .eq("organization_id", fx.organizationId)
      .eq("inventory_item_id", verified.itemIds[0]!)
      .eq("is_active", true);
    expect(tamperError).toBeNull();

    let caught: unknown;
    try {
      await postPurchaseDocumentInventoryRpc(fx.supabase, {
        purchaseDocumentId: verified.purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InventoryPostingBlockedError);
    const blockers = (caught as InventoryPostingBlockedError).blockers;
    expect(blockers.some((b) => /does not match the confirmed purchase package/.test(b.reason))).toBe(true);
  });

  it("test 14: an existing valid invoice (matching units throughout) continues posting normally", async () => {
    const verified = await createVerifiedPostingDocument(fx.supabase, fx, locationId, [
      {
        description: `Valid Invoice Still Posts ${randomUUID().slice(0, 8)}`,
        receiving: {
          behavior: "FIXED_CONVERSION",
          baseUnitCode: "PIECE",
          purchaseUnitCode: "CASE",
          fixedConversionFactor: 6,
          receivedQuantity: 3,
          receivedUnit: "CASE",
          verifiedBaseQuantity: 18,
          locationId,
        },
      },
    ]);

    const result = await postPurchaseDocumentInventoryRpc(fx.supabase, {
      purchaseDocumentId: verified.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
    });
    expect(result.postedLineCount).toBe(1);
  });
});
