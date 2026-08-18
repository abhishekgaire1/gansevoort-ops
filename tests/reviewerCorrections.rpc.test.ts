import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { applyReceivingEdits, getEffectiveReceivingLines } from "@/app/lib/receiving/effectiveReceivingEdit";
import { approveLineClassificationExistingItemRpc } from "@/app/lib/itemMaster/approveLineClassificationExistingItemRpc";
import { verifyPurchaseDocumentRpc } from "@/app/lib/purchaseDocuments/verifyPurchaseDocumentRpc";
import { returnPurchaseDocumentToDraftRpc } from "@/app/lib/purchaseDocuments/returnPurchaseDocumentToDraftRpc";
import { saveReviewCorrectionsRpc } from "@/app/lib/purchaseDocuments/saveReviewCorrectionsRpc";
import { saveReviewProposalsRpc } from "@/app/lib/purchaseDocuments/saveReviewProposalsRpc";
import { withdrawPurchaseDocumentSubmissionRpc } from "@/app/lib/purchaseDocuments/withdrawPurchaseDocumentSubmissionRpc";
import {
  CannotSelfVerifyError,
  StaleVersionError,
  PreparationIncompleteError,
  ReviewProposalsConflictError,
  ReviewProposalsOwnedElsewhereError,
  StaleReviewProposalsError,
} from "@/app/lib/purchaseDocuments/errors";
import { approveLineClassificationNewItemRpc } from "@/app/lib/itemMaster/approveLineClassificationNewItemRpc";
import { correctDocumentDeliveryVerifierRpc } from "@/app/lib/itemMaster/correctDocumentDeliveryVerifierRpc";
import { recordReceiptRpc } from "@/app/lib/receiving/recordReceiptRpc";
import { setupRpcTestFixtures, type RpcTestFixtures } from "./testFixtures";
import { createSubmittedPostingDocument, createVerifiedPostingDocument, type SubmittedPostingDocument } from "./inventoryPostingTestHelpers";
import {
  createDraftPurchaseDocumentWithLines,
  confirmAllCurrentLinesNonInventory,
  getLineKeys,
  findOrCreateNamedEmployee,
  findOrCreateThrowawaySpendCategory,
} from "./itemMasterTestHelpers";
import { submitPurchaseDocumentForVerificationRpc } from "@/app/lib/purchaseDocuments/submitPurchaseDocumentForVerificationRpc";
import type { PurchaseDocumentHeaderDraft, PurchaseDocumentLine } from "@/app/lib/purchaseDocuments/types";

/**
 * MANUAL / ON-DEMAND ONLY -- see purchaseDocuments.rpc.test.ts's header
 * comment.
 *
 * Manager 2's correction-overlay model (20260811100071). CORE RULE:
 *
 *   Manager 1 submitted snapshot + Manager 2 proposed corrections
 *     = review working state
 *   ONLY Final Verify promotes that state into the VERIFIED
 *   authoritative state.
 *
 * Reviewer mapping/receiving corrections live in
 * purchase_document_review_proposals as explicitly-provisional state:
 * persisted (refresh-safe) but NEVER authoritative -- effective receipts
 * and confirmed classifications stay exactly Manager 1's until
 * verify_purchase_document promotes the overlay atomically (through the
 * same audited approval RPC and append-only receipt-correction model),
 * re-runs the authoritative gates on the promoted state, and only then
 * transitions to VERIFIED. Direct reviewer writes through the receipt/
 * classification RPCs during final review are rejected server-side.
 * Return to Preparer promotes nothing: the submitted snapshot is
 * restored and pending proposals survive only inside the RETURNED audit
 * event.
 */

let fx: RpcTestFixtures;
let locationId: string;

/** Preparer: changeableEmployee (uploads + submits). Reviewer:
 * lockedEmployee (a different manager). */
beforeAll(async () => {
  fx = await setupRpcTestFixtures();
  const { data: location } = await fx.supabase.from("locations").select("id").eq("organization_id", fx.organizationId).limit(1).single();
  locationId = location!.id as string;
});

/** The document's CURRENT persisted header/lines, shaped as the verify
 * payload -- what the review UI's working copy holds after a refresh. */
async function currentPayload(supabase: SupabaseClient, purchaseDocumentId: string): Promise<{ header: PurchaseDocumentHeaderDraft; lines: PurchaseDocumentLine[] }> {
  const { data: headerRow } = await supabase
    .from("purchase_documents")
    .select("vendor_id, document_type, document_number, document_date, po_number, delivery_date, subtotal, tax, fees, total, currency")
    .eq("id", purchaseDocumentId)
    .single();
  const { data: lineRows } = await supabase
    .from("purchase_document_lines")
    .select("line_key, vendor_sku, description, package_quantity, package_unit, measured_quantity, measured_unit, unit_price, price_basis_unit, line_total")
    .eq("purchase_document_id", purchaseDocumentId)
    .order("line_number");
  return {
    header: {
      vendorId: headerRow!.vendor_id as string | null,
      documentType: (headerRow!.document_type as PurchaseDocumentHeaderDraft["documentType"]) ?? null,
      documentNumber: headerRow!.document_number as string | null,
      documentDate: headerRow!.document_date as string | null,
      poNumber: headerRow!.po_number as string | null,
      deliveryDate: headerRow!.delivery_date as string | null,
      subtotal: headerRow!.subtotal === null ? null : Number(headerRow!.subtotal),
      tax: headerRow!.tax === null ? null : Number(headerRow!.tax),
      fees: headerRow!.fees === null ? null : Number(headerRow!.fees),
      total: headerRow!.total === null ? null : Number(headerRow!.total),
      currency: headerRow!.currency as string | null,
    },
    lines: (lineRows ?? []).map((row) => ({
      lineKey: row.line_key as string,
      vendorSku: row.vendor_sku as string | null,
      description: row.description as string | null,
      packageQuantity: row.package_quantity === null ? null : Number(row.package_quantity),
      packageUnit: row.package_unit as string | null,
      measuredQuantity: row.measured_quantity === null ? null : Number(row.measured_quantity),
      measuredUnit: row.measured_unit as string | null,
      unitPrice: row.unit_price === null ? null : Number(row.unit_price),
      priceBasisUnit: row.price_basis_unit as string | null,
      lineTotal: row.line_total === null ? null : Number(row.line_total),
      rawLineText: null,
    })),
  };
}

async function receiptRows(purchaseDocumentId: string): Promise<{ receipt_kind: string; corrects_receipt_id: string | null; idempotency_key: string | null }[]> {
  const { data } = await fx.supabase
    .from("receipts")
    .select("receipt_kind, corrects_receipt_id, idempotency_key")
    .eq("purchase_document_id", purchaseDocumentId)
    .eq("organization_id", fx.organizationId);
  return data ?? [];
}

async function classificationOf(purchaseDocumentId: string, lineKey: string): Promise<{ inventory_item_id: string | null; status: string }> {
  const { data } = await fx.supabase
    .from("purchase_document_line_classifications")
    .select("inventory_item_id, status")
    .eq("purchase_document_id", purchaseDocumentId)
    .eq("line_key", lineKey)
    .single();
  return data as { inventory_item_id: string | null; status: string };
}

async function overlayRow(purchaseDocumentId: string): Promise<Record<string, unknown> | null> {
  const { data } = await fx.supabase
    .from("purchase_document_review_proposals")
    .select("mapping_proposals, receiving_proposals, proposed_by_app_user_id")
    .eq("organization_id", fx.organizationId)
    .eq("purchase_document_id", purchaseDocumentId)
    .maybeSingle();
  return data as Record<string, unknown> | null;
}

/** A submitted doc with TWO independently-mapped SAME_UNIT PIECE lines --
 * remapping line 0 to line 1's item keeps completeness intact. */
async function twoLineSubmittedDoc(): Promise<SubmittedPostingDocument> {
  return createSubmittedPostingDocument(fx.supabase, fx, locationId, [
    { description: "Rvw Line A", receiving: { behavior: "SAME_UNIT", baseUnitCode: "PIECE", receivedQuantity: 72, receivedUnit: "PIECE" } },
    { description: "Rvw Line B", receiving: { behavior: "SAME_UNIT", baseUnitCode: "PIECE", receivedQuantity: 5, receivedUnit: "PIECE" } },
  ]);
}

describe("proposals are provisional -- nothing becomes authoritative before Final Verify", () => {
  it("test 1: a saved receiving proposal changes NO effective receipt, and a direct reviewer receipt correction during READY is rejected", async () => {
    const doc = await twoLineSubmittedDoc();
    const effective = await getEffectiveReceivingLines(fx.supabase, doc.purchaseDocumentId, fx.organizationId);
    const target = effective.find((line) => line.matchedLineKey === doc.lineKeys[0])!;

    const saved = await saveReviewProposalsRpc(fx.supabase, {
      purchaseDocumentId: doc.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: 0,
      mappingProposals: {},
      receivingProposals: {
        [target.receiptLineId]: { receivedQuantity: 70, receivedUnit: "PIECE", verifiedBaseQuantity: null, locationId, conditionStatus: "SHORT" },
      },
    });
    expect(saved.receivingCount).toBe(1);

    // The authoritative receiving state is COMPLETELY unchanged.
    const after = await getEffectiveReceivingLines(fx.supabase, doc.purchaseDocumentId, fx.organizationId);
    expect(after.find((line) => line.matchedLineKey === doc.lineKeys[0])!.receivedQuantity).toBe(72);
    expect((await receiptRows(doc.purchaseDocumentId)).filter((r) => r.receipt_kind === "CORRECTION")).toHaveLength(0);

    // And the direct write path is closed during final review -- even for
    // the legitimate reviewer.
    await expect(
      applyReceivingEdits(fx.supabase, {
        organizationId: fx.organizationId,
        appUserId: fx.lockedEmployeeAppUserId,
        purchaseDocumentId: doc.purchaseDocumentId,
        editSessionKey: randomUUID(),
        edits: [{ receiptLineId: target.receiptLineId, receivedQuantity: 70, receivedUnit: "PIECE", verifiedBaseQuantity: null, locationId, conditionStatus: "SHORT" }],
      })
    ).rejects.toThrow(/applied atomically by Final Verify/);
  });

  it("test 2: a saved mapping proposal changes NO classification, and a direct reviewer approval during READY is rejected", async () => {
    const doc = await twoLineSubmittedDoc();
    const before = await classificationOf(doc.purchaseDocumentId, doc.lineKeys[0]);
    expect(before.inventory_item_id).toBe(doc.itemIds[0]);

    await saveReviewProposalsRpc(fx.supabase, {
      purchaseDocumentId: doc.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: 0,
      mappingProposals: { [doc.lineKeys[0]]: { inventoryItemId: doc.itemIds[1]! } },
      receivingProposals: {},
    });

    const after = await classificationOf(doc.purchaseDocumentId, doc.lineKeys[0]);
    expect(after.inventory_item_id).toBe(doc.itemIds[0]); // untouched
    expect(after.status).toBe("CONFIRMED");

    await expect(
      approveLineClassificationExistingItemRpc(fx.supabase, {
        purchaseDocumentId: doc.purchaseDocumentId,
        lineKey: doc.lineKeys[0],
        organizationId: fx.organizationId,
        appUserId: fx.lockedEmployeeAppUserId,
        inventoryItemId: doc.itemIds[1]!,
        rememberVendorMapping: false,
      })
    ).rejects.toThrow(/applied atomically by Final Verify/);
  });

  it("test 3: reviewer header/line edits persist as review working state (refresh-safe) while the SUBMITTED snapshot keeps Manager 1's values", async () => {
    const doc = await twoLineSubmittedDoc();
    const payload = await currentPayload(fx.supabase, doc.purchaseDocumentId);

    await saveReviewCorrectionsRpc(fx.supabase, {
      purchaseDocumentId: doc.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: doc.submittedVersion,
      header: { ...payload.header, total: 555 },
      lines: payload.lines.map((line, index) => (index === 0 ? { ...line, unitPrice: 9.99 } : line)),
    });

    // "Refresh": a fresh read of the persisted state shows the pending
    // corrections...
    const reread = await currentPayload(fx.supabase, doc.purchaseDocumentId);
    expect(reread.header.total).toBe(555);
    expect(reread.lines[0].unitPrice).toBe(9.99);

    // ...while Manager 1's submitted snapshot is untouched (this is what
    // Return restores and what verify diffs against).
    const { data: submittedEvent } = await fx.supabase
      .from("audit_events")
      .select("after_state")
      .eq("entity_type", "purchase_document")
      .eq("entity_id", doc.purchaseDocumentId)
      .eq("action", "PURCHASE_DOCUMENT_SUBMITTED")
      .order("occurred_at", { ascending: false })
      .limit(1)
      .single();
    const snapshot = submittedEvent!.after_state as { total: number | string };
    expect(Number(snapshot.total)).not.toBe(555);
  });

  it("the preparer cannot save proposals on their own submission (GA004)", async () => {
    const doc = await twoLineSubmittedDoc();
    await expect(
      saveReviewProposalsRpc(fx.supabase, {
        purchaseDocumentId: doc.purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId,
        expectedVersion: 0,
        mappingProposals: { [doc.lineKeys[0]]: { inventoryItemId: doc.itemIds[1]! } },
        receivingProposals: {},
      })
    ).rejects.toThrow(CannotSelfVerifyError);
  });
});

describe("Return to Preparer promotes nothing (tests 4-7)", () => {
  it("return restores the submitted state; receiving/mapping proposals stay unpromoted, preserved only in the RETURNED audit event", async () => {
    const doc = await twoLineSubmittedDoc();
    const payload = await currentPayload(fx.supabase, doc.purchaseDocumentId);
    const effective = await getEffectiveReceivingLines(fx.supabase, doc.purchaseDocumentId, fx.organizationId);
    const target = effective.find((line) => line.matchedLineKey === doc.lineKeys[0])!;

    // The reviewer proposes everything: header edit, mapping, receiving.
    const corrected = await saveReviewCorrectionsRpc(fx.supabase, {
      purchaseDocumentId: doc.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: doc.submittedVersion,
      header: { ...payload.header, total: 777 },
      lines: payload.lines,
    });
    await saveReviewProposalsRpc(fx.supabase, {
      purchaseDocumentId: doc.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: 0,
      mappingProposals: { [doc.lineKeys[0]]: { inventoryItemId: doc.itemIds[1]! } },
      receivingProposals: {
        [target.receiptLineId]: { receivedQuantity: 60, receivedUnit: "PIECE", verifiedBaseQuantity: null, locationId, conditionStatus: "SHORT" },
      },
    });

    const returned = await returnPurchaseDocumentToDraftRpc(fx.supabase, {
      purchaseDocumentId: doc.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: corrected.version,
      reason: "Larger problems -- please rework",
    });
    expect(returned.status).toBe("DRAFT");

    // Test 4: Manager 1 gets the SUBMITTED state back -- the reviewer's
    // persisted header edit is gone.
    const restored = await currentPayload(fx.supabase, doc.purchaseDocumentId);
    expect(restored.header.total).not.toBe(777);

    // Test 5: the effective receipt is exactly the original delivery.
    const afterEffective = await getEffectiveReceivingLines(fx.supabase, doc.purchaseDocumentId, fx.organizationId);
    expect(afterEffective.find((line) => line.matchedLineKey === doc.lineKeys[0])!.receivedQuantity).toBe(72);
    expect((await receiptRows(doc.purchaseDocumentId)).filter((r) => r.receipt_kind === "CORRECTION")).toHaveLength(0);

    // Test 6: the classification is exactly Manager 1's.
    const classification = await classificationOf(doc.purchaseDocumentId, doc.lineKeys[0]);
    expect(classification.inventory_item_id).toBe(doc.itemIds[0]);

    // Test 7: the proposals remain AUDITABLE -- embedded in the RETURNED
    // event -- and the provisional overlay row itself is gone.
    const { data: returnedEvent } = await fx.supabase
      .from("audit_events")
      .select("after_state")
      .eq("entity_type", "purchase_document")
      .eq("entity_id", doc.purchaseDocumentId)
      .eq("action", "PURCHASE_DOCUMENT_RETURNED")
      .order("occurred_at", { ascending: false })
      .limit(1)
      .single();
    const state = returnedEvent!.after_state as { reason: string; unpromotedReviewerProposals?: { mappingProposals: Record<string, unknown>; receivingProposals: Record<string, unknown> } };
    expect(state.reason).toBe("Larger problems -- please rework");
    expect(state.unpromotedReviewerProposals).toBeTruthy();
    expect(Object.keys(state.unpromotedReviewerProposals!.mappingProposals)).toEqual([doc.lineKeys[0]]);
    expect(Object.keys(state.unpromotedReviewerProposals!.receivingProposals)).toEqual([target.receiptLineId]);
    expect(await overlayRow(doc.purchaseDocumentId)).toBeNull();
  });
});

describe("Final Verify promotes the overlay atomically (tests 8-11)", () => {
  it("test 8: verify appends the receiving correction (append-only), effective state updates, the original DELIVERY survives, VERIFIED", async () => {
    const doc = await twoLineSubmittedDoc();
    const effective = await getEffectiveReceivingLines(fx.supabase, doc.purchaseDocumentId, fx.organizationId);
    const target = effective.find((line) => line.matchedLineKey === doc.lineKeys[0])!;

    await saveReviewProposalsRpc(fx.supabase, {
      purchaseDocumentId: doc.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: 0,
      mappingProposals: {},
      receivingProposals: {
        [target.receiptLineId]: { receivedQuantity: 70, receivedUnit: "PIECE", verifiedBaseQuantity: null, locationId, conditionStatus: "SHORT" },
      },
    });

    const verified = await verifyPurchaseDocumentRpc(fx.supabase, {
      purchaseDocumentId: doc.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: doc.submittedVersion,
    });
    expect(verified.verifiedAt).toBeTruthy();

    const afterEffective = await getEffectiveReceivingLines(fx.supabase, doc.purchaseDocumentId, fx.organizationId);
    const promoted = afterEffective.find((line) => line.matchedLineKey === doc.lineKeys[0])!;
    expect(promoted.receivedQuantity).toBe(70);
    expect(promoted.conditionStatus).toBe("SHORT");
    // Sibling line of the same receipt survives untouched.
    expect(afterEffective.find((line) => line.matchedLineKey === doc.lineKeys[1])!.receivedQuantity).toBe(5);

    const receipts = await receiptRows(doc.purchaseDocumentId);
    const correction = receipts.find((r) => r.receipt_kind === "CORRECTION");
    expect(receipts.find((r) => r.receipt_kind === "DELIVERY")).toBeTruthy(); // original preserved
    expect(correction).toBeTruthy();
    expect(correction!.idempotency_key).toMatch(/^review-promotion:/);

    expect(await overlayRow(doc.purchaseDocumentId)).toBeNull(); // spent

    const { data: verifiedEvent } = await fx.supabase
      .from("audit_events")
      .select("after_state")
      .eq("entity_id", doc.purchaseDocumentId)
      .eq("action", "PURCHASE_DOCUMENT_VERIFIED")
      .single();
    const state = verifiedEvent!.after_state as { promotedReceivingCorrectionCount: number; promotedMappingCorrectionCount: number };
    expect(state.promotedReceivingCorrectionCount).toBe(1);
    expect(state.promotedMappingCorrectionCount).toBe(0);
  });

  it("test 9: verify promotes the mapping proposal through the audited approval mechanism, attributed to the reviewer", async () => {
    const doc = await twoLineSubmittedDoc();

    await saveReviewProposalsRpc(fx.supabase, {
      purchaseDocumentId: doc.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: 0,
      mappingProposals: { [doc.lineKeys[0]]: { inventoryItemId: doc.itemIds[1]! } },
      receivingProposals: {},
    });

    await verifyPurchaseDocumentRpc(fx.supabase, {
      purchaseDocumentId: doc.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: doc.submittedVersion,
    });

    const classification = await classificationOf(doc.purchaseDocumentId, doc.lineKeys[0]);
    expect(classification.inventory_item_id).toBe(doc.itemIds[1]);
    expect(classification.status).toBe("CONFIRMED");

    const { count } = await fx.supabase
      .from("audit_events")
      .select("id", { count: "exact", head: true })
      .eq("entity_id", doc.purchaseDocumentId)
      .eq("action", "LINE_CLASSIFICATION_CONFIRMED")
      .eq("actor_app_user_id", fx.lockedEmployeeAppUserId);
    expect(count).toBeGreaterThan(0);
  });

  it("tests 10+11: header, line-fact, mapping, and receiving corrections all promote in ONE coherent verify -- including an identity-field edit whose mapping re-confirmation resolves against the corrected facts", async () => {
    const doc = await twoLineSubmittedDoc();
    const payload = await currentPayload(fx.supabase, doc.purchaseDocumentId);
    const effective = await getEffectiveReceivingLines(fx.supabase, doc.purchaseDocumentId, fx.organizationId);
    const target = effective.find((line) => line.matchedLineKey === doc.lineKeys[0])!;

    await saveReviewProposalsRpc(fx.supabase, {
      purchaseDocumentId: doc.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: 0,
      mappingProposals: { [doc.lineKeys[0]]: { inventoryItemId: doc.itemIds[1]! } },
      receivingProposals: {
        [target.receiptLineId]: { receivedQuantity: 68, receivedUnit: "PIECE", verifiedBaseQuantity: null, locationId, conditionStatus: "SHORT" },
      },
    });

    // One click: header total corrected, line 0's DESCRIPTION (a
    // classification-identity field) corrected, plus the two proposals.
    const verified = await verifyPurchaseDocumentRpc(fx.supabase, {
      purchaseDocumentId: doc.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: doc.submittedVersion,
      header: { ...payload.header, total: 432.1 },
      lines: payload.lines.map((line, index) => (index === 0 ? { ...line, description: "Rvw Line A CORRECTED" } : line)),
    });
    expect(verified.verifiedAt).toBeTruthy();

    // All four kinds of correction landed in one verified result.
    const finalState = await currentPayload(fx.supabase, doc.purchaseDocumentId);
    expect(finalState.header.total).toBe(432.1);
    expect(finalState.lines[0].description).toBe("Rvw Line A CORRECTED");

    const classification = await classificationOf(doc.purchaseDocumentId, doc.lineKeys[0]);
    expect(classification.inventory_item_id).toBe(doc.itemIds[1]);
    expect(classification.status).toBe("CONFIRMED"); // resolved against the CORRECTED description -- not STALE

    const afterEffective = await getEffectiveReceivingLines(fx.supabase, doc.purchaseDocumentId, fx.organizationId);
    expect(afterEffective.find((line) => line.matchedLineKey === doc.lineKeys[0])!.receivedQuantity).toBe(68);

    const { data: correctedEvents } = await fx.supabase
      .from("audit_events")
      .select("id")
      .eq("entity_id", doc.purchaseDocumentId)
      .eq("action", "PURCHASE_DOCUMENT_REVIEW_CORRECTED");
    expect(correctedEvents!.length).toBeGreaterThan(0);

    const { data: verifiedEvent } = await fx.supabase
      .from("audit_events")
      .select("after_state")
      .eq("entity_id", doc.purchaseDocumentId)
      .eq("action", "PURCHASE_DOCUMENT_VERIFIED")
      .single();
    const state = verifiedEvent!.after_state as { promotedReceivingCorrectionCount: number; promotedMappingCorrectionCount: number; finalCorrectionCount: number };
    expect(state.promotedMappingCorrectionCount).toBe(1);
    expect(state.promotedReceivingCorrectionCount).toBe(1);
    expect(state.finalCorrectionCount).toBeGreaterThan(0);
  });

  it("test 12a: a receiving proposal that violates the item's FIXED_CONVERSION math fails the verify -- and the WHOLE promotion rolls back", async () => {
    const doc = await createSubmittedPostingDocument(fx.supabase, fx, locationId, [
      {
        description: "Rvw Fixed Fail",
        receiving: {
          behavior: "FIXED_CONVERSION",
          baseUnitCode: "LB",
          purchaseUnitCode: "CASE",
          fixedConversionFactor: 10,
          receivedQuantity: 2,
          receivedUnit: "CASE",
          verifiedBaseQuantity: 20,
        },
      },
    ]);
    const effective = await getEffectiveReceivingLines(fx.supabase, doc.purchaseDocumentId, fx.organizationId);

    await saveReviewProposalsRpc(fx.supabase, {
      purchaseDocumentId: doc.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: 0,
      mappingProposals: {},
      receivingProposals: {
        // 1 CASE at 1 CASE = 10 LB can never carry 15 LB.
        [effective[0].receiptLineId]: { receivedQuantity: 1, receivedUnit: "CASE", verifiedBaseQuantity: 15, locationId, conditionStatus: "SHORT" },
      },
    });

    await expect(
      verifyPurchaseDocumentRpc(fx.supabase, {
        purchaseDocumentId: doc.purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.lockedEmployeeAppUserId,
        expectedVersion: doc.submittedVersion,
      })
    ).rejects.toThrow(/inconsistent with/);

    // Validation failure left the authoritative state COMPLETELY intact.
    const { data: docRow } = await fx.supabase.from("purchase_documents").select("status").eq("id", doc.purchaseDocumentId).single();
    expect(docRow!.status).toBe("READY_FOR_VERIFICATION");
    const afterEffective = await getEffectiveReceivingLines(fx.supabase, doc.purchaseDocumentId, fx.organizationId);
    expect(afterEffective[0].receivedQuantity).toBe(2);
    expect((await receiptRows(doc.purchaseDocumentId)).filter((r) => r.receipt_kind === "CORRECTION")).toHaveLength(0);
    // The proposal is retained for the reviewer to fix.
    expect(await overlayRow(doc.purchaseDocumentId)).not.toBeNull();
  });

  it("test 12b: a mapping proposal whose promotion re-introduces incompleteness fails the gates -- promotion (including the classification change) rolls back", async () => {
    // Submitted with a single NON_INVENTORY line: complete without any
    // receiving or delivery verifier.
    const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: `RVW-GATE-${randomUUID().slice(0, 8)}`, description: "Rvw Gate Line", packageUnit: "PIECE", packageQuantity: 4 }],
    });
    await confirmAllCurrentLinesNonInventory(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, purchaseDocumentId);
    const submitted = await submitPurchaseDocumentForVerificationRpc(fx.supabase, {
      purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      expectedVersion: 1,
    });
    const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);
    const before = await classificationOf(purchaseDocumentId, lineKey);

    // Proposal: remap to a REAL INVENTORY item -- legitimate in itself,
    // but it makes receiving (and a delivery verifier) required, and
    // neither exists.
    await saveReviewProposalsRpc(fx.supabase, {
      purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: 0,
      mappingProposals: { [lineKey]: { inventoryItemId: fx.noRuleItemId } },
      receivingProposals: {},
    });

    await expect(
      verifyPurchaseDocumentRpc(fx.supabase, {
        purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.lockedEmployeeAppUserId,
        expectedVersion: submitted.version,
      })
    ).rejects.toThrow(PreparationIncompleteError);

    // Not partially verified, not partially promoted: the classification
    // is STILL Manager 1's, and the proposal survives for rework.
    const { data: row } = await fx.supabase.from("purchase_documents").select("status").eq("id", purchaseDocumentId).single();
    expect(row!.status).toBe("READY_FOR_VERIFICATION");
    const after = await classificationOf(purchaseDocumentId, lineKey);
    expect(after.inventory_item_id).toBe(before.inventory_item_id);
    expect(await overlayRow(purchaseDocumentId)).not.toBeNull();
  });

  it("test 13: VERIFIED remains immutable -- no proposals, no direct corrections", async () => {
    const doc = await createVerifiedPostingDocument(fx.supabase, fx, locationId, [
      { description: "Rvw Verified Frozen", receiving: { behavior: "SAME_UNIT", baseUnitCode: "PIECE", receivedQuantity: 5, receivedUnit: "PIECE" } },
    ]);
    const effective = await getEffectiveReceivingLines(fx.supabase, doc.purchaseDocumentId, fx.organizationId);

    await expect(
      saveReviewProposalsRpc(fx.supabase, {
        purchaseDocumentId: doc.purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.lockedEmployeeAppUserId,
        expectedVersion: 0,
        mappingProposals: {},
        receivingProposals: {
          [effective[0].receiptLineId]: { receivedQuantity: 4, receivedUnit: "PIECE", verifiedBaseQuantity: null, locationId, conditionStatus: "SHORT" },
        },
      })
    ).rejects.toThrow(StaleVersionError); // GA002: the document left READY -- no overlay can be created after

    await expect(
      applyReceivingEdits(fx.supabase, {
        organizationId: fx.organizationId,
        appUserId: fx.lockedEmployeeAppUserId,
        purchaseDocumentId: doc.purchaseDocumentId,
        editSessionKey: randomUUID(),
        edits: [{ receiptLineId: effective[0].receiptLineId, receivedQuantity: 4, receivedUnit: "PIECE", verifiedBaseQuantity: null, locationId, conditionStatus: "SHORT" }],
      })
    ).rejects.toThrow(/VERIFIED/);
  });
});

describe("overlay lifecycle hardening (20260811100072): withdraw, freshness, stale targets, versioning, ownership", () => {
  it("withdraw archives and DELETES the overlay; the resubmitted document verifies with NONE of submission A's proposals promoted", async () => {
    const doc = await twoLineSubmittedDoc();
    const effective = await getEffectiveReceivingLines(fx.supabase, doc.purchaseDocumentId, fx.organizationId);
    const target = effective.find((line) => line.matchedLineKey === doc.lineKeys[0])!;

    // Submission A: Manager 2 proposes a mapping AND a receiving change.
    await saveReviewProposalsRpc(fx.supabase, {
      purchaseDocumentId: doc.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: 0,
      mappingProposals: { [doc.lineKeys[0]]: { inventoryItemId: doc.itemIds[1]! } },
      receivingProposals: {
        [target.receiptLineId]: { receivedQuantity: 50, receivedUnit: "PIECE", verifiedBaseQuantity: null, locationId, conditionStatus: "SHORT" },
      },
    });

    // Manager 1 withdraws.
    const withdrawn = await withdrawPurchaseDocumentSubmissionRpc(fx.supabase, {
      purchaseDocumentId: doc.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      expectedVersion: doc.submittedVersion,
      reason: "Need to rework quantities",
    });
    expect(withdrawn.status).toBe("DRAFT");

    // ZERO active overlay after withdrawal; the proposals survive only in
    // the withdrawal audit event.
    expect(await overlayRow(doc.purchaseDocumentId)).toBeNull();
    const { data: withdrawnEvent } = await fx.supabase
      .from("audit_events")
      .select("after_state")
      .eq("entity_id", doc.purchaseDocumentId)
      .eq("action", "PURCHASE_DOCUMENT_SUBMISSION_WITHDRAWN")
      .order("occurred_at", { ascending: false })
      .limit(1)
      .single();
    const withdrawnState = withdrawnEvent!.after_state as { unpromotedReviewerProposals?: { mappingProposals: Record<string, unknown> } };
    expect(withdrawnState.unpromotedReviewerProposals).toBeTruthy();
    expect(Object.keys(withdrawnState.unpromotedReviewerProposals!.mappingProposals)).toEqual([doc.lineKeys[0]]);

    // Manager 1 reworks and resubmits (submission B), reviewer verifies.
    const resubmitted = await submitPurchaseDocumentForVerificationRpc(fx.supabase, {
      purchaseDocumentId: doc.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      expectedVersion: withdrawn.version,
    });
    await verifyPurchaseDocumentRpc(fx.supabase, {
      purchaseDocumentId: doc.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: resubmitted.version,
    });

    // NONE of submission A's proposals promoted into submission B.
    const classification = await classificationOf(doc.purchaseDocumentId, doc.lineKeys[0]);
    expect(classification.inventory_item_id).toBe(doc.itemIds[0]); // Manager 1's mapping, not the stale proposal
    const afterEffective = await getEffectiveReceivingLines(fx.supabase, doc.purchaseDocumentId, fx.organizationId);
    expect(afterEffective.find((line) => line.matchedLineKey === doc.lineKeys[0])!.receivedQuantity).toBe(72);
    expect((await receiptRows(doc.purchaseDocumentId)).filter((r) => r.receipt_kind === "CORRECTION")).toHaveLength(0);
    const { data: verifiedEvent } = await fx.supabase
      .from("audit_events")
      .select("after_state")
      .eq("entity_id", doc.purchaseDocumentId)
      .eq("action", "PURCHASE_DOCUMENT_VERIFIED")
      .single();
    const state = verifiedEvent!.after_state as { promotedMappingCorrectionCount: number; promotedReceivingCorrectionCount: number };
    expect(state.promotedMappingCorrectionCount).toBe(0);
    expect(state.promotedReceivingCorrectionCount).toBe(0);
  });

  it("submission freshness: a stale-bound overlay is refused by Final Verify (GA020), promotes nothing, and is not consumed", async () => {
    const doc = await twoLineSubmittedDoc();

    // Forge the failure mode structurally: an overlay bound to a DIFFERENT
    // submission event (another document's SUBMITTED event of this org).
    const other = await twoLineSubmittedDoc();
    const { data: otherSubmitted } = await fx.supabase
      .from("audit_events")
      .select("id")
      .eq("entity_id", other.purchaseDocumentId)
      .eq("action", "PURCHASE_DOCUMENT_SUBMITTED")
      .order("occurred_at", { ascending: false })
      .limit(1)
      .single();
    const { error: insertError } = await fx.supabase.from("purchase_document_review_proposals").insert({
      organization_id: fx.organizationId,
      purchase_document_id: doc.purchaseDocumentId,
      proposed_by_app_user_id: fx.lockedEmployeeAppUserId,
      submission_audit_event_id: otherSubmitted!.id,
      mapping_proposals: { [doc.lineKeys[0]]: { inventoryItemId: doc.itemIds[1]! } },
      receiving_proposals: {},
      version: 1,
    });
    expect(insertError).toBeNull();

    await expect(
      verifyPurchaseDocumentRpc(fx.supabase, {
        purchaseDocumentId: doc.purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.lockedEmployeeAppUserId,
        expectedVersion: doc.submittedVersion,
      })
    ).rejects.toThrow(StaleReviewProposalsError);

    // No VERIFIED transition, no promotion, overlay NOT consumed.
    const { data: row } = await fx.supabase.from("purchase_documents").select("status").eq("id", doc.purchaseDocumentId).single();
    expect(row!.status).toBe("READY_FOR_VERIFICATION");
    expect((await classificationOf(doc.purchaseDocumentId, doc.lineKeys[0])).inventory_item_id).toBe(doc.itemIds[0]);
    expect((await receiptRows(doc.purchaseDocumentId)).filter((r) => r.receipt_kind === "CORRECTION")).toHaveLength(0);
    expect(await overlayRow(doc.purchaseDocumentId)).not.toBeNull();
  });

  it("stale receipt target: a proposal against a SUPERSEDED receipt line fails the whole verify -- never silently skipped while the rest promotes", async () => {
    // Build a submitted doc whose original delivery line L1 was superseded
    // by a DRAFT-time Edit Receiving correction (effective line L2).
    const tag = randomUUID().slice(0, 8);
    const spendCategoryId = await findOrCreateThrowawaySpendCategory(fx.supabase, fx.organizationId);
    const { data: categoryRow } = await fx.supabase.from("inventory_items").select("category_id").eq("id", fx.noRuleItemId).single();
    const verifierEmployeeId = await findOrCreateNamedEmployee(fx.supabase, fx.organizationId, "TEST Delivery Verifier");
    const { purchaseDocumentId, documentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: `RVW-SUP-${tag}`, description: "Rvw Superseded", packageUnit: "PIECE", packageQuantity: 9 }],
    });
    const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);
    await approveLineClassificationNewItemRpc(fx.supabase, {
      purchaseDocumentId,
      lineKey,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      finalName: `TEST Rvw Superseded ${tag}`,
      disposition: "INVENTORY",
      categoryId: categoryRow!.category_id as string,
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
          vendorSkuSnapshot: `RVW-SUP-${tag}`,
          descriptionSnapshot: "Rvw Superseded",
          invoicePackageQuantity: 9,
          invoicePackageUnit: "PIECE",
          invoiceMeasuredQuantity: null,
          invoiceMeasuredUnit: null,
          actualReceivedPackageQuantity: 9,
          actualReceivedPackageUnit: "PIECE",
          actualVerifiedBaseQuantity: null,
          actualVerifiedBaseUnitId: null,
          locationId,
        },
      ],
    });
    const originalLines = await getEffectiveReceivingLines(fx.supabase, purchaseDocumentId, fx.organizationId);
    const supersededLineId = originalLines[0].receiptLineId;
    // DRAFT-time correction supersedes the original receipt line.
    await applyReceivingEdits(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      purchaseDocumentId,
      editSessionKey: randomUUID(),
      edits: [{ receiptLineId: supersededLineId, receivedQuantity: 8, receivedUnit: "PIECE", verifiedBaseQuantity: null, locationId, conditionStatus: "SHORT" }],
    });
    await correctDocumentDeliveryVerifierRpc(fx.supabase, {
      documentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      newEmployeeId: verifierEmployeeId,
    });
    const submitted = await submitPurchaseDocumentForVerificationRpc(fx.supabase, {
      purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      expectedVersion: 1,
    });

    // The reviewer's proposal targets the SUPERSEDED line (passes save's
    // belongs-to-document validation -- receipt lines are append-only).
    await saveReviewProposalsRpc(fx.supabase, {
      purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: 0,
      mappingProposals: {},
      receivingProposals: {
        [supersededLineId]: { receivedQuantity: 7, receivedUnit: "PIECE", verifiedBaseQuantity: null, locationId, conditionStatus: "SHORT" },
      },
    });

    await expect(
      verifyPurchaseDocumentRpc(fx.supabase, {
        purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.lockedEmployeeAppUserId,
        expectedVersion: submitted.version,
      })
    ).rejects.toThrow(StaleReviewProposalsError);

    const { data: row } = await fx.supabase.from("purchase_documents").select("status").eq("id", purchaseDocumentId).single();
    expect(row!.status).toBe("READY_FOR_VERIFICATION");
    const stillEffective = await getEffectiveReceivingLines(fx.supabase, purchaseDocumentId, fx.organizationId);
    expect(stillEffective[0].receivedQuantity).toBe(8); // the DRAFT-time correction, untouched
    expect(await overlayRow(purchaseDocumentId)).not.toBeNull(); // retained for reviewer recovery
  });

  it("optimistic concurrency: a stale-version save is rejected and the other tab's proposal survives; a reloaded merge then succeeds", async () => {
    const doc = await twoLineSubmittedDoc();
    const effective = await getEffectiveReceivingLines(fx.supabase, doc.purchaseDocumentId, fx.organizationId);
    const target = effective.find((line) => line.matchedLineKey === doc.lineKeys[0])!;
    const receivingProposal = {
      [target.receiptLineId]: { receivedQuantity: 71, receivedUnit: "PIECE", verifiedBaseQuantity: null, locationId, conditionStatus: "SHORT" as const },
    };

    // Tab A creates the overlay (version 0 -> 1) with a receiving proposal.
    const savedA = await saveReviewProposalsRpc(fx.supabase, {
      purchaseDocumentId: doc.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: 0,
      mappingProposals: {},
      receivingProposals: receivingProposal,
    });
    expect(savedA.version).toBe(1);

    // Tab B, still on stale local state (expected 0), tries to save ONLY
    // its mapping proposal -- rejected, nothing overwritten.
    await expect(
      saveReviewProposalsRpc(fx.supabase, {
        purchaseDocumentId: doc.purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.lockedEmployeeAppUserId,
        expectedVersion: 0,
        mappingProposals: { [doc.lineKeys[0]]: { inventoryItemId: doc.itemIds[1]! } },
        receivingProposals: {},
      })
    ).rejects.toThrow(ReviewProposalsConflictError);

    const midway = (await overlayRow(doc.purchaseDocumentId)) as { receiving_proposals: Record<string, unknown>; mapping_proposals: Record<string, unknown> };
    expect(Object.keys(midway.receiving_proposals)).toEqual([target.receiptLineId]); // A's work intact
    expect(Object.keys(midway.mapping_proposals)).toEqual([]);

    // Tab B reloads (latest state + version 1) and reapplies its mapping
    // proposal MERGED with A's receiving proposal -> version 2.
    const savedB = await saveReviewProposalsRpc(fx.supabase, {
      purchaseDocumentId: doc.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: 1,
      mappingProposals: { [doc.lineKeys[0]]: { inventoryItemId: doc.itemIds[1]! } },
      receivingProposals: receivingProposal,
    });
    expect(savedB.version).toBe(2);

    const final = (await overlayRow(doc.purchaseDocumentId)) as { receiving_proposals: Record<string, unknown>; mapping_proposals: Record<string, unknown> };
    expect(Object.keys(final.receiving_proposals)).toEqual([target.receiptLineId]);
    expect(Object.keys(final.mapping_proposals)).toEqual([doc.lineKeys[0]]);
  });

  it("reviewer ownership: a different reviewer cannot silently overwrite an existing overlay", async () => {
    const doc = await twoLineSubmittedDoc();

    await saveReviewProposalsRpc(fx.supabase, {
      purchaseDocumentId: doc.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId, // reviewer A
      expectedVersion: 0,
      mappingProposals: { [doc.lineKeys[0]]: { inventoryItemId: doc.itemIds[1]! } },
      receivingProposals: {},
    });

    await expect(
      saveReviewProposalsRpc(fx.supabase, {
        purchaseDocumentId: doc.purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.mustPickEmployeeAppUserId, // reviewer B -- not the preparer, but not the overlay's owner
        expectedVersion: 1,
        mappingProposals: { [doc.lineKeys[0]]: { inventoryItemId: doc.itemIds[0]! } },
        receivingProposals: {},
      })
    ).rejects.toThrow(ReviewProposalsOwnedElsewhereError);

    const still = (await overlayRow(doc.purchaseDocumentId)) as { mapping_proposals: Record<string, { inventoryItemId: string }>; proposed_by_app_user_id: string };
    expect(still.proposed_by_app_user_id).toBe(fx.lockedEmployeeAppUserId);
    expect(still.mapping_proposals[doc.lineKeys[0]].inventoryItemId).toBe(doc.itemIds[1]); // A's proposal untouched
  });

  it("lifecycle race closure: after Return, no overlay survives and no save can recreate one", async () => {
    const doc = await twoLineSubmittedDoc();
    await saveReviewProposalsRpc(fx.supabase, {
      purchaseDocumentId: doc.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: 0,
      mappingProposals: { [doc.lineKeys[0]]: { inventoryItemId: doc.itemIds[1]! } },
      receivingProposals: {},
    });
    await returnPurchaseDocumentToDraftRpc(fx.supabase, {
      purchaseDocumentId: doc.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: doc.submittedVersion,
      reason: "race-closure check",
    });
    expect(await overlayRow(doc.purchaseDocumentId)).toBeNull();
    // The document left READY -- the save RPC's doc-row lock + status
    // check make a late insert impossible.
    await expect(
      saveReviewProposalsRpc(fx.supabase, {
        purchaseDocumentId: doc.purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.lockedEmployeeAppUserId,
        expectedVersion: 0,
        mappingProposals: { [doc.lineKeys[0]]: { inventoryItemId: doc.itemIds[1]! } },
        receivingProposals: {},
      })
    ).rejects.toThrow(StaleVersionError);
  });
});
