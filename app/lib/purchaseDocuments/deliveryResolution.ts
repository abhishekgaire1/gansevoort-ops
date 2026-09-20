import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Read model for the delivery-lineage resolver. Returns each current effective
 * delivery lineage of a document with the facts a manager needs to decide
 * whether they are separate physical deliveries or duplicate entries, plus the
 * authoritative status and the fingerprint the resolve RPC validates against.
 */

export type DeliveryStatus = "SINGLE" | "ADDITIONAL" | "RESOLVED" | "AMBIGUOUS";

export interface DeliveryLineageLine {
  lineKey: string;
  description: string | null;
  quantity: number | null;
  unit: string | null;
  normalizedBaseQuantity: number | null;
  location: string | null;
  condition: string | null;
}

export interface DeliveryLineage {
  receiptId: string;
  receiptRef: string;
  recordedAt: string | null;
  recordedByName: string | null;
  deliveryEventId: string | null;
  isLegacy: boolean;
  correctionChain: string[];
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
  const [{ data: status }, { data: fingerprint }, { data: effReceipts }] = await Promise.all([
    supabase.rpc("purchase_document_delivery_status", { p_purchase_document_id: purchaseDocumentId, p_organization_id: organizationId }),
    supabase.rpc("purchase_document_delivery_fingerprint", { p_purchase_document_id: purchaseDocumentId, p_organization_id: organizationId }),
    supabase.rpc("effective_receipts_for_purchase_document", { p_purchase_document_id: purchaseDocumentId, p_organization_id: organizationId }),
  ]);

  const receipts = ((effReceipts ?? []) as {
    id: string;
    delivery_event_id: string | null;
    occurred_at: string | null;
    recorded_by_app_user_id: string | null;
    corrects_receipt_id: string | null;
    receipt_kind: string;
  }[]);

  // Resolve recorder names.
  const actorIds = Array.from(new Set(receipts.map((r) => r.recorded_by_app_user_id).filter((x): x is string => x !== null)));
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
        .select("receipt_id, matched_line_key, description_snapshot, actual_received_package_quantity, actual_received_package_unit, actual_verified_base_quantity, location_id")
        .in("receipt_id", receiptIds)
        .not("matched_line_key", "is", null)
    : { data: [] };
  const rows = (lineRows ?? []) as {
    receipt_id: string;
    matched_line_key: string;
    description_snapshot: string | null;
    actual_received_package_quantity: number | null;
    actual_received_package_unit: string | null;
    actual_verified_base_quantity: number | null;
    location_id: string | null;
  }[];

  const locationIds = Array.from(new Set(rows.map((r) => r.location_id).filter((x): x is string => x !== null)));
  const locationById = new Map<string, string>();
  if (locationIds.length > 0) {
    const { data: locs } = await supabase.from("locations").select("id, name").in("id", locationIds);
    for (const l of locs ?? []) locationById.set((l as { id: string }).id, (l as { name: string }).name);
  }

  const chainOf = (receiptId: string): string[] => {
    const chain: string[] = [receiptId.slice(0, 8)];
    let cur = receipts.find((r) => r.id === receiptId);
    while (cur?.corrects_receipt_id) {
      chain.push(cur.corrects_receipt_id.slice(0, 8));
      cur = receipts.find((r) => r.id === cur!.corrects_receipt_id);
      if (!cur) break;
    }
    return chain;
  };

  const affected = new Set<string>();
  const lineages: DeliveryLineage[] = receipts.map((r) => {
    const rls = rows.filter((x) => x.receipt_id === r.id);
    for (const rl of rls) affected.add(rl.matched_line_key);
    return {
      receiptId: r.id,
      receiptRef: r.id.slice(0, 8),
      recordedAt: r.occurred_at,
      recordedByName: r.recorded_by_app_user_id ? (nameById.get(r.recorded_by_app_user_id) ?? "A manager") : null,
      deliveryEventId: r.delivery_event_id,
      isLegacy: r.delivery_event_id === null,
      correctionChain: chainOf(r.id),
      lines: rls.map((rl) => ({
        lineKey: rl.matched_line_key,
        description: rl.description_snapshot,
        quantity: rl.actual_received_package_quantity,
        unit: rl.actual_received_package_unit,
        normalizedBaseQuantity: rl.actual_verified_base_quantity,
        location: rl.location_id ? (locationById.get(rl.location_id) ?? null) : null,
        condition: null,
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
