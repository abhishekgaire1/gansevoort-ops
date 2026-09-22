import type { ReviewFlag } from "@/app/lib/ai/tasks/invoiceExtraction/types";
import type { LineTreatment } from "@/app/lib/purchaseDocuments/lineTreatment";

/**
 * Extraction-time review flags that treat a negative amount as an error are
 * correct for a purchase line and WRONG for a credit or discount: a
 * "CASES RETURNED −$24.00" line classified as a credit is expected to be
 * negative. Once a line's treatment is CREDIT_RETURN or DISCOUNT (decided
 * or AI-proposed and still pending), those flags are removed here -- the
 * SAME idea as reconcileStaleUnitFlags: Step 1 never re-derives a fact
 * Step 2's authoritative classification already settled. Every other flag
 * is untouched, and an UNRESOLVED line keeps its flags until classified.
 */
const NEGATIVE_AMOUNT_FLAG_CODES = new Set(["LINE_NEGATIVE_TOTAL", "LINE_NEGATIVE_UNIT_PRICE", "LINE_NEGATIVE_PACKAGE_QUANTITY", "LINE_NEGATIVE_MEASURED_QUANTITY"]);
const LINE_FIELD_INDEX_PATTERN = /^lines\[(\d+)\]/;

export function treatmentExplainsNegativeAmount(treatment: LineTreatment | null | undefined): boolean {
  return treatment === "CREDIT_RETURN" || treatment === "DISCOUNT";
}

export function reconcileTreatmentFlags(flags: ReviewFlag[], lines: { lineKey: string | null }[], treatmentByLineKey: ReadonlyMap<string, LineTreatment>): ReviewFlag[] {
  return flags.filter((flag) => {
    if (!NEGATIVE_AMOUNT_FLAG_CODES.has(flag.code)) return true;
    const match = flag.field?.match(LINE_FIELD_INDEX_PATTERN);
    if (!match) return true;
    const line = lines[Number(match[1])];
    if (!line?.lineKey) return true;
    return !treatmentExplainsNegativeAmount(treatmentByLineKey.get(line.lineKey));
  });
}

/** The extraction-time TOTAL_MISMATCH check adds the header tax/fees to
 * every line, so an invoice that carries its tax (or freight) as an
 * explicit LINE is double-counted and flagged even though it reconciles.
 * Once the treatment-aware reconciliation (totalsReconciliation.ts) says
 * the classified lines reconcile with the printed total, that flag is
 * removed; when it does not reconcile, the flag stays. */
export function reconcileTotalMismatchFlag(flags: ReviewFlag[], treatmentAwareReconciles: boolean | null): ReviewFlag[] {
  if (treatmentAwareReconciles !== true) return flags;
  return flags.filter((flag) => flag.code !== "TOTAL_MISMATCH");
}
