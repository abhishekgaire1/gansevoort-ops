import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { approveLineClassificationNewItemRpc } from "@/app/lib/itemMaster/approveLineClassificationNewItemRpc";
import { confirmReceivingLineInvoiceUnitRpc } from "@/app/lib/receiving/confirmReceivingLineInvoiceUnitRpc";
import { getReceivingLines } from "@/app/lib/receiving/getReceivingLines";
import { computeReceivingPrefill } from "@/app/lib/receiving/computeReceivingPrefill";
import { setupRpcTestFixtures, setupOtherOrgFixtures, type RpcTestFixtures, type OtherOrgFixtures } from "./testFixtures";
import { createDraftPurchaseDocumentWithLines, getLineKeys, findOrCreateThrowawaySpendCategory } from "./itemMasterTestHelpers";

/**
 * MANUAL / ON-DEMAND ONLY -- see purchaseDocuments.rpc.test.ts's header
 * comment.
 *
 * Direct tests of the confirmed vendor invoice-unit workflow
 * (20260811100054) against real Postgres -- the exact real Bartlett "HEAVY
 * CREAM 40% QUART (12)" case (package_quantity=48, package_unit=null) that
 * an inline manager confirmation in Step 3 -- Receive Delivery resolves
 * once, then remembers, without ever letting the item's packaging config
 * (1 CASE = 12 PIECE) substitute for what the invoice itself means.
 *
 * Every test group below uses its OWN unique vendor_sku (never a shared
 * one across groups) so intentional cross-test/cross-document sequencing
 * within a group (e.g. "a later confirmation must not rewrite an earlier
 * document's snapshot") is never confused with accidental fixture
 * collision between UNRELATED groups -- the exact lesson from this
 * session's earlier flaky-fixture bug (deriving shared test identifiers
 * positionally/by reuse instead of by an explicit, test-owned identifier).
 */

let fx: RpcTestFixtures;
let otherOrg: OtherOrgFixtures;
let categoryId: string;
let spendCategoryId: string;
let pieceUnitId: string;
let caseUnitId: string;

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
  otherOrg = await setupOtherOrgFixtures(fx.supabase);

  const { data: item } = await fx.supabase.from("inventory_items").select("category_id").eq("id", fx.noRuleItemId).single();
  categoryId = item!.category_id as string;
  spendCategoryId = await findOrCreateThrowawaySpendCategory(fx.supabase, fx.organizationId);

  const { data: units } = await fx.supabase.from("units").select("id, code").in("code", ["PIECE", "CASE"]);
  const unitIdByCode = new Map((units ?? []).map((u) => [u.code as string, u.id as string]));
  pieceUnitId = unitIdByCode.get("PIECE")!;
  caseUnitId = unitIdByCode.get("CASE")!;
});

/** Creates a fresh purchase document with one CONFIRMED INVENTORY
 * FIXED_CONVERSION line -- base unit PIECE, purchase unit CASE, 1 CASE =
 * 12 PIECE -- the exact real Heavy Cream shape, for a given (test-owned)
 * vendor_sku. */
async function createAmbiguousLine(opts: {
  vendorSku: string;
  packageQuantity: number;
  packageUnit?: string | null;
  rememberVendorMapping: boolean;
}): Promise<{ purchaseDocumentId: string; lineKey: string }> {
  const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
    organizationId: fx.organizationId,
    vendorId: fx.vendorId,
    uploadedByAppUserId: fx.changeableEmployeeAppUserId,
    lines: [{ vendorSku: opts.vendorSku, description: "HEAVY CREAM 40% QUART (12)", packageUnit: opts.packageUnit ?? null, packageQuantity: opts.packageQuantity }],
  });
  const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);
  await approveLineClassificationNewItemRpc(fx.supabase, {
    purchaseDocumentId,
    lineKey,
    organizationId: fx.organizationId,
    appUserId: fx.changeableEmployeeAppUserId,
    finalName: `TEST Heavy Cream ${purchaseDocumentId.slice(0, 8)}`,
    disposition: "INVENTORY",
    categoryId,
    spendCategoryId,
    baseUnitCode: "PIECE",
    purchaseUnitCode: "CASE",
    receivingBehavior: "FIXED_CONVERSION",
    fixedConversionFactor: 12,
    rememberVendorMapping: opts.rememberVendorMapping,
  });
  return { purchaseDocumentId, lineKey };
}

async function vendorMapping(vendorSku: string): Promise<{ id: string; confirmedInvoiceUnitId: string | null } | null> {
  const { data } = await fx.supabase
    .from("vendor_item_mappings")
    .select("id, confirmed_invoice_unit_id")
    .eq("organization_id", fx.organizationId)
    .eq("vendor_id", fx.vendorId)
    .eq("vendor_sku", vendorSku)
    .eq("match_basis", "VENDOR_SKU")
    .eq("is_active", true)
    .maybeSingle();
  if (!data) return null;
  return { id: data.id as string, confirmedInvoiceUnitId: (data.confirmed_invoice_unit_id as string | null) ?? null };
}

async function auditCount(mappingId: string): Promise<number> {
  const { count } = await fx.supabase
    .from("audit_events")
    .select("id", { count: "exact", head: true })
    .eq("entity_id", mappingId)
    .eq("action", "VENDOR_ITEM_MAPPING_INVOICE_UNIT_CHANGED");
  return count ?? 0;
}

async function lineFromReceivingLines(purchaseDocumentId: string, lineKey: string) {
  const lines = await getReceivingLines(fx.supabase, purchaseDocumentId, fx.organizationId);
  const found = lines.find((l) => l.lineKey === lineKey);
  if (!found) throw new Error(`line ${lineKey} not found in getReceivingLines(${purchaseDocumentId})`);
  return found;
}

describe("confirm_receiving_line_invoice_unit", () => {
  describe("first confirmation, current-invoice snapshot, vendor memory, and future auto-resolution", () => {
    const vendorSku = `SKU-AB-${randomUUID().slice(0, 8)}`;
    let doc1: { purchaseDocumentId: string; lineKey: string };
    let firstConfirmResult: { lineConfirmationRecorded: boolean; vendorMappingUpdated: boolean };

    beforeAll(async () => {
      doc1 = await createAmbiguousLine({ vendorSku, packageQuantity: 48, packageUnit: null, rememberVendorMapping: true });
      firstConfirmResult = await confirmReceivingLineInvoiceUnitRpc(fx.supabase, {
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId,
        purchaseDocumentId: doc1.purchaseDocumentId,
        lineKey: doc1.lineKey,
        confirmedInvoiceUnitCode: "PIECE",
        rememberForVendor: true,
      });
    });

    it("first ambiguous Bartlett line can confirm PIECE", () => {
      expect(firstConfirmResult).toEqual({ lineConfirmationRecorded: true, vendorMappingUpdated: true });
    });

    it("current invoice retains quantity 48 + unit PIECE", async () => {
      const line = await lineFromReceivingLines(doc1.purchaseDocumentId, doc1.lineKey);
      expect(line.invoicePackageQuantity).toBe(48);
      expect(line.confirmedInvoiceUnitCode).toBe("PIECE");

      const prefill = computeReceivingPrefill(line);
      expect(prefill).toEqual({ receivedQuantity: "48", receivedUnit: "PIECE", verifiedQuantity: "48", conflict: null });
    });

    it("vendor mapping remembers PIECE", async () => {
      const mapping = await vendorMapping(vendorSku);
      expect(mapping?.confirmedInvoiceUnitId).toBe(pieceUnitId);
    });

    it("(test 4) future Bartlett SKU with missing unit resolves automatically to PIECE, with no manager RPC call for this new line at all", async () => {
      const doc2 = await createAmbiguousLine({ vendorSku, packageQuantity: 60, packageUnit: null, rememberVendorMapping: false });
      const line = await lineFromReceivingLines(doc2.purchaseDocumentId, doc2.lineKey);
      expect(line.confirmedInvoiceUnitCode).toBe("PIECE");

      const prefill = computeReceivingPrefill(line);
      expect(prefill).toEqual({ receivedQuantity: "60", receivedUnit: "PIECE", verifiedQuantity: "60", conflict: null });
    });

    it("(test 5) CASE=12 PIECE packaging remains a separate fact -- the auto-resolved future line's verified quantity is 60, never 720", async () => {
      const doc2 = await createAmbiguousLine({ vendorSku, packageQuantity: 60, packageUnit: null, rememberVendorMapping: false });
      const line = await lineFromReceivingLines(doc2.purchaseDocumentId, doc2.lineKey);
      const prefill = computeReceivingPrefill(line);
      expect(prefill.verifiedQuantity).toBe("60"); // NOT 60 * 12 = 720
    });
  });

  it("changing vendor remembered unit does not rewrite an earlier, already-confirmed historical invoice line", async () => {
    const vendorSku = `SKU-C-${randomUUID().slice(0, 8)}`;
    const doc1 = await createAmbiguousLine({ vendorSku, packageQuantity: 48, packageUnit: null, rememberVendorMapping: true });
    await confirmReceivingLineInvoiceUnitRpc(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      purchaseDocumentId: doc1.purchaseDocumentId,
      lineKey: doc1.lineKey,
      confirmedInvoiceUnitCode: "PIECE",
      rememberForVendor: true,
    });

    // A later, unrelated document for the same vendor_sku changes the
    // vendor's remembered default to CASE.
    const doc2 = await createAmbiguousLine({ vendorSku, packageQuantity: 4, packageUnit: null, rememberVendorMapping: false });
    const changeResult = await confirmReceivingLineInvoiceUnitRpc(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      purchaseDocumentId: doc2.purchaseDocumentId,
      lineKey: doc2.lineKey,
      confirmedInvoiceUnitCode: "CASE",
      rememberForVendor: true,
    });
    expect(changeResult.vendorMappingUpdated).toBe(true);

    const mapping = await vendorMapping(vendorSku);
    expect(mapping?.confirmedInvoiceUnitId).toBe(caseUnitId);

    // doc1's line -- already permanently confirmed as PIECE -- is
    // completely unaffected by the vendor-wide change.
    const doc1Line = await lineFromReceivingLines(doc1.purchaseDocumentId, doc1.lineKey);
    expect(doc1Line.confirmedInvoiceUnitCode).toBe("PIECE");
  });

  it("(test 7) an explicit future invoice unit of CASE conflicting with a remembered PIECE surfaces a review conflict, never a silent pick", async () => {
    const vendorSku = `SKU-D-${randomUUID().slice(0, 8)}`;
    const doc1 = await createAmbiguousLine({ vendorSku, packageQuantity: 48, packageUnit: null, rememberVendorMapping: true });
    await confirmReceivingLineInvoiceUnitRpc(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      purchaseDocumentId: doc1.purchaseDocumentId,
      lineKey: doc1.lineKey,
      confirmedInvoiceUnitCode: "PIECE",
      rememberForVendor: true,
    });

    const doc2 = await createAmbiguousLine({ vendorSku, packageQuantity: 5, packageUnit: "CASE", rememberVendorMapping: false });
    const line = await lineFromReceivingLines(doc2.purchaseDocumentId, doc2.lineKey);
    expect(line.invoicePackageUnit).toBe("CASE");
    expect(line.confirmedInvoiceUnitCode).toBe("PIECE");

    const prefill = computeReceivingPrefill(line);
    expect(prefill).toEqual({ receivedQuantity: "", receivedUnit: "", verifiedQuantity: "", conflict: { invoiceUnit: "CASE", rememberedUnit: "PIECE" } });
  });

  it("manager can decline Remember for future -- the current-line snapshot is still recorded, but the vendor's memory stays untouched", async () => {
    const vendorSku = `SKU-E-${randomUUID().slice(0, 8)}`;
    const doc1 = await createAmbiguousLine({ vendorSku, packageQuantity: 48, packageUnit: null, rememberVendorMapping: true });

    const result = await confirmReceivingLineInvoiceUnitRpc(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      purchaseDocumentId: doc1.purchaseDocumentId,
      lineKey: doc1.lineKey,
      confirmedInvoiceUnitCode: "PIECE",
      rememberForVendor: false,
    });

    expect(result).toEqual({ lineConfirmationRecorded: true, vendorMappingUpdated: false });

    const mapping = await vendorMapping(vendorSku);
    expect(mapping?.confirmedInvoiceUnitId).toBeNull();

    const line = await lineFromReceivingLines(doc1.purchaseDocumentId, doc1.lineKey);
    expect(line.confirmedInvoiceUnitCode).toBe("PIECE"); // from the line-level snapshot, not vendor memory
  });

  it("confirming the same remembered value again is a quiet no-op -- no extra history row, no extra audit event", async () => {
    const vendorSku = `SKU-F-${randomUUID().slice(0, 8)}`;
    const doc1 = await createAmbiguousLine({ vendorSku, packageQuantity: 48, packageUnit: null, rememberVendorMapping: true });

    const first = await confirmReceivingLineInvoiceUnitRpc(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      purchaseDocumentId: doc1.purchaseDocumentId,
      lineKey: doc1.lineKey,
      confirmedInvoiceUnitCode: "PIECE",
      rememberForVendor: true,
    });
    expect(first).toEqual({ lineConfirmationRecorded: true, vendorMappingUpdated: true });

    const mapping = await vendorMapping(vendorSku);
    expect(await auditCount(mapping!.id)).toBe(1);

    const second = await confirmReceivingLineInvoiceUnitRpc(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      purchaseDocumentId: doc1.purchaseDocumentId,
      lineKey: doc1.lineKey,
      confirmedInvoiceUnitCode: "PIECE",
      rememberForVendor: true,
    });
    expect(second).toEqual({ lineConfirmationRecorded: false, vendorMappingUpdated: false });
    expect(await auditCount(mapping!.id)).toBe(1);
  });

  it("rejects cross-org access -- a different organization cannot confirm a unit for another org's purchase document line", async () => {
    const vendorSku = `SKU-G-${randomUUID().slice(0, 8)}`;
    const doc1 = await createAmbiguousLine({ vendorSku, packageQuantity: 48, packageUnit: null, rememberVendorMapping: false });

    await expect(
      confirmReceivingLineInvoiceUnitRpc(fx.supabase, {
        organizationId: otherOrg.organizationId,
        appUserId: otherOrg.appUserId,
        purchaseDocumentId: doc1.purchaseDocumentId,
        lineKey: doc1.lineKey,
        confirmedInvoiceUnitCode: "PIECE",
        rememberForVendor: false,
      })
    ).rejects.toThrow();
  });

  it("rejects a unit code that does not exist", async () => {
    const vendorSku = `SKU-H-${randomUUID().slice(0, 8)}`;
    const doc1 = await createAmbiguousLine({ vendorSku, packageQuantity: 48, packageUnit: null, rememberVendorMapping: false });

    await expect(
      confirmReceivingLineInvoiceUnitRpc(fx.supabase, {
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId,
        purchaseDocumentId: doc1.purchaseDocumentId,
        lineKey: doc1.lineKey,
        confirmedInvoiceUnitCode: "NOT_A_REAL_UNIT",
        rememberForVendor: false,
      })
    ).rejects.toThrow();
  });
});
