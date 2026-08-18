import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { GeminiProvider } from "@/app/lib/ai/providers/gemini";
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
    }

    if (stillUnresolved.length > 0) {
      await classifyRemainingWithAI(supabase, organizationId, purchaseDocumentId, stillUnresolved);
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
  lines: LineNeedingClassification[]
): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set");
  }

  const candidateContext = await buildClassificationCandidateContext(supabase, organizationId);
  const knownUnitCodes = new Set(candidateContext.units.map((u) => u.code));

  const linesForAI: UnresolvedClassificationLine[] = [];
  for (const line of lines) {
    const shortlist = await buildItemShortlist(supabase, organizationId, line.description);
    linesForAI.push({
      lineKey: line.lineKey,
      vendorSku: line.vendorSku,
      description: line.description,
      packageUnit: line.packageUnit,
      measuredUnit: line.measuredUnit,
      shortlist,
    });
  }

  const provider = new GeminiProvider(apiKey);
  const result = await runItemClassification(provider, candidateContext, linesForAI, knownUnitCodes);

  for (const resultLine of result.lines) {
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
  }
}
