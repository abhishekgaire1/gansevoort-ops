// Deliberately NOT "server-only" -- shared shapes and pure helpers for
// Manager 2's provisional correction overlay, used by the client review
// UI and server code alike (same sharing rationale as
// preparationBlockers.ts).
//
// CORE RULE: these are PROPOSALS. They are persisted (so a refresh never
// loses the reviewer's work) but persisted != authoritative -- only
// verify_purchase_document's atomic promotion turns them into real
// receipt corrections / classification approvals, and Return to Preparer
// discards them (preserving a copy inside the RETURNED audit event).

import type { PreparationBlocker } from "@/app/lib/purchaseDocuments/preparationBlockers";
import type { ReceiptLineConditionStatus } from "@/app/lib/receiving/types";

export interface MappingProposal {
  inventoryItemId: string;
}

export interface ReceivingProposal {
  receivedQuantity: number;
  receivedUnit: string | null;
  verifiedBaseQuantity: number | null;
  locationId: string | null;
  conditionStatus: ReceiptLineConditionStatus;
}

/** Keyed by line_key. */
export type MappingProposals = Record<string, MappingProposal>;
/** Keyed by receipt_line_id (a specific effective receipt line -- an
 * additional-delivery occurrence is a distinct correction target). */
export type ReceivingProposals = Record<string, ReceivingProposal>;

/** Blocker reasons a pending MAPPING proposal provisionally addresses --
 * the classification-resolution family from getPreparationStatus. */
const MAPPING_BLOCKER_PATTERN = /classification|item match|classified/i;
/** Blocker reasons a pending RECEIVING proposal provisionally addresses --
 * the recorded-facts-vs-configuration mismatch family. */
const RECEIVING_BLOCKER_PATTERN = /receiving needs review/i;

/**
 * UI-preview courtesy only, never the authority: filters out line-level
 * blockers that a pending proposal on that line plausibly resolves, so
 * Final Verify isn't dead-locked behind a blocker whose fix is exactly
 * the pending correction the verify will promote. Document-level
 * blockers (lineKey null) are never filtered. verify_purchase_document
 * re-runs the real gates on the POST-promotion state regardless -- a
 * proposal that doesn't actually resolve the blocker still fails there
 * with the exact reason.
 */
export function blockersUnresolvedByProposals(
  blockers: PreparationBlocker[],
  mappingProposalLineKeys: ReadonlySet<string>,
  receivingProposalLineKeys: ReadonlySet<string>
): PreparationBlocker[] {
  return blockers.filter((blocker) => {
    if (blocker.lineKey === null) return true;
    if (mappingProposalLineKeys.has(blocker.lineKey) && MAPPING_BLOCKER_PATTERN.test(blocker.reason)) return false;
    if (receivingProposalLineKeys.has(blocker.lineKey) && RECEIVING_BLOCKER_PATTERN.test(blocker.reason)) return false;
    return true;
  });
}

export function proposalCount(mapping: MappingProposals, receiving: ReceivingProposals): number {
  return Object.keys(mapping).length + Object.keys(receiving).length;
}
