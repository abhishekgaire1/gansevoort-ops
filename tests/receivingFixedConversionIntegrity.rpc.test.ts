import { beforeAll, describe, expect, it } from "vitest";
import { recordReceiptRpc } from "@/app/lib/receiving/recordReceiptRpc";
import { approveLineClassificationNewItemRpc } from "@/app/lib/itemMaster/approveLineClassificationNewItemRpc";
import { FixedConversionQuantityMismatchError } from "@/app/lib/itemMaster/errors";
import { setupRpcTestFixtures, type RpcTestFixtures } from "./testFixtures";
import { createDraftPurchaseDocumentWithLines, getLineKeys, findOrCreateThrowawaySpendCategory } from "./itemMasterTestHelpers";

/**
 * MANUAL / ON-DEMAND ONLY -- see purchaseDocuments.rpc.test.ts's header
 * comment.
 *
 * Adversarial-review priority 3 (backend half, 20260811100061).
 * ReceivingPanel.tsx's Received Qty/Unit fields never recomputed the
 * derived FIXED_CONVERSION quantity on manual edit, so a shortage/excess
 * correction silently stored a stale, wrong base-unit quantity in the
 * append-only receipt_lines table. record_receipt now independently
 * recomputes/validates it server-side from the item's own current
 * inventory_item_units conversion factor, never trusting the client's
 * math -- these tests prove the append-only storage itself, not just the
 * client, actually holds the correct number.
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

/** A CONFIRMED FIXED_CONVERSION item: 1 CASE = 24 PIECE. */
async function createFixedConversionLine(): Promise<{ purchaseDocumentId: string; lineKey: string }> {
  const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
    organizationId: fx.organizationId,
    vendorId: fx.vendorId,
    uploadedByAppUserId: fx.changeableEmployeeAppUserId,
    lines: [{ vendorSku: `FC-${crypto.randomUUID().slice(0, 8)}`, description: "Fixed Conversion Integrity Item", packageUnit: "CASE", packageQuantity: 2 }],
  });
  const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);

  await approveLineClassificationNewItemRpc(fx.supabase, {
    purchaseDocumentId,
    lineKey,
    organizationId: fx.organizationId,
    appUserId: fx.changeableEmployeeAppUserId,
    finalName: `TEST Fixed Conversion Integrity ${purchaseDocumentId.slice(0, 8)}`,
    disposition: "INVENTORY",
    categoryId,
    spendCategoryId,
    baseUnitCode: "PIECE",
    purchaseUnitCode: "CASE",
    receivingBehavior: "FIXED_CONVERSION",
    fixedConversionFactor: 24,
    rememberVendorMapping: false,
  });

  return { purchaseDocumentId, lineKey };
}

describe("record_receipt FIXED_CONVERSION integrity (priority 3)", () => {
  it("2 CASE at 1 CASE = 24 PIECE stores 48 PIECE when the client math agrees", async () => {
    const { purchaseDocumentId, lineKey } = await createFixedConversionLine();

    const receipt = await recordReceiptRpc(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      receiptKind: "DELIVERY",
      purchaseDocumentId,
      lines: [
        {
          lineNumberSnapshot: 1,
          matchedLineKey: lineKey,
          vendorSkuSnapshot: "FC-ITEM",
          descriptionSnapshot: "Fixed Conversion Integrity Item",
          invoicePackageQuantity: 2,
          invoicePackageUnit: "CASE",
          invoiceMeasuredQuantity: null,
          invoiceMeasuredUnit: null,
          actualReceivedPackageQuantity: 2,
          actualReceivedPackageUnit: "CASE",
          actualVerifiedBaseQuantity: 48,
          actualVerifiedBaseUnitId: null,
          locationId,
        },
      ],
    });

    const { data: receiptLine } = await fx.supabase
      .from("receipt_lines")
      .select("actual_verified_base_quantity")
      .eq("receipt_id", receipt.receiptId)
      .eq("matched_line_key", lineKey)
      .single();
    expect(receiptLine!.actual_verified_base_quantity).toBe(48);
  });

  it("a manager correcting 2 CASE down to 1 CASE stores 24 PIECE in the append-only receipt, never a stale 48 -- the exact regression this priority fixes", async () => {
    const { purchaseDocumentId, lineKey } = await createFixedConversionLine();

    // Simulates the FIXED client: Received Qty/Unit corrected to 1 CASE,
    // and the derived quantity recomputed to 24 (recomputeFixedConversion
    // VerifiedQuantity's own job -- this RPC-level test proves the
    // AUTHORITATIVE backend half independently recomputes/accepts the
    // same correct number, not merely that the client computed it right).
    const receipt = await recordReceiptRpc(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      receiptKind: "DELIVERY",
      purchaseDocumentId,
      lines: [
        {
          lineNumberSnapshot: 1,
          matchedLineKey: lineKey,
          vendorSkuSnapshot: "FC-ITEM",
          descriptionSnapshot: "Fixed Conversion Integrity Item",
          invoicePackageQuantity: 2,
          invoicePackageUnit: "CASE",
          invoiceMeasuredQuantity: null,
          invoiceMeasuredUnit: null,
          actualReceivedPackageQuantity: 1,
          actualReceivedPackageUnit: "CASE",
          actualVerifiedBaseQuantity: 24,
          actualVerifiedBaseUnitId: null,
          conditionStatus: "SHORT",
          locationId,
        },
      ],
    });

    const { data: receiptLine } = await fx.supabase
      .from("receipt_lines")
      .select("actual_verified_base_quantity, actual_received_package_quantity")
      .eq("receipt_id", receipt.receiptId)
      .eq("matched_line_key", lineKey)
      .single();
    expect(receiptLine!.actual_received_package_quantity).toBe(1);
    expect(receiptLine!.actual_verified_base_quantity).toBe(24); // never 48
  });

  it("the server recomputes and stores the correct value even when the client sends none at all", async () => {
    const { purchaseDocumentId, lineKey } = await createFixedConversionLine();

    const receipt = await recordReceiptRpc(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      receiptKind: "DELIVERY",
      purchaseDocumentId,
      lines: [
        {
          lineNumberSnapshot: 1,
          matchedLineKey: lineKey,
          vendorSkuSnapshot: "FC-ITEM",
          descriptionSnapshot: "Fixed Conversion Integrity Item",
          invoicePackageQuantity: 2,
          invoicePackageUnit: "CASE",
          invoiceMeasuredQuantity: null,
          invoiceMeasuredUnit: null,
          actualReceivedPackageQuantity: 3,
          actualReceivedPackageUnit: "CASE",
          actualVerifiedBaseQuantity: null,
          actualVerifiedBaseUnitId: null,
          locationId,
        },
      ],
    });

    const { data: receiptLine } = await fx.supabase
      .from("receipt_lines")
      .select("actual_verified_base_quantity")
      .eq("receipt_id", receipt.receiptId)
      .eq("matched_line_key", lineKey)
      .single();
    expect(receiptLine!.actual_verified_base_quantity).toBe(72); // 3 * 24
  });

  it("rejects a client-supplied verified quantity that contradicts the server's own recomputation -- nothing is stored", async () => {
    const { purchaseDocumentId, lineKey } = await createFixedConversionLine();

    await expect(
      recordReceiptRpc(fx.supabase, {
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId,
        receiptKind: "DELIVERY",
        purchaseDocumentId,
        lines: [
          {
            lineNumberSnapshot: 1,
            matchedLineKey: lineKey,
            vendorSkuSnapshot: "FC-ITEM",
            descriptionSnapshot: "Fixed Conversion Integrity Item",
            invoicePackageQuantity: 2,
            invoicePackageUnit: "CASE",
            invoiceMeasuredQuantity: null,
            invoiceMeasuredUnit: null,
            actualReceivedPackageQuantity: 1,
            actualReceivedPackageUnit: "CASE",
            actualVerifiedBaseQuantity: 48, // stale -- should be 24
            actualVerifiedBaseUnitId: null,
            locationId,
          },
        ],
      })
    ).rejects.toThrow(FixedConversionQuantityMismatchError);

    const { data: receiptLines } = await fx.supabase.from("receipt_lines").select("id").eq("matched_line_key", lineKey);
    expect(receiptLines).toHaveLength(0); // nothing partial was written
  });

  it("rejects a received unit that matches neither the item's purchase unit nor its base unit", async () => {
    const { purchaseDocumentId, lineKey } = await createFixedConversionLine();

    await expect(
      recordReceiptRpc(fx.supabase, {
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId,
        receiptKind: "DELIVERY",
        purchaseDocumentId,
        lines: [
          {
            lineNumberSnapshot: 1,
            matchedLineKey: lineKey,
            vendorSkuSnapshot: "FC-ITEM",
            descriptionSnapshot: "Fixed Conversion Integrity Item",
            invoicePackageQuantity: 2,
            invoicePackageUnit: "CASE",
            invoiceMeasuredQuantity: null,
            invoiceMeasuredUnit: null,
            actualReceivedPackageQuantity: 1,
            actualReceivedPackageUnit: "GALLON", // neither CASE nor PIECE
            actualVerifiedBaseQuantity: null,
            actualVerifiedBaseUnitId: null,
            locationId,
          },
        ],
      })
    ).rejects.toThrow(FixedConversionQuantityMismatchError);
  });

  it("never touches MEASURE_EACH_DELIVERY -- the manager's own measured quantity remains authoritative, unvalidated against any conversion factor", async () => {
    const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: `MEASURE-${crypto.randomUUID().slice(0, 8)}`, description: "Measure Each Delivery Integrity Item", packageUnit: "BOX" }],
    });
    const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);
    await approveLineClassificationNewItemRpc(fx.supabase, {
      purchaseDocumentId,
      lineKey,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      finalName: `TEST Measure Integrity ${purchaseDocumentId.slice(0, 8)}`,
      disposition: "INVENTORY",
      categoryId,
      spendCategoryId,
      baseUnitCode: "LB",
      purchaseUnitCode: "BOX",
      receivingBehavior: "MEASURE_EACH_DELIVERY",
      rememberVendorMapping: false,
    });

    // A genuinely variable weight -- no fixed factor could ever predict
    // this, and none is required to.
    const receipt = await recordReceiptRpc(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      receiptKind: "DELIVERY",
      purchaseDocumentId,
      lines: [
        {
          lineNumberSnapshot: 1,
          matchedLineKey: lineKey,
          vendorSkuSnapshot: "MEASURE-ITEM",
          descriptionSnapshot: "Measure Each Delivery Integrity Item",
          invoicePackageQuantity: 1,
          invoicePackageUnit: "BOX",
          invoiceMeasuredQuantity: null,
          invoiceMeasuredUnit: null,
          actualReceivedPackageQuantity: 1,
          actualReceivedPackageUnit: "BOX",
          actualVerifiedBaseQuantity: 41.7,
          actualVerifiedBaseUnitId: null,
          locationId,
        },
      ],
    });

    const { data: receiptLine } = await fx.supabase
      .from("receipt_lines")
      .select("actual_verified_base_quantity")
      .eq("receipt_id", receipt.receiptId)
      .eq("matched_line_key", lineKey)
      .single();
    expect(receiptLine!.actual_verified_base_quantity).toBe(41.7); // untouched, manager's own measurement
  });
});
