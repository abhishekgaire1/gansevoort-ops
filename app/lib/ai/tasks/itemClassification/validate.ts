import type { ClassificationCandidateContext, ItemClassificationIssue, ItemShortlistCandidate, NormalizedItemClassificationLine } from "./types";

/**
 * Deterministic, non-AI validation over the already-normalized output --
 * Gemini is never the final validator, this is. Re-checks every returned
 * candidateItemId is literally present in the shortlist that was SENT for
 * that specific line, and every proposedCategoryId/proposedSpendCategoryId
 * is literally present in the org-wide candidate context that was sent for
 * this whole batch (never trusted blindly, even though both were already
 * org-scoped -- belt and suspenders), validates unit codes against the
 * known global unit-code set, and strips every field that does not belong
 * to the returned treatment (a TAX line can never carry an item proposal;
 * an EXPENSE never carries a purchase package). Returns a SANITIZED copy of
 * the lines, never the raw model output directly -- an invalid id, unit
 * code, or an internally-inconsistent receiving-behavior/conversion-factor
 * pair is stripped here, downgrading that line to "no confident
 * suggestion" rather than ever letting a hallucinated id, unit, or
 * fabricated fixed conversion reach a database write.
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
    let proposedCategoryId = line.proposedCategoryId;
    let proposedSpendCategoryId = line.proposedSpendCategoryId;
    let proposedBaseUnitCode = line.proposedBaseUnitCode;
    let proposedVendorPurchaseUnitCode = line.proposedVendorPurchaseUnitCode;
    let proposedReceivingBehavior = line.proposedReceivingBehavior;
    let proposedFixedConversionFactor = line.proposedFixedConversionFactor;
    let proposedCreditSubtype = line.proposedCreditSubtype ?? null;
    let proposedDiscountScope = line.proposedDiscountScope ?? null;

    // Treatment: explicit, or derived from the legacy disposition/item
    // fields when a caller only supplied those.
    let treatment = line.proposedLineTreatment ?? null;
    if (treatment === null) {
      if (candidateItemId !== null || proposedName !== null || line.proposedDisposition === "INVENTORY") treatment = "INVENTORY_PURCHASE";
      else if (line.proposedDisposition === "NON_INVENTORY") treatment = "EXPENSE";
    }

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

    // A candidate item match IS an inventory purchase, whatever the model
    // said about treatment.
    if (candidateItemId !== null && treatment !== "INVENTORY_PURCHASE") {
      issues.push({ lineKey: line.lineKey, code: "CANDIDATE_IMPLIES_INVENTORY_PURCHASE", message: `Model returned a candidate item together with treatment ${treatment} -- treating the line as an inventory purchase.` });
      treatment = "INVENTORY_PURCHASE";
    }

    if (candidateItemId !== null && (proposedName !== null || proposedBaseUnitCode !== null)) {
      issues.push({
        lineKey: line.lineKey,
        code: "AMBIGUOUS_BOTH_CANDIDATE_AND_PROPOSAL",
        message: "Model returned both a candidateItemId and new-item proposal fields -- preferring the candidate match, discarding the proposal.",
      });
      proposedName = null;
      proposedCategoryId = null;
      proposedSpendCategoryId = null;
      proposedBaseUnitCode = null;
      proposedVendorPurchaseUnitCode = null;
      proposedReceivingBehavior = null;
      proposedFixedConversionFactor = null;
    }

    if (proposedCategoryId !== null && !validCategoryIds.has(proposedCategoryId)) {
      issues.push({
        lineKey: line.lineKey,
        code: "UNKNOWN_INVENTORY_CATEGORY_ID",
        message: `Model returned suggestedInventoryCategoryId "${proposedCategoryId}" that was not in the candidate list sent for this batch -- discarded, requires manual selection.`,
      });
      proposedCategoryId = null;
    }

    if (proposedSpendCategoryId !== null && !validSpendCategoryIds.has(proposedSpendCategoryId)) {
      issues.push({
        lineKey: line.lineKey,
        code: "UNKNOWN_SPEND_CATEGORY_ID",
        message: `Model returned suggestedSpendCategoryId "${proposedSpendCategoryId}" that was not in the candidate list sent for this batch -- discarded, requires manual selection.`,
      });
      proposedSpendCategoryId = null;
    }

    // Treatment-specific field ownership: strip whatever the treatment
    // cannot carry, so a writer can never be handed an item proposal for a
    // tax line or a category for a credit.
    const isInventory = treatment === "INVENTORY_PURCHASE";
    if (!isInventory) {
      if (proposedName !== null || proposedCategoryId !== null || proposedBaseUnitCode !== null || proposedVendorPurchaseUnitCode !== null || proposedReceivingBehavior !== null || proposedFixedConversionFactor !== null) {
        issues.push({ lineKey: line.lineKey, code: "ITEM_FIELDS_ON_NON_INVENTORY_LINE", message: `Model returned item fields on a ${treatment ?? "unresolved"} line -- discarded.` });
      }
      proposedName = null;
      proposedCategoryId = null;
      proposedBaseUnitCode = null;
      proposedVendorPurchaseUnitCode = null;
      proposedReceivingBehavior = null;
      proposedFixedConversionFactor = null;
      if (treatment !== "EXPENSE" && treatment !== "FREIGHT_FEE") proposedSpendCategoryId = null;
    }
    if (treatment !== "CREDIT_RETURN") proposedCreditSubtype = null;
    if (treatment !== "DISCOUNT") proposedDiscountScope = null;

    if (isInventory && candidateItemId === null && proposedBaseUnitCode !== null && !knownUnitCodes.has(proposedBaseUnitCode)) {
      issues.push({
        lineKey: line.lineKey,
        code: "UNKNOWN_BASE_UNIT_CODE",
        message: `Model proposed unrecognized base unit code "${proposedBaseUnitCode}" -- discarded, requires manual selection.`,
      });
      proposedBaseUnitCode = null;
    }

    if (isInventory && candidateItemId === null && proposedVendorPurchaseUnitCode !== null && !knownUnitCodes.has(proposedVendorPurchaseUnitCode)) {
      issues.push({
        lineKey: line.lineKey,
        code: "UNKNOWN_VENDOR_PURCHASE_UNIT_CODE",
        message: `Model proposed unrecognized vendor purchase unit code "${proposedVendorPurchaseUnitCode}" -- discarded, requires manual selection.`,
      });
      proposedVendorPurchaseUnitCode = null;
    }

    // A candidate match reuses whatever purchase-unit config that EXISTING
    // item was already confirmed with -- never a fresh AI guess.
    if (candidateItemId !== null) {
      proposedBaseUnitCode = null;
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
      proposedVendorPurchaseUnitCode = proposedBaseUnitCode;
    }

    const proposedDisposition: NormalizedItemClassificationLine["proposedDisposition"] =
      treatment === null || treatment === "UNRESOLVED" ? null : isInventory ? "INVENTORY" : "NON_INVENTORY";

    return {
      lineKey: line.lineKey,
      proposedLineTreatment: treatment,
      proposedCreditSubtype,
      proposedDiscountScope,
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
      evidence: line.evidence ?? [],
      fieldsRequiringReview: line.fieldsRequiringReview ?? [],
    };
  });

  return { lines: sanitized, issues };
}
