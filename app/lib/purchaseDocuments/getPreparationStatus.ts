import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getReceivingLines } from "@/app/lib/receiving/getReceivingLines";

import { lineLevelBlockers, type PreparationBlocker } from "@/app/lib/purchaseDocuments/preparationBlockers";
import { getPackageMismatchByLineKey } from "@/app/lib/purchaseDocuments/lineMismatchLookup";
import { isAmbiguousDeliveryLineage, AMBIGUOUS_DELIVERY_REASON } from "@/app/lib/purchaseDocuments/duplicateDelivery";

export type { PreparationBlocker };

export interface PreparationStatus {
  /** The FULL Send-for-Final-Review gate: every line-level receiving
   * requirement AND every document-level one (delivery verifier,
   * plausible date). Mirrors exactly what
   * submit_purchase_document_for_verification enforces. */
  ready: boolean;
  /** Step 3 -- Receive Delivery's own completion: every required
   * INVENTORY line has an effective receipt with quantity/location/
   * required measurement. Document-level requirements are deliberately
   * EXCLUDED -- they are Step 4 concerns (the delivery-verifier control
   * lives there), and gating Step 3's Continue on them created a real
   * deadlock: Step 4 unreachable until a verifier is set, verifier only
   * settable on Step 4. */
  receivingComplete: boolean;
  blockers: PreparationBlocker[];
}

const IMPLAUSIBLE_DATE_YEAR = 2000;

/**
 * The read-only, rich, per-line/document preview of the same
 * completeness rule submit_purchase_document_for_verification enforces
 * authoritatively (purchase_document_preparation_incomplete,
 * purchase_document_missing_delivery_verifier,
 * purchase_document_has_implausible_date -- 20260811100047/100056) --
 * this is what lets the UI explain WHY Send for Final Review is
 * disabled, never the source of truth itself (a client could compute
 * this wrong or skip it entirely; the RPC-level checks are what actually
 * can't be bypassed).
 */
export async function getPreparationStatus(supabase: SupabaseClient, purchaseDocumentId: string, organizationId: string): Promise<PreparationStatus> {
  const [{ data: classifications }, { data: purchaseDocument }] = await Promise.all([
    supabase
      .from("purchase_document_line_classifications")
      .select("id, line_key, status, disposition, line_treatment")
      .eq("purchase_document_id", purchaseDocumentId)
      .eq("organization_id", organizationId),
    supabase.from("purchase_documents").select("document_date, source_document_id").eq("id", purchaseDocumentId).eq("organization_id", organizationId).maybeSingle(),
  ]);
  const classificationByLineKey = new Map((classifications ?? []).map((c) => [c.line_key as string, c]));

  // Line-treatment facts from the SAME database helpers the completeness
  // gate and the posting RPC use (20260811100182): which pending
  // proposals the manager's Continue/Post will accept, and which
  // treatments still have an invalid/missing required field.
  const acceptableIds = new Set<string>();
  const treatmentIssueById = new Map<string, string>();
  await Promise.all(
    (classifications ?? []).map(async (c) => {
      const id = c.id as string;
      const [{ data: acceptable }, { data: issue }] = await Promise.all([
        c.status === "PENDING_REVIEW" ? supabase.rpc("line_classification_is_auto_acceptable", { p_classification_id: id }) : Promise.resolve({ data: false }),
        supabase.rpc("line_classification_treatment_issue", { p_classification_id: id }),
      ]);
      if (acceptable === true) acceptableIds.add(id);
      if (typeof issue === "string" && issue.length > 0) treatmentIssueById.set(id, issue);
    })
  );

  const receivingLines = await getReceivingLines(supabase, purchaseDocumentId, organizationId);
  // The SAME purchase-package-mismatch fact combinedLineReadiness.ts (Step
  // 2's own authoritative per-line model) already checks -- without this,
  // a line with an unresolved vendor/SKU package mismatch could read as
  // "ready" here even though Step 2 correctly still calls it needs_
  // attention, letting Send for Second Review enable (and the Stepper
  // mark Step 2 done) despite the genuine unresolved mismatch.
  const packageMismatchByLineKey = await getPackageMismatchByLineKey(supabase, purchaseDocumentId, organizationId);

  const { data: effectiveReceipts } = await supabase.rpc("effective_receipts_for_purchase_document", {
    p_purchase_document_id: purchaseDocumentId,
    p_organization_id: organizationId,
  });
  const effectiveReceiptRows = (effectiveReceipts ?? []) as { id: string; delivery_event_id: string | null }[];
  const effectiveReceiptIds = effectiveReceiptRows.map((r) => r.id);
  const deliveryEventByReceiptId = new Map(effectiveReceiptRows.map((r) => [r.id, r.delivery_event_id]));

  const { data: receiptLines } =
    effectiveReceiptIds.length > 0
      ? await supabase
          .from("receipt_lines")
          .select("receipt_id, matched_line_key, actual_received_package_quantity, actual_received_package_unit, actual_verified_base_quantity, location_id")
          .in("receipt_id", effectiveReceiptIds)
          // Same deterministic "most recent wins" ordering as
          // getReviewSummary.ts's identical map-building query -- never
          // an unspecified row order when more than one effective receipt
          // touches the same line.
          .order("created_at", { ascending: true })
      : { data: [] };
  const receiptLineByMatchedKey = new Map((receiptLines ?? []).filter((r) => r.matched_line_key).map((r) => [r.matched_line_key as string, r]));

  const blockers: PreparationBlocker[] = [];
  let hasConfirmedInventory = false;

  for (const line of receivingLines) {
    const classification = classificationByLineKey.get(line.lineKey);

    if (!classification) {
      blockers.push({ lineKey: line.lineKey, description: line.description, reason: "Needs classification -- choose how this line should be treated." });
      continue;
    }
    if ((classification.line_treatment as string | null) === "UNRESOLVED") {
      blockers.push({ lineKey: line.lineKey, description: line.description, reason: "Needs classification -- choose how this line should be treated." });
      continue;
    }
    const acceptable = acceptableIds.has(classification.id as string);
    if (classification.status === "PENDING_REVIEW" && !acceptable) {
      blockers.push({
        lineKey: line.lineKey,
        description: line.description,
        reason: classification.disposition === "INVENTORY" ? "Awaiting manager approval of the item match." : "Awaiting manager confirmation of the classification.",
      });
      continue;
    }
    if (classification.status === "STALE") {
      blockers.push({ lineKey: line.lineKey, description: line.description, reason: "Line changed since it was classified -- needs re-review." });
      continue;
    }
    const treatmentIssue = treatmentIssueById.get(classification.id as string);
    if (treatmentIssue) {
      blockers.push({ lineKey: line.lineKey, description: line.description, reason: `Classification incomplete -- ${treatmentIssue}.` });
      continue;
    }
    // CONFIRMED (or acceptable) from here. Non-inventory treatments are
    // complete as soon as their own fields are valid -- never blocked by
    // receiving fields.
    if (classification.disposition !== "INVENTORY") {
      continue;
    }
    if (acceptable) {
      // An accepted-on-continue item match still needs receiving before
      // it can post; the manager sees this as "AI assigned · receiving
      // needed" on Items & Receiving.
      blockers.push({ lineKey: line.lineKey, description: line.description, reason: "Not yet received -- accept the item match and record a delivery quantity." });
      continue;
    }
    hasConfirmedInventory = true;

    const receiptLine = receiptLineByMatchedKey.get(line.lineKey);
    if (!receiptLine || receiptLine.actual_received_package_quantity === null) {
      blockers.push({ lineKey: line.lineKey, description: line.description, reason: "Not yet received -- record a delivery quantity." });
      continue;
    }
    if (receiptLine.location_id === null) {
      blockers.push({ lineKey: line.lineKey, description: line.description, reason: "Storage location is required." });
      continue;
    }
    if (line.requiresVerifiedMeasurement && receiptLine.actual_verified_base_quantity === null) {
      blockers.push({
        lineKey: line.lineKey,
        description: line.description,
        reason: `Verified ${line.baseUnitCode ?? "measurement"} is required -- this item's vendor purchase unit varies by delivery.`,
      });
      continue;
    }

    // DOWNSTREAM INVALIDATION: an already-recorded receipt whose facts no
    // longer agree with the item's CURRENT configuration (e.g. Manager 1
    // went back to Step 2 and remapped the item, or its units/behavior/
    // conversion changed) must never be silently preserved as
    // authoritative -- the affected line needs its receiving re-confirmed
    // (Edit Receiving records an append-only correction under the new
    // configuration; record_receipt re-validates it server-side).
    // Unrelated lines are judged strictly per-line and stay untouched.
    const receivedUnit = (receiptLine.actual_received_package_unit as string | null)?.trim().toLowerCase() ?? null;
    const matchesUnit = (code: string | null) => code !== null && receivedUnit === code.trim().toLowerCase();
    const unitStillConfigured = receivedUnit === null || matchesUnit(line.baseUnitCode) || matchesUnit(line.purchaseUnitCode);
    const fixedConversionConsistent =
      line.receivingBehavior !== "FIXED_CONVERSION" ||
      receiptLine.actual_verified_base_quantity === null ||
      line.fixedConversionFactor === null ||
      !matchesUnit(line.purchaseUnitCode) ||
      Number(receiptLine.actual_verified_base_quantity) === Number(receiptLine.actual_received_package_quantity) * line.fixedConversionFactor;

    if (!unitStillConfigured || !fixedConversionConsistent) {
      blockers.push({
        lineKey: line.lineKey,
        description: line.description,
        reason: "Receiving needs review -- this item's unit configuration changed after the delivery was recorded. Re-confirm the line via Edit Receiving.",
      });
      continue;
    }

    // The SAME purchase-package-mismatch fact combinedLineReadiness.ts
    // (Step 2's own authoritative model) checks -- checked LAST, after
    // every receipt-specific reason above, so a line whose ALREADY-
    // RECORDED receipt is merely stale relative to a newer item
    // configuration keeps that more specific, more actionable message
    // (which one blocker to show is otherwise ambiguous when both
    // conditions are genuinely true at once, e.g. right after a remap).
    if (packageMismatchByLineKey.get(line.lineKey)) {
      blockers.push({ lineKey: line.lineKey, description: line.description, reason: "Purchase package needs review -- the invoice unit does not match this vendor/SKU's confirmed package." });
    }
  }

  // Document-level checks -- never blamed on a specific line.
  if (hasConfirmedInventory && purchaseDocument?.source_document_id) {
    const { data: deliveryVerifierEmployeeId } = await supabase.rpc("current_document_delivery_verifier_employee_id", {
      p_document_id: purchaseDocument.source_document_id,
      p_organization_id: organizationId,
    });
    if (!deliveryVerifierEmployeeId) {
      blockers.push({
        lineKey: null,
        description: null,
        reason: "Delivery verified by is required before sending for final review -- this document has inventory lines.",
      });
    }
  }

  // Duplicate-delivery integrity: more than one NON-superseded (effective)
  // receipt line for the same invoice line means the same delivery was
  // recorded multiple times as independent DELIVERY receipts (corrections
  // supersede within their chain, so a normally-corrected line yields exactly
  // one effective line). Posting sums every effective receipt line, so this
  // would MULTIPLY inventory -- block it here (and surface the real reason)
  // rather than let it post 2x/3x, or be mis-reported as a price change.
  // Delivery lineage: block only genuinely AMBIGUOUS lineage (historical/
  // unidentified duplicates), never legitimate additional deliveries (distinct
  // delivery_event_id). One entry per effective receipt that contributes an
  // inventory line -- each is one physical delivery contribution.
  const deliveryReceiptIdsWithInventoryLines = new Set(
    (receiptLines ?? [])
      .filter((rl) => rl.matched_line_key !== null && receivingLines.some((l) => l.lineKey === rl.matched_line_key))
      .map((rl) => (rl as { receipt_id: string }).receipt_id),
  );
  const effectiveDeliveries = [...deliveryReceiptIdsWithInventoryLines].map((id) => ({ deliveryEventId: deliveryEventByReceiptId.get(id) ?? null }));
  if (isAmbiguousDeliveryLineage(effectiveDeliveries)) {
    blockers.push({ lineKey: null, description: null, reason: AMBIGUOUS_DELIVERY_REASON });
  }

  const documentDate = purchaseDocument?.document_date as string | null | undefined;
  if (documentDate && new Date(documentDate).getUTCFullYear() < IMPLAUSIBLE_DATE_YEAR) {
    blockers.push({
      lineKey: null,
      description: null,
      reason: `Invoice date needs attention: ${documentDate} does not look like a valid business document date.`,
    });
  }

  return {
    ready: blockers.length === 0,
    receivingComplete: lineLevelBlockers(blockers).length === 0,
    blockers,
  };
}
