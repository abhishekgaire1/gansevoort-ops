"use server";

import { requireManagerOrAdmin, requireAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import {
  setLineTreatmentRpc,
  acceptAiAssignedLineClassificationsRpc,
  listVendorLineTreatmentRulesRpc,
  setVendorLineTreatmentRuleActiveRpc,
  type VendorLineTreatmentRuleSummary,
} from "@/app/lib/purchaseDocuments/lineTreatmentRpcs";
import { classifyPurchaseDocumentLines } from "@/app/lib/itemMaster/classifyPurchaseDocumentLines";
import {
  InvalidLineTreatmentError,
  ExplanationRequiredError,
  NotPreparerError,
  VerifiedLockedError,
  StaleVersionError,
} from "@/app/lib/purchaseDocuments/errors";
import { InsufficientInventoryError, InvalidStorageLocationError } from "@/app/lib/inventory/errors";
import { LineNotFoundInCurrentRevisionError, ItemNotPendingReviewError } from "@/app/lib/itemMaster/errors";
import { isLineTreatment, type CreditSubtype, type DiscountScope, type LineTreatment } from "@/app/lib/purchaseDocuments/lineTreatment";

/** Unexpected failures are logged with full detail for developers; the
 * manager only ever sees a safe message. */
function logIfUnexpected(actionName: string, err: unknown, context: Record<string, unknown>): void {
  console.error(`[${actionName}] unexpected failure`, { ...context, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
}

type AuthFailure = { ok: false; reason: "not_authorized"; message: string };
const NOT_AUTHORIZED: AuthFailure = { ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." };

export interface SetLineTreatmentActionInput {
  purchaseDocumentId: string;
  lineKey: string;
  lineTreatment: LineTreatment;
  creditSubtype?: CreditSubtype | null;
  spendCategoryId?: string | null;
  explanation?: string | null;
  discountScope?: DiscountScope | null;
  discountRelatedLineKey?: string | null;
  returnInventoryItemId?: string | null;
  returnQuantity?: number | null;
  returnUnitCode?: string | null;
  returnLocationId?: string | null;
  returnReason?: string | null;
  returnImpactAcknowledged?: boolean;
  rememberVendorRule?: boolean;
}

export type SetLineTreatmentActionResult =
  | { ok: true; classificationId: string; status: "CONFIRMED" | "PENDING_REVIEW"; ruleId: string | null }
  | AuthFailure
  | {
      ok: false;
      reason: "invalid" | "explanation_required" | "insufficient_stock" | "invalid_location" | "line_not_found" | "not_preparer" | "locked" | "item_not_confirmed" | "misconfigured";
      message: string;
      detail?: { availableQuantity?: number; requestedQuantity?: number };
    };

/**
 * The manager's line-treatment decision (Step 1 "Change classification" /
 * "Change treatment", Step 2 "Edit classification"). Every requirement is
 * validated in the database (set_purchase_document_line_treatment): an
 * active org-scoped expense category, a credit subtype, a discount scope,
 * a confirmed tracked item + quantity + configured unit + storage-eligible
 * source location + reason + acknowledgment for an inventory return, and
 * the negative-stock check. The client's choice is never trusted. When
 * the line becomes an inventory purchase, item matching is re-run so the
 * manager sees a candidate immediately.
 */
export async function setLineTreatment(input: SetLineTreatmentActionInput): Promise<SetLineTreatmentActionResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;
  if (!isLineTreatment(input.lineTreatment)) {
    return { ok: false, reason: "invalid", message: "Choose a valid line treatment." };
  }

  try {
    const result = await setLineTreatmentRpc(getServiceRoleClient(), {
      organizationId: auth.manager.organizationId,
      appUserId: auth.manager.appUserId,
      purchaseDocumentId: input.purchaseDocumentId,
      lineKey: input.lineKey,
      lineTreatment: input.lineTreatment,
      creditSubtype: input.creditSubtype ?? null,
      spendCategoryId: input.spendCategoryId ?? null,
      explanation: input.explanation ?? null,
      discountScope: input.discountScope ?? null,
      discountRelatedLineKey: input.discountRelatedLineKey ?? null,
      returnInventoryItemId: input.returnInventoryItemId ?? null,
      returnQuantity: input.returnQuantity ?? null,
      returnUnitCode: input.returnUnitCode ?? null,
      returnLocationId: input.returnLocationId ?? null,
      returnReason: input.returnReason ?? null,
      returnImpactAcknowledged: input.returnImpactAcknowledged ?? false,
      rememberVendorRule: input.rememberVendorRule ?? false,
    });
    if (input.lineTreatment === "INVENTORY_PURCHASE" && result.status === "PENDING_REVIEW") {
      // Re-open item matching right away so the manager sees a candidate
      // (deterministic mapping or AI) without a separate click. Awaited so
      // the caller's reload reflects the match when it was quick; a slow
      // AI call is still safely claimed and picked up by polling.
      try {
        await classifyPurchaseDocumentLines(input.purchaseDocumentId, auth.manager.organizationId);
      } catch (err) {
        logIfUnexpected("setLineTreatment.classify", err, { purchaseDocumentId: input.purchaseDocumentId, lineKey: input.lineKey });
      }
    }
    return { ok: true, ...result };
  } catch (err) {
    if (err instanceof InvalidLineTreatmentError) return { ok: false, reason: "invalid", message: err.message };
    if (err instanceof ExplanationRequiredError) return { ok: false, reason: "explanation_required", message: "A written explanation is required for this expense category." };
    if (err instanceof InsufficientInventoryError) {
      return {
        ok: false,
        reason: "insufficient_stock",
        message: "Returning that quantity would take inventory below zero at the source location.",
        detail: { availableQuantity: err.availableQuantity ?? undefined, requestedQuantity: err.requestedQuantity ?? undefined },
      };
    }
    if (err instanceof InvalidStorageLocationError) return { ok: false, reason: "invalid_location", message: "Choose an active, storage-eligible location." };
    if (err instanceof LineNotFoundInCurrentRevisionError) return { ok: false, reason: "line_not_found", message: "This line no longer exists on the current revision. Reload the page." };
    if (err instanceof NotPreparerError) return { ok: false, reason: "not_preparer", message: "Only this document's preparer (or an authorized manager) can classify its lines." };
    if (err instanceof VerifiedLockedError || err instanceof StaleVersionError) return { ok: false, reason: "locked", message: "This document is no longer a draft and cannot be reclassified." };
    if (err instanceof ItemNotPendingReviewError) return { ok: false, reason: "item_not_confirmed", message: "Choose a confirmed, tracked inventory item for the return." };
    logIfUnexpected("setLineTreatment", err, { purchaseDocumentId: input.purchaseDocumentId, lineKey: input.lineKey });
    return { ok: false, reason: "misconfigured", message: "Could not save the classification. Try again." };
  }
}

export type AcceptAiAssignedResult = { ok: true; acceptedCount: number } | AuthFailure | { ok: false; reason: "not_preparer" | "misconfigured"; message: string };

/** The manager's acceptance of every high-confidence "AI assigned" /
 * "Matched previous decision" proposal, recorded as their own decision --
 * called when they continue past Review Invoice with those labels
 * visible. Idempotent; the sole-approver posting RPC applies the same
 * acceptance again inside its own transaction. */
export async function acceptAiAssignedClassifications(purchaseDocumentId: string): Promise<AcceptAiAssignedResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;
  try {
    const acceptedCount = await acceptAiAssignedLineClassificationsRpc(getServiceRoleClient(), {
      organizationId: auth.manager.organizationId,
      purchaseDocumentId,
      appUserId: auth.manager.appUserId,
    });
    return { ok: true, acceptedCount };
  } catch (err) {
    if (err instanceof NotPreparerError) return { ok: false, reason: "not_preparer", message: "Only this document's preparer (or an authorized manager) can accept its classifications." };
    logIfUnexpected("acceptAiAssignedClassifications", err, { purchaseDocumentId });
    return { ok: false, reason: "misconfigured", message: "Could not accept the AI-assigned classifications. Try again." };
  }
}

// ---- Admin: vendor-specific prior decisions ----------------------------

type AdminAuthFailure = { ok: false; reason: "not_authorized"; message: string };
const ADMIN_NOT_AUTHORIZED: AdminAuthFailure = { ok: false, reason: "not_authorized", message: "You must be signed in as an Admin." };

export type ListVendorLineTreatmentRulesResult = { ok: true; rules: VendorLineTreatmentRuleSummary[] } | AdminAuthFailure;

export async function listVendorLineTreatmentRulesAction(): Promise<ListVendorLineTreatmentRulesResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return ADMIN_NOT_AUTHORIZED;
  const rules = await listVendorLineTreatmentRulesRpc(getServiceRoleClient(), auth.manager.organizationId);
  return { ok: true, rules };
}

export type SetVendorLineTreatmentRuleActiveResult = { ok: true } | AdminAuthFailure | { ok: false; reason: "error"; message: string };

export async function setVendorLineTreatmentRuleActiveAction(ruleId: string, isActive: boolean): Promise<SetVendorLineTreatmentRuleActiveResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return ADMIN_NOT_AUTHORIZED;
  try {
    await setVendorLineTreatmentRuleActiveRpc(getServiceRoleClient(), {
      organizationId: auth.manager.organizationId,
      actorAppUserId: auth.manager.appUserId,
      ruleId,
      isActive,
    });
    return { ok: true };
  } catch (err) {
    if (err instanceof InvalidLineTreatmentError) return { ok: false, reason: "error", message: err.message };
    logIfUnexpected("setVendorLineTreatmentRuleActive", err, { ruleId });
    return { ok: false, reason: "error", message: "Could not update the rule. Try again." };
  }
}

export type ReturnPreviewResult = { ok: true; onHandQuantity: number; baseUnitCode: string | null } | AuthFailure | { ok: false; reason: "misconfigured"; message: string };

/** Read-only on-hand preview for an inventory return (the same
 * inventory_location_item_balance the posting RPC checks) -- so the
 * classification drawer can show "on hand before / after" and flag a
 * negative result before the manager saves. Never the enforcement. */
export async function getInventoryReturnPreview(inventoryItemId: string, locationId: string): Promise<ReturnPreviewResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;
  const supabase = getServiceRoleClient();
  const [{ data: balance, error }, { data: item }] = await Promise.all([
    supabase.rpc("inventory_location_item_balance", { p_organization_id: auth.manager.organizationId, p_inventory_item_id: inventoryItemId, p_location_id: locationId }),
    supabase.from("inventory_items").select("id, units(code)").eq("id", inventoryItemId).eq("organization_id", auth.manager.organizationId).maybeSingle(),
  ]);
  if (error) {
    logIfUnexpected("getInventoryReturnPreview", error, { inventoryItemId, locationId });
    return { ok: false, reason: "misconfigured", message: "Could not read the on-hand quantity." };
  }
  const unit = item ? (Array.isArray(item.units) ? item.units[0] : item.units) : null;
  return { ok: true, onHandQuantity: Number(balance ?? 0), baseUnitCode: (unit as { code?: string } | null)?.code ?? null };
}
