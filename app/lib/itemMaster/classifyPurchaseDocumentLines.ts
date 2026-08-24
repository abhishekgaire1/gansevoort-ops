import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { resolveAIConfig } from "@/app/lib/ai/router/resolveAIConfig";
import { executeAITask } from "@/app/lib/ai/router/executeAITask";
import { runItemClassification } from "@/app/lib/ai/tasks/itemClassification/runItemClassification";
import type { UnresolvedClassificationLine } from "@/app/lib/ai/tasks/itemClassification/types";
import { resolveDeterministicClassification } from "@/app/lib/itemMaster/resolveDeterministicClassification";
import { buildItemShortlist } from "@/app/lib/itemMaster/buildItemShortlist";
import { buildClassificationCandidateContext } from "@/app/lib/itemMaster/buildClassificationCandidateContext";
import { getLinesNeedingClassification, type LineNeedingClassification } from "@/app/lib/itemMaster/getLinesNeedingClassification";
import { tryClaimClassificationRunRpc, finishClassificationRunRpc } from "@/app/lib/itemMaster/classificationRunClaimRpc";
import { resolveLineClassificationDeterministicRpc } from "@/app/lib/itemMaster/resolveLineClassificationDeterministicRpc";
import { recordDeterministicSuggestedCandidateRpc } from "@/app/lib/itemMaster/recordDeterministicSuggestedCandidateRpc";
import { recordAiSuggestedCandidateRpc } from "@/app/lib/itemMaster/recordAiSuggestedCandidateRpc";
import { recordAiItemProposalRpc } from "@/app/lib/itemMaster/recordAiItemProposalRpc";
import { VerifiedLockedError } from "@/app/lib/purchaseDocuments/errors";

/**
 * The 2A.3 classification orchestrator (plan §4/§9/§13). Safe to invoke
 * from any of its four call sites (auto after() on submit, auto after() on
 * review-correction/atomic-verify, page-load recovery check, manual "Run
 * Item Matching" button) -- concurrency is fully owned by the atomic claim
 * RPC, so overlapping invocations always converge to exactly one doing
 * real work.
 *
 * 1. Determine which current lines need (re-)classification (set-based,
 *    never a count comparison -- see getLinesNeedingClassification).
 * 2. If none, no-op without even attempting a claim.
 * 3. Claim the run; ALREADY_RUNNING means another caller already has it,
 *    so this invocation is a no-op too.
 * 4. Deterministic tier first, zero AI calls, for every line it resolves.
 * 5. Whatever's left goes to one batched AI call, using a per-line
 *    org-scoped CONFIRMED-only shortlist.
 * 6. finish the claim SUCCEEDED/FAILED in a try/finally, mirroring
 *    runDocumentExtractionAttempt.ts's shape.
 *
 * Per-line isolation (item-matching robustness fix, reproduced against a
 * real invoice -- Capital Paper Inc #178606): every per-line step below
 * (deterministic resolution, shortlist lookup, and recording an AI result)
 * is individually try/caught. Item matching is assistance, not a single
 * point of failure -- one line's write failing (a transient RPC error, or
 * two sibling lines proposing the identical new-item name, as reproduced)
 * must never discard every OTHER line's already-committed result, and must
 * never turn a run that mostly succeeded into one whose outcome is FAILED.
 * The ONE exception is VerifiedLockedError (GA003): the parent document
 * itself moved out of DRAFT/READY_FOR_VERIFICATION mid-run, so every
 * remaining write would fail identically -- that's a genuine whole-run
 * failure, not a per-line one, and is left to propagate to the outer
 * catch. Everything else is logged (full domain error, line key, stage)
 * for developers and left for getLinesNeedingClassification's set-based
 * recovery check to pick back up on the next run -- the Manager-facing
 * surface only ever needs to know "resolved" vs "still needs review,"
 * never the raw cause.
 *
 * options.includeUnconfirmedAiProposals: only ever passed true by the
 * manual "Run Item Matching" button (see runItemMatchingNow in
 * app/actions/itemClassification.ts) -- also re-resolves PENDING_REVIEW
 * lines whose current proposal came from AI, so a manager can refresh an
 * older proposal (e.g. one produced before a classifier fix) against the
 * current classifier on demand. Never passed true from an automatic
 * trigger (submit, review-correction, page-load recovery), which must keep
 * leaving an awaiting-review proposal alone. record_ai_item_proposal itself
 * reuses the existing pending item row rather than creating a duplicate,
 * and refuses to touch an already-CONFIRMED line regardless of this flag.
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

    const stillUnresolved: LineNeedingClassification[] = [];

    for (const line of needing) {
      try {
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
          stillUnresolved.push(line);
        }
      } catch (err) {
        if (err instanceof VerifiedLockedError) {
          // Document-wide: every remaining line's write will fail
          // identically (the parent document itself moved out of
          // DRAFT/READY_FOR_VERIFICATION). No point isolating further --
          // rethrow so the outer catch marks the whole run FAILED, which
          // is what actually happened.
          throw err;
        }
        // One line's deterministic resolution genuinely failed (e.g. a
        // transient RPC error) -- never let that discard every OTHER
        // line's already-committed progress. Log with full detail for
        // developers; leave this line unresolved so the AI tier gets a
        // chance at it, and -- if that also can't resolve it --
        // getLinesNeedingClassification's set-based recovery check picks
        // it back up on the next run.
        console.error("[item-classification] deterministic resolution failed for one line", {
          purchaseDocumentId,
          lineKey: line.lineKey,
          vendorSku: line.vendorSku,
          error: err instanceof Error ? err.message : String(err),
        });
        stillUnresolved.push(line);
      }
    }

    if (stillUnresolved.length > 0) {
      await classifyRemainingWithAI(supabase, organizationId, purchaseDocumentId, stillUnresolved, claim.claimId);
    }

    await finishClassificationRunRpc(supabase, { claimId: claim.claimId, organizationId, outcome: "SUCCEEDED" });
  } catch (err) {
    await finishClassificationRunRpc(supabase, { claimId: claim.claimId, organizationId, outcome: "FAILED" }).catch(() => {});
    throw err;
  }
}

async function classifyRemainingWithAI(
  supabase: SupabaseClient,
  organizationId: string,
  purchaseDocumentId: string,
  lines: LineNeedingClassification[],
  classificationRunClaimId: string
): Promise<void> {
  const candidateContext = await buildClassificationCandidateContext(supabase, organizationId);
  const knownUnitCodes = new Set(candidateContext.units.map((u) => u.code));

  const linesForAI: UnresolvedClassificationLine[] = [];
  for (const line of lines) {
    let shortlist: Awaited<ReturnType<typeof buildItemShortlist>> = [];
    try {
      shortlist = await buildItemShortlist(supabase, organizationId, line.description);
    } catch (err) {
      // One line's candidate-shortlist lookup failing must never block the
      // single shared AI call for every other line -- send this one
      // through with an empty shortlist (the model can still propose a new
      // item; it just has no existing-item candidate list to choose from).
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
      packageUnit: line.packageUnit,
      measuredUnit: line.measuredUnit,
      shortlist,
    });
  }

  // AI Configuration + Usage/Cost Tracking milestone: resolved fresh for
  // this run (task override -> org default -> app default) -- unlike
  // invoice extraction, item classification has no pre-existing attempt
  // table to freeze the choice onto ahead of time, so resolution and
  // execution happen back-to-back here. requestKey reuses the
  // classification run's own claim id (already a per-attempt-unique,
  // idempotency-safe identifier from tryClaimClassificationRunRpc), so a
  // retried invocation of the same run can never double-record cost.
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
      if (resultLine.candidateItemId) {
        await recordAiSuggestedCandidateRpc(supabase, {
          organizationId,
          purchaseDocumentId,
          lineKey: resultLine.lineKey,
          candidateInventoryItemId: resultLine.candidateItemId,
          aiConfidence: resultLine.confidence,
        });
      } else if (resultLine.proposedName) {
        await recordAiItemProposalRpc(supabase, {
          organizationId,
          purchaseDocumentId,
          lineKey: resultLine.lineKey,
          proposedName: resultLine.proposedName,
          proposedDisposition: resultLine.proposedDisposition,
          proposedCategoryId: resultLine.proposedCategoryId,
          proposedSpendCategoryId: resultLine.proposedSpendCategoryId,
          proposedBaseUnitCode: resultLine.proposedBaseUnitCode,
          aiConfidence: resultLine.confidence,
          proposedVendorPurchaseUnitCode: resultLine.proposedVendorPurchaseUnitCode,
          proposedReceivingBehavior: resultLine.proposedReceivingBehavior,
          proposedFixedConversionFactor: resultLine.proposedFixedConversionFactor,
        });
      }
      // Neither a candidate nor a usable new-item proposal: AI gave nothing
      // actionable for this line. No classification row is written, so the
      // set-based recovery check (getLinesNeedingClassification) will
      // correctly pick it back up as still-needing-classification on the
      // next run, rather than silently dropping it.
    } catch (err) {
      if (err instanceof VerifiedLockedError) {
        // Document-wide -- every remaining line's write will fail
        // identically. Stop here so the outer catch marks the whole run
        // FAILED, matching what actually happened.
        throw err;
      }
      // Reproduced against a real invoice (Capital Paper #178606): a
      // normal purchase line and a separate credit/return line for the
      // same physical product can both get AI-proposed as the same
      // brand-new item name. Without this isolation, a single such
      // collision (or any other one-line write failure) here would abort
      // the whole loop, discarding every other line's already-successful
      // result even though the AI call itself succeeded. Log full detail
      // for developers; leave this line unresolved so it's picked back up
      // as still-needing-classification on the next run.
      console.error("[item-classification] failed to record AI result for one line", {
        purchaseDocumentId,
        lineKey: resultLine.lineKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
