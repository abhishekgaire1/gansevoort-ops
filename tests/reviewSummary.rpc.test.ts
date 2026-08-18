import { beforeAll, describe, expect, it } from "vitest";
import { savePurchaseDocumentDraftRpc } from "@/app/lib/purchaseDocuments/savePurchaseDocumentDraftRpc";
import { approveLineClassificationNewItemRpc } from "@/app/lib/itemMaster/approveLineClassificationNewItemRpc";
import { confirmReceivingLineInvoiceUnitRpc } from "@/app/lib/receiving/confirmReceivingLineInvoiceUnitRpc";
import { recordReceiptRpc } from "@/app/lib/receiving/recordReceiptRpc";
import { getPurchaseDocumentReviewSummary } from "@/app/lib/purchaseDocuments/getReviewSummary";
import { setupRpcTestFixtures, type RpcTestFixtures } from "./testFixtures";
import { createDraftPurchaseDocumentWithLines, getLineKeys, findOrCreateThrowawaySpendCategory } from "./itemMasterTestHelpers";

/**
 * MANUAL / ON-DEMAND ONLY -- see purchaseDocuments.rpc.test.ts's header
 * comment.
 *
 * Two things, against real Postgres:
 *
 * 1. The actual root cause of the real "Send for Final Review" /
 *    "Something went wrong" failure -- 20260811100054's
 *    purchase_document_line_invoice_unit_confirmations FK made the
 *    delete-and-reinsert every save/submit performs on
 *    purchase_document_lines fail with a 23503 the moment any line had a
 *    confirmed invoice unit. 20260811100055 drops that FK (line_key is a
 *    soft pointer here, exactly like purchase_document_line_classifications
 *    and receipt_lines.matched_line_key already are) -- this is the
 *    regression test proving a resave no longer breaks.
 *
 * 2. getPurchaseDocumentReviewSummary (Step 4's read-only review) --
 *    proves it only ever reflects CURRENT lines (never an orphaned
 *    classification), the EFFECTIVE (corrected) receiving facts, keeps
 *    non-inventory lines out of the receiving section while still
 *    showing them elsewhere, shows variable measurement correctly, and
 *    derives exceptions from real discrepancies.
 */

let fx: RpcTestFixtures;
let categoryId: string;
let spendCategoryId: string;
let locationId: string;

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
  const { data: item } = await fx.supabase.from("inventory_items").select("category_id").eq("id", fx.noRuleItemId).single();
  categoryId = item!.category_id as string;
  spendCategoryId = await findOrCreateThrowawaySpendCategory(fx.supabase, fx.organizationId);
  const { data: location } = await fx.supabase.from("locations").select("id").eq("organization_id", fx.organizationId).limit(1).single();
  locationId = location!.id as string;
});

describe("regression: confirming an invoice unit must never break a later save/submit", () => {
  it("a line with a confirmed invoice-unit snapshot can still be resaved (delete + reinsert) without a foreign-key violation", async () => {
    const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: "REGRESSION-101102", description: "HEAVY CREAM 40% QUART (12)", packageUnit: null, packageQuantity: 60 }],
    });
    const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);

    await approveLineClassificationNewItemRpc(fx.supabase, {
      purchaseDocumentId,
      lineKey,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      finalName: `TEST Regression Heavy Cream ${purchaseDocumentId.slice(0, 8)}`,
      disposition: "INVENTORY",
      categoryId,
      spendCategoryId,
      baseUnitCode: "PIECE",
      purchaseUnitCode: "CASE",
      receivingBehavior: "FIXED_CONVERSION",
      fixedConversionFactor: 12,
      rememberVendorMapping: false,
    });

    // This is the exact action that was broken: confirming an invoice
    // unit creates a purchase_document_line_invoice_unit_confirmations
    // row referencing this line's (purchase_document_id, line_key).
    await confirmReceivingLineInvoiceUnitRpc(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      purchaseDocumentId,
      lineKey,
      confirmedInvoiceUnitCode: "PIECE",
      rememberForVendor: false,
    });

    // Resaving the document -- exactly what both "Save Draft" and "Send
    // for Final Review" do -- deletes and reinserts purchase_document_lines.
    // Echoing the SAME lineKey back (as the real frontend always does)
    // must succeed, not throw a 23503 foreign-key violation.
    const saved = await savePurchaseDocumentDraftRpc(fx.supabase, {
      purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      expectedVersion: 1,
      header: {
        vendorId: fx.vendorId,
        documentType: "INVOICE",
        documentNumber: "REGRESSION-1",
        documentDate: "2026-08-14",
        poNumber: null,
        deliveryDate: "2026-08-14",
        subtotal: 262.68,
        tax: null,
        fees: null,
        total: 262.68,
        currency: "USD",
      },
      lines: [
        {
          lineKey,
          vendorSku: "REGRESSION-101102",
          description: "HEAVY CREAM 40% QUART (12)",
          packageQuantity: 60,
          packageUnit: null,
          measuredQuantity: null,
          measuredUnit: null,
          unitPrice: 4.378,
          priceBasisUnit: null,
          lineTotal: 262.68,
          rawLineText: null,
        },
      ],
    });

    expect(saved.version).toBe(2);

    // The confirmation itself survives the resave (line_key was
    // preserved), and still correctly resolves.
    const { data: stillThere } = await fx.supabase
      .from("purchase_document_line_invoice_unit_confirmations")
      .select("id")
      .eq("purchase_document_id", purchaseDocumentId)
      .eq("line_key", lineKey);
    expect(stillThere).toHaveLength(1);
  });
});

describe("getPurchaseDocumentReviewSummary", () => {
  it("only reflects CURRENT lines -- an orphaned classification (line_key no longer present) is silently excluded, never counted", async () => {
    const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: "ORPHAN-REAL", description: "Real Current Line" }],
    });
    const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);

    await approveLineClassificationNewItemRpc(fx.supabase, {
      purchaseDocumentId,
      lineKey,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      finalName: `TEST Orphan Real Line ${purchaseDocumentId.slice(0, 8)}`,
      disposition: "NON_INVENTORY",
      categoryId: null,
      spendCategoryId,
      baseUnitCode: null,
      rememberVendorMapping: false,
    });

    // A classification row for a line_key that does NOT exist in
    // purchase_document_lines at all -- exactly what an orphan (from a
    // resave whose old lines were deleted) looks like.
    const { error } = await fx.supabase.from("purchase_document_line_classifications").insert({
      organization_id: fx.organizationId,
      purchase_document_id: purchaseDocumentId,
      line_key: "00000000-0000-0000-0000-000000000000",
      disposition: "NON_INVENTORY",
      resolution_source: "MANUAL",
      status: "CONFIRMED",
      spend_category_id: spendCategoryId,
      resolved_at: new Date().toISOString(),
    });
    expect(error).toBeNull();

    const summary = await getPurchaseDocumentReviewSummary(fx.supabase, purchaseDocumentId, fx.organizationId);
    expect(summary.items).toHaveLength(1);
    expect(summary.items[0].lineKey).toBe(lineKey);
  });

  it("uses the EFFECTIVE (corrected) receipt, never the superseded original", async () => {
    const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: "CORRECTION-ITEM", description: "Correction Test Item", packageUnit: "PIECE", measuredUnit: "PIECE", packageQuantity: 10 }],
    });
    const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);

    await approveLineClassificationNewItemRpc(fx.supabase, {
      purchaseDocumentId,
      lineKey,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      finalName: `TEST Correction Item ${purchaseDocumentId.slice(0, 8)}`,
      disposition: "INVENTORY",
      categoryId,
      spendCategoryId,
      baseUnitCode: "PIECE",
      rememberVendorMapping: false,
    });

    await recordReceiptRpc(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      receiptKind: "DELIVERY",
      purchaseDocumentId,
      lines: [
        {
          lineNumberSnapshot: 1,
          matchedLineKey: lineKey,
          vendorSkuSnapshot: "CORRECTION-ITEM",
          descriptionSnapshot: "Correction Test Item",
          invoicePackageQuantity: 10,
          invoicePackageUnit: "PIECE",
          invoiceMeasuredQuantity: null,
          invoiceMeasuredUnit: null,
          actualReceivedPackageQuantity: 10,
          actualReceivedPackageUnit: "PIECE",
          actualVerifiedBaseQuantity: null,
          actualVerifiedBaseUnitId: null,
          locationId,
        },
      ],
    });

    const { data: firstReceipt } = await fx.supabase.from("receipts").select("id").eq("purchase_document_id", purchaseDocumentId).limit(1).single();
    await recordReceiptRpc(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      receiptKind: "CORRECTION",
      correctsReceiptId: firstReceipt!.id as string,
      lines: [
        {
          lineNumberSnapshot: 1,
          matchedLineKey: lineKey,
          vendorSkuSnapshot: "CORRECTION-ITEM",
          descriptionSnapshot: "Correction Test Item",
          invoicePackageQuantity: 10,
          invoicePackageUnit: "PIECE",
          invoiceMeasuredQuantity: null,
          invoiceMeasuredUnit: null,
          actualReceivedPackageQuantity: 8,
          actualReceivedPackageUnit: "PIECE",
          actualVerifiedBaseQuantity: null,
          actualVerifiedBaseUnitId: null,
          locationId,
        },
      ],
    });

    const summary = await getPurchaseDocumentReviewSummary(fx.supabase, purchaseDocumentId, fx.organizationId);
    const line = summary.receiving.find((r) => r.lineKey === lineKey);
    expect(line?.receivedQuantity).toBe(8); // the correction's value, not the original 10
    expect(summary.exceptions.some((e) => e.lineKey === lineKey && /received 8.*expected 10/.test(e.message))).toBe(true);
  });

  it("a NON_INVENTORY line appears in items and nonInventory, but never in receiving", async () => {
    const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: "FUEL-SURCHARGE", description: "Fuel Surcharge" }],
    });
    const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);

    await approveLineClassificationNewItemRpc(fx.supabase, {
      purchaseDocumentId,
      lineKey,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      finalName: `TEST Fuel Surcharge ${purchaseDocumentId.slice(0, 8)}`,
      disposition: "NON_INVENTORY",
      categoryId: null,
      spendCategoryId,
      baseUnitCode: null,
      rememberVendorMapping: false,
    });

    const summary = await getPurchaseDocumentReviewSummary(fx.supabase, purchaseDocumentId, fx.organizationId);
    expect(summary.items.find((i) => i.lineKey === lineKey)?.disposition).toBe("NON_INVENTORY");
    expect(summary.nonInventory.find((n) => n.lineKey === lineKey)).toBeDefined();
    expect(summary.receiving.find((r) => r.lineKey === lineKey)).toBeUndefined();
  });

  it("shows a variable-measurement (MEASURE_EACH_DELIVERY) line's verified quantity correctly, and flags condition exceptions", async () => {
    const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: "SUMMARY-RADISH", description: "Summary Korean Radish", packageUnit: "BOX", measuredUnit: "LB" }],
    });
    const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);

    await approveLineClassificationNewItemRpc(fx.supabase, {
      purchaseDocumentId,
      lineKey,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      finalName: `TEST Summary Korean Radish ${purchaseDocumentId.slice(0, 8)}`,
      disposition: "INVENTORY",
      categoryId,
      spendCategoryId,
      baseUnitCode: "LB",
      purchaseUnitCode: "BOX",
      receivingBehavior: "MEASURE_EACH_DELIVERY",
      rememberVendorMapping: false,
    });

    const { data: units } = await fx.supabase.from("units").select("id").eq("code", "LB").single();
    await recordReceiptRpc(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      receiptKind: "DELIVERY",
      purchaseDocumentId,
      lines: [
        {
          lineNumberSnapshot: 1,
          matchedLineKey: lineKey,
          vendorSkuSnapshot: "SUMMARY-RADISH",
          descriptionSnapshot: "Summary Korean Radish",
          invoicePackageQuantity: 1,
          invoicePackageUnit: "BOX",
          invoiceMeasuredQuantity: null,
          invoiceMeasuredUnit: null,
          actualReceivedPackageQuantity: 1,
          actualReceivedPackageUnit: "BOX",
          actualVerifiedBaseQuantity: 38.6,
          actualVerifiedBaseUnitId: units!.id as string,
          locationId,
          conditionStatus: "DAMAGED",
        },
      ],
    });

    const summary = await getPurchaseDocumentReviewSummary(fx.supabase, purchaseDocumentId, fx.organizationId);
    const line = summary.receiving.find((r) => r.lineKey === lineKey);
    expect(line).toMatchObject({ requiresVerifiedMeasurement: true, verifiedQuantity: 38.6, verifiedUnit: "LB", receivedQuantity: 1, receivedUnit: "BOX" });
    expect(summary.exceptions.some((e) => e.lineKey === lineKey && /Damaged/.test(e.message))).toBe(true);
  });

  it("shows Inventory Quantity for a FIXED_CONVERSION line received in its packaging unit", async () => {
    const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: "SUMMARY-CASE-ITEM", description: "Summary Case Item", packageUnit: "CASE", measuredUnit: null }],
    });
    const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);

    await approveLineClassificationNewItemRpc(fx.supabase, {
      purchaseDocumentId,
      lineKey,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      finalName: `TEST Summary Case Item ${purchaseDocumentId.slice(0, 8)}`,
      disposition: "INVENTORY",
      categoryId,
      spendCategoryId,
      baseUnitCode: "PIECE",
      purchaseUnitCode: "CASE",
      receivingBehavior: "FIXED_CONVERSION",
      fixedConversionFactor: 12,
      rememberVendorMapping: false,
    });

    await recordReceiptRpc(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      receiptKind: "DELIVERY",
      purchaseDocumentId,
      lines: [
        {
          lineNumberSnapshot: 1,
          matchedLineKey: lineKey,
          vendorSkuSnapshot: "SUMMARY-CASE-ITEM",
          descriptionSnapshot: "Summary Case Item",
          invoicePackageQuantity: 2,
          invoicePackageUnit: "CASE",
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

    const summary = await getPurchaseDocumentReviewSummary(fx.supabase, purchaseDocumentId, fx.organizationId);
    const line = summary.receiving.find((r) => r.lineKey === lineKey);
    expect(line).toMatchObject({ receivedQuantity: 2, receivedUnit: "CASE", inventoryQuantity: 24, verifiedUnit: "PIECE" });
  });
});
