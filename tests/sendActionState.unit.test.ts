import { describe, expect, it } from "vitest";
import { deriveSendActionState } from "@/app/lib/purchaseDocuments/sendActionState";

/**
 * Step 4's primary action must honestly represent the document lifecycle:
 * an already-submitted document must never render an actionable Send
 * button again (a real browser-found bug: the preparer viewing their own
 * READY_FOR_VERIFICATION document saw an active Send whose click could
 * only ever produce a backend rejection). Frontend prevention is UX; the
 * submit RPC's own DRAFT+version gate remains the integrity boundary.
 */
describe("deriveSendActionState", () => {
  it("DRAFT + ready + preparer -> Send, enabled", () => {
    expect(deriveSendActionState({ status: "DRAFT", editable: true, ready: true })).toEqual({ kind: "send", enabled: true });
  });

  it("DRAFT + not ready + preparer -> Send, disabled (blockers shown alongside; no click-to-discover-error)", () => {
    expect(deriveSendActionState({ status: "DRAFT", editable: true, ready: false })).toEqual({ kind: "send", enabled: false });
  });

  it("READY_FOR_VERIFICATION -> inert Sent state, never an actionable Send -- even though the gate reads ready", () => {
    expect(deriveSendActionState({ status: "READY_FOR_VERIFICATION", editable: false, ready: true })).toEqual({ kind: "sent" });
  });

  it("a non-preparer viewing someone else's DRAFT gets no Send affordance at all", () => {
    expect(deriveSendActionState({ status: "DRAFT", editable: false, ready: true })).toEqual({ kind: "hidden" });
  });

  it("VERIFIED and DISCARDED never offer Send through the preparation path", () => {
    expect(deriveSendActionState({ status: "VERIFIED", editable: false, ready: true })).toEqual({ kind: "hidden" });
    expect(deriveSendActionState({ status: "DISCARDED", editable: false, ready: false })).toEqual({ kind: "hidden" });
  });

  it("after Withdraw Submission / Return to Preparer restores DRAFT, Send becomes available again for the preparer", () => {
    // The same derivation, fed the post-withdrawal/post-return state.
    expect(deriveSendActionState({ status: "DRAFT", editable: true, ready: true })).toEqual({ kind: "send", enabled: true });
  });
});
