import { describe, expect, it, vi } from "vitest";
import { continueFromStep1 } from "@/app/lib/purchaseDocuments/continueFromStep1";

/**
 * Directly proves the fix for the real "Continue to Items does nothing"
 * bug: the button used to unconditionally save-then-navigate with no gate
 * on required fields, so a click could "succeed" at saving and still get
 * silently clamped back to Step 1 by the wizard's step-progress
 * derivation, with no feedback at all. This function is now the single
 * source of truth for whether that click may proceed.
 */

describe("continueFromStep1", () => {
  it("clean Step 1 (nothing changed) advances immediately, without calling persistDraft", async () => {
    const persistDraft = vi.fn();
    const result = await continueFromStep1({ step1Complete: true, editable: true, isDirty: false, persistDraft });
    expect(result).toEqual({ advanced: true, error: null });
    expect(persistDraft).not.toHaveBeenCalled();
  });

  it("dirty Step 1 saves, then advances once the save succeeds", async () => {
    const persistDraft = vi.fn().mockResolvedValue({ ok: true });
    const result = await continueFromStep1({ step1Complete: true, editable: true, isDirty: true, persistDraft });
    expect(persistDraft).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ advanced: true, error: null });
  });

  it("a save failure keeps the manager on Step 1 with a visible error, never a silent no-op", async () => {
    const persistDraft = vi.fn().mockResolvedValue({ ok: false, message: "This document was updated elsewhere. Reload to see the latest version." });
    const result = await continueFromStep1({ step1Complete: true, editable: true, isDirty: true, persistDraft });
    expect(result.advanced).toBe(false);
    expect(result.error).toBe("This document was updated elsewhere. Reload to see the latest version.");
  });

  it("never advances, and never even attempts a save, while a required field is missing", async () => {
    const persistDraft = vi.fn();
    const result = await continueFromStep1({ step1Complete: false, editable: true, isDirty: true, persistDraft });
    expect(result.advanced).toBe(false);
    expect(result.error).toBeTruthy();
    expect(persistDraft).not.toHaveBeenCalled();
  });

  it("a read-only viewer advances immediately regardless of dirtiness -- there is nothing for them to save", async () => {
    const persistDraft = vi.fn();
    const result = await continueFromStep1({ step1Complete: true, editable: false, isDirty: true, persistDraft });
    expect(result).toEqual({ advanced: true, error: null });
    expect(persistDraft).not.toHaveBeenCalled();
  });
});
