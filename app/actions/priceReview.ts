"use server";

import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { getPurchaseDocumentPriceReview } from "@/app/lib/purchasing/getPurchaseDocumentPriceReview";
import type { PriceReviewState } from "@/app/lib/purchasing/priceReviewPolicy";

/**
 * Server actions for the vendor-aware price-change review on invoice Step 2.
 * The review is always recomputed server-side from authoritative data --
 * the client never supplies the prices, percentages, or "is this
 * significant" verdict, so a tampered client cannot fabricate or bypass a
 * review. Acknowledgment is durable (20260811100155) and idempotent.
 */

type AuthFailure = { ok: false; reason: "not_authorized"; message: string };
const NOT_AUTHORIZED: AuthFailure = { ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." };

export interface LinePriceReviewView {
  lineKey: string;
  state: PriceReviewState;
  comparison: null | {
    currentUnitCost: number;
    baseUnitCode: string;
    deltaAbs: number;
    deltaPct: number;
    direction: "increase" | "decrease" | "unchanged";
    previous: { purchaseDocumentId: string; documentNumber: string | null; documentDate: string | null; vendorName: string | null; unitCost: number };
  };
  fingerprint: string | null;
  acknowledgment: null | { actorName: string | null; acknowledgedAt: string; note: string | null };
  vendorSku: string | null;
}

export type GetPriceReviewResult =
  | { ok: true; lines: LinePriceReviewView[]; requiresAckLineKeys: string[]; informationalCount: number; acknowledgedCount: number; noComparableCount: number }
  | AuthFailure;

export async function getPurchaseDocumentPriceReviewAction(purchaseDocumentId: string): Promise<GetPriceReviewResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const review = await getPurchaseDocumentPriceReview(getServiceRoleClient(), purchaseDocumentId, auth.manager.organizationId);
  const lines: LinePriceReviewView[] = [];
  for (const [lineKey, result] of review.byLineKey.entries()) {
    lines.push({
      lineKey,
      state: result.state,
      comparison: result.comparison,
      fingerprint: result.fingerprint,
      acknowledgment: result.acknowledgment ? { actorName: result.acknowledgment.actorName, acknowledgedAt: result.acknowledgment.acknowledgedAt, note: result.acknowledgment.note } : null,
      vendorSku: review.contextByLineKey.get(lineKey)?.vendorSku ?? null,
    });
  }
  return {
    ok: true,
    lines,
    requiresAckLineKeys: review.requiresAcknowledgment,
    informationalCount: review.informationalCount,
    acknowledgedCount: review.acknowledgedCount,
    noComparableCount: review.noComparableCount,
  };
}

export type AcknowledgePriceChangeResult =
  | { ok: true }
  | AuthFailure
  | { ok: false; reason: "not_significant" | "error"; message: string };

/**
 * Idempotently acknowledge a significant price change on one line. The
 * server recomputes the comparison and REJECTS if the line is not actually
 * REQUIRES_ACKNOWLEDGMENT (or already ACKNOWLEDGED) -- the client's claim is
 * never trusted. Persists the server-computed values + fingerprint.
 */
export async function acknowledgePriceChangeAction(purchaseDocumentId: string, lineKey: string, note: string | null): Promise<AcknowledgePriceChangeResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const supabase = getServiceRoleClient();
  const review = await getPurchaseDocumentPriceReview(supabase, purchaseDocumentId, auth.manager.organizationId);
  const result = review.byLineKey.get(lineKey);
  const context = review.contextByLineKey.get(lineKey);

  if (!result || !result.comparison || !result.fingerprint || !context) {
    return { ok: false, reason: "not_significant", message: "This line no longer has a price change that needs review." };
  }
  if (result.state !== "REQUIRES_ACKNOWLEDGMENT" && result.state !== "ACKNOWLEDGED") {
    return { ok: false, reason: "not_significant", message: "This line no longer requires a price-change acknowledgment." };
  }
  const direction = result.comparison.direction === "decrease" ? "decrease" : "increase";

  const { error } = await supabase.rpc("acknowledge_price_change", {
    p_organization_id: auth.manager.organizationId,
    p_actor_app_user_id: auth.manager.appUserId,
    p_purchase_document_id: purchaseDocumentId,
    p_line_key: lineKey,
    p_inventory_item_id: context.inventoryItemId,
    p_vendor_id: context.vendorId,
    p_vendor_sku: context.vendorSku,
    p_currency: context.currency,
    p_previous_purchase_document_id: result.comparison.previous.purchaseDocumentId,
    p_previous_unit_cost: result.comparison.previous.unitCost,
    p_current_unit_cost: result.comparison.currentUnitCost,
    p_delta_pct: result.comparison.deltaPct,
    p_direction: direction,
    p_base_unit_code: result.comparison.baseUnitCode,
    p_normalized_base_quantity: null,
    p_fingerprint: result.fingerprint,
    p_note: note && note.trim() ? note.trim() : null,
  });
  if (error) {
    return { ok: false, reason: "error", message: "Could not save the acknowledgment. Try again." };
  }
  return { ok: true };
}
