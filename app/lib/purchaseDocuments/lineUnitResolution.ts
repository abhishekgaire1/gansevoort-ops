import type { ReviewFlag } from "@/app/lib/ai/tasks/invoiceExtraction/types";

/**
 * Reconciles Step 1's own "invoice quantity/measured unit could not be
 * identified" warnings (validateLineItem, severity "warning" -- these
 * never actually block step1Complete, which only counts "error" severity
 * flags) against what Step 2 has since AUTHORITATIVELY resolved. A blank
 * raw packageUnit/measuredUnit field on the extracted line is a real fact
 * about the ORIGINAL EXTRACTION, and stays true forever -- but a manager
 * reading "invoice quantity unit could not be identified" reasonably
 * expects that to mean the workflow doesn't know the unit, which becomes
 * FALSE the moment Step 2 classifies the line: a CONFIRMED classification
 * always carries a real effective purchase unit (either a confirmed
 * vendor/SKU package, or the item's own base unit -- resolveLineMismatchFields's
 * fallback), and an expense (NON_INVENTORY) line never needed a
 * unit at all. STALE deliberately does NOT count as resolved: exactly
 * the "later-invalidated" case (e.g. the item was remapped and its
 * configuration no longer agrees with what was recorded) where the
 * warning must genuinely reappear, never stay silently suppressed.
 *
 * This never touches validateLineItem/validatePurchaseDocumentDraft
 * itself (which still correctly describes the raw extraction), and never
 * recomputes classification status independently -- callers pass in the
 * SAME classification rows getPurchaseDocumentLineClassifications
 * already produces (Step 2's own authoritative source).
 */

const STALE_UNIT_FLAG_CODES = new Set(["LINE_MISSING_PACKAGE_UNIT", "LINE_MISSING_MEASURED_UNIT"]);
const LINE_FIELD_INDEX_PATTERN = /^lines\[(\d+)\]/;

export function isLineInvoiceUnitResolved(classificationStatus: "UNCLASSIFIED" | "PENDING_REVIEW" | "STALE" | "CONFIRMED" | undefined): boolean {
  return classificationStatus === "CONFIRMED";
}

/**
 * Drops a stale-unit warning once its line's classification is CONFIRMED
 * -- every other flag (including a genuinely still-unresolved stale-unit
 * warning on an unclassified/pending/stale line) passes through
 * unchanged. `lines` must be the SAME array (by index) validatePurchaseDocumentDraft
 * was called with, since validateLineItem's own field path
 * ("lines[N].packageUnit") is index-based, not lineKey-based.
 */
export function reconcileStaleUnitFlags(flags: ReviewFlag[], lines: { lineKey: string | null }[], resolvedLineKeys: ReadonlySet<string>): ReviewFlag[] {
  return flags.filter((flag) => {
    if (!STALE_UNIT_FLAG_CODES.has(flag.code)) return true;
    const match = flag.field?.match(LINE_FIELD_INDEX_PATTERN);
    if (!match) return true;
    const line = lines[Number(match[1])];
    if (!line?.lineKey) return true;
    return !resolvedLineKeys.has(line.lineKey);
  });
}

export interface ResolvedUnitNote {
  lineKey: string;
  /** e.g. "Farmland Sour Cream 10lb" -- the matched item, so the manager
   * sees WHERE the resolution came from, never just a bare "resolved". */
  itemName: string | null;
  /** e.g. "LB" -- the item's effective purchase/base unit. */
  unitCode: string | null;
}

/** Builds the "resolved via..." note Step 1 shows in place of a cleared
 * warning -- only for lines that genuinely HAD a stale-unit flag AND are
 * now resolved, never fabricated for a line that was never flagged. */
export function buildResolvedUnitNotes(
  flags: ReviewFlag[],
  lines: { lineKey: string | null }[],
  classifications: { lineKey: string; status: string; inventoryItemName: string | null; effectivePurchaseUnitCode: string | null }[]
): ResolvedUnitNote[] {
  const classificationByLineKey = new Map(classifications.map((c) => [c.lineKey, c]));
  const flaggedLineKeys = new Set<string>();
  for (const flag of flags) {
    if (!STALE_UNIT_FLAG_CODES.has(flag.code)) continue;
    const match = flag.field?.match(LINE_FIELD_INDEX_PATTERN);
    if (!match) continue;
    const line = lines[Number(match[1])];
    if (line?.lineKey) flaggedLineKeys.add(line.lineKey);
  }

  const notes: ResolvedUnitNote[] = [];
  for (const lineKey of flaggedLineKeys) {
    const c = classificationByLineKey.get(lineKey);
    if (!c || !isLineInvoiceUnitResolved(c.status as "CONFIRMED")) continue;
    notes.push({ lineKey, itemName: c.inventoryItemName, unitCode: c.effectivePurchaseUnitCode });
  }
  return notes;
}
