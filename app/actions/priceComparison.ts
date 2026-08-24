"use server";

import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import {
  getPriceComparisonsForDocument,
  getPriceHistoryForItem,
  type PriceComparisonResult,
  type PriceHistoryPoint,
} from "@/app/lib/purchasing/priceComparison";

type AuthFailure = { ok: false; reason: "not_authorized"; message: string };
const NOT_AUTHORIZED: AuthFailure = { ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." };

type LoadFailure = { ok: false; reason: "load_failed"; message: string };

export type GetPriceComparisonsResult = { ok: true; comparisons: Record<string, PriceComparisonResult> } | AuthFailure | LoadFailure;

/** Confirm Items' quiet "vs previous purchase" indicator -- one batched
 * call for every resolved INVENTORY line on the document, never one call
 * per line (Part 47's "no N+1" rule). Never a blocker: a line simply
 * shows no comparison (or "First recorded purchase") when one isn't
 * trustworthy, per the reasons in PriceComparisonUnavailableReason.
 *
 * Bug fix (Reports closeout audit -- the same dead-code error-handling
 * gap found in app/actions/reports.ts): an uncaught RPC failure here
 * would reject the WHOLE Confirm Items load() Promise.all, breaking the
 * entire screen over a purely quiet, optional feature. Caught and
 * degraded to "no comparisons this load" instead. */
export async function getPriceComparisons(purchaseDocumentId: string): Promise<GetPriceComparisonsResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  try {
    const supabase = getServiceRoleClient();
    const comparisons = await getPriceComparisonsForDocument(supabase, purchaseDocumentId, auth.manager.organizationId);
    return { ok: true, comparisons: Object.fromEntries(comparisons) };
  } catch (err) {
    console.error("[priceComparison] getPriceComparisons failed", { purchaseDocumentId, organizationId: auth.manager.organizationId, error: err instanceof Error ? err.message : String(err) });
    return { ok: false, reason: "load_failed", message: "Could not load price comparisons." };
  }
}

export type GetPriceHistoryResult = { ok: true; history: PriceHistoryPoint[] } | AuthFailure | LoadFailure | { ok: false; reason: "no_vendor"; message: string };

/** The on-demand price-history drill-down for one item, on the SAME
 * vendor as the given purchase document (Section 21) -- called only when
 * a manager expands a single line, never eagerly. Resolves the vendor
 * from the document server-side so callers never need to plumb vendorId
 * as a separate prop through the component tree. */
export async function getPriceHistory(purchaseDocumentId: string, inventoryItemId: string): Promise<GetPriceHistoryResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  try {
    const supabase = getServiceRoleClient();
    const { data: purchaseDocument } = await supabase
      .from("purchase_documents")
      .select("vendor_id")
      .eq("id", purchaseDocumentId)
      .eq("organization_id", auth.manager.organizationId)
      .maybeSingle();
    const vendorId = (purchaseDocument?.vendor_id as string | null | undefined) ?? null;
    if (!vendorId) return { ok: false, reason: "no_vendor", message: "This document has no vendor to compare purchases against." };

    const history = await getPriceHistoryForItem(supabase, auth.manager.organizationId, vendorId, inventoryItemId, 8);
    return { ok: true, history };
  } catch (err) {
    console.error("[priceComparison] getPriceHistory failed", { purchaseDocumentId, inventoryItemId, organizationId: auth.manager.organizationId, error: err instanceof Error ? err.message : String(err) });
    return { ok: false, reason: "load_failed", message: "Could not load price history." };
  }
}
