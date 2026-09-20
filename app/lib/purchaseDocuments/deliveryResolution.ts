import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getReceivingLines } from "@/app/lib/receiving/getReceivingLines";

/**
 * Read model for the delivery-lineage resolver. Returns each current effective
 * delivery lineage of a document with the facts a manager needs to decide
 * whether they are separate physical deliveries or duplicate entries, plus the
 * authoritative status and the fingerprint the resolve RPC validates against.
 *
 * Every quantity is carried WITH its unit -- the received package unit for the
 * recorded quantity and the item's own base unit for the normalized inventory
 * quantity. No quantity is ever summed across different base units, and no
 * quantity is ever labeled a generic "base".
 */

export type DeliveryStatus = "SINGLE" | "ADDITIONAL" | "RESOLVED" | "AMBIGUOUS";

export interface DeliveryLineageLine {
  lineKey: string;
  description: string | null;
  /** Recorded (received) quantity for this line in this lineage. */
  quantity: number | null;
  /** Unit of `quantity` -- the received package unit (e.g. PIECE, LB). */
  unit: string | null;
  /** Normalized quantity in the item's own base unit (null when not yet
   * measured for a MEASURE/COUNT item). */
  normalizedBaseQuantity: number | null;
  /** The item's authoritative base unit code (e.g. PIECE, LB) -- never a
   * generic "base"; used to label both the normalized quantity and the
   * inventory that would post. */
  baseUnitCode: string | null;
  /** Invoice-stated package quantity for this line + its unit, so a manager
   * can compare recorded vs invoiced when deciding separate-vs-duplicate. */
  invoiceQuantity: number | null;
  invoiceUnit: string | null;
  location: string | null;
  /** RECEIVED_AS_INVOICED / SHORT / DAMAGED etc. -- the line's condition. */
  condition: string | null;
  /** Free-text note recorded on this receipt line, if any. */
  note: string | null;
}

export interface DeliveryLineage {
  receiptId: string;
  receiptRef: string;
  /** 1-based ordinal ("Recorded delivery 1/2/3") in occurred-at order --
   * the manager-facing identity, never "Legacy delivery". */
  ordinal: number;
  /** When this delivery was originally recorded (root of the correction
   * chain), if distinct from the latest correction. */
  originallyRecordedAt: string | null;
  /** When the current (effective) version of this lineage was recorded --
   * the latest correction, or the original if never corrected. */
  recordedAt: string | null;
  /** Actor who originally recorded the delivery. */
  originalActorName: string | null;
  /** Actor who recorded the latest correction (null if never corrected). */
  correctingActorName: string | null;
  /** Whether this lineage has been corrected at least once. */
  wasCorrected: boolean;
  deliveryEventId: string | null;
  isLegacy: boolean;
  correctionChain: string[];
  /** Receipt-level note on the current (effective) version, if any. */
  note: string | null;
  lines: DeliveryLineageLine[];
}

export interface DeliveryResolutionData {
  status: DeliveryStatus;
  fingerprint: string;
  affectedLineKeys: string[];
  lineages: DeliveryLineage[];
}

export async function getDeliveryResolutionData(
  supabase: SupabaseClient,
  purchaseDocumentId: string,
  organizationId: string,
): Promise<DeliveryResolutionData> {
  const [{ data: status }, { data: fingerprint }, { data: effReceipts }, receivingLines] = await Promise.all([
    supabase.rpc("purchase_document_delivery_status", { p_purchase_document_id: purchaseDocumentId, p_organization_id: organizationId }),
    supabase.rpc("purchase_document_delivery_fingerprint", { p_purchase_document_id: purchaseDocumentId, p_organization_id: organizationId }),
    supabase.rpc("effective_receipts_for_purchase_document", { p_purchase_document_id: purchaseDocumentId, p_organization_id: organizationId }),
    getReceivingLines(supabase, purchaseDocumentId, organizationId),
  ]);

  // Per-line item facts: base unit + invoice quantity, keyed by matched line.
  const baseUnitByLineKey = new Map(receivingLines.map((l) => [l.lineKey, l.baseUnitCode]));
  const invoiceQtyByLineKey = new Map(receivingLines.map((l) => [l.lineKey, l.invoicePackageQuantity]));
  const invoiceUnitByLineKey = new Map(receivingLines.map((l) => [l.lineKey, l.invoicePackageUnit]));

  const receipts = ((effReceipts ?? []) as {
    id: string;
    delivery_event_id: string | null;
    occurred_at: string | null;
    recorded_by_app_user_id: string | null;
    corrects_receipt_id: string | null;
    receipt_kind: string;
    notes: string | null;
  }[]);

  // We need the whole chain (including superseded/corrected receipts) to show
  // original vs latest timestamps and the original vs correcting actor.
  const { data: allReceiptRows } = await supabase
    .from("receipts")
    .select("id, occurred_at, recorded_by_app_user_id, corrects_receipt_id, receipt_kind, notes, created_at")
    .eq("purchase_document_id", purchaseDocumentId)
    .eq("organization_id", organizationId);
  const allById = new Map(((allReceiptRows ?? []) as { id: string }[]).map((r) => [(r as { id: string }).id, r as {
    id: string; occurred_at: string | null; recorded_by_app_user_id: string | null; corrects_receipt_id: string | null; receipt_kind: string; notes: string | null; created_at: string | null;
  }]));

  // Resolve recorder names for every actor across the full chain.
  const actorIds = Array.from(new Set(
    [...(allReceiptRows ?? []) as { recorded_by_app_user_id: string | null }[]]
      .map((r) => r.recorded_by_app_user_id)
      .filter((x): x is string => x !== null),
  ));
  const nameById = new Map<string, string>();
  if (actorIds.length > 0) {
    const { data: users } = await supabase.from("app_users").select("id, employees(first_name, last_name)").in("id", actorIds);
    for (const u of users ?? []) {
      const emp = (u as { employees?: { first_name?: string | null; last_name?: string | null } | null }).employees;
      nameById.set((u as { id: string }).id, emp ? `${emp.first_name ?? ""} ${emp.last_name ?? ""}`.trim() || "A manager" : "A manager");
    }
  }

  const receiptIds = receipts.map((r) => r.id);
  const { data: lineRows } = receiptIds.length
    ? await supabase
        .from("receipt_lines")
        .select("receipt_id, matched_line_key, description_snapshot, invoice_package_quantity, invoice_package_unit, actual_received_package_quantity, actual_received_package_unit, actual_verified_base_quantity, location_id, condition_status, notes")
        .in("receipt_id", receiptIds)
        .not("matched_line_key", "is", null)
    : { data: [] };
  const rows = (lineRows ?? []) as {
    receipt_id: string;
    matched_line_key: string;
    description_snapshot: string | null;
    invoice_package_quantity: number | null;
    invoice_package_unit: string | null;
    actual_received_package_quantity: number | null;
    actual_received_package_unit: string | null;
    actual_verified_base_quantity: number | null;
    location_id: string | null;
    condition_status: string | null;
    notes: string | null;
  }[];

  const locationIds = Array.from(new Set(rows.map((r) => r.location_id).filter((x): x is string => x !== null)));
  const locationById = new Map<string, string>();
  if (locationIds.length > 0) {
    const { data: locs } = await supabase.from("locations").select("id, name").in("id", locationIds);
    for (const l of locs ?? []) locationById.set((l as { id: string }).id, (l as { name: string }).name);
  }

  const chainOf = (receiptId: string): string[] => {
    const chain: string[] = [receiptId.slice(0, 8)];
    let cur = allById.get(receiptId);
    while (cur?.corrects_receipt_id) {
      chain.push(cur.corrects_receipt_id.slice(0, 8));
      cur = allById.get(cur.corrects_receipt_id);
      if (!cur) break;
    }
    return chain;
  };

  // Walk to the root of a correction chain (the original delivery) to recover
  // the original timestamp + actor, distinct from the latest correction.
  const rootOf = (receiptId: string): { id: string; occurred_at: string | null; recorded_by_app_user_id: string | null } => {
    let cur = allById.get(receiptId);
    let root = cur;
    while (cur?.corrects_receipt_id) {
      const next = allById.get(cur.corrects_receipt_id);
      if (!next) break;
      root = next;
      cur = next;
    }
    return root ? { id: root.id, occurred_at: root.occurred_at, recorded_by_app_user_id: root.recorded_by_app_user_id } : { id: receiptId, occurred_at: null, recorded_by_app_user_id: null };
  };

  // Effective lineages are ordered by their original recording time so the
  // "Recorded delivery 1/2/3" ordinals are stable and chronological.
  const ordered = [...receipts].sort((a, b) => {
    const ra = rootOf(a.id).occurred_at ?? "";
    const rb = rootOf(b.id).occurred_at ?? "";
    return ra.localeCompare(rb);
  });

  const affected = new Set<string>();
  const lineages: DeliveryLineage[] = ordered.map((r, index) => {
    const rls = rows.filter((x) => x.receipt_id === r.id);
    for (const rl of rls) affected.add(rl.matched_line_key);
    const root = rootOf(r.id);
    const wasCorrected = r.corrects_receipt_id !== null;
    return {
      receiptId: r.id,
      receiptRef: r.id.slice(0, 8),
      ordinal: index + 1,
      originallyRecordedAt: root.occurred_at,
      recordedAt: r.occurred_at,
      originalActorName: root.recorded_by_app_user_id ? (nameById.get(root.recorded_by_app_user_id) ?? "A manager") : null,
      correctingActorName: wasCorrected && r.recorded_by_app_user_id ? (nameById.get(r.recorded_by_app_user_id) ?? "A manager") : null,
      wasCorrected,
      deliveryEventId: r.delivery_event_id,
      isLegacy: r.delivery_event_id === null,
      correctionChain: chainOf(r.id),
      note: r.notes ?? allById.get(r.id)?.notes ?? null,
      lines: rls.map((rl) => ({
        lineKey: rl.matched_line_key,
        description: rl.description_snapshot,
        quantity: rl.actual_received_package_quantity,
        unit: rl.actual_received_package_unit,
        normalizedBaseQuantity: rl.actual_verified_base_quantity,
        baseUnitCode: baseUnitByLineKey.get(rl.matched_line_key) ?? null,
        invoiceQuantity: rl.invoice_package_quantity ?? invoiceQtyByLineKey.get(rl.matched_line_key) ?? null,
        invoiceUnit: rl.invoice_package_unit ?? invoiceUnitByLineKey.get(rl.matched_line_key) ?? null,
        location: rl.location_id ? (locationById.get(rl.location_id) ?? null) : null,
        condition: rl.condition_status,
        note: rl.notes,
      })),
    };
  });

  return {
    status: (status as DeliveryStatus) ?? "SINGLE",
    fingerprint: (fingerprint as string) ?? "",
    affectedLineKeys: [...affected],
    lineages,
  };
}
