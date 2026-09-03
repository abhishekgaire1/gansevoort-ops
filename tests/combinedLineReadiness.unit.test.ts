import { describe, expect, it } from "vitest";
import { classifyLineOutcome, summarizeCombinedStep, type CombinedLineReadinessInput } from "@/app/lib/purchaseDocuments/combinedLineReadiness";

/**
 * Redesign: combined "Confirm Items & Receiving" step -- the single
 * shared per-line readiness decision (badge, auto-expand, footer counts,
 * and the step's own completion gate all read from this, never a
 * separately-recomputed copy).
 */

const readyLine: CombinedLineReadinessInput = { status: "CONFIRMED", disposition: "INVENTORY", hasPackageMismatch: false, receivingReady: true };

describe("classifyLineOutcome", () => {
  it("test 3: a fully resolved inventory line (confirmed match, matching package, complete receiving) is ready", () => {
    expect(classifyLineOutcome(readyLine)).toBe("ready");
  });

  it("test 4 + 8: an unclassified/pending line, a purchase-package mismatch, and incomplete receiving each need attention", () => {
    expect(classifyLineOutcome({ ...readyLine, status: "PENDING_REVIEW" })).toBe("needs_attention");
    expect(classifyLineOutcome({ ...readyLine, status: "UNCLASSIFIED" })).toBe("needs_attention");
    expect(classifyLineOutcome({ ...readyLine, hasPackageMismatch: true })).toBe("needs_attention");
    expect(classifyLineOutcome({ ...readyLine, receivingReady: false })).toBe("needs_attention");
  });

  it("test 11: a correctly classified expense (NON_INVENTORY, confirmed) is its own outcome, never blocked by receiving", () => {
    expect(classifyLineOutcome({ status: "CONFIRMED", disposition: "NON_INVENTORY", hasPackageMismatch: false, receivingReady: null })).toBe("expense");
  });

  it("test 9: correcting a mismatch changes the line's outcome to ready", () => {
    const before = classifyLineOutcome({ ...readyLine, hasPackageMismatch: true });
    const after = classifyLineOutcome({ ...readyLine, hasPackageMismatch: false });
    expect(before).toBe("needs_attention");
    expect(after).toBe("ready");
  });

  it("a NON_INVENTORY line that hasn't actually been confirmed yet still needs attention, not treated as an expense prematurely", () => {
    expect(classifyLineOutcome({ status: "PENDING_REVIEW", disposition: "NON_INVENTORY", hasPackageMismatch: false, receivingReady: null })).toBe("needs_attention");
  });
});

describe("summarizeCombinedStep", () => {
  it("test 1 (component of): counts ready/needs-attention/expense lines and gates allResolved on zero unresolved lines", () => {
    const summary = summarizeCombinedStep(["ready", "ready", "needs_attention", "expense"]);
    expect(summary).toEqual({ totalLines: 4, readyCount: 2, needsAttentionCount: 1, expenseCount: 1, allResolved: false });
  });

  it("is resolved once every line is ready or a correctly classified expense", () => {
    expect(summarizeCombinedStep(["ready", "expense", "ready"]).allResolved).toBe(true);
  });

  it("an empty document is never treated as resolved", () => {
    expect(summarizeCombinedStep([]).allResolved).toBe(false);
  });
});
