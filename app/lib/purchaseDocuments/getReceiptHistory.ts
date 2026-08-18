import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface ReceiptHistoryEntry {
  id: string;
  receiptKind: "DELIVERY" | "CORRECTION";
  correctsReceiptId: string | null;
  occurredAt: string;
  recordedByName: string | null;
  notes: string | null;
  /** True for a receipt no other receipt is ever superseded BY it and no
   * later correction in the same chain supersedes it -- i.e. it's in
   * effective_receipts_for_purchase_document's own result. A receipt
   * that has been corrected (a later CORRECTION points corrects_receipt_id
   * at it) is superseded and shown as history, never hidden. */
  effective: boolean;
}

/**
 * The full read-only receipt timeline for a purchase document -- every
 * receipt ever recorded, not just the currently-effective ones, each
 * clearly marked Effective/Superseded so a correction relationship is
 * visible rather than presented as an unexplained list of timestamps.
 */
export async function getReceiptHistory(supabase: SupabaseClient, purchaseDocumentId: string, organizationId: string): Promise<ReceiptHistoryEntry[]> {
  const { data: receipts } = await supabase
    .from("receipts")
    .select("id, receipt_kind, corrects_receipt_id, occurred_at, notes, recorded_by_app_user_id")
    .eq("purchase_document_id", purchaseDocumentId)
    .eq("organization_id", organizationId)
    .order("occurred_at", { ascending: true });

  const { data: effectiveReceipts } = await supabase.rpc("effective_receipts_for_purchase_document", {
    p_purchase_document_id: purchaseDocumentId,
    p_organization_id: organizationId,
  });
  const effectiveIds = new Set(((effectiveReceipts ?? []) as { id: string }[]).map((r) => r.id));

  const appUserIds = Array.from(new Set((receipts ?? []).map((r) => r.recorded_by_app_user_id as string | null).filter((id): id is string => Boolean(id))));
  const { data: appUsers } =
    appUserIds.length > 0 ? await supabase.from("app_users").select("id, employees(first_name, last_name)").in("id", appUserIds) : { data: [] };
  const nameById = new Map(
    (appUsers ?? []).map((row) => {
      const employee = Array.isArray(row.employees) ? row.employees[0] : row.employees;
      return [row.id as string, employee ? `${employee.first_name} ${employee.last_name}` : null];
    })
  );

  return (receipts ?? []).map((r) => ({
    id: r.id as string,
    receiptKind: r.receipt_kind as "DELIVERY" | "CORRECTION",
    correctsReceiptId: r.corrects_receipt_id as string | null,
    occurredAt: r.occurred_at as string,
    recordedByName: r.recorded_by_app_user_id ? (nameById.get(r.recorded_by_app_user_id as string) ?? null) : null,
    notes: r.notes as string | null,
    effective: effectiveIds.has(r.id as string),
  }));
}
