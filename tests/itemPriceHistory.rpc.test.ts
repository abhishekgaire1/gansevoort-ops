import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { setupRpcTestFixtures, setupOtherOrgFixtures, createTestVendor, type RpcTestFixtures } from "./testFixtures";
import { createDraftPurchaseDocumentWithLines, getLineKeys, findOrCreateThrowawaySpendCategory, findOrCreateNamedEmployee } from "./itemMasterTestHelpers";
import { createVerifiedPostingDocument } from "./inventoryPostingTestHelpers";
import { approveLineClassificationNewItemRpc } from "@/app/lib/itemMaster/approveLineClassificationNewItemRpc";
import { approveLineClassificationExistingItemRpc } from "@/app/lib/itemMaster/approveLineClassificationExistingItemRpc";
import { correctDocumentDeliveryVerifierRpc } from "@/app/lib/itemMaster/correctDocumentDeliveryVerifierRpc";
import { recordReceiptRpc } from "@/app/lib/receiving/recordReceiptRpc";
import { submitPurchaseDocumentForVerificationRpc } from "@/app/lib/purchaseDocuments/submitPurchaseDocumentForVerificationRpc";
import { verifyPurchaseDocumentRpc } from "@/app/lib/purchaseDocuments/verifyPurchaseDocumentRpc";
import { initiateAmendmentRpc } from "@/app/lib/purchaseDocuments/initiateAmendmentRpc";
import { postPurchaseDocumentInventoryRpc } from "@/app/lib/inventory/postingRpcs";
import { setVendorPurchasePackage, correctReceiptPackageFactor } from "@/app/lib/admin/vendorPackages";
import { recordInventoryCorrection } from "@/app/lib/inventory/corrections";
import { recordInventoryWaste } from "@/app/lib/inventory/waste";
import { listItemPriceHistory, getItemPriceHistorySummary } from "@/app/lib/inventory/priceHistory";

/**
 * MANUAL / ON-DEMAND ONLY -- see adminItemMaster.rpc.test.ts's header
 * comment (same convention).
 *
 * Vendor-aware Price History (get_item_price_history /
 * get_item_price_history_summary, 20260811100149) -- read-only
 * HISTORICAL purchase pricing, never an inventory valuation. Covers the
 * spec's test scenarios: same-unit/fixed-conversion/measured pricing,
 * multi-vendor package normalization, vendor/date filters, structural
 * exclusion of non-purchase writers (drafts, expense lines, manual
 * adjustments, waste -- transfers/cycle counts share the same
 * structural guarantee: only purchase_document_inventory_posting_lines
 * rows ever become events, and none of those writers create them),
 * amendment lineage (no duplicate event, Amended flag, current-revision
 * link), receipt corrections (corrected result + preserved original),
 * additional deliveries, cross-organization isolation, invalid-data
 * safety, keyset pagination, stable ordering, and read-only-ness
 * (viewing history changes no balance).
 */

let fx: RpcTestFixtures;
let locationId: string;
let categoryId: string;
let spendCategoryId: string;
let deliveryVerifierEmployeeId: string;

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
  const { data: location } = await fx.supabase.from("locations").select("id").eq("organization_id", fx.organizationId).limit(1).single();
  locationId = location!.id as string;
  const { data: item } = await fx.supabase.from("inventory_items").select("category_id").eq("id", fx.noRuleItemId).single();
  categoryId = item!.category_id as string;
  spendCategoryId = await findOrCreateThrowawaySpendCategory(fx.supabase, fx.organizationId);
  deliveryVerifierEmployeeId = await findOrCreateNamedEmployee(fx.supabase, fx.organizationId, "TEST Delivery Verifier");
});

/** Scalar exact-balance read -- deliberately NOT the shared
 * getLocationBalance helper; see inventoryCorrections.rpc.test.ts's
 * header comment on the PostgREST row-cap truncation of the unfiltered
 * inventory_location_balances listing against the shared fixture org. */
async function getScalarBalance(itemId: string): Promise<number> {
  const { data, error } = await fx.supabase.rpc("inventory_location_item_balance", {
    p_organization_id: fx.organizationId,
    p_inventory_item_id: itemId,
    p_location_id: locationId,
  });
  if (error) throw new Error(error.message);
  return Number(data);
}

interface BuiltDoc {
  purchaseDocumentId: string;
  documentId: string;
  lineKey: string;
  itemId: string;
  postingLineIds: string[];
}

/**
 * Full pipeline for ONE inventory line -- draft, classify (new item or
 * an EXISTING item so a second vendor can sell the same item in its own
 * package), receive, verify, post. Unlike the shared
 * createVerifiedPostingDocument, this takes the vendor, supports
 * existing-item classification, rememberVendorMapping (needed for the
 * package-correction workflow), and an invoiced-vs-received quantity
 * split (needed for the QUANTITY_MISMATCH safety case).
 */
async function buildPostedDoc(opts: {
  vendorId: string;
  existingItemId?: string;
  rememberVendorMapping?: boolean;
  behavior: "SAME_UNIT" | "FIXED_CONVERSION" | "MEASURE_EACH_DELIVERY";
  baseUnitCode: string;
  purchaseUnitCode?: string;
  fixedConversionFactor?: number;
  invoiceQuantity: number;
  receivedQuantity: number;
  receivedUnit: string;
  verifiedBaseQuantity?: number | null;
  skipPost?: boolean;
  /** Applied while the document is still DRAFT (lines lock at
   * READY_FOR_VERIFICATION) -- lets the invalid-data tests build a
   * posted event whose line amount is missing or a credit. */
  lineTotalOverride?: number | null;
}): Promise<BuiltDoc> {
  const supabase = fx.supabase;
  const runTag = randomUUID().slice(0, 8);
  const { purchaseDocumentId, documentId } = await createDraftPurchaseDocumentWithLines(supabase, {
    organizationId: fx.organizationId,
    vendorId: opts.vendorId,
    uploadedByAppUserId: fx.changeableEmployeeAppUserId,
    lines: [{ vendorSku: `PH-${runTag}`, description: `Price History ${runTag}`, packageUnit: opts.receivedUnit, packageQuantity: opts.invoiceQuantity }],
  });
  const [lineKey] = await getLineKeys(supabase, purchaseDocumentId);

  let itemId: string;
  if (opts.existingItemId) {
    await approveLineClassificationExistingItemRpc(supabase, {
      purchaseDocumentId,
      lineKey,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      inventoryItemId: opts.existingItemId,
      rememberVendorMapping: opts.rememberVendorMapping ?? false,
      purchaseUnitCode: opts.behavior === "SAME_UNIT" ? null : opts.purchaseUnitCode,
      receivingBehavior: opts.behavior === "SAME_UNIT" ? null : opts.behavior,
      fixedConversionFactor: opts.behavior === "FIXED_CONVERSION" ? opts.fixedConversionFactor : null,
    });
    itemId = opts.existingItemId;
  } else {
    const result = await approveLineClassificationNewItemRpc(supabase, {
      purchaseDocumentId,
      lineKey,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      finalName: `TEST PriceHistory ${runTag}`,
      disposition: "INVENTORY",
      categoryId,
      spendCategoryId,
      baseUnitCode: opts.baseUnitCode,
      purchaseUnitCode: opts.behavior === "SAME_UNIT" ? null : opts.purchaseUnitCode,
      receivingBehavior: opts.behavior === "SAME_UNIT" ? null : opts.behavior,
      fixedConversionFactor: opts.behavior === "FIXED_CONVERSION" ? opts.fixedConversionFactor : null,
      rememberVendorMapping: opts.rememberVendorMapping ?? false,
    });
    itemId = result.inventoryItemId;
  }

  if (opts.lineTotalOverride !== undefined) {
    const { error: overrideError } = await supabase
      .from("purchase_document_lines")
      .update({ line_total: opts.lineTotalOverride })
      .eq("purchase_document_id", purchaseDocumentId)
      .eq("line_key", lineKey);
    if (overrideError) throw new Error(`line_total override failed: ${overrideError.message}`);
  }

  await recordReceiptRpc(supabase, {
    organizationId: fx.organizationId,
    appUserId: fx.changeableEmployeeAppUserId,
    receiptKind: "DELIVERY",
    purchaseDocumentId,
    lines: [
      {
        lineNumberSnapshot: 1,
        matchedLineKey: lineKey,
        vendorSkuSnapshot: `PH-${runTag}`,
        descriptionSnapshot: `Price History ${runTag}`,
        invoicePackageQuantity: opts.invoiceQuantity,
        invoicePackageUnit: opts.receivedUnit,
        invoiceMeasuredQuantity: null,
        invoiceMeasuredUnit: null,
        actualReceivedPackageQuantity: opts.receivedQuantity,
        actualReceivedPackageUnit: opts.receivedUnit,
        actualVerifiedBaseQuantity: opts.verifiedBaseQuantity ?? null,
        actualVerifiedBaseUnitId: null,
        locationId,
      },
    ],
  });
  await correctDocumentDeliveryVerifierRpc(supabase, {
    documentId,
    organizationId: fx.organizationId,
    appUserId: fx.changeableEmployeeAppUserId,
    newEmployeeId: deliveryVerifierEmployeeId,
  });
  const submitted = await submitPurchaseDocumentForVerificationRpc(supabase, {
    purchaseDocumentId,
    organizationId: fx.organizationId,
    appUserId: fx.changeableEmployeeAppUserId,
    expectedVersion: 1,
  });
  await verifyPurchaseDocumentRpc(supabase, {
    purchaseDocumentId,
    organizationId: fx.organizationId,
    appUserId: fx.lockedEmployeeAppUserId,
    expectedVersion: submitted.version,
  });
  if (!opts.skipPost) {
    await postPurchaseDocumentInventoryRpc(supabase, { purchaseDocumentId, organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId });
  }
  return { purchaseDocumentId, documentId, lineKey, itemId, postingLineIds: await postingLineIdsFor(supabase, purchaseDocumentId) };
}

async function postingLineIdsFor(supabase: SupabaseClient, purchaseDocumentId: string): Promise<string[]> {
  const { data: postings } = await supabase
    .from("purchase_document_inventory_postings")
    .select("id")
    .eq("organization_id", fx.organizationId)
    .eq("purchase_document_id", purchaseDocumentId);
  const postingIds = (postings ?? []).map((p) => p.id as string);
  if (postingIds.length === 0) return [];
  const { data: lines } = await supabase.from("purchase_document_inventory_posting_lines").select("id").in("posting_id", postingIds);
  return (lines ?? []).map((l) => l.id as string);
}

describe("normalized pricing per receiving behavior", () => {
  it("same-unit purchase: price = line_total / posted base quantity, vendor and invoice link on the event (spec #1, #5, #17)", async () => {
    const doc = await buildPostedDoc({ vendorId: fx.vendorId, behavior: "SAME_UNIT", baseUnitCode: "PIECE", invoiceQuantity: 10, receivedQuantity: 10, receivedUnit: "PIECE" });
    const page = await listItemPriceHistory(fx.supabase, fx.organizationId, doc.itemId);
    expect(page.events).toHaveLength(1);
    const event = page.events[0];
    expect(event.purchaseDocumentId).toBe(doc.purchaseDocumentId);
    expect(event.currentRevisionId).toBe(doc.purchaseDocumentId);
    expect(event.isAmended).toBe(false);
    expect(event.vendorName).toBeTruthy();
    expect(event.authoritativeQuantity).toBe(10);
    expect(event.baseUnitCode).toBe("PIECE");
    expect(event.normalizedPrice).toBeCloseTo(10, 6);
    expect(event.priceUnavailableReason).toBeNull();
  });

  it("fixed conversion: 2 CASE x 24 posts 48 base units, price normalized to the base unit (spec #2)", async () => {
    const doc = await buildPostedDoc({
      vendorId: fx.vendorId,
      behavior: "FIXED_CONVERSION",
      baseUnitCode: "PIECE",
      purchaseUnitCode: "CASE",
      fixedConversionFactor: 24,
      invoiceQuantity: 2,
      receivedQuantity: 2,
      receivedUnit: "CASE",
    });
    const page = await listItemPriceHistory(fx.supabase, fx.organizationId, doc.itemId);
    expect(page.events).toHaveLength(1);
    const event = page.events[0];
    expect(event.authoritativeQuantity).toBe(48);
    expect(event.snapshotPurchaseUnitCode).toBe("CASE");
    expect(event.snapshotConversionFactor).toBe(24);
    expect(event.normalizedPrice).toBeCloseTo(100 / 48, 6);
  });

  it("measured at receiving: price uses the actual verified base quantity, never the invoice package count (spec #3)", async () => {
    const doc = await buildPostedDoc({
      vendorId: fx.vendorId,
      behavior: "MEASURE_EACH_DELIVERY",
      baseUnitCode: "LB",
      purchaseUnitCode: "CASE",
      invoiceQuantity: 2,
      receivedQuantity: 2,
      receivedUnit: "CASE",
      verifiedBaseQuantity: 37,
    });
    const page = await listItemPriceHistory(fx.supabase, fx.organizationId, doc.itemId);
    expect(page.events).toHaveLength(1);
    const event = page.events[0];
    expect(event.authoritativeQuantity).toBe(37);
    expect(event.normalizedPrice).toBeCloseTo(100 / 37, 6);
    expect(event.priceUnavailableReason).toBeNull();
  });
});

describe("multi-vendor normalization and filters", () => {
  let itemId: string;
  let vendorBId: string;
  let docA: BuiltDoc;
  let docB: BuiltDoc;

  beforeAll(async () => {
    vendorBId = await createTestVendor(fx.supabase, fx.organizationId, { namePrefix: "TEST PriceHistory Vendor B", runId: randomUUID().slice(0, 8) });
    docA = await buildPostedDoc({
      vendorId: fx.vendorId,
      behavior: "FIXED_CONVERSION",
      baseUnitCode: "PIECE",
      purchaseUnitCode: "CASE",
      fixedConversionFactor: 24,
      invoiceQuantity: 2,
      receivedQuantity: 2,
      receivedUnit: "CASE",
    });
    itemId = docA.itemId;
    docB = await buildPostedDoc({
      vendorId: vendorBId,
      existingItemId: itemId,
      behavior: "FIXED_CONVERSION",
      baseUnitCode: "PIECE",
      purchaseUnitCode: "CASE",
      fixedConversionFactor: 30,
      invoiceQuantity: 3,
      receivedQuantity: 3,
      receivedUnit: "CASE",
    });
  });

  it("each vendor's own package snapshot normalizes its own price -- 24/case vs 30/case never blended (spec #4, #5)", async () => {
    const page = await listItemPriceHistory(fx.supabase, fx.organizationId, itemId);
    expect(page.events).toHaveLength(2);
    for (const event of page.events) expect(event.vendorName).toBeTruthy();

    const eventA = page.events.find((e) => e.purchaseDocumentId === docA.purchaseDocumentId)!;
    const eventB = page.events.find((e) => e.purchaseDocumentId === docB.purchaseDocumentId)!;
    expect(eventA.authoritativeQuantity).toBe(48);
    expect(eventA.normalizedPrice).toBeCloseTo(100 / 48, 6);
    expect(eventA.snapshotConversionFactor).toBe(24);
    expect(eventB.authoritativeQuantity).toBe(90);
    expect(eventB.normalizedPrice).toBeCloseTo(100 / 90, 6);
    expect(eventB.snapshotConversionFactor).toBe(30);
    expect(eventA.vendorId).not.toBe(eventB.vendorId);
  });

  it("summary aggregates per vendor plus one overall row (vendor comparison basis)", async () => {
    const summary = await getItemPriceHistorySummary(fx.supabase, fx.organizationId, itemId, { startDate: null });
    expect(summary.overall).not.toBeNull();
    expect(summary.overall!.eventCount).toBe(2);
    expect(summary.vendors).toHaveLength(2);
    expect(summary.overall!.lowestPrice).toBeCloseTo(100 / 90, 6);
    expect(summary.overall!.highestPrice).toBeCloseTo(100 / 48, 6);
  });

  it("vendor filter narrows to one vendor's events (spec #6)", async () => {
    const page = await listItemPriceHistory(fx.supabase, fx.organizationId, itemId, { vendorId: vendorBId });
    expect(page.events).toHaveLength(1);
    expect(page.events[0].vendorId).toBe(vendorBId);
  });

  it("date-range filter includes and excludes by document date (spec #7)", async () => {
    // Fixture documents always carry document_date 2026-08-12.
    const inRange = await listItemPriceHistory(fx.supabase, fx.organizationId, itemId, { startDate: "2026-08-01", endDate: "2026-08-31" });
    expect(inRange.events).toHaveLength(2);
    const outOfRange = await listItemPriceHistory(fx.supabase, fx.organizationId, itemId, { startDate: "2026-09-01", endDate: "2026-09-30" });
    expect(outOfRange.events).toHaveLength(0);
  });

  it("newest-first ordering is stable and deterministic (spec #19)", async () => {
    const first = await listItemPriceHistory(fx.supabase, fx.organizationId, itemId);
    const second = await listItemPriceHistory(fx.supabase, fx.organizationId, itemId);
    expect(first.events.map((e) => `${e.purchaseDocumentId}:${e.lineKey}`)).toEqual(second.events.map((e) => `${e.purchaseDocumentId}:${e.lineKey}`));
    const times = first.events.map((e) => e.receivedAt);
    expect([...times].sort().reverse()).toEqual(times);
  });
});

describe("structural exclusions", () => {
  it("a classified but unposted draft contributes nothing (spec #8)", async () => {
    const posted = await buildPostedDoc({ vendorId: fx.vendorId, behavior: "SAME_UNIT", baseUnitCode: "PIECE", invoiceQuantity: 10, receivedQuantity: 10, receivedUnit: "PIECE" });
    const before = await listItemPriceHistory(fx.supabase, fx.organizationId, posted.itemId);
    expect(before.events).toHaveLength(1);

    // A second document classified against the same item but never
    // received/verified/posted.
    const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: `PH-DRAFT-${randomUUID().slice(0, 8)}`, description: "Draft never posted", packageUnit: "PIECE", packageQuantity: 5 }],
    });
    const [draftLineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);
    await approveLineClassificationExistingItemRpc(fx.supabase, {
      purchaseDocumentId,
      lineKey: draftLineKey,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      inventoryItemId: posted.itemId,
      rememberVendorMapping: false,
    });

    const after = await listItemPriceHistory(fx.supabase, fx.organizationId, posted.itemId);
    expect(after.events).toHaveLength(1);
    expect(after.events[0].purchaseDocumentId).toBe(posted.purchaseDocumentId);
  });

  it("an expense (NON_INVENTORY) line on a posted document contributes nothing (spec #9)", async () => {
    const verified = await createVerifiedPostingDocument(fx.supabase, fx, locationId, [
      { description: "PH Inventory Line", receiving: { behavior: "SAME_UNIT", baseUnitCode: "PIECE", receivedQuantity: 7, receivedUnit: "PIECE", locationId } },
      { description: "PH Expense Line", receiving: null },
    ]);
    await postPurchaseDocumentInventoryRpc(fx.supabase, { purchaseDocumentId: verified.purchaseDocumentId, organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId });
    const itemId = verified.itemIds[0]!;
    const page = await listItemPriceHistory(fx.supabase, fx.organizationId, itemId);
    expect(page.events).toHaveLength(1);
    expect(page.events[0].authoritativeQuantity).toBe(7);
  });

  it("manual adjustments and waste never appear and never move a purchase price (spec #10, #11 -- transfers/cycle counts share the same structural guarantee)", async () => {
    const doc = await buildPostedDoc({ vendorId: fx.vendorId, behavior: "SAME_UNIT", baseUnitCode: "PIECE", invoiceQuantity: 20, receivedQuantity: 20, receivedUnit: "PIECE" });
    const before = await listItemPriceHistory(fx.supabase, fx.organizationId, doc.itemId);

    await recordInventoryCorrection(fx.supabase, fx.changeableEmployeeAppUserId, doc.itemId, locationId, "DELTA", null, 5, "PH exclusion test adjustment", randomUUID());
    await recordInventoryWaste(fx.supabase, {
      recordedByAppUserId: fx.changeableEmployeeAppUserId,
      locationId,
      inventoryItemId: doc.itemId,
      quantity: "2",
      reasonCode: "SPOILED",
      note: null,
      clientRequestId: randomUUID(),
    });

    const after = await listItemPriceHistory(fx.supabase, fx.organizationId, doc.itemId);
    expect(after.events).toHaveLength(before.events.length);
    expect(after.events[0].authoritativeQuantity).toBe(20);
    expect(after.events[0].normalizedPrice).toBeCloseTo(100 / 20, 6);
    expect(after.events[0].hasCorrection).toBe(false);
  });
});

describe("amendments and corrections", () => {
  it("a verified amendment produces no duplicate event; the single event is flagged Amended and links to the current revision (spec #12)", async () => {
    const doc = await buildPostedDoc({ vendorId: fx.vendorId, behavior: "SAME_UNIT", baseUnitCode: "PIECE", invoiceQuantity: 10, receivedQuantity: 10, receivedUnit: "PIECE" });

    const amendment = await initiateAmendmentRpc(fx.supabase, {
      purchaseDocumentId: doc.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      reason: "PH amendment lineage test",
    });
    const [amendedLineKey] = await getLineKeys(fx.supabase, amendment.purchaseDocumentId);
    await approveLineClassificationExistingItemRpc(fx.supabase, {
      purchaseDocumentId: amendment.purchaseDocumentId,
      lineKey: amendedLineKey,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      inventoryItemId: doc.itemId,
      rememberVendorMapping: false,
    });
    await recordReceiptRpc(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      receiptKind: "DELIVERY",
      purchaseDocumentId: amendment.purchaseDocumentId,
      lines: [
        {
          lineNumberSnapshot: 1,
          matchedLineKey: amendedLineKey,
          vendorSkuSnapshot: "PH-AMEND",
          descriptionSnapshot: "Amended line",
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
    // The delivery verifier lives on the shared source document and was
    // already set for the original revision -- correcting it again after
    // verification is (correctly) locked, and unnecessary here.
    const { data: amendmentDocRow } = await fx.supabase.from("purchase_documents").select("version").eq("id", amendment.purchaseDocumentId).single();
    const submitted = await submitPurchaseDocumentForVerificationRpc(fx.supabase, {
      purchaseDocumentId: amendment.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      expectedVersion: amendmentDocRow!.version as number,
    });
    await verifyPurchaseDocumentRpc(fx.supabase, {
      purchaseDocumentId: amendment.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: submitted.version,
    });

    // The amendment lineage may post AT MOST once (GA075) -- re-posting
    // through the amendment must fail, never double the history.
    await expect(
      postPurchaseDocumentInventoryRpc(fx.supabase, {
        purchaseDocumentId: amendment.purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId,
      })
    ).rejects.toThrow();

    const page = await listItemPriceHistory(fx.supabase, fx.organizationId, doc.itemId);
    expect(page.events).toHaveLength(1);
    const event = page.events[0];
    expect(event.purchaseDocumentId).toBe(doc.purchaseDocumentId);
    expect(event.isAmended).toBe(true);
    expect(event.currentRevisionId).toBe(amendment.purchaseDocumentId);
    expect(event.normalizedPrice).toBeCloseTo(10, 6);
  });

  it("an authorized package-factor correction shows the corrected price while preserving the original quantity and reason (spec #13)", async () => {
    const doc = await buildPostedDoc({
      vendorId: fx.vendorId,
      rememberVendorMapping: true,
      behavior: "FIXED_CONVERSION",
      baseUnitCode: "PIECE",
      purchaseUnitCode: "CASE",
      fixedConversionFactor: 24,
      invoiceQuantity: 2,
      receivedQuantity: 2,
      receivedUnit: "CASE",
    });
    const { data: mapping } = await fx.supabase
      .from("vendor_item_mappings")
      .select("id")
      .eq("organization_id", fx.organizationId)
      .eq("vendor_id", fx.vendorId)
      .eq("inventory_item_id", doc.itemId)
      .eq("is_active", true)
      .single();
    const setResult = await setVendorPurchasePackage(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, mapping!.id as string, "CASE", "FIXED_CONVERSION", 30, false);
    await correctReceiptPackageFactor(
      fx.supabase,
      fx.organizationId,
      fx.changeableEmployeeAppUserId,
      doc.postingLineIds,
      setResult.vendorItemPurchaseUnitId,
      "Vendor package corrected",
      randomUUID()
    );

    const page = await listItemPriceHistory(fx.supabase, fx.organizationId, doc.itemId);
    expect(page.events).toHaveLength(1);
    const event = page.events[0];
    expect(event.hasCorrection).toBe(true);
    expect(event.postedBaseQuantity).toBe(48);
    expect(event.authoritativeQuantity).toBe(60);
    expect(event.normalizedPrice).toBeCloseTo(100 / 60, 6);
    expect(event.correctionReason).toBe("Vendor package corrected");
    expect(event.priceUnavailableReason).toBeNull();
  });

  it("an additional delivery on the same line folds into the SAME single price event (spec #14)", async () => {
    const doc = await buildPostedDoc({ vendorId: fx.vendorId, behavior: "SAME_UNIT", baseUnitCode: "PIECE", invoiceQuantity: 15, receivedQuantity: 10, receivedUnit: "PIECE" });

    await recordReceiptRpc(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      receiptKind: "DELIVERY",
      purchaseDocumentId: doc.purchaseDocumentId,
      lines: [
        {
          lineNumberSnapshot: 1,
          matchedLineKey: doc.lineKey,
          vendorSkuSnapshot: "PH-ADDL",
          descriptionSnapshot: "Additional delivery",
          invoicePackageQuantity: 15,
          invoicePackageUnit: "PIECE",
          invoiceMeasuredQuantity: null,
          invoiceMeasuredUnit: null,
          actualReceivedPackageQuantity: 5,
          actualReceivedPackageUnit: "PIECE",
          actualVerifiedBaseQuantity: null,
          actualVerifiedBaseUnitId: null,
          locationId,
        },
      ],
    });
    await postPurchaseDocumentInventoryRpc(fx.supabase, { purchaseDocumentId: doc.purchaseDocumentId, organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId });

    const page = await listItemPriceHistory(fx.supabase, fx.organizationId, doc.itemId);
    expect(page.events).toHaveLength(1);
    expect(page.events[0].authoritativeQuantity).toBe(15);
    expect(page.events[0].normalizedPrice).toBeCloseTo(100 / 15, 6);
  });
});

describe("safety, isolation, pagination, read-only", () => {
  it("cross-organization access yields zero rows in both directions (spec #15)", async () => {
    const other = await setupOtherOrgFixtures(fx.supabase);
    const doc = await buildPostedDoc({ vendorId: fx.vendorId, behavior: "SAME_UNIT", baseUnitCode: "PIECE", invoiceQuantity: 10, receivedQuantity: 10, receivedUnit: "PIECE" });

    const crossOrg = await listItemPriceHistory(fx.supabase, other.organizationId, doc.itemId);
    expect(crossOrg.events).toHaveLength(0);
    const crossOrgSummary = await getItemPriceHistorySummary(fx.supabase, other.organizationId, doc.itemId);
    expect(crossOrgSummary.overall).toBeNull();
  });

  it("missing or invalid line amounts and quantity mismatches surface as price-unavailable rows, never $0.00 (spec #16)", async () => {
    // Missing line amount (nulled while DRAFT -- lines lock at
    // READY_FOR_VERIFICATION, so history can only ever inherit this
    // state, never receive it after the fact).
    const missing = await buildPostedDoc({
      vendorId: fx.vendorId,
      behavior: "SAME_UNIT",
      baseUnitCode: "PIECE",
      invoiceQuantity: 10,
      receivedQuantity: 10,
      receivedUnit: "PIECE",
      lineTotalOverride: null,
    });
    let page = await listItemPriceHistory(fx.supabase, fx.organizationId, missing.itemId);
    expect(page.events).toHaveLength(1);
    expect(page.events[0].normalizedPrice).toBeNull();
    expect(page.events[0].priceUnavailableReason).toBe("MISSING_LINE_AMOUNT");

    // Summary aggregates only priced events -- an unpriced-only item has
    // no summary rather than a $0 one.
    const missingSummary = await getItemPriceHistorySummary(fx.supabase, fx.organizationId, missing.itemId);
    expect(missingSummary.overall).toBeNull();

    // Credit/negative amount.
    const credit = await buildPostedDoc({
      vendorId: fx.vendorId,
      behavior: "SAME_UNIT",
      baseUnitCode: "PIECE",
      invoiceQuantity: 10,
      receivedQuantity: 10,
      receivedUnit: "PIECE",
      lineTotalOverride: -25,
    });
    page = await listItemPriceHistory(fx.supabase, fx.organizationId, credit.itemId);
    expect(page.events[0].normalizedPrice).toBeNull();
    expect(page.events[0].priceUnavailableReason).toBe("NON_POSITIVE_LINE_AMOUNT");

    // Received quantity differing from the FIXED-snapshot expectation
    // without any correction -- price refused rather than fabricated
    // from a partial receipt (invoiced 3 CASE x 24 = 72 expected, only
    // 2 CASE = 48 posted).
    const short = await buildPostedDoc({
      vendorId: fx.vendorId,
      behavior: "FIXED_CONVERSION",
      baseUnitCode: "PIECE",
      purchaseUnitCode: "CASE",
      fixedConversionFactor: 24,
      invoiceQuantity: 3,
      receivedQuantity: 2,
      receivedUnit: "CASE",
    });
    page = await listItemPriceHistory(fx.supabase, fx.organizationId, short.itemId);
    expect(page.events).toHaveLength(1);
    expect(page.events[0].normalizedPrice).toBeNull();
    expect(page.events[0].priceUnavailableReason).toBe("QUANTITY_MISMATCH");

    // A line with NO vendor-package snapshot has no stored expectation:
    // per the spec's own formula ("line amount / authoritative base
    // quantity received") and its "missing conversion: do not guess"
    // rule, the price divides by what was actually received.
    const noSnapshot = await buildPostedDoc({
      vendorId: fx.vendorId,
      behavior: "SAME_UNIT",
      baseUnitCode: "PIECE",
      invoiceQuantity: 12,
      receivedQuantity: 10,
      receivedUnit: "PIECE",
    });
    page = await listItemPriceHistory(fx.supabase, fx.organizationId, noSnapshot.itemId);
    expect(page.events[0].normalizedPrice).toBeCloseTo(100 / 10, 6);
  });

  it("keyset pagination pages a long history without duplicates or gaps, newest first (spec #18, #19)", async () => {
    const first = await buildPostedDoc({ vendorId: fx.vendorId, behavior: "SAME_UNIT", baseUnitCode: "PIECE", invoiceQuantity: 10, receivedQuantity: 10, receivedUnit: "PIECE" });
    for (let i = 0; i < 2; i += 1) {
      await buildPostedDoc({ vendorId: fx.vendorId, existingItemId: first.itemId, behavior: "SAME_UNIT", baseUnitCode: "PIECE", invoiceQuantity: 10 + i, receivedQuantity: 10 + i, receivedUnit: "PIECE" });
    }

    // Page size 2 exercises the exact cursor mechanics that make the
    // listing immune to PostgREST's default row cap at any history size.
    const seen: string[] = [];
    let beforeReceivedAt: string | null = null;
    let beforeDocumentId: string | null = null;
    let beforeLineKey: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const { data, error } = await fx.supabase.rpc("get_item_price_history", {
        p_organization_id: fx.organizationId,
        p_inventory_item_id: first.itemId,
        p_limit: 2,
        p_before_received_at: beforeReceivedAt,
        p_before_document_id: beforeDocumentId,
        p_before_line_key: beforeLineKey,
      });
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as { out_purchase_document_id: string; out_line_key: string; out_received_at: string }[];
      if (rows.length === 0) break;
      for (const row of rows) seen.push(`${row.out_purchase_document_id}:${row.out_line_key}`);
      const last = rows[rows.length - 1];
      beforeReceivedAt = last.out_received_at;
      beforeDocumentId = last.out_purchase_document_id;
      beforeLineKey = last.out_line_key;
      if (rows.length < 2) break;
    }
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);

    const unpaged = await listItemPriceHistory(fx.supabase, fx.organizationId, first.itemId);
    expect(unpaged.events.map((e) => `${e.purchaseDocumentId}:${e.lineKey}`)).toEqual(seen);
  });

  it("viewing price history changes no inventory balance (spec #20)", async () => {
    const doc = await buildPostedDoc({ vendorId: fx.vendorId, behavior: "SAME_UNIT", baseUnitCode: "PIECE", invoiceQuantity: 10, receivedQuantity: 10, receivedUnit: "PIECE" });
    const before = await getScalarBalance(doc.itemId);
    await listItemPriceHistory(fx.supabase, fx.organizationId, doc.itemId);
    await getItemPriceHistorySummary(fx.supabase, fx.organizationId, doc.itemId);
    const after = await getScalarBalance(doc.itemId);
    expect(after).toBe(before);
    expect(after).toBe(10);
  });
});
