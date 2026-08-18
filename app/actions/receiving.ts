"use server";

import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { recordReceiptRpc } from "@/app/lib/receiving/recordReceiptRpc";
import { correctDocumentDeliveryVerifierRpc } from "@/app/lib/itemMaster/correctDocumentDeliveryVerifierRpc";
import { setInventoryItemDefaultReceivingLocationRpc } from "@/app/lib/itemMaster/setInventoryItemDefaultReceivingLocationRpc";
import { confirmReceivingLineInvoiceUnitRpc } from "@/app/lib/receiving/confirmReceivingLineInvoiceUnitRpc";
import { getReceivingLines, type ReceivingLineInfo } from "@/app/lib/receiving/getReceivingLines";
import { ReceiptNotFoundOrInvalidError, EmployeeNotFoundOrInactiveError, FixedConversionQuantityMismatchError } from "@/app/lib/itemMaster/errors";
import type { ReceiptKind, ReceiptLineInput } from "@/app/lib/receiving/types";

type AuthFailure = { ok: false; reason: "not_authorized"; message: string };
const NOT_AUTHORIZED: AuthFailure = { ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." };

export interface RecordReceiptInput {
  receiptKind: ReceiptKind;
  purchaseDocumentId?: string | null;
  correctsReceiptId?: string | null;
  defaultLocationId?: string | null;
  notes?: string | null;
  lines: ReceiptLineInput[];
  /** Learns each item's default receiving location, but ONLY after the
   * receipt below has actually been recorded successfully -- opening or
   * editing the draft form never touches this. Best-effort: a failure
   * here never fails the receipt itself, which is already authoritative
   * by the time this runs. Deliberately NOT part of ReceiptLineInput --
   * that type is also the record_receipt RPC's own line-item contract,
   * and this is a completely separate, Item-Master-level side effect. */
  rememberLocations?: { inventoryItemId: string; locationId: string }[];
  /** Resolves an ambiguous (or explicitly conflicting) invoice unit for
   * one or more lines, inline in Step 3 -- Receive Delivery. Same
   * "only after the receipt has actually succeeded" and best-effort
   * per-entry semantics as rememberLocations above; a failure here never
   * fails the receipt. purchaseDocumentId is required (this concept only
   * applies to a DELIVERY receipt tied to a specific purchase document
   * revision, never a standalone correction). */
  confirmedInvoiceUnits?: { lineKey: string; unitCode: string; rememberForVendor: boolean }[];
  /** See RecordReceiptRpcInput.idempotencyKey -- passed straight through. */
  idempotencyKey?: string | null;
}

export type RecordReceiptResult =
  | { ok: true; receiptId: string }
  | AuthFailure
  | { ok: false; reason: "invalid_receipt" | "quantity_mismatch" | "misconfigured"; message: string };

export async function recordReceipt(input: RecordReceiptInput): Promise<RecordReceiptResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  try {
    const result = await recordReceiptRpc(getServiceRoleClient(), {
      organizationId: auth.manager.organizationId,
      appUserId: auth.manager.appUserId,
      receiptKind: input.receiptKind,
      purchaseDocumentId: input.purchaseDocumentId,
      correctsReceiptId: input.correctsReceiptId,
      defaultLocationId: input.defaultLocationId,
      notes: input.notes,
      lines: input.lines,
      idempotencyKey: input.idempotencyKey,
    });

    if (input.rememberLocations && input.rememberLocations.length > 0) {
      const supabase = getServiceRoleClient();
      await Promise.all(
        input.rememberLocations.map((entry) =>
          setInventoryItemDefaultReceivingLocationRpc(supabase, {
            organizationId: auth.manager.organizationId,
            appUserId: auth.manager.appUserId,
            inventoryItemId: entry.inventoryItemId,
            locationId: entry.locationId,
          }).catch(() => {
            // Soft failure -- the receipt itself already succeeded and is
            // authoritative; a missed location-memory update just means
            // next time's prefill is less convenient, never wrong.
          })
        )
      );
    }

    if (input.confirmedInvoiceUnits && input.confirmedInvoiceUnits.length > 0 && input.purchaseDocumentId) {
      const supabase = getServiceRoleClient();
      const purchaseDocumentId = input.purchaseDocumentId;
      await Promise.all(
        input.confirmedInvoiceUnits.map((entry) =>
          confirmReceivingLineInvoiceUnitRpc(supabase, {
            organizationId: auth.manager.organizationId,
            appUserId: auth.manager.appUserId,
            purchaseDocumentId,
            lineKey: entry.lineKey,
            confirmedInvoiceUnitCode: entry.unitCode,
            rememberForVendor: entry.rememberForVendor,
          }).catch(() => {
            // Soft failure, same reasoning as rememberLocations above --
            // the receipt is already authoritative; a missed invoice-unit
            // confirmation just means this line stays unresolved next time.
          })
        )
      );
    }

    return { ok: true, receiptId: result.receiptId };
  } catch (err) {
    if (err instanceof ReceiptNotFoundOrInvalidError) {
      return { ok: false, reason: "invalid_receipt", message: "The receipt or purchase document being referenced could not be found." };
    }
    if (err instanceof FixedConversionQuantityMismatchError) {
      return { ok: false, reason: "quantity_mismatch", message: "The received quantity doesn't match the item's known unit conversion. Re-check the received quantity/unit and try again." };
    }
    return { ok: false, reason: "misconfigured", message: "Could not record the receipt. Try again." };
  }
}

export interface EffectiveReceiptRow {
  id: string;
  receiptKind: "DELIVERY" | "CORRECTION";
  correctsReceiptId: string | null;
  occurredAt: string;
  notes: string | null;
}

export type ListEffectiveReceiptsResult = { ok: true; receipts: EffectiveReceiptRow[] } | AuthFailure;

/** The only receipt read 2A.4 (and this milestone's own receiving UI) is
 * ever allowed to use -- every receipt not superseded by a later
 * correction. */
export async function listEffectiveReceiptsForPurchaseDocument(purchaseDocumentId: string): Promise<ListEffectiveReceiptsResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const supabase = getServiceRoleClient();
  const { data } = await supabase.rpc("effective_receipts_for_purchase_document", {
    p_purchase_document_id: purchaseDocumentId,
    p_organization_id: auth.manager.organizationId,
  });

  const receipts: EffectiveReceiptRow[] = ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    receiptKind: r.receipt_kind as "DELIVERY" | "CORRECTION",
    correctsReceiptId: r.corrects_receipt_id as string | null,
    occurredAt: r.occurred_at as string,
    notes: r.notes as string | null,
  }));

  return { ok: true, receipts };
}

export type GetReceivingLinesResult = { ok: true; lines: ReceivingLineInfo[] } | AuthFailure;

export async function getReceivingLinesForPurchaseDocument(purchaseDocumentId: string): Promise<GetReceivingLinesResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const lines = await getReceivingLines(getServiceRoleClient(), purchaseDocumentId, auth.manager.organizationId);
  return { ok: true, lines };
}

export interface LocationSummary {
  id: string;
  name: string;
}

export type ListLocationsResult = { ok: true; locations: LocationSummary[] } | AuthFailure;

export async function listLocations(): Promise<ListLocationsResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const supabase = getServiceRoleClient();
  const { data } = await supabase.from("locations").select("id, name").eq("organization_id", auth.manager.organizationId).eq("is_active", true).order("name");
  return { ok: true, locations: (data ?? []).map((l) => ({ id: l.id as string, name: l.name as string })) };
}

export interface EmployeeSummary {
  id: string;
  name: string;
}

export type ListActiveEmployeesResult = { ok: true; employees: EmployeeSummary[] } | AuthFailure;

/** For the delivery-verifier picker -- an employee, never an app_user
 * (the person who physically verified a delivery may never authenticate
 * with the app at all, see 20260811100038's own design note). */
export async function listActiveEmployees(): Promise<ListActiveEmployeesResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const supabase = getServiceRoleClient();
  const { data } = await supabase
    .from("employees")
    .select("id, first_name, last_name")
    .eq("organization_id", auth.manager.organizationId)
    .eq("status", "active")
    .order("first_name");
  return { ok: true, employees: (data ?? []).map((e) => ({ id: e.id as string, name: `${e.first_name} ${e.last_name}` })) };
}

export type CorrectDocumentDeliveryVerifierResult =
  | { ok: true }
  | AuthFailure
  | { ok: false; reason: "invalid_employee" | "misconfigured"; message: string };

export async function correctDocumentDeliveryVerifier(
  documentId: string,
  newEmployeeId: string,
  reason?: string
): Promise<CorrectDocumentDeliveryVerifierResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  try {
    await correctDocumentDeliveryVerifierRpc(getServiceRoleClient(), {
      documentId,
      organizationId: auth.manager.organizationId,
      appUserId: auth.manager.appUserId,
      newEmployeeId,
      reason,
    });
    return { ok: true };
  } catch (err) {
    if (err instanceof EmployeeNotFoundOrInactiveError) {
      return { ok: false, reason: "invalid_employee", message: "That employee is not active in this organization." };
    }
    return { ok: false, reason: "misconfigured", message: "Could not correct the delivery verifier. Try again." };
  }
}
