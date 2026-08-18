import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mapItemMasterRpcError } from "@/app/lib/itemMaster/errors";

export interface ConfirmReceivingLineInvoiceUnitInput {
  organizationId: string;
  appUserId: string;
  purchaseDocumentId: string;
  lineKey: string;
  confirmedInvoiceUnitCode: string;
  /** Defaults to true (low-friction: most vendors bill a given SKU
   * consistently) -- the manager can uncheck it to resolve just this one
   * invoice without touching the vendor's remembered default. Silently
   * skipped server-side (never guessed) when the line has no vendor_sku
   * to key vendor-wide memory off of. */
  rememberForVendor: boolean;
}

export interface ConfirmReceivingLineInvoiceUnitResult {
  /** True unless this exact line was already confirmed to this exact
   * unit (a quiet no-op, no new historical row). */
  lineConfirmationRecorded: boolean;
  /** True only when rememberForVendor was set AND the vendor's
   * remembered default actually changed (also a quiet no-op otherwise). */
  vendorMappingUpdated: boolean;
}

/** Resolves an ambiguous (or explicitly conflicting) invoice unit for one
 * receiving line -- see confirm_receiving_line_invoice_unit
 * (20260811100054). Manager confirmation is the only caller of this;
 * an AI suggestion alone must never call it. */
export async function confirmReceivingLineInvoiceUnitRpc(
  supabase: SupabaseClient,
  input: ConfirmReceivingLineInvoiceUnitInput
): Promise<ConfirmReceivingLineInvoiceUnitResult> {
  const { data, error } = await supabase.rpc("confirm_receiving_line_invoice_unit", {
    p_organization_id: input.organizationId,
    p_app_user_id: input.appUserId,
    p_purchase_document_id: input.purchaseDocumentId,
    p_line_key: input.lineKey,
    p_confirmed_invoice_unit_code: input.confirmedInvoiceUnitCode,
    p_remember_for_vendor: input.rememberForVendor,
  });

  if (error) {
    throw mapItemMasterRpcError(error);
  }

  const row = ((data ?? []) as { out_line_confirmation_recorded: boolean; out_vendor_mapping_updated: boolean }[])[0];
  return {
    lineConfirmationRecorded: Boolean(row?.out_line_confirmation_recorded),
    vendorMappingUpdated: Boolean(row?.out_vendor_mapping_updated),
  };
}
