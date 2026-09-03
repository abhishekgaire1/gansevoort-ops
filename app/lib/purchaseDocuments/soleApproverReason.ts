/**
 * Pure, framework-free logic for the "Post Now as Sole Approver"
 * confirmation modal -- the reason options, which one requires free-text
 * notes, and whether the form as a whole may submit. Kept separate from
 * the modal component so it's directly unit-testable without mounting
 * anything (same "pure logic in app/lib, rendering in the component"
 * split used throughout this codebase).
 */

export type SoleApproverReasonCode = "SECOND_REVIEWER_UNAVAILABLE" | "TIME_SENSITIVE_RECEIVING" | "MANAGER_COMPLETED_FULL_REVIEW" | "OTHER";

export const SOLE_APPROVER_REASON_OPTIONS: { code: SoleApproverReasonCode; label: string }[] = [
  { code: "SECOND_REVIEWER_UNAVAILABLE", label: "Second reviewer unavailable" },
  { code: "TIME_SENSITIVE_RECEIVING", label: "Time-sensitive receiving" },
  { code: "MANAGER_COMPLETED_FULL_REVIEW", label: "Manager completed the full review" },
  { code: "OTHER", label: "Other" },
];

/** Only "Other" strictly requires free-text notes -- every other reason
 * may optionally carry notes, but a blank note is never itself blocking
 * for them. */
export function reasonRequiresNotes(reason: SoleApproverReasonCode | null): boolean {
  return reason === "OTHER";
}

export interface SoleApproverFormState {
  reason: SoleApproverReasonCode | null;
  notes: string;
  acknowledged: boolean;
}

/** The confirmation modal's own submit gate: a reason must be selected,
 * "Other" must carry non-blank notes, and the sole-approver
 * acknowledgment checkbox must be explicitly checked -- never defaulted
 * on. Never a substitute for the server's own authoritative checks; this
 * only decides whether the modal's own Confirm button is enabled. */
export function isSoleApproverFormValid(form: SoleApproverFormState): boolean {
  if (!form.reason) return false;
  if (reasonRequiresNotes(form.reason) && form.notes.trim() === "") return false;
  if (!form.acknowledged) return false;
  return true;
}
