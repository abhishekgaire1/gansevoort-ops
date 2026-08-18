import type { ClassificationCandidateContext, ItemClassificationIssue, ItemShortlistCandidate, NormalizedItemClassificationLine } from "./types";

/**
 * Deterministic, non-AI validation over the already-normalized output --
 * Gemini is never the final validator, this is. Re-checks every returned
 * candidateItemId is literally present in the shortlist that was SENT for
 * that specific line, and every proposedCategoryId/proposedSpendCategoryId
 * is literally present in the org-wide candidate context that was sent for
 * this whole batch (never trusted blindly, even though both were already
 * org-scoped -- belt and suspenders), and validates
 * proposedBaseUnitCode/proposedVendorPurchaseUnitCode against the known
 * global unit-code set. Returns a SANITIZED copy of the lines, never the
 * raw model output directly -- an invalid candidateItemId, category id, unit
 * code, or an internally-inconsistent receiving-behavior/conversion-factor
 * pair is stripped here, downgrading that line to "no confident suggestion"
 * rather than ever letting a hallucinated id, unit, or fabricated fixed
 * conversion for a genuinely variable item reach a database write.
 */
export function validateItemClassification(
  lines: NormalizedItemClassificationLine[],
  shortlistsByLineKey: Map<string, ItemShortlistCandidate[]>,
  knownUnitCodes: Set<string>,
  candidateContext: ClassificationCandidateContext
): { lines: NormalizedItemClassificationLine[]; issues: ItemClassificationIssue[] } {
  const issues: ItemClassificationIssue[] = [];
  const validCategoryIds = new Set(candidateContext.inventoryCategories.map((c) => c.id));
  const validSpendCategoryIds = new Set(candidateContext.spendCategories.map((c) => c.id));

  const sanitized = lines.map((line): NormalizedItemClassificationLine => {
    let candidateItemId = line.candidateItemId;
    let proposedName = line.proposedName;
    let proposedDisposition = line.proposedDisposition;
    let proposedCategoryId = line.proposedCategoryId;
    let proposedSpendCategoryId = line.proposedSpendCategoryId;
    let proposedBaseUnitCode = line.proposedBaseUnitCode;
    let proposedVendorPurchaseUnitCode = line.proposedVendorPurchaseUnitCode;
    let proposedReceivingBehavior = line.proposedReceivingBehavior;
    let proposedFixedConversionFactor = line.proposedFixedConversionFactor;

    if (candidateItemId !== null) {
      const shortlist = shortlistsByLineKey.get(line.lineKey) ?? [];
      const validIds = new Set(shortlist.map((c) => c.id));
      if (!validIds.has(candidateItemId)) {
        issues.push({
          lineKey: line.lineKey,
          code: "CANDIDATE_NOT_IN_SHORTLIST",
          message: `Model returned candidateItemId "${candidateItemId}" that was not in the shortlist sent for this line -- discarded.`,
        });
        candidateItemId = null;
      }
    }

    if (candidateItemId !== null && (proposedName !== null || proposedDisposition !== null || proposedBaseUnitCode !== null)) {
      issues.push({
        lineKey: line.lineKey,
        code: "AMBIGUOUS_BOTH_CANDIDATE_AND_PROPOSAL",
        message: "Model returned both a candidateItemId and new-item proposal fields -- preferring the candidate match, discarding the proposal.",
      });
      proposedName = null;
      proposedDisposition = null;
      proposedCategoryId = null;
      proposedSpendCategoryId = null;
      proposedBaseUnitCode = null;
      proposedVendorPurchaseUnitCode = null;
      proposedReceivingBehavior = null;
      proposedFixedConversionFactor = null;
    }

    if (candidateItemId === null && proposedCategoryId !== null && !validCategoryIds.has(proposedCategoryId)) {
      issues.push({
        lineKey: line.lineKey,
        code: "UNKNOWN_INVENTORY_CATEGORY_ID",
        message: `Model returned suggestedInventoryCategoryId "${proposedCategoryId}" that was not in the candidate list sent for this batch -- discarded, requires manual selection.`,
      });
      proposedCategoryId = null;
    }

    if (candidateItemId === null && proposedSpendCategoryId !== null && !validSpendCategoryIds.has(proposedSpendCategoryId)) {
      issues.push({
        lineKey: line.lineKey,
        code: "UNKNOWN_SPEND_CATEGORY_ID",
        message: `Model returned suggestedSpendCategoryId "${proposedSpendCategoryId}" that was not in the candidate list sent for this batch -- discarded, requires manual selection.`,
      });
      proposedSpendCategoryId = null;
    }

    if (candidateItemId === null && proposedDisposition === "INVENTORY" && proposedBaseUnitCode !== null) {
      if (!knownUnitCodes.has(proposedBaseUnitCode)) {
        issues.push({
          lineKey: line.lineKey,
          code: "UNKNOWN_BASE_UNIT_CODE",
          message: `Model proposed unrecognized base unit code "${proposedBaseUnitCode}" -- discarded, requires manual selection.`,
        });
        proposedBaseUnitCode = null;
      }
    }

    if (candidateItemId === null && proposedDisposition === "INVENTORY" && proposedVendorPurchaseUnitCode !== null) {
      if (!knownUnitCodes.has(proposedVendorPurchaseUnitCode)) {
        issues.push({
          lineKey: line.lineKey,
          code: "UNKNOWN_VENDOR_PURCHASE_UNIT_CODE",
          message: `Model proposed unrecognized vendor purchase unit code "${proposedVendorPurchaseUnitCode}" -- discarded, requires manual selection.`,
        });
        proposedVendorPurchaseUnitCode = null;
      }
    }

    // Purchase-unit/receiving-behavior concepts are meaningless for a
    // NON_INVENTORY proposal or when there's no proposal at all (a
    // candidate match reuses whatever purchase-unit config that EXISTING
    // item was already confirmed with -- never a fresh AI guess).
    if (candidateItemId !== null || proposedDisposition !== "INVENTORY") {
      proposedBaseUnitCode = candidateItemId === null && proposedDisposition === "INVENTORY" ? proposedBaseUnitCode : null;
      proposedVendorPurchaseUnitCode = null;
      proposedReceivingBehavior = null;
      proposedFixedConversionFactor = null;
    }

    if (proposedReceivingBehavior === "FIXED_CONVERSION") {
      if (proposedFixedConversionFactor === null || proposedFixedConversionFactor <= 0) {
        issues.push({
          lineKey: line.lineKey,
          code: "MISSING_FIXED_CONVERSION_FACTOR",
          message: "Model proposed FIXED_CONVERSION with no valid factor -- discarded, requires manual selection.",
        });
        proposedReceivingBehavior = null;
        proposedFixedConversionFactor = null;
      }
    } else if (proposedFixedConversionFactor !== null) {
      // Never apply a fixed rate to a unit relationship the model itself
      // did not mark as fixed -- most importantly, never let a fabricated
      // factor survive under MEASURE_EACH_DELIVERY/COUNT_EACH_DELIVERY,
      // which exist specifically because no fixed rate is trustworthy.
      issues.push({
        lineKey: line.lineKey,
        code: "FIXED_CONVERSION_FACTOR_IGNORED",
        message: "Model proposed a fixed conversion factor without FIXED_CONVERSION behavior -- discarded.",
      });
      proposedFixedConversionFactor = null;
    }

    if (proposedReceivingBehavior === "SAME_UNIT" && proposedVendorPurchaseUnitCode !== null && proposedBaseUnitCode !== null && proposedVendorPurchaseUnitCode !== proposedBaseUnitCode) {
      // Internally inconsistent -- SAME_UNIT means there is no distinct
      // vendor purchase unit. Trust the explicit behavior, drop the
      // mismatched unit code rather than silently picking one.
      proposedVendorPurchaseUnitCode = proposedBaseUnitCode;
    }

    return {
      lineKey: line.lineKey,
      candidateItemId,
      proposedName,
      proposedDisposition,
      proposedCategoryId,
      proposedSpendCategoryId,
      proposedBaseUnitCode,
      proposedVendorPurchaseUnitCode,
      proposedReceivingBehavior,
      proposedFixedConversionFactor,
      confidence: line.confidence,
      reasoning: line.reasoning,
    };
  });

  return { lines: sanitized, issues };
}
