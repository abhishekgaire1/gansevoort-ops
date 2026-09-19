/**
 * Duplicate-delivery detection.
 *
 * A purchase document normally has exactly one effective (non-superseded)
 * receipt line per invoice line: a correction supersedes the receipt it
 * corrects, so a normally-corrected line still resolves to one effective line.
 * When the SAME delivery is recorded more than once as independent DELIVERY
 * receipts, each carries a full copy of every line, so an invoice line ends up
 * with more than one effective receipt line. Posting sums every effective
 * receipt line (one movement per receipt line), so this would post inventory
 * two or three times over -- and the price guard, which recomputes unit cost
 * from the (inflated) summed quantity, then reports a spurious large price drop.
 *
 * This pure predicate flags that condition from the set of matched line keys
 * across a document's effective receipt lines, so both the readiness model and
 * the server posting preflight refuse it with one clear, shared reason.
 */
export function hasDuplicateEffectiveDeliveryLines(matchedLineKeys: (string | null | undefined)[]): boolean {
  const counts = new Map<string, number>();
  for (const key of matchedLineKeys) {
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const count of counts.values()) {
    if (count > 1) return true;
  }
  return false;
}

/** The single manager-facing reason used everywhere this condition is refused. */
export const DUPLICATE_DELIVERY_REASON =
  "This invoice has more than one recorded delivery for the same line(s), which would post inventory more than once. Remove the duplicate delivery in Items & Receiving before posting.";
