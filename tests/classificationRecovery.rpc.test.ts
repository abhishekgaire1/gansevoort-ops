import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { approveLineClassificationExistingItemRpc } from "@/app/lib/itemMaster/approveLineClassificationExistingItemRpc";
import { getLinesNeedingClassification } from "@/app/lib/itemMaster/getLinesNeedingClassification";
import { setupRpcTestFixtures, type RpcTestFixtures } from "./testFixtures";
import { createDraftPurchaseDocumentWithLines, getLineKeys } from "./itemMasterTestHelpers";

/**
 * MANUAL / ON-DEMAND ONLY -- see purchaseDocuments.rpc.test.ts's header
 * comment.
 *
 * Proves the corrected set-based recovery-detection query (plan §4/§13)
 * against REAL Postgres data, not just a mocked supabase client (see
 * tests/getLinesNeedingClassification.unit.test.ts for the mocked
 * equivalent): a genuinely orphaned classification row -- one whose
 * line_key no longer matches any CURRENT purchase_document_lines row,
 * deliberately retained rather than cascaded away (20260811100037's own
 * design) -- must never mask a real, never-classified current line, even
 * though a naive line-count-vs-classification-count comparison would see
 * the counts as equal or classification-heavy and wrongly conclude nothing
 * needs classification.
 */

let fx: RpcTestFixtures;

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
});

describe("classification recovery detection (real Postgres)", () => {
  it("is not fooled by an orphaned classification row even though it makes the row counts equal", async () => {
    const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [
        { vendorSku: "SKU-CONFIRMED", description: "Confirmed Line" },
        { vendorSku: "SKU-NEW", description: "Never Classified Line" },
      ],
    });
    const [confirmedLineKey, neverClassifiedLineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);

    // Line 1 gets a real CONFIRMED classification against a real item.
    await approveLineClassificationExistingItemRpc(fx.supabase, {
      purchaseDocumentId,
      lineKey: confirmedLineKey,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      inventoryItemId: fx.noRuleItemId,
      rememberVendorMapping: false,
    });

    // A genuinely orphaned classification row -- its line_key does not
    // (and never did) match any current line on this purchase_document,
    // exactly the shape a removed-then-resaved line leaves behind.
    const { error: orphanError } = await fx.supabase.from("purchase_document_line_classifications").insert({
      organization_id: fx.organizationId,
      purchase_document_id: purchaseDocumentId,
      line_key: randomUUID(),
      disposition: "INVENTORY",
      inventory_item_id: fx.noRuleItemId,
      resolution_source: "MANUAL",
      status: "CONFIRMED",
    });
    expect(orphanError).toBeNull();

    // Row counts are now EQUAL (2 lines, 2 classification rows) -- a naive
    // "line count > classification count" check would wrongly conclude
    // nothing needs classification. The correct set-based check must still
    // flag line 2.
    const needing = await getLinesNeedingClassification(fx.supabase, purchaseDocumentId, fx.organizationId);
    expect(needing.map((l) => l.lineKey)).toEqual([neverClassifiedLineKey]);
  });

  it("does not flag a PENDING_REVIEW line as needing a re-run", async () => {
    const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: "SKU-PENDING", description: "Awaiting Manager Review" }],
    });
    const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);

    const { error } = await fx.supabase.from("purchase_document_line_classifications").insert({
      organization_id: fx.organizationId,
      purchase_document_id: purchaseDocumentId,
      line_key: lineKey,
      disposition: "INVENTORY",
      ai_suggested_inventory_item_id: fx.noRuleItemId,
      resolution_source: "AI_SUGGESTED",
      status: "PENDING_REVIEW",
    });
    expect(error).toBeNull();

    const needing = await getLinesNeedingClassification(fx.supabase, purchaseDocumentId, fx.organizationId);
    expect(needing).toEqual([]);
  });

  it("flags a STALE line for re-resolution", async () => {
    const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: "SKU-STALE", description: "Will Go Stale" }],
    });
    const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);

    await approveLineClassificationExistingItemRpc(fx.supabase, {
      purchaseDocumentId,
      lineKey,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      inventoryItemId: fx.noRuleItemId,
      rememberVendorMapping: false,
    });

    // Force STALE directly -- the invalidation trigger itself is proven by
    // its own migration/tests; here we only need a STALE row to exist to
    // prove the recovery query picks it up.
    const { error } = await fx.supabase
      .from("purchase_document_line_classifications")
      .update({ status: "STALE" })
      .eq("organization_id", fx.organizationId)
      .eq("purchase_document_id", purchaseDocumentId)
      .eq("line_key", lineKey);
    expect(error).toBeNull();

    const needing = await getLinesNeedingClassification(fx.supabase, purchaseDocumentId, fx.organizationId);
    expect(needing.map((l) => l.lineKey)).toEqual([lineKey]);
  });
});
