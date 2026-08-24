import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/** V1 Reports foundation -- Receiving report (Section 35). Operational
 * status counts + the same posting-status derivation the Receiving Queue
 * uses (20260811100107), collapsed to summary counts. */
export interface ReceivingReportStatusRow {
  status: string;
  count: number;
}

export interface ReceivingReportVendorRow {
  vendorId: string;
  vendorName: string;
  count: number;
}

export interface ReceivingReport {
  documentCount: number;
  byStatus: ReceivingReportStatusRow[];
  byVendor: ReceivingReportVendorRow[];
  creditLineCount: number;
  readyToPostCount: number;
  partiallyPostedCount: number;
  postedCount: number;
}

export async function getReceivingReport(
  supabase: SupabaseClient,
  organizationId: string,
  dateFrom: string,
  dateTo: string,
  vendorId?: string | null
): Promise<ReceivingReport> {
  const { data, error } = await supabase.rpc("get_receiving_report", {
    p_organization_id: organizationId,
    p_date_from: dateFrom,
    p_date_to: dateTo,
    p_vendor_id: vendorId ?? null,
  });
  if (error) throw new Error(error.message);
  const row = (data ?? {}) as Partial<ReceivingReport>;
  return {
    documentCount: row.documentCount ?? 0,
    byStatus: row.byStatus ?? [],
    byVendor: row.byVendor ?? [],
    creditLineCount: row.creditLineCount ?? 0,
    readyToPostCount: row.readyToPostCount ?? 0,
    partiallyPostedCount: row.partiallyPostedCount ?? 0,
    postedCount: row.postedCount ?? 0,
  };
}
