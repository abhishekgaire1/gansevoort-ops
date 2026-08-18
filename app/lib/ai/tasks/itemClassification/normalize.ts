import type { GeminiItemClassification } from "./schema";
import type { NormalizedItemClassificationLine } from "./types";

function blankToNull(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function normalizeItemClassification(raw: GeminiItemClassification): NormalizedItemClassificationLine[] {
  return raw.lines.map((line) => ({
    lineKey: line.lineKey,
    candidateItemId: blankToNull(line.candidateItemId),
    proposedName: blankToNull(line.proposedName),
    proposedDisposition: line.proposedDisposition,
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
  }));
}
