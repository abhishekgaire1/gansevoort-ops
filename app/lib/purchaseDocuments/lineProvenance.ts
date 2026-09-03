/**
 * Truthful completion provenance for the Confirm Items & Receiving
 * checklist -- pure, framework-free so it's directly unit-testable. Only
 * ever labels a line with what the underlying data actually supports:
 * "Confirmed for this invoice" requires a real resolved_by_app_user_id
 * (a genuine manager action), never assumed from resolutionSource alone.
 * A system auto-match (VENDOR_SKU_MAPPING/VENDOR_DESCRIPTION_MAPPING,
 * system_classification_resolution_rpcs -- 20260811100042) never sets
 * that column, so it is always "Previously approved," never falsely
 * attributed to a manager who never touched this line.
 */

export type ProvenanceKind = "previously_approved" | "confirmed_this_invoice" | "ai_suggestion" | "not_yet_classified";

export interface ProvenanceInput {
  status: "UNCLASSIFIED" | "PENDING_REVIEW" | "STALE" | "CONFIRMED";
  resolutionSource: string | null;
  /** Non-null only for a genuine manager resolution -- see this module's
   * own doc comment. */
  resolvedByName: string | null;
  resolvedAt: string | null;
}

export interface ProvenanceDisplay {
  kind: ProvenanceKind;
  label: string;
  /** Non-null only when resolvedByName is itself non-null -- the caller
   * renders "Confirmed by <name> · <time>" from these, formatting
   * resolvedAt however is appropriate for display (never formatted here,
   * to keep this function's output independent of runtime locale). */
  resolvedByName: string | null;
  resolvedAt: string | null;
}

export function deriveLineProvenance(input: ProvenanceInput): ProvenanceDisplay {
  if (input.status !== "CONFIRMED") {
    if (input.resolutionSource === "AI_SUGGESTED") {
      return { kind: "ai_suggestion", label: "AI suggestion", resolvedByName: null, resolvedAt: null };
    }
    return { kind: "not_yet_classified", label: "Not yet classified", resolvedByName: null, resolvedAt: null };
  }
  if (input.resolvedByName) {
    return { kind: "confirmed_this_invoice", label: "Confirmed for this invoice", resolvedByName: input.resolvedByName, resolvedAt: input.resolvedAt };
  }
  return { kind: "previously_approved", label: "Previously approved", resolvedByName: null, resolvedAt: null };
}

export interface AmendmentDiffLine {
  vendorSku: string | null;
  description: string | null;
  packageQuantity: number | null;
  packageUnit: string | null;
}

export interface AmendmentDiffResult {
  changed: boolean;
  /** The previous revision's own package (or, lacking one, description) --
   * shown in smaller text beside a "Changed in amendment" badge. Null
   * unless changed is true. */
  previousSummary: string | null;
}

/** Whether an invoice line's own facts (description/package quantity/
 * unit) differ from the matching line -- by vendor SKU, since line_key
 * regenerates fresh per revision -- on the PREVIOUS revision. A line
 * with no vendor SKU, or no match on the previous revision (e.g. it's
 * new to this amendment), is never marked "changed" -- there's nothing
 * genuinely comparable to compare it against. */
export function amendmentDiff(current: AmendmentDiffLine, previousLineBySku: Map<string, AmendmentDiffLine>): AmendmentDiffResult {
  if (!current.vendorSku) return { changed: false, previousSummary: null };
  const previous = previousLineBySku.get(current.vendorSku);
  if (!previous) return { changed: false, previousSummary: null };
  const changed = previous.description !== current.description || previous.packageQuantity !== current.packageQuantity || previous.packageUnit !== current.packageUnit;
  if (!changed) return { changed: false, previousSummary: null };
  const previousSummary = previous.packageQuantity !== null && previous.packageUnit ? `${previous.packageQuantity} ${previous.packageUnit}` : previous.description;
  return { changed: true, previousSummary };
}
