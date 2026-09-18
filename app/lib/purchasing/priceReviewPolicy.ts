/**
 * Vendor-aware price-change review policy -- the ONE place the alert
 * thresholds and the review-state machine live, so no component re-derives
 * "is this a significant change" on its own. Built on top of the existing
 * authoritative normalized base-unit comparison (app/lib/purchasing/
 * priceComparison.ts): that module decides WHAT the current-vs-previous
 * normalized prices are; this module decides what to DO about the delta.
 *
 * Price information here is operational, not financial advice: it never
 * labels a vendor "cheapest"/"best", never frames a valuation, and both
 * increases and decreases are surfaced (a large decrease can equally mean a
 * wrong quantity, package conversion, or invoice amount).
 */

/** Version of this threshold policy. Participates in the acknowledgment
 * fingerprint, so changing the thresholds invalidates existing
 * acknowledgments and forces a fresh review under the new policy. */
export const PRICE_REVIEW_POLICY_VERSION = "v1:10-20";

/** Absolute % change at/above which a line shows an informational alert. */
export const INFORMATIONAL_THRESHOLD_PCT = 10;
/** Absolute % change at/above which a manager must acknowledge before the
 * document can continue to Review & Post. */
export const ACKNOWLEDGMENT_THRESHOLD_PCT = 20;

export type PriceChangeSeverity = "NONE" | "INFORMATIONAL" | "SIGNIFICANT";

/** Maps an absolute percentage change to a severity band. `deltaPct` is the
 * signed percentage; magnitude drives the band (direction is carried
 * separately). Computed from full-precision values, never a rounded display. */
export function classifyPriceChangeSeverity(deltaPct: number): PriceChangeSeverity {
  const magnitude = Math.abs(deltaPct);
  if (magnitude >= ACKNOWLEDGMENT_THRESHOLD_PCT) return "SIGNIFICANT";
  if (magnitude >= INFORMATIONAL_THRESHOLD_PCT) return "INFORMATIONAL";
  return "NONE";
}

/**
 * Every explicit price-review state a line can be in. Exhaustive by design
 * so the stepper, issue count, filters, group placement, row badge, footer,
 * Step 3 summary and posting gate all read the same vocabulary.
 */
export type PriceReviewState =
  | "NOT_APPLICABLE" // expense / non-inventory / unresolved -- no price signal
  | "NO_COMPARABLE_HISTORY" // first purchase of this item from this vendor
  | "COMPARISON_UNAVAILABLE" // missing quantity/amount/conversion/currency -- never invent a price
  | "NO_MATERIAL_CHANGE" // comparable, but below the informational threshold
  | "INFORMATIONAL_CHANGE" // 10%..<20% -- surfaced, never blocking
  | "REQUIRES_ACKNOWLEDGMENT" // >=20% and not (validly) acknowledged -- blocks posting
  | "ACKNOWLEDGED"; // >=20% and a current, non-stale acknowledgment exists

/** True only for the one state that blocks Review & Post. */
export function priceReviewBlocksPosting(state: PriceReviewState): boolean {
  return state === "REQUIRES_ACKNOWLEDGMENT";
}

/** True for any comparable, above-noise change (informational or significant,
 * acknowledged or not) -- drives the "Price changes" filter and the Step 3
 * "N price changes noted/reviewed" summary. */
export function priceReviewIsNotable(state: PriceReviewState): boolean {
  return state === "INFORMATIONAL_CHANGE" || state === "REQUIRES_ACKNOWLEDGMENT" || state === "ACKNOWLEDGED";
}

export type PriceDirection = "increase" | "decrease" | "unchanged";

/** Direction-specific, plain-language label. Never "cheapest"/"best". */
export function priceChangeLabel(direction: PriceDirection, deltaPct: number, opts: { requiresReview?: boolean } = {}): string {
  const pct = Math.abs(deltaPct).toFixed(1);
  if (direction === "unchanged") return "No material change";
  const verb = direction === "increase" ? "increased" : "decreased";
  return opts.requiresReview ? `Price change requires review: ${verb} ${pct}%` : `Price ${verb} ${pct}%`;
}

export interface PriceCheckDisplay {
  text: string;
  tone: "neutral" | "info" | "success" | "warning";
  /** True when meaning must never rest on color alone -- callers pair the
   * text with an icon/label; this flags a directional change for the icon. */
  direction: PriceDirection | null;
}

/** The Price Check column value for a line, derived from its review state.
 * Vendor-aware, base-unit-normalized, plain language -- never "$0.00",
 * never "cheapest"/"best". */
export function priceCheckDisplay(
  state: PriceReviewState,
  detail: { direction: PriceDirection; deltaPct: number; vendorName: string | null } | null
): PriceCheckDisplay | null {
  switch (state) {
    case "NOT_APPLICABLE":
      return null;
    case "NO_COMPARABLE_HISTORY":
      return { text: "No previous comparable purchase", tone: "neutral", direction: null };
    case "COMPARISON_UNAVAILABLE":
      return { text: "Comparison unavailable", tone: "neutral", direction: null };
    case "NO_MATERIAL_CHANGE":
      return { text: "No material change", tone: "neutral", direction: null };
    case "INFORMATIONAL_CHANGE":
      return detail ? { text: priceCheckBadge(detail.direction, detail.deltaPct, detail.vendorName), tone: "info", direction: detail.direction } : null;
    case "REQUIRES_ACKNOWLEDGMENT":
      return detail ? { text: `Review required · ${Math.abs(detail.deltaPct).toFixed(1)}% ${detail.direction === "increase" ? "increase" : "decrease"}`, tone: "warning", direction: detail.direction } : null;
    case "ACKNOWLEDGED":
      return detail ? { text: `${Math.abs(detail.deltaPct).toFixed(1)}% ${detail.direction === "increase" ? "increase" : "decrease"} reviewed`, tone: "success", direction: detail.direction } : null;
  }
}

/** Compact badge text for the Price Check column, e.g. "↑ 18.4% · Bartlett".
 * The arrow is paired with the vendor + percent so meaning never rests on
 * color alone; callers still render an accessible text alternative. */
export function priceCheckBadge(direction: PriceDirection, deltaPct: number, vendorName: string | null): string {
  const pct = Math.abs(deltaPct).toFixed(1);
  const arrow = direction === "increase" ? "↑" : direction === "decrease" ? "↓" : "→";
  const vendor = vendorName ? ` · ${vendorName}` : "";
  return `${arrow} ${pct}%${vendor}`;
}
