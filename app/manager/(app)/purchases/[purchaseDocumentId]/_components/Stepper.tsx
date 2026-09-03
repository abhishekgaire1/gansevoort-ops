"use client";

import type { WizardStepId, WizardStepState } from "@/app/lib/purchaseDocuments/deriveWizardProgress";

// Redesign: Steps 2 (Confirm Items) and 3 (Confirm Receiving) are now ONE
// step -- a manager used to have to hold item-matching, purchase-package,
// and receiving facts in mind across two separate screens (and Step 2's
// far-left invoice column vs. far-right mapping column even split related
// facts within one screen) to understand a single line. "Confirm Items &
// Receiving" reviews each invoice line in one place: what the invoice
// says, which item it matches, how the package converts, and how much was
// received, together. What was Step 4 ("Review & Send") is now Step 3
// ("Review & Post") -- it was already a pure summary of decisions made
// upstream, never introducing new information, so only its position and
// label changed.
const STEP_LABELS: Record<WizardStepId, string> = {
  1: "Review Invoice",
  2: "Confirm Items & Receiving",
  3: "Review & Post",
};

const STATE_ICON: Record<WizardStepState, string> = {
  complete: "✓",
  current: "●",
  not_started: "○",
  needs_attention: "⚠",
};

const STATE_CLASS: Record<WizardStepState, string> = {
  complete: "border-emerald-700 bg-emerald-950/30 text-emerald-300",
  current: "border-amber-500 bg-amber-950/30 text-amber-300",
  not_started: "border-zinc-800 bg-zinc-900 text-zinc-500",
  needs_attention: "border-amber-600 bg-amber-950/40 text-amber-400",
};

/**
 * The persistent four-step navigation for the manager preparation workflow.
 * Every step's state is derived from existing backend data (see
 * deriveWizardProgress.ts) -- this component only renders it and reports
 * clicks; it holds no workflow state of its own. Clickability comes from
 * REACHABILITY (never from the visual state): a manager can navigate
 * freely among every step up to the furthest reachable one -- backward to
 * completed steps AND forward again to a reachable later step -- but never
 * skip ahead of what's actually been resolved.
 */
export function Stepper({
  steps,
  activeStep,
  furthestReachableStep,
  onNavigate,
}: {
  steps: { id: WizardStepId; state: WizardStepState }[];
  activeStep: WizardStepId;
  furthestReachableStep: WizardStepId;
  onNavigate: (step: WizardStepId) => void;
}) {
  return (
    <nav aria-label="Invoice preparation steps" className="rounded-2xl border border-zinc-800 bg-zinc-900 p-3">
      <p className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">Invoice Preparation</p>
      <ol className="flex flex-col gap-1.5 sm:flex-row sm:gap-2">
        {steps.map((step) => {
          const clickable = step.id <= furthestReachableStep;
          return (
            <li key={step.id} className="flex-1">
              <button
                type="button"
                onClick={() => clickable && onNavigate(step.id)}
                disabled={!clickable}
                aria-current={step.id === activeStep ? "step" : undefined}
                className={`flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-left text-sm transition disabled:cursor-not-allowed ${STATE_CLASS[step.state]} ${
                  step.id === activeStep ? "ring-1 ring-amber-400" : ""
                }`}
              >
                <span aria-hidden className="text-base leading-none">
                  {STATE_ICON[step.state]}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[10px] uppercase tracking-wide text-zinc-500">Step {step.id}</span>
                  <span className="block truncate font-medium">{STEP_LABELS[step.id]}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
