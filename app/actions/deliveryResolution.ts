"use server";

import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { getDeliveryResolutionData, type DeliveryResolutionData } from "@/app/lib/purchaseDocuments/deliveryResolution";

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
