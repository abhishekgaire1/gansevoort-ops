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

// Icon + word together, never color alone, so the state reads correctly
// without relying on hue perception.
const STATE_ICON: Record<WizardStepState, string> = {
  complete: "✓",
  current: "●",
  not_started: "○",
  needs_attention: "⚠",
};

const STATE_WORD: Record<WizardStepState, string> = {
  complete: "Done",
  current: "In progress",
  not_started: "Not started",
  needs_attention: "Needs attention",
};

const STATE_CLASS: Record<WizardStepState, string> = {
  complete: "border-emerald-600 bg-emerald-950/40 text-emerald-300",
  current: "border-amber-400 bg-amber-950/40 text-amber-200",
  not_started: "border-zinc-700 bg-zinc-900 text-zinc-300",
  needs_attention: "border-amber-500 bg-amber-950/50 text-amber-300",
};

const ICON_CLASS: Record<WizardStepState, string> = {
  complete: "text-emerald-400",
  current: "text-amber-300",
  not_started: "text-zinc-500",
  needs_attention: "text-amber-400",
};

/**
 * The persistent three-step navigation for the manager preparation
 * workflow. Every step's state is derived from existing backend data (see
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
  stepStatusText,
}: {
  steps: { id: WizardStepId; state: WizardStepState }[];
  activeStep: WizardStepId;
  furthestReachableStep: WizardStepId;
  onNavigate: (step: WizardStepId) => void;
  /** Extra status line under a specific step (e.g. "7 of 9 reviewed" or
   * "Complete — ready to continue" under Step 2) -- reported by that
   * step's own panel, never recomputed here. */
  stepStatusText?: Partial<Record<WizardStepId, string>>;
}) {
  return (
    <nav aria-label="Invoice preparation steps" className="rounded-2xl border border-zinc-800 bg-zinc-900 p-3">
      <p className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-zinc-400">Invoice Preparation</p>
      <ol className="flex flex-col gap-1.5 sm:flex-row sm:gap-2">
        {steps.map((step) => {
          const clickable = step.id <= furthestReachableStep;
          const status = stepStatusText?.[step.id];
          return (
            <li key={step.id} className="flex-1">
              <button
                type="button"
                onClick={() => clickable && onNavigate(step.id)}
                disabled={!clickable}
                aria-current={step.id === activeStep ? "step" : undefined}
                className={`flex w-full items-center gap-2 rounded-xl border-2 px-3 py-2 text-left text-sm transition disabled:cursor-not-allowed ${STATE_CLASS[step.state]} ${
                  step.id === activeStep ? "ring-2 ring-amber-400" : ""
                }`}
              >
                <span aria-hidden className={`text-lg font-bold leading-none ${ICON_CLASS[step.state]}`}>
                  {STATE_ICON[step.state]}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[10px] font-semibold uppercase tracking-wide text-zinc-300">
                    Step {step.id} · {STATE_WORD[step.state]}
                  </span>
                  <span className="block truncate font-semibold text-zinc-50">{STEP_LABELS[step.id]}</span>
                  {status ? <span className="block truncate text-xs font-medium text-zinc-200">{status}</span> : null}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
