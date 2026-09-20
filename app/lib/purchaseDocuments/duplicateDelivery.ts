/**
 * Delivery-lineage classification for a purchase document's EFFECTIVE
 * (non-superseded) delivery receipts.
 *
 * A document normally has one physical delivery (its correction chain resolves
 * to a single effective receipt). Legitimate PARTIAL/ADDITIONAL deliveries are
 * distinct physical delivery events -- each an effective receipt with its own
 * stable delivery_event_id (20260811100171) -- and their quantities are summed.
 * The Bartlett incident was the SAME physical delivery recorded three times as
 * independent receipts; summing them multiplied inventory.
 *
 * Because the delivery_event_id is the authoritative identity, this classifier
 * never guesses from matching quantities:
 *   - one effective delivery                         -> single (post normally)
 *   - many, all with DISTINCT non-null event ids     -> additional (sum; allowed)
 *   - many, with any null or repeated event id        -> ambiguous (block)
 * Historical receipts have a null event id, so a document with multiple
 * effective deliveries recorded before this identity existed is AMBIGUOUS and
 * must be resolved by a manager before posting -- never auto-summed, never
 * auto-deduplicated.
 */

export type DeliveryLineageStatus = "single" | "additional" | "ambiguous";

export interface EffectiveDeliveryReceipt {
  /** Stable identity for one physical delivery; null for historical receipts. */
  deliveryEventId: string | null;
}

export function classifyDeliveryLineage(effectiveDeliveries: EffectiveDeliveryReceipt[]): DeliveryLineageStatus {
  if (effectiveDeliveries.length <= 1) return "single";
  const eventIds = effectiveDeliveries.map((d) => d.deliveryEventId);
  // Any historical/unidentified delivery among several -> cannot prove they are
  // distinct physical deliveries -> ambiguous.
  if (eventIds.some((id) => id === null || id === undefined || id === "")) return "ambiguous";
  // Two current versions claiming the same physical delivery -> ambiguous.
  if (new Set(eventIds).size !== eventIds.length) return "ambiguous";
  // Every effective delivery is a distinct, identified physical delivery.
  return "additional";
}

/** True only for lineage that must block posting (never for legitimate
 * additional deliveries). */
export function isAmbiguousDeliveryLineage(effectiveDeliveries: EffectiveDeliveryReceipt[]): boolean {
  return classifyDeliveryLineage(effectiveDeliveries) === "ambiguous";
}

/** The single manager-facing reason used everywhere ambiguous lineage blocks. */
export const AMBIGUOUS_DELIVERY_REASON =
  "This invoice has multiple recorded deliveries for the same lines whose delivery records cannot be automatically distinguished. Review the recorded deliveries to confirm whether they are separate physical deliveries or duplicate entries before posting.";
