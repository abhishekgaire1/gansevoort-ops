import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getPriceComparisonsForDocument, type PriceComparisonResult } from "@/app/lib/purchasing/priceComparison";
import { getReceivingLines } from "@/app/lib/receiving/getReceivingLines";
import { derivePriceReviewState, type PriceReviewResult, type StoredPriceAcknowledgment } from "@/app/lib/purchasing/priceReviewState";

/**
 * The single server-side per-line price-review result for a document,
 * folding the authoritative normalized comparison (priceComparison.ts) with
 * the stored acknowledgments (20260811100155). This is the ONE source the
 * UI reads and the posting/submit guards enforce against -- so the stepper,
 * issue count, row badge, footer, Step 3 summary and the server gate all
 * agree by construction.
 */

export interface LinePriceContextEcho {
  inventoryItemId: string | null;
  vendorId: string | null;
  vendorSku: string | null;
  currency: string | null;
}

export interface DocumentPriceReview {
  /** lineKey -> review result (state + comparison detail + fingerprint). */
  byLineKey: Map<string, PriceReviewResult>;
  /** lineKey -> the exact context used for the comparison/fingerprint, so
   * an acknowledge call persists the same authoritative inputs. */
  contextByLineKey: Map<string, LinePriceContextEcho>;
  /** Line keys of comparable lines whose >=20% change is not yet validly
   * acknowledged -- the blocking set the submit/post gates reject on. */
  requiresAcknowledgment: string[];
  informationalCount: number;
  acknowledgedCount: number;
  noComparableCount: number;
}

interface AckRow {
  out_line_key: string;
  out_fingerprint: string;
  out_actor_app_user_id: string;
  out_acknowledged_at: string;
  out_note: string | null;
}

export async function getPurchaseDocumentPriceReview(
  supabase: SupabaseClient,
  purchaseDocumentId: string,
  organizationId: string
): Promise<DocumentPriceReview> {
  const [comparisons, receivingLines, { data: doc }, { data: ackRows }] = await Promise.all([
    getPriceComparisonsForDocument(supabase, purchaseDocumentId, organizationId),
    getReceivingLines(supabase, purchaseDocumentId, organizationId),
    supabase.from("purchase_documents").select("vendor_id, currency").eq("id", purchaseDocumentId).eq("organization_id", organizationId).maybeSingle(),
    supabase.rpc("list_price_change_acknowledgments", { p_organization_id: organizationId, p_purchase_document_id: purchaseDocumentId }),
  ]);

  const vendorId = (doc?.vendor_id as string | null | undefined) ?? null;
  const currency = (doc?.currency as string | null | undefined) ?? null;

  // Resolve acknowledgment actor names for display ("Reviewed by …").
  const acks = (ackRows ?? []) as AckRow[];
  const actorIds = Array.from(new Set(acks.map((a) => a.out_actor_app_user_id)));
  const actorNameById = new Map<string, string>();
  if (actorIds.length > 0) {
    const { data: users } = await supabase.from("app_users").select("id, employees(first_name, last_name)").in("id", actorIds);
    for (const u of users ?? []) {
      const emp = (u as { employees?: { first_name?: string | null; last_name?: string | null } | null }).employees;
      const name = emp ? `${emp.first_name ?? ""} ${emp.last_name ?? ""}`.trim() : "";
      actorNameById.set((u as { id: string }).id, name || "A manager");
    }
  }
  const ackByLineKey = new Map<string, StoredPriceAcknowledgment>();
  for (const a of acks) {
    ackByLineKey.set(a.out_line_key, {
      fingerprint: a.out_fingerprint,
      actorName: actorNameById.get(a.out_actor_app_user_id) ?? "A manager",
      acknowledgedAt: a.out_acknowledged_at,
      note: a.out_note,
    });
  }

  const skuByLineKey = new Map(receivingLines.map((l) => [l.lineKey, l.vendorSku]));
  const itemByLineKey = new Map(receivingLines.map((l) => [l.lineKey, l.inventoryItemId]));

  const byLineKey = new Map<string, PriceReviewResult>();
  const contextByLineKey = new Map<string, LinePriceContextEcho>();
  const requiresAcknowledgment: string[] = [];
  let informationalCount = 0;
  let acknowledgedCount = 0;
  let noComparableCount = 0;

  for (const [lineKey, comparison] of comparisons.entries()) {
    const context = {
      inventoryItemId: itemByLineKey.get(lineKey) ?? null,
      vendorId,
      vendorSku: skuByLineKey.get(lineKey) ?? null,
      currency,
    };
    const result = derivePriceReviewState({ comparison: comparison as PriceComparisonResult, context, acknowledgment: ackByLineKey.get(lineKey) ?? null });
    byLineKey.set(lineKey, result);
    contextByLineKey.set(lineKey, context);
    if (result.state === "REQUIRES_ACKNOWLEDGMENT") requiresAcknowledgment.push(lineKey);
    else if (result.state === "INFORMATIONAL_CHANGE") informationalCount += 1;
    else if (result.state === "ACKNOWLEDGED") acknowledgedCount += 1;
    else if (result.state === "NO_COMPARABLE_HISTORY") noComparableCount += 1;
  }

  return { byLineKey, contextByLineKey, requiresAcknowledgment, informationalCount, acknowledgedCount, noComparableCount };
}
