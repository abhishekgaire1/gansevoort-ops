import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordReceiptRpc } from "@/app/lib/receiving/recordReceiptRpc";
import type { ReceiptLineConditionStatus } from "@/app/lib/receiving/types";

/**
 * Edit Receiving (DRAFT only for direct calls -- during
 * READY_FOR_VERIFICATION reviewer receiving corrections are PROPOSALS
 * promoted atomically inside verify_purchase_document, the only caller
 * record_receipt's reviewer window admits, 20260811100071; VERIFIED
 * stays immutable): loads the current EFFECTIVE receiving state
 * for prefill, and
 * applies manager edits as APPEND-ONLY receipt corrections through the
 * established correction model -- the original receipt rows are never
 * updated or deleted; a CORRECTION receipt (with the owning receipt's
 * FULL corrected line set) becomes the new effective state, and
 * effective_receipts_for_purchase_document does the rest.
 */

export interface EffectiveReceivingLine {
  /** The EFFECTIVE receipt this line currently belongs to -- corrections
   * target this exact receipt. */
  receiptId: string;
  receiptLineId: string;
  matchedLineKey: string;
  receivedQuantity: number | null;
  receivedUnit: string | null;
  verifiedBaseQuantity: number | null;
  verifiedBaseUnitId: string | null;
  locationId: string | null;
  conditionStatus: string;
  lineNumberSnapshot: number | null;
  vendorSkuSnapshot: string | null;
  descriptionSnapshot: string | null;
  invoicePackageQuantity: number | null;
  invoicePackageUnit: string | null;
  invoiceMeasuredQuantity: number | null;
  invoiceMeasuredUnit: string | null;
  notes: string | null;
}

/** All lines of every EFFECTIVE receipt, in deterministic order (receipt
 * occurred_at, then line creation). When the same matched_line_key appears
 * in more than one effective receipt (a genuine additional delivery), each
 * occurrence is returned -- the caller decides what to show/edit. */
export async function getEffectiveReceivingLines(
  supabase: SupabaseClient,
  purchaseDocumentId: string,
  organizationId: string
): Promise<EffectiveReceivingLine[]> {
  const { data: effectiveReceipts, error: receiptsError } = await supabase.rpc("effective_receipts_for_purchase_document", {
    p_purchase_document_id: purchaseDocumentId,
    p_organization_id: organizationId,
  });
  if (receiptsError) throw new Error(receiptsError.message);
  const receipts = ((effectiveReceipts ?? []) as { id: string; occurred_at: string }[]).sort(
    (a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime()
  );
  if (receipts.length === 0) return [];

  const { data: lines, error: linesError } = await supabase
    .from("receipt_lines")
    .select(
      "id, receipt_id, matched_line_key, actual_received_package_quantity, actual_received_package_unit, actual_verified_base_quantity, actual_verified_base_unit_id, location_id, condition_status, line_number_snapshot, vendor_sku_snapshot, description_snapshot, invoice_package_quantity, invoice_package_unit, invoice_measured_quantity, invoice_measured_unit, notes"
    )
    .in(
      "receipt_id",
      receipts.map((r) => r.id)
    )
    .order("created_at", { ascending: true });
  if (linesError) throw new Error(linesError.message);

  const receiptOrder = new Map(receipts.map((r, index) => [r.id, index]));
  return ((lines ?? []) as Record<string, unknown>[])
    .filter((line) => line.matched_line_key !== null)
    .sort((a, b) => (receiptOrder.get(a.receipt_id as string) ?? 0) - (receiptOrder.get(b.receipt_id as string) ?? 0))
    .map((line) => ({
      receiptId: line.receipt_id as string,
      receiptLineId: line.id as string,
      matchedLineKey: line.matched_line_key as string,
      receivedQuantity: line.actual_received_package_quantity as number | null,
      receivedUnit: line.actual_received_package_unit as string | null,
      verifiedBaseQuantity: line.actual_verified_base_quantity as number | null,
      verifiedBaseUnitId: line.actual_verified_base_unit_id as string | null,
      locationId: line.location_id as string | null,
      conditionStatus: line.condition_status as string,
      lineNumberSnapshot: line.line_number_snapshot as number | null,
      vendorSkuSnapshot: line.vendor_sku_snapshot as string | null,
      descriptionSnapshot: line.description_snapshot as string | null,
      invoicePackageQuantity: line.invoice_package_quantity as number | null,
      invoicePackageUnit: line.invoice_package_unit as string | null,
      invoiceMeasuredQuantity: line.invoice_measured_quantity as number | null,
      invoiceMeasuredUnit: line.invoice_measured_unit as string | null,
      notes: line.notes as string | null,
    }));
}

export interface ReceivingLineEdit {
  /** Targets one specific effective receipt line (never "the line key
   * wherever it appears" -- additional-delivery occurrences are distinct). */
  receiptLineId: string;
  receivedQuantity: number;
  receivedUnit: string | null;
  verifiedBaseQuantity: number | null;
  locationId: string | null;
  conditionStatus: ReceiptLineConditionStatus;
}

export interface ApplyReceivingEditsResult {
  correctedReceiptIds: string[];
}

/**
 * Applies edits as append-only corrections. For each EFFECTIVE receipt
 * containing at least one edited line, records ONE CORRECTION receipt
 * carrying that receipt's COMPLETE corrected line set (edited lines
 * updated, untouched lines copied verbatim) -- required because the
 * correction chain replaces the corrected receipt wholesale in the
 * effective state; a partial line set would silently drop the receipt's
 * other lines. Idempotent per edit session: retries reuse
 * `${editSessionKey}:${receiptId}` and converge on the same corrections.
 */
export async function applyReceivingEdits(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    appUserId: string;
    purchaseDocumentId: string;
    editSessionKey: string;
    edits: ReceivingLineEdit[];
  }
): Promise<ApplyReceivingEditsResult> {
  if (input.edits.length === 0) return { correctedReceiptIds: [] };

  const effectiveLines = await getEffectiveReceivingLines(supabase, input.purchaseDocumentId, input.organizationId);
  const editByReceiptLineId = new Map(input.edits.map((edit) => [edit.receiptLineId, edit]));

  const unknownTargets = input.edits.filter((edit) => !effectiveLines.some((line) => line.receiptLineId === edit.receiptLineId));
  const replayedReceiptIds: string[] = [];
  if (unknownTargets.length > 0) {
    // A target no longer effective is EITHER a genuine conflict (someone
    // else corrected the receipt -- reload) OR this very session's own
    // retry (our first attempt succeeded but the response was lost; the
    // target lines are superseded by OUR correction). Receipt lines are
    // append-only, so the targeted rows still exist -- resolve their
    // owning receipts and check whether the superseding correction
    // carries THIS session's idempotency key.
    const { data: targetRows, error: targetError } = await supabase
      .from("receipt_lines")
      .select("id, receipt_id")
      .in(
        "id",
        unknownTargets.map((edit) => edit.receiptLineId)
      );
    if (targetError) throw new Error(targetError.message);
    const targetReceiptIds = Array.from(new Set(((targetRows ?? []) as { receipt_id: string }[]).map((row) => row.receipt_id)));
    if (targetRows?.length !== unknownTargets.length || targetReceiptIds.length === 0) {
      throw new Error("One or more edited lines no longer belong to the current effective receiving state. Reload and try again.");
    }
    const { data: ownCorrections, error: correctionsError } = await supabase
      .from("receipts")
      .select("corrects_receipt_id, idempotency_key")
      .in("corrects_receipt_id", targetReceiptIds);
    if (correctionsError) throw new Error(correctionsError.message);
    const correctionKeyByReceiptId = new Map(
      ((ownCorrections ?? []) as { corrects_receipt_id: string; idempotency_key: string | null }[]).map((row) => [row.corrects_receipt_id, row.idempotency_key])
    );
    const allOwnReplays = targetReceiptIds.every((receiptId) => correctionKeyByReceiptId.get(receiptId) === `${input.editSessionKey}:${receiptId}`);
    if (!allOwnReplays) {
      throw new Error("One or more edited lines no longer belong to the current effective receiving state. Reload and try again.");
    }
    // Pure replay of this session's already-applied corrections.
    replayedReceiptIds.push(...targetReceiptIds);
    for (const edit of unknownTargets) editByReceiptLineId.delete(edit.receiptLineId);
    if (editByReceiptLineId.size === 0) {
      return { correctedReceiptIds: replayedReceiptIds };
    }
  }

  const linesByReceiptId = new Map<string, EffectiveReceivingLine[]>();
  for (const line of effectiveLines) {
    if (!linesByReceiptId.has(line.receiptId)) linesByReceiptId.set(line.receiptId, []);
    linesByReceiptId.get(line.receiptId)!.push(line);
  }

  const correctedReceiptIds: string[] = [...replayedReceiptIds];
  for (const [receiptId, receiptLines] of linesByReceiptId) {
    const hasEdits = receiptLines.some((line) => editByReceiptLineId.has(line.receiptLineId));
    if (!hasEdits) continue; // untouched receipts are never corrected

    await recordReceiptRpc(supabase, {
      organizationId: input.organizationId,
      appUserId: input.appUserId,
      receiptKind: "CORRECTION",
      correctsReceiptId: receiptId,
      idempotencyKey: `${input.editSessionKey}:${receiptId}`,
      lines: receiptLines.map((line) => {
        const edit = editByReceiptLineId.get(line.receiptLineId);
        return {
          lineNumberSnapshot: line.lineNumberSnapshot,
          matchedLineKey: line.matchedLineKey,
          vendorSkuSnapshot: line.vendorSkuSnapshot,
          descriptionSnapshot: line.descriptionSnapshot,
          invoicePackageQuantity: line.invoicePackageQuantity,
          invoicePackageUnit: line.invoicePackageUnit,
          invoiceMeasuredQuantity: line.invoiceMeasuredQuantity,
          invoiceMeasuredUnit: line.invoiceMeasuredUnit,
          actualReceivedPackageQuantity: edit ? edit.receivedQuantity : line.receivedQuantity,
          actualReceivedPackageUnit: edit ? edit.receivedUnit : line.receivedUnit,
          actualVerifiedBaseQuantity: edit ? edit.verifiedBaseQuantity : line.verifiedBaseQuantity,
          // The base unit itself never changes by editing quantities --
          // preserved from the effective line (record_receipt re-validates
          // FIXED_CONVERSION math server-side regardless); cleared when
          // the verified quantity is cleared.
          actualVerifiedBaseUnitId: (edit ? edit.verifiedBaseQuantity : line.verifiedBaseQuantity) !== null ? line.verifiedBaseUnitId : null,
          locationId: edit ? edit.locationId : line.locationId,
          conditionStatus: (edit ? edit.conditionStatus : line.conditionStatus) as ReceiptLineConditionStatus,
          notes: line.notes,
        };
      }),
    });
    correctedReceiptIds.push(receiptId);
  }

  return { correctedReceiptIds };
}
