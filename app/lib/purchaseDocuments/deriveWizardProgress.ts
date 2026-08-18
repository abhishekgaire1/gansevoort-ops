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
  /** The manager's own explicit backward-navigation choice, if any --
   * clamped below to never exceed the furthest reachable step (no
   * skipping ahead of an incomplete step). */
  requestedStep?: WizardStepId | null;
}

export interface WizardProgress {
  steps: WizardStepStatus[];
  activeStep: WizardStepId;
}

export function deriveWizardProgress(input: DeriveWizardProgressInput): WizardProgress {
  const step2Known = input.step2Complete === true;
  const step3Known = input.step3Complete === true;

  // The furthest step the manager has actually reached -- the first one
  // that isn't yet complete, or step 4 if everything upstream is done.
  let furthestReachable: WizardStepId = 1;
  if (input.step1Complete) furthestReachable = 2;
  if (input.step1Complete && step2Known) furthestReachable = 3;
  if (input.step1Complete && step2Known && step3Known) furthestReachable = 4;

  const activeStep: WizardStepId = input.requestedStep ? (Math.min(input.requestedStep, furthestReachable) as WizardStepId) : furthestReachable;

  function stateFor(id: WizardStepId, complete: boolean): WizardStepState {
    if (complete) return "complete";
    if (id === 2 && input.step2NeedsAttention) return "needs_attention";
    if (id === activeStep) return "current";
    return id < furthestReachable ? "complete" : "not_started";
  }

  const steps: WizardStepStatus[] = [
    { id: 1, state: stateFor(1, input.step1Complete) },
    { id: 2, state: stateFor(2, input.step1Complete && step2Known) },
    { id: 3, state: stateFor(3, input.step1Complete && step2Known && step3Known) },
    { id: 4, state: stateFor(4, false) },
  ];

  return { steps, activeStep };
}
