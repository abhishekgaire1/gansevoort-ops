import type { ReceivingItemStatus } from "@/app/lib/documents/documentStatus";
import type { StatusTone } from "@/app/components/manager/StatusBadge";

/**
 * Manager-facing presentation for the Receiving Queue (Manager UX &
 * Navigation Milestone, Part 8/10/17) -- maps the CANONICAL
 * ReceivingItemStatus (never changed by this module) to a compact tab
 * group, a human status label/tone, and an obvious next-action label.
 * Pure and framework-agnostic so it's directly unit-testable; the page
 * component only renders what this returns.
 */

export type ReceivingTabKey = "ALL" | "NEEDS_ATTENTION" | "READY_FOR_VERIFICATION" | "VERIFIED";

export const RECEIVING_TABS: { key: ReceivingTabKey; label: string }[] = [
  { key: "ALL", label: "All" },
  { key: "NEEDS_ATTENTION", label: "Needs Attention" },
  { key: "READY_FOR_VERIFICATION", label: "Ready for Verification" },
  { key: "VERIFIED", label: "Verified" },
];

// Everything the manager still needs to DO something about: pick up an
// extracted document, fix a stalled/failed extraction, or finish a draft.
// READY_FOR_VERIFICATION and VERIFIED get their own dedicated tabs since
// they're each a distinct, high-volume workflow stage on their own.
const NEEDS_ATTENTION_STATUSES: ReceivingItemStatus[] = ["NEEDS_REVIEW", "STALLED", "FAILED", "DRAFT"];

export function receivingTabForStatus(status: ReceivingItemStatus): ReceivingTabKey {
  if (status === "READY_FOR_VERIFICATION") return "READY_FOR_VERIFICATION";
  if (status === "VERIFIED") return "VERIFIED";
  if (NEEDS_ATTENTION_STATUSES.includes(status)) return "NEEDS_ATTENTION";
  return "ALL"; // PROCESSING (still automatically working, no action yet) and the unreachable DISCARDED
}

export function matchesReceivingTab(status: ReceivingItemStatus, tab: ReceivingTabKey): boolean {
  return tab === "ALL" || receivingTabForStatus(status) === tab;
}

export interface ReceivingStatusPresentation {
  label: string;
  tone: StatusTone;
  /** The obvious next action for a row in this status (Part 10/18) --
   * null means there is genuinely nothing to click yet (still
   * processing automatically), or -- for READY_FOR_VERIFICATION viewed
   * by its own preparer -- that no action exists for THIS viewer even
   * though the document is actionable for someone else. */
  actionLabel: string | null;
}

/** The queue-row shape of get_purchase_documents_inventory_posting_status
 * (V1 Ready-to-Post queue fix, 20260811100107) -- the batched sibling of
 * the VERIFIED detail page's own purchase_document_inventory_posting_status.
 * requiredLineCount === 0 means this VERIFIED document has no physical
 * inventory lines at all (e.g. entirely non-inventory) -- never shown as
 * "Ready to Post" since there is nothing to post. */
export interface QueueInventoryPostingStatus {
  status: "NOT_POSTED" | "PARTIALLY_POSTED" | "POSTED";
  requiredLineCount: number;
}

/**
 * Status Language -- Verification milestone: the SAME canonical
 * READY_FOR_VERIFICATION status reads differently depending on the
 * current viewer's relationship to the document -- never a second/third
 * database status, purely a presentation split over the one existing
 * enum value.
 *
 *   preparer          -- the manager who submitted it. Their work is
 *                        done; this is someone else's job now. Never
 *                        offered an action (self-verification is
 *                        prohibited server-side regardless -- this just
 *                        keeps the UI from implying they can act).
 *   eligible_verifier -- any OTHER manager/admin. This is real,
 *                        actionable work for them.
 *   generic           -- the relationship genuinely isn't known (e.g. a
 *                        defensive fallback when the preparer id wasn't
 *                        resolved) -- deliberately neutral wording,
 *                        never implying the viewer can or cannot act.
 */
export type ViewerRelationship = "preparer" | "eligible_verifier" | "generic";

export function receivingStatusPresentation(
  status: ReceivingItemStatus,
  viewer: ViewerRelationship = "generic",
  postingStatus?: QueueInventoryPostingStatus | null
): ReceivingStatusPresentation {
  switch (status) {
    case "PROCESSING":
      return { label: "Processing", tone: "neutral", actionLabel: null };
    case "STALLED":
      return { label: "Extraction Stalled", tone: "warning", actionLabel: "View →" };
    case "NEEDS_REVIEW":
      return { label: "Needs Review", tone: "info", actionLabel: "Continue Review →" };
    case "FAILED":
      return { label: "Extraction Failed", tone: "danger", actionLabel: "View →" };
    case "DRAFT":
      return { label: "Draft", tone: "info", actionLabel: "Continue Review →" };
    case "READY_FOR_VERIFICATION":
      if (viewer === "preparer") return { label: "Sent for Verification", tone: "warning", actionLabel: "View →" };
      if (viewer === "eligible_verifier") return { label: "Needs Verification", tone: "warning", actionLabel: "Verify →" };
      return { label: "Awaiting Verification", tone: "warning", actionLabel: "View →" };
    case "VERIFIED":
      // READY TO POST remains derived presentation, never a DB enum
      // (Section 2): VERIFIED + contains inventory + not fully posted.
      // requiredLineCount === 0 (no physical inventory lines at all) falls
      // through to the plain "Verified" label -- there is nothing to post.
      if (postingStatus && postingStatus.requiredLineCount > 0) {
        if (postingStatus.status === "NOT_POSTED") {
          return { label: "Ready to Post", tone: "success", actionLabel: "Post to Inventory →" };
        }
        if (postingStatus.status === "PARTIALLY_POSTED") {
          return { label: "Partially Posted", tone: "warning", actionLabel: "Review →" };
        }
        return { label: "Posted", tone: "success", actionLabel: "View →" };
      }
      return { label: "Verified", tone: "success", actionLabel: "View Invoice →" };
    case "DISCARDED":
      return { label: "Discarded", tone: "neutral", actionLabel: "View →" };
  }
}

/** Derives the viewer's relationship to a document from its preparer id
 * -- the SAME identity (purchase_documents.created_by_app_user_id) the
 * app already uses everywhere else to decide self-verification
 * eligibility, never a new/different rule. */
export function viewerRelationshipFor(createdByAppUserId: string | null, currentAppUserId: string): ViewerRelationship {
  if (createdByAppUserId === null) return "generic";
  return createdByAppUserId === currentAppUserId ? "preparer" : "eligible_verifier";
}
