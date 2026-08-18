// Deliberately NOT "server-only" -- a pure derivation of Step 4's primary
// action from the document lifecycle, shared with the client component and
// directly unit-testable. Frontend prevention is UX only: the submit RPC's
// own DRAFT+version gate remains the integrity boundary regardless of what
// this renders.

import type { PurchaseDocumentStatus } from "@/app/lib/purchaseDocuments/types";

export type SendActionState =
  /** DRAFT, viewed by its own preparer: the real action -- enabled only
   * when the authoritative preparation gate says ready. */
  | { kind: "send"; enabled: boolean }
  /** Already submitted: never an actionable Send again -- an inert,
   * checked "Sent" state awaiting Manager 2 (Withdraw Submission is the
   * explicit separate action for taking it back). */
  | { kind: "sent" }
  /** No Send affordance at all: a non-preparer viewing someone else's
   * draft, or a terminal/non-submittable status. */
  | { kind: "hidden" };

export function deriveSendActionState(input: { status: PurchaseDocumentStatus; editable: boolean; ready: boolean }): SendActionState {
  if (input.status === "READY_FOR_VERIFICATION") return { kind: "sent" };
  if (input.status !== "DRAFT") return { kind: "hidden" }; // VERIFIED / DISCARDED never submit through this path
  if (!input.editable) return { kind: "hidden" }; // a non-preparer can't submit someone else's draft
  return { kind: "send", enabled: input.ready };
}
