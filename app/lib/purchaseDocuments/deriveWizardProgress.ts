/**
 * The 4-step manager preparation wizard's progress is entirely DERIVED from
 * existing backend state -- never a second, independently-persisted
 * workflow-state system. Step 1 completeness comes from
 * validatePurchaseDocumentDraft's error-severity flags (header/vendor/type/
 * total), step 2 from whether every current line's classification is
 * CONFIRMED (getPurchaseDocumentLineClassifications), and step 3/4 from the
 * existing first-manager completion gate's own preview
 * (getPreparationStatus, backed by the same RPC-enforced rule
 * submit_purchase_document_for_verification already uses authoritatively).
 * Refreshing the page re-derives the same progress from the same data --
 * there is nothing to lose.
 */

export type WizardStepId = 1 | 2 | 3 | 4;
export type WizardStepState = "complete" | "current" | "not_started" | "needs_attention";

export interface WizardStepStatus {
  id: WizardStepId;
  state: WizardStepState;
}

export interface DeriveWizardProgressInput {
  /** True once the header has no error-severity review flags (vendor,
   * document type/number/date, total all present). */
  step1Complete: boolean;
  /** True once every CURRENT line's classification is CONFIRMED. Null
   * while classification data hasn't loaded yet -- treated as incomplete,
   * never falsely marked complete before we actually know. */
  step2Complete: boolean | null;
  /** True once the existing completion-gate preview reports ready (which,
   * once step 2 is complete, can only still be blocked by receiving). Null
   * while not yet loaded. */
  step3Complete: boolean | null;
  /** True if any line has a STALE classification or an AI proposal
   * awaiting the manager's review -- surfaces "needs_attention" instead of
   * plain "current"/"not_started" for step 2. */
  step2NeedsAttention?: boolean;
  /** The manager's own explicit navigation choice (a Continue click, a
   * Stepper click, or the ?step= URL param they navigated to/refreshed
   * on). Clamped below to never exceed the furthest reachable step, but
   * NEVER auto-advanced: null means "no explicit navigation yet," which
   * lands on step 1 -- not on the furthest reachable step. */
  requestedStep?: WizardStepId | null;
}

export interface WizardProgress {
  steps: WizardStepStatus[];
  activeStep: WizardStepId;
  /** The furthest step the manager is ALLOWED to visit -- distinct from
   * activeStep (what they're currently viewing) and from per-step
   * completion. Exposed so callers/tests can reason about reachability
   * without re-deriving it. */
  furthestReachableStep: WizardStepId;
}

/**
 * COMPLETION, REACHABILITY, and the ACTIVE STEP are three separate
 * concepts (a real browser-tested bug conflated them):
 *   1. completion -- which steps are finished (the checkmarks);
 *   2. reachability -- the furthest step the manager MAY visit, derived
 *      from completion;
 *   3. activeStep -- the step the manager is CURRENTLY viewing, which
 *      changes ONLY through an explicit navigation (requestedStep) and is
 *      merely CLAMPED by reachability, never pulled forward by it.
 * Completing a step therefore marks it complete, unlocks the next step,
 * and enables its Continue button -- but the manager stays exactly where
 * they are (step1Complete=true, furthestReachable=2, activeStep=1 is a
 * valid, stable state) until they deliberately click Continue/the
 * Stepper. Previously `activeStep` defaulted to `furthestReachable`
 * whenever no explicit request existed, so the instant the last required
 * Step 1 field became valid (live validation runs per keystroke) the
 * wizard auto-jumped to Step 2 -- and async completions (AI matching
 * finishing, a receipt recording) auto-jumped Steps 2/3 the same way.
 */
export function deriveWizardProgress(input: DeriveWizardProgressInput): WizardProgress {
  const step2Known = input.step2Complete === true;
  const step3Known = input.step3Complete === true;

  // Reachability: the first not-yet-complete step (or 4 when everything
  // upstream is done).
  let furthestReachable: WizardStepId = 1;
  if (input.step1Complete) furthestReachable = 2;
  if (input.step1Complete && step2Known) furthestReachable = 3;
  if (input.step1Complete && step2Known && step3Known) furthestReachable = 4;

  // Active step: explicit navigation only, clamped by reachability. No
  // explicit navigation yet = step 1. (Refresh keeps the manager's place
  // because every explicit navigation also writes ?step=, which feeds
  // back in here as requestedStep.)
  const activeStep: WizardStepId = Math.min(input.requestedStep ?? 1, furthestReachable) as WizardStepId;

  // Receiving UX pass: the currently-VIEWED step must never render with a
  // completion checkmark, even once its own requirements are already
  // satisfied (e.g. the manager is looking at an already-resolved Step 2
  // right before clicking Continue) -- "current" and "complete" are
  // different facts about a step, and conflating them is exactly the
  // "current step looks completed" bug this pass is fixing. Reachability/
  // clickability (furthestReachableStep) are untouched -- only the visual
  // state label for the active step changes.
  function stateFor(id: WizardStepId, complete: boolean): WizardStepState {
    if (id === activeStep) {
      if (id === 2 && input.step2NeedsAttention) return "needs_attention";
      return "current";
    }
    if (complete) return "complete";
    if (id === 2 && input.step2NeedsAttention) return "needs_attention";
    return id < furthestReachable ? "complete" : "not_started";
  }

  const steps: WizardStepStatus[] = [
    { id: 1, state: stateFor(1, input.step1Complete) },
    { id: 2, state: stateFor(2, input.step1Complete && step2Known) },
    { id: 3, state: stateFor(3, input.step1Complete && step2Known && step3Known) },
    { id: 4, state: stateFor(4, false) },
  ];

  return { steps, activeStep, furthestReachableStep: furthestReachable };
}
