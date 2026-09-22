import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { resolveAIConfig } from "@/app/lib/ai/router/resolveAIConfig";
import { executeAITask } from "@/app/lib/ai/router/executeAITask";
import { runItemClassification } from "@/app/lib/ai/tasks/itemClassification/runItemClassification";
import type { NormalizedItemClassificationLine, PriorTreatmentDecision, UnresolvedClassificationLine } from "@/app/lib/ai/tasks/itemClassification/types";
import { resolveDeterministicClassification } from "@/app/lib/itemMaster/resolveDeterministicClassification";
import { buildItemShortlist } from "@/app/lib/itemMaster/buildItemShortlist";
import { buildClassificationCandidateContext } from "@/app/lib/itemMaster/buildClassificationCandidateContext";
import { getLinesNeedingClassification, type LineNeedingClassification } from "@/app/lib/itemMaster/getLinesNeedingClassification";
import { tryClaimClassificationRunRpc, finishClassificationRunRpc } from "@/app/lib/itemMaster/classificationRunClaimRpc";
import { resolveLineClassificationDeterministicRpc } from "@/app/lib/itemMaster/resolveLineClassificationDeterministicRpc";
import { recordDeterministicSuggestedCandidateRpc } from "@/app/lib/itemMaster/recordDeterministicSuggestedCandidateRpc";
import { recordAiSuggestedCandidateRpc } from "@/app/lib/itemMaster/recordAiSuggestedCandidateRpc";
import { recordAiItemProposalRpc } from "@/app/lib/itemMaster/recordAiItemProposalRpc";
import { recordAiLineTreatmentRpc, findVendorLineTreatmentRuleRpc, type VendorLineTreatmentRuleMatch } from "@/app/lib/purchaseDocuments/lineTreatmentRpcs";
import { CONFIDENCE_MEDIUM } from "@/app/lib/purchaseDocuments/lineTreatment";
import { VerifiedLockedError } from "@/app/lib/purchaseDocuments/errors";

/**
 * The classification orchestrator. Safe to invoke from any of its call
 * sites (auto after() on submit/save, auto after() on review-correction/
 * atomic-verify, Step 1/Step 2 page-load recovery check, manual "Run Item
 * Matching" button) -- concurrency is fully owned by the atomic claim
 * RPC, so overlapping invocations always converge to exactly one doing
 * real work.
 *
 * 1. Determine which current lines need (re-)classification (set-based,
 *    never a count comparison -- see getLinesNeedingClassification).
 * 2. If none, no-op without even attempting a claim.
 * 3. Claim the run; ALREADY_RUNNING means another caller already has it.
 * 4. Deterministic tiers first, zero AI calls, for every line they resolve:
 *      a. a vendor-specific PRIOR TREATMENT DECISION (vendor_line_treatment_
 *         rules -- e.g. Bartlett Dairy + SKU 99 "CASES RETURNED" ->
 *         returnable-container credit), recorded as a pending "Matched
 *         previous decision" proposal UNLESS the current line's own
 *         evidence contradicts it (a credit rule on a positive amount, a
 *         charge rule on a negative one) -- a contradiction is never
 *         overridden silently: the rule is passed to the AI as context
 *         instead and the manager sees the AI's reasoning;
 *      b. the vendor-item mapping / normalized-name tiers (unchanged) for
 *         inventory purchases.
 * 5. Whatever's left goes to one batched AI call that returns each line's
 *    TREATMENT first (inventory purchase / expense / credit / discount /
 *    tax / freight / unresolved), then the treatment-specific fields.
 *    Results route to the writer that owns that treatment; every id was
 *    validated against the org-scoped candidate lists before this point,
 *    and the database writers re-validate again.
 * 6. finish the claim SUCCEEDED/FAILED in a try/finally.
 *
 * Per-line isolation: every per-line step is individually try/caught --
 * one line's write failing must never discard every OTHER line's
 * already-committed result. The ONE exception is VerifiedLockedError
 * (GA003): the parent document itself moved out of DRAFT/READY, so every
 * remaining write would fail identically -- a whole-run failure.
 */
export async function classifyPurchaseDocumentLines(
  purchaseDocumentId: string,
  organizationId: string,
  options?: { includeUnconfirmedAiProposals?: boolean }
): Promise<void> {
  const supabase = getServiceRoleClient();

  const needing = await getLinesNeedingClassification(supabase, purchaseDocumentId, organizationId, options);
  if (needing.length === 0) {
    return;
  }

  const claim = await tryClaimClassificationRunRpc(supabase, { purchaseDocumentId, organizationId });
  if (claim.status !== "CLAIMED" || !claim.claimId) {
    return;
  }

  try {
    const { data: purchaseDocument } = await supabase
      .from("purchase_documents")
      .select("vendor_id")
      .eq("id", purchaseDocumentId)
      .eq("organization_id", organizationId)
      .single();
    const vendorId = (purchaseDocument?.vendor_id as string | null | undefined) ?? null;

    const stillUnresolved: { line: LineNeedingClassification; priorDecision: PriorTreatmentDecision | null }[] = [];

    for (const line of needing) {
      try {
        // 4a. Vendor-specific prior treatment decision.
        let priorDecision: PriorTreatmentDecision | null = null;
        if (vendorId) {
          const rule = await lookupVendorRule(supabase, organizationId, vendorId, line, purchaseDocumentId);
          if (rule) {
            if (ruleContradictsEvidence(rule, line)) {
              priorDecision = { lineTreatment: rule.lineTreatment, creditSubtype: rule.creditSubtype, spendCategoryId: rule.spendCategoryId, matchBasis: rule.matchBasis };
            } else {
              await recordAiLineTreatmentRpc(supabase, {
                organizationId,
                purchaseDocumentId,
                lineKey: line.lineKey,
                proposedTreatment: rule.lineTreatment,
                proposedCreditSubtype: rule.creditSubtype,
                proposedSpendCategoryId: rule.spendCategoryId,
                proposedDiscountScope: rule.discountScope,
                confidence: 1,
                reason: `Matched a previous decision for this vendor (${rule.matchBasis === "VENDOR_SKU" ? `SKU ${line.vendorSku}` : "same description"}).`,
                evidence: [rule.matchBasis === "VENDOR_SKU" ? `vendor SKU ${line.vendorSku}` : "identical normalized description", "prior manager decision"],
                fieldsRequiringReview: [],
                resolutionSource: "VENDOR_TREATMENT_RULE",
                treatmentRuleId: rule.ruleId,
              });
              continue;
            }
          }
        }

        // 4b. Vendor item mapping / normalized name (inventory purchases).
        const match = await resolveDeterministicClassification(supabase, {
          organizationId,
          vendorId,
          vendorSku: line.vendorSku,
          description: line.description,
        });

        if (match && match.resolutionSource === "NORMALIZED_NAME_MATCH") {
          // A generic, org-wide exact-name match with no vendor scoping --
          // never auto-confirmed; requires the same manager review as an
          // AI-suggested candidate (see 20260811100058).
          await recordDeterministicSuggestedCandidateRpc(supabase, {
            organizationId,
            purchaseDocumentId,
            lineKey: line.lineKey,
            candidateInventoryItemId: match.inventoryItemId,
          });
        } else if (match) {
          await resolveLineClassificationDeterministicRpc(supabase, {
            organizationId,
            purchaseDocumentId,
            lineKey: line.lineKey,
            inventoryItemId: match.inventoryItemId,
            resolutionSource: match.resolutionSource,
          });
        } else {
          stillUnresolved.push({ line, priorDecision });
        }
      } catch (err) {
        if (err instanceof VerifiedLockedError) {
          throw err;
        }
        console.error("[item-classification] deterministic resolution failed for one line", {
          purchaseDocumentId,
          lineKey: line.lineKey,
          vendorSku: line.vendorSku,
          error: err instanceof Error ? err.message : String(err),
        });
        stillUnresolved.push({ line, priorDecision: null });
      }
    }

    if (stillUnresolved.length > 0) {
      await classifyRemainingWithAI(supabase, organizationId, purchaseDocumentId, vendorId, stillUnresolved, claim.claimId);
    }

    await finishClassificationRunRpc(supabase, { claimId: claim.claimId, organizationId, outcome: "SUCCEEDED" });
  } catch (err) {
    await finishClassificationRunRpc(supabase, { claimId: claim.claimId, organizationId, outcome: "FAILED" }).catch(() => {});
    throw err;
  }
}

async function lookupVendorRule(
  supabase: SupabaseClient,
  organizationId: string,
  vendorId: string,
  line: LineNeedingClassification,
  purchaseDocumentId: string
): Promise<VendorLineTreatmentRuleMatch | null> {
  try {
    return await findVendorLineTreatmentRuleRpc(supabase, { organizationId, vendorId, vendorSku: line.vendorSku, description: line.description });
  } catch (err) {
    // A rule lookup failing is never a reason to stop classifying -- the
    // line simply proceeds through the other tiers.
    console.error("[item-classification] vendor treatment rule lookup failed for one line", {
      purchaseDocumentId,
      lineKey: line.lineKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** A prior decision is applied only when the current line's own evidence
 * is consistent with it: a credit/discount rule needs a non-positive
 * amount (or no amount), a charge/expense/tax rule a non-negative one.
 * Anything else is a contradiction the manager must see. */
export function ruleContradictsEvidence(rule: { lineTreatment: string }, line: { lineTotal: number | null }): boolean {
  if (line.lineTotal === null) return false;
  if (rule.lineTreatment === "CREDIT_RETURN" || rule.lineTreatment === "DISCOUNT") return line.lineTotal > 0;
  return line.lineTotal < 0;
}

async function classifyRemainingWithAI(
  supabase: SupabaseClient,
  organizationId: string,
  purchaseDocumentId: string,
  vendorId: string | null,
  entries: { line: LineNeedingClassification; priorDecision: PriorTreatmentDecision | null }[],
  classificationRunClaimId: string
): Promise<void> {
  const candidateContext = await buildClassificationCandidateContext(supabase, organizationId, vendorId);
  const knownUnitCodes = new Set(candidateContext.units.map((u) => u.code));

  const linesForAI: UnresolvedClassificationLine[] = [];
  for (const { line, priorDecision } of entries) {
    let shortlist: Awaited<ReturnType<typeof buildItemShortlist>> = [];
    try {
      shortlist = await buildItemShortlist(supabase, organizationId, line.description);
    } catch (err) {
      console.error("[item-classification] shortlist lookup failed for one line", {
        purchaseDocumentId,
        lineKey: line.lineKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    linesForAI.push({
      lineKey: line.lineKey,
      vendorSku: line.vendorSku,
      description: line.description,
      packageQuantity: line.packageQuantity,
      packageUnit: line.packageUnit,
      measuredQuantity: line.measuredQuantity,
      measuredUnit: line.measuredUnit,
      unitPrice: line.unitPrice,
      lineTotal: line.lineTotal,
      shortlist,
      priorDecision,
    });
  }

  const aiConfig = await resolveAIConfig(supabase, organizationId, "ITEM_CLASSIFICATION");
  const result = await executeAITask({
    organizationId,
    task: "ITEM_CLASSIFICATION",
    provider: aiConfig.provider,
    model: aiConfig.model,
    requestKey: classificationRunClaimId,
    sourceType: "purchase_document",
    sourceId: purchaseDocumentId,
    run: async (provider, model) => {
      const classification = await runItemClassification(provider, candidateContext, linesForAI, knownUnitCodes, model);
      return { data: classification, raw: classification.raw, model: classification.model, provider: classification.provider };
    },
  });

  for (const resultLine of result.lines) {
    try {
      await recordAiResult(supabase, organizationId, purchaseDocumentId, resultLine);
    } catch (err) {
      if (err instanceof VerifiedLockedError) {
        throw err;
      }
      console.error("[item-classification] failed to record AI result for one line", {
        purchaseDocumentId,
        lineKey: resultLine.lineKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** Routes one validated AI result to the writer that owns its treatment.
 * Inventory purchases keep the existing item writers (candidate match /
 * new-item proposal); every other treatment -- and any inventory purchase
 * too uncertain to propose an item for -- goes to record_ai_line_
 * treatment, which applies the confidence policy in the database. */
async function recordAiResult(supabase: SupabaseClient, organizationId: string, purchaseDocumentId: string, resultLine: NormalizedItemClassificationLine): Promise<void> {
  const treatment = resultLine.proposedLineTreatment ?? (resultLine.candidateItemId || resultLine.proposedName ? "INVENTORY_PURCHASE" : "UNRESOLVED");
  const confidence = resultLine.confidence ?? 0;

  if (treatment === "INVENTORY_PURCHASE" && resultLine.candidateItemId) {
    await recordAiSuggestedCandidateRpc(supabase, {
      organizationId,
      purchaseDocumentId,
      lineKey: resultLine.lineKey,
      candidateInventoryItemId: resultLine.candidateItemId,
      aiConfidence: resultLine.confidence,
    });
    return;
  }

  if (treatment === "INVENTORY_PURCHASE" && resultLine.proposedName && confidence >= CONFIDENCE_MEDIUM) {
    await recordAiItemProposalRpc(supabase, {
      organizationId,
      purchaseDocumentId,
      lineKey: resultLine.lineKey,
      proposedName: resultLine.proposedName,
      proposedDisposition: "INVENTORY",
      proposedCategoryId: resultLine.proposedCategoryId,
      proposedSpendCategoryId: resultLine.proposedSpendCategoryId,
      proposedBaseUnitCode: resultLine.proposedBaseUnitCode,
      aiConfidence: resultLine.confidence,
      proposedVendorPurchaseUnitCode: resultLine.proposedVendorPurchaseUnitCode,
      proposedReceivingBehavior: resultLine.proposedReceivingBehavior,
      proposedFixedConversionFactor: resultLine.proposedFixedConversionFactor,
    });
    return;
  }

  // Every non-item treatment, plus an inventory purchase the model could
  // not confidently resolve to an item (< 0.70): the database writer
  // lands it UNRESOLVED with the raw proposal preserved for display --
  // never an invented item named after the description.
  await recordAiLineTreatmentRpc(supabase, {
    organizationId,
    purchaseDocumentId,
    lineKey: resultLine.lineKey,
    proposedTreatment: treatment,
    proposedCreditSubtype: resultLine.proposedCreditSubtype,
    proposedSpendCategoryId: resultLine.proposedSpendCategoryId,
    proposedDiscountScope: resultLine.proposedDiscountScope,
    confidence: resultLine.confidence,
    reason: resultLine.reasoning,
    evidence: resultLine.evidence,
    fieldsRequiringReview: resultLine.fieldsRequiringReview,
    resolutionSource: "AI_SUGGESTED",
    treatmentRuleId: null,
  });
}
