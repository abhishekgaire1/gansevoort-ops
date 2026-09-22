import type { GeminiItemClassification } from "./schema";
import type { NormalizedItemClassificationLine } from "./types";

function blankToNull(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function cleanList(values: string[] | null): string[] {
  return (values ?? []).map((v) => v.trim()).filter((v) => v.length > 0);
}

export function normalizeItemClassification(raw: GeminiItemClassification): NormalizedItemClassificationLine[] {
  return raw.lines.map((line) => {
    const treatment = line.proposedLineTreatment;
    return {
      lineKey: line.lineKey,
      proposedLineTreatment: treatment,
      proposedCreditSubtype: line.proposedCreditSubtype,
      proposedDiscountScope: line.proposedDiscountScope,
      candidateItemId: blankToNull(line.candidateItemId),
      proposedName: blankToNull(line.proposedName),
      // The coarse view is DERIVED from the treatment, never returned by the
      // model separately (two fields that could disagree).
      proposedDisposition: treatment === null || treatment === "UNRESOLVED" ? null : treatment === "INVENTORY_PURCHASE" ? "INVENTORY" : "NON_INVENTORY",
      proposedCategoryId: blankToNull(line.suggestedInventoryCategoryId),
      proposedSpendCategoryId: blankToNull(line.suggestedSpendCategoryId),
      proposedBaseUnitCode: blankToNull(line.proposedBaseUnitCode),
      proposedVendorPurchaseUnitCode: blankToNull(line.proposedVendorPurchaseUnitCode),
      proposedReceivingBehavior: line.proposedReceivingBehavior,
      proposedFixedConversionFactor:
        line.proposedFixedConversionFactor === null || Number.isNaN(line.proposedFixedConversionFactor) || !Number.isFinite(line.proposedFixedConversionFactor)
          ? null
          : line.proposedFixedConversionFactor,
      confidence:
        line.confidence === null || Number.isNaN(line.confidence) || !Number.isFinite(line.confidence)
          ? null
          : Math.min(1, Math.max(0, line.confidence)),
      reasoning: blankToNull(line.reasoning),
      evidence: cleanList(line.evidence),
      fieldsRequiringReview: cleanList(line.fieldsRequiringReview),
    };
  });
}
