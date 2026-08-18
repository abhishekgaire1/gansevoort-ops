/**
 * The exact decision the "Continue to Items" button makes -- pulled out as
 * a pure, directly-testable function because the bug this replaces lived
 * entirely in this control flow: the button used to unconditionally call
 * save-then-navigate with no gate on whether Step 1 actually had required
 * fields missing, so a click that "succeeded" at saving still got silently
 * clamped back to Step 1 by the wizard's own step-progress derivation --
 * with zero feedback. This function is now the single place that decides
 * whether the click may proceed at all, whether a save is even needed, and
 * exactly what to show if it fails -- the component only translates its
 * result into state updates.
 */

export interface ContinueFromStep1Input {
  /** False whenever Step 1 has at least one required-severity review flag
   * (e.g. a missing vendor or document date) -- mirrors exactly what
   * disables the Continue button itself, so this function can never be
   * called in a state the UI wouldn't have already blocked, and never
   * silently "succeeds" against incomplete data either way. */
  step1Complete: boolean;
  /** False for a read-only viewer (not the preparer, or not DRAFT) --
   * nothing to save, always safe to proceed straight through. */
  editable: boolean;
  /** False when the current header/lines are identical to what's already
   * persisted -- skips the round-trip entirely ("If everything is already
   * saved: Continue to Items -> Step 2 immediately," never a second
   * required Save Draft click first). */
  isDirty: boolean;
  persistDraft: () => Promise<{ ok: true } | { ok: false; message: string }>;
}

export interface ContinueFromStep1Result {
  advanced: boolean;
  error: string | null;
}

export async function continueFromStep1(input: ContinueFromStep1Input): Promise<ContinueFromStep1Result> {
  if (!input.step1Complete) {
    return { advanced: false, error: "Complete the required fields listed above before continuing." };
  }

  if (!input.editable || !input.isDirty) {
    return { advanced: true, error: null };
  }

  const result = await input.persistDraft();
  if (!result.ok) {
    return { advanced: false, error: result.message };
  }
  return { advanced: true, error: null };
}
