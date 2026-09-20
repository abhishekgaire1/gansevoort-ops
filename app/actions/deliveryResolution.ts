"use server";

import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { getDeliveryResolutionData, type DeliveryResolutionData } from "@/app/lib/purchaseDocuments/deliveryResolution";
import { getPostedDeliveryConflict, type PostedDeliveryConflict } from "@/app/lib/inventory/deliveryConflictCorrection";
import { recordInventoryCorrection } from "@/app/lib/inventory/corrections";
import { InsufficientInventoryError, InvalidCorrectionInputError } from "@/app/lib/inventory/errors";

type AuthFailure = { ok: false; reason: "not_authorized"; message: string };
const NOT_AUTHORIZED: AuthFailure = { ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." };

export type GetDeliveryResolutionResult = { ok: true; data: DeliveryResolutionData } | AuthFailure;

export async function getDeliveryResolution(purchaseDocumentId: string): Promise<GetDeliveryResolutionResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;
  const data = await getDeliveryResolutionData(getServiceRoleClient(), purchaseDocumentId, auth.manager.organizationId);
  return { ok: true, data };
}

export interface DeliveryResolutionDecision {
  receiptId: string;
  decision: "CANONICAL" | "DUPLICATE";
  duplicateOfReceiptId: string | null;
}

export type ResolveDeliveryLineageResult =
  | { ok: true; resolutionId: string; resolutionVersion: number; status: string }
  | { ok: false; reason: "routed_to_correction"; message: string }
  | AuthFailure
  | { ok: false; reason: "invalid" | "stale" | "misconfigured"; message: string };

export async function resolveDeliveryLineage(input: {
  purchaseDocumentId: string;
  expectedFingerprint: string;
  reason: string;
  acknowledged: boolean;
  decisions: DeliveryResolutionDecision[];
}): Promise<ResolveDeliveryLineageResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const { data, error } = await getServiceRoleClient().rpc("resolve_delivery_lineage", {
    p_purchase_document_id: input.purchaseDocumentId,
    p_organization_id: auth.manager.organizationId,
    p_app_user_id: auth.manager.appUserId,
    p_expected_fingerprint: input.expectedFingerprint,
    p_reason: input.reason,
    p_acknowledged: input.acknowledged,
    p_decisions: input.decisions,
  });

  if (error) {
    if (error.code === "GA002") return { ok: false, reason: "stale", message: "The recorded deliveries changed since you reviewed them. Reload and try again." };
    if (error.code === "GA033" || error.code === "GA006") return { ok: false, reason: "invalid", message: error.message };
    return { ok: false, reason: "misconfigured", message: "The delivery resolution could not be saved." };
  }

  const row = (Array.isArray(data) ? data[0] : data) as
    | { out_resolution_id: string | null; out_resolution_version: number | null; out_status: string; out_routed_to_correction: boolean }
    | undefined;
  if (!row) return { ok: false, reason: "misconfigured", message: "The delivery resolution returned no result." };

  if (row.out_routed_to_correction) {
    return {
      ok: false,
      reason: "routed_to_correction",
      message: "One or more of these deliveries has already posted inventory. Use the Inventory Correction workflow — this cannot be resolved by exclusion.",
    };
  }

  return { ok: true, resolutionId: row.out_resolution_id!, resolutionVersion: row.out_resolution_version!, status: row.out_status };
}

/* -------------------------------------------------------------------------- */
/* §4 posted-delivery-conflict -> inventory correction handoff                 */
/* -------------------------------------------------------------------------- */

export type GetPostedDeliveryConflictResult = { ok: true; data: PostedDeliveryConflict } | AuthFailure;

export async function getPostedDeliveryConflict_action(purchaseDocumentId: string): Promise<GetPostedDeliveryConflictResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;
  const data = await getPostedDeliveryConflict(getServiceRoleClient(), purchaseDocumentId, auth.manager.organizationId);
  return { ok: true, data };
}

export type CreateDeliveryConflictCorrectionResult =
  | { ok: true; correctionIds: string[]; correctedItems: number }
  | { ok: false; reason: "nothing_to_correct"; message: string }
  | { ok: false; reason: "would_go_negative"; message: string }
  | { ok: false; reason: "not_acknowledged"; message: string }
  | AuthFailure
  | { ok: false; reason: "invalid"; message: string };

/**
 * Removes the duplicate excess that an already-posted ambiguous document added
 * to inventory, through the audited correction primitive. Never auto-applies:
 * requires an explicit acknowledgment and a reason. The server RECALCULATES the
 * conflict at call time (it does not trust any client-supplied quantities), so a
 * balance that changed since the manager looked is reflected authoritatively.
 * Idempotent per (clientRequestId, item, location): re-submitting the same
 * request does not double-correct because record_inventory_correction dedupes on
 * its client_request_id. Negative stock is blocked both here (pre-check) and by
 * the correction RPC's own lock-then-reread.
 */
export async function createDeliveryConflictCorrection(input: {
  purchaseDocumentId: string;
  reason: string;
  acknowledged: boolean;
  clientRequestId: string;
}): Promise<CreateDeliveryConflictCorrectionResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;
  if (!input.acknowledged) {
    return { ok: false, reason: "not_acknowledged", message: "You must acknowledge that this removes duplicate inventory before continuing." };
  }
  if (!input.reason || input.reason.trim() === "") {
    return { ok: false, reason: "invalid", message: "A reason is required to correct inventory." };
  }

  const supabase = getServiceRoleClient();

  // Server-authoritative recalculation -- never trust client quantities.
  const conflict = await getPostedDeliveryConflict(supabase, input.purchaseDocumentId, auth.manager.organizationId);
  if (!conflict.isPostedConflict || conflict.items.length === 0) {
    return { ok: false, reason: "nothing_to_correct", message: "There is no posted duplicate inventory to correct for this document." };
  }
  if (conflict.items.some((it) => it.wouldGoNegative)) {
    return {
      ok: false,
      reason: "would_go_negative",
      message: "Removing the duplicate quantity would drive stock below zero for at least one item. Investigate withdrawals before correcting.",
    };
  }

  const reason = `Delivery-conflict correction (duplicate delivery, doc ${input.purchaseDocumentId.slice(0, 8)}): ${input.reason.trim()}`;
  const correctionIds: string[] = [];
  try {
    for (const item of conflict.items) {
      // Deterministic per-line request id keeps the whole batch idempotent.
      const requestId = `${input.clientRequestId}:${item.inventoryItemId}:${item.locationId}`;
      const result = await recordInventoryCorrection(
        supabase,
        auth.manager.appUserId,
        item.inventoryItemId,
        item.locationId,
        "DELTA",
        null,
        item.proposedDelta,
        reason,
        requestId,
      );
      correctionIds.push(result.correctionId);
    }
  } catch (e) {
    if (e instanceof InsufficientInventoryError) {
      return { ok: false, reason: "would_go_negative", message: "Removing the duplicate quantity would drive stock below zero. Investigate withdrawals before correcting." };
    }
    if (e instanceof InvalidCorrectionInputError) {
      return { ok: false, reason: "invalid", message: e.message };
    }
    throw e;
  }

  return { ok: true, correctionIds, correctedItems: conflict.items.length };
}
