"use server";

import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { postPurchaseDocumentInventoryRpc, setInventoryStockReferenceRpc } from "@/app/lib/inventory/postingRpcs";
import { getInventoryPostingDetail, type InventoryPostingDetail } from "@/app/lib/inventory/getInventoryPostingDetail";
import { listInventoryBalances, type InventoryBalanceRow } from "@/app/lib/inventory/listInventoryBalances";
import { InventoryPostingBlockedError, AmendmentLineageAlreadyPostedError, type InventoryPostingBlocker } from "@/app/lib/inventory/errors";
import { VerifiedLockedError } from "@/app/lib/purchaseDocuments/errors";

type AuthFailure = { ok: false; reason: "not_authorized"; message: string };
const NOT_AUTHORIZED: AuthFailure = { ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." };

export type PostToInventoryResult =
  | { ok: true; status: "POSTED" | "ALREADY_POSTED"; postedLineCount: number }
  | AuthFailure
  | { ok: false; reason: "blocked"; message: string; blockers: InventoryPostingBlocker[] }
  | { ok: false; reason: "wrong_status" | "misconfigured"; message: string };

/** The explicit [Post to Inventory] action -- the ONLY path that turns a
 * verified receipt into real inventory. Never triggered automatically by
 * Final Verify; idempotent against double-clicks/retries (server-side
 * unique backbone, not just button disabling). */
export async function postPurchaseDocumentToInventory(purchaseDocumentId: string): Promise<PostToInventoryResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  try {
    const result = await postPurchaseDocumentInventoryRpc(getServiceRoleClient(), {
      purchaseDocumentId,
      organizationId: auth.manager.organizationId,
      appUserId: auth.manager.appUserId,
    });
    return { ok: true, status: result.status, postedLineCount: result.postedLineCount };
  } catch (err) {
    if (err instanceof InventoryPostingBlockedError) {
      return { ok: false, reason: "blocked", message: "Cannot post inventory yet.", blockers: err.blockers };
    }
    if (err instanceof VerifiedLockedError) {
      return { ok: false, reason: "wrong_status", message: "Only a VERIFIED document can be posted to inventory." };
    }
    if (err instanceof AmendmentLineageAlreadyPostedError) {
      return {
        ok: false,
        reason: "wrong_status",
        message: "Inventory for this delivery was already posted from an earlier revision of this document -- posting again would double-count it.",
      };
    }
    return { ok: false, reason: "misconfigured", message: "Could not post to inventory. Try again." };
  }
}

export type GetInventoryPostingResult = { ok: true; detail: InventoryPostingDetail } | AuthFailure;

export async function getPurchaseDocumentInventoryPosting(purchaseDocumentId: string): Promise<GetInventoryPostingResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const detail = await getInventoryPostingDetail(getServiceRoleClient(), purchaseDocumentId, auth.manager.organizationId);
  return { ok: true, detail };
}

export type ListInventoryBalancesResult = { ok: true; rows: InventoryBalanceRow[] } | AuthFailure;

export async function listInventoryBalancesForOrganization(): Promise<ListInventoryBalancesResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const rows = await listInventoryBalances(getServiceRoleClient(), auth.manager.organizationId);
  return { ok: true, rows };
}

export type AdjustFullReferenceResult = { ok: true } | AuthFailure | { ok: false; reason: "invalid" | "misconfigured"; message: string };

/** Manager override of an item+location's full-stock reference -- the
 * visualization denominator ONLY. Never creates a movement, never changes
 * actual inventory; the next genuine restock supersedes it automatically. */
export async function adjustInventoryFullReference(
  inventoryItemId: string,
  locationId: string,
  fullQuantity: number
): Promise<AdjustFullReferenceResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  if (!Number.isFinite(fullQuantity) || fullQuantity <= 0) {
    return { ok: false, reason: "invalid", message: "The full reference must be a positive quantity." };
  }

  try {
    await setInventoryStockReferenceRpc(getServiceRoleClient(), {
      organizationId: auth.manager.organizationId,
      inventoryItemId,
      locationId,
      fullQuantity,
      appUserId: auth.manager.appUserId,
    });
    return { ok: true };
  } catch {
    return { ok: false, reason: "misconfigured", message: "Could not update the full reference. Try again." };
  }
}
