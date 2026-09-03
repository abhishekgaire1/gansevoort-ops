import { describe, expect, it } from "vitest";
import { deriveWizardProgress } from "@/app/lib/purchaseDocuments/deriveWizardProgress";

/**
 * COMPLETION, REACHABILITY, and ACTIVE STEP are three separate values --
 * a real browser-tested bug conflated them: activeStep used to default to
 * the furthest reachable step, so the instant Step 1's last required
 * field became valid (or matching/receiving finished on Step 2) the
 * wizard auto-navigated forward without any click. Completion may only
 * mark steps complete, unlock the next step, and enable Continue --
 * navigation happens exclusively through an explicit requestedStep
 * (Continue/Stepper click, or the ?step= URL param), merely clamped by
 * reachability.
 *
 * Redesign: the wizard is now 3 steps -- step 2 ("Confirm Items &
 * Receiving") combines what used to be separate item-matching and
 * receiving steps, so step2Complete here is that COMBINED completion
 * fact (see combinedLineReadiness.ts). Step 3 ("Review & Post") is
 * terminal, like the old wizard's Step 4 -- it never shows its own
 * completion checkmark.
 */
describe("deriveWizardProgress -- completion never navigates", () => {
  it("test 1: the workflow now has exactly three steps", () => {
    const { steps } = deriveWizardProgress({ step1Complete: true, step2Complete: true, requestedStep: 1 });
    expect(steps.map((s) => s.id)).toEqual([1, 2, 3]);
  });

  it("starts on step 1 when nothing is complete", () => {
    const { activeStep, furthestReachableStep, steps } = deriveWizardProgress({ step1Complete: false, step2Complete: null });
    expect(activeStep).toBe(1);
    expect(furthestReachableStep).toBe(1);
    expect(steps.find((s) => s.id === 1)?.state).toBe("current");
    expect(steps.find((s) => s.id === 2)?.state).toBe("not_started");
  });

  it("step 1 becoming complete makes step 2 REACHABLE but the manager REMAINS on step 1 -- no auto-jump on the last valid keystroke", () => {
    const { activeStep, furthestReachableStep, steps } = deriveWizardProgress({
      step1Complete: true,
      step2Complete: null,
      requestedStep: null, // no explicit navigation has happened
    });
    expect(furthestReachableStep).toBe(2); // Continue to Items & Receiving is now allowed
    expect(activeStep).toBe(1); // but the view does not move
    // Receiving UX pass: the step the manager is CURRENTLY viewing never
    // shows a completion checkmark, even once its own requirements are
    // already satisfied -- "current" and "complete" are different facts,
    // and showing both at once is exactly the confusing state this pass
    // removes. The checkmark appears once the manager has moved on.
    expect(steps.find((s) => s.id === 1)?.state).toBe("current");
  });

  it("clicking Continue to Items & Receiving (an explicit requestedStep) is what navigates to step 2", () => {
    const { activeStep } = deriveWizardProgress({ step1Complete: true, step2Complete: null, requestedStep: 2 });
    expect(activeStep).toBe(2);
  });

  it("once the manager has moved on, the now-past step DOES show its completion checkmark", () => {
    const { steps } = deriveWizardProgress({ step1Complete: true, step2Complete: null, requestedStep: 2 });
    expect(steps.find((s) => s.id === 1)?.state).toBe("complete");
    expect(steps.find((s) => s.id === 2)?.state).toBe("current");
  });

  it("a currently-viewed step whose OWN requirements are already met still reads as current, never complete -- true for step 2 as well as step 1", () => {
    const { steps } = deriveWizardProgress({ step1Complete: true, step2Complete: true, requestedStep: 2 });
    expect(steps.find((s) => s.id === 2)?.state).toBe("current");
  });

  it("step 2's item matching and receiving both finishing asynchronously enables Continue but the manager REMAINS on step 2", () => {
    // Manager explicitly navigated to step 2 earlier; the combined
    // item+receiving readiness completes in the background.
    const { activeStep, furthestReachableStep } = deriveWizardProgress({
      step1Complete: true,
      step2Complete: true, // async completion just landed
      requestedStep: 2, // still where the manager last navigated
    });
    expect(furthestReachableStep).toBe(3);
    expect(activeStep).toBe(2); // inspect "6 of 8 lines ready" in peace
  });

  it("clicking Continue to Review & Post navigates to step 3", () => {
    const { activeStep } = deriveWizardProgress({ step1Complete: true, step2Complete: true, requestedStep: 3 });
    expect(activeStep).toBe(3);
  });

  it("step 3 (Review & Post) is terminal -- it never shows its own completion checkmark", () => {
    const { steps } = deriveWizardProgress({ step1Complete: true, step2Complete: true, requestedStep: 3 });
    expect(steps.find((s) => s.id === 3)?.state).toBe("current");
  });

  it("backward navigation to an earlier completed step sticks -- later steps staying reachable never bounces the manager forward", () => {
    const { activeStep, furthestReachableStep } = deriveWizardProgress({
      step1Complete: true,
      step2Complete: true,
      requestedStep: 1, // manager clicked back to Step 1
    });
    expect(furthestReachableStep).toBe(3);
    expect(activeStep).toBe(1); // stable -- no auto-bounce to 2/3
  });

  it("a refresh with an explicit ?step= (fed back in as requestedStep) restores that exact step", () => {
    const { activeStep } = deriveWizardProgress({ step1Complete: true, step2Complete: true, requestedStep: 3 });
    expect(activeStep).toBe(3);
  });

  it("a manually-entered future step beyond reachability is clamped backward, never honored", () => {
    const { activeStep } = deriveWizardProgress({ step1Complete: true, step2Complete: false, requestedStep: 3 });
    expect(activeStep).toBe(2); // clamped to the furthest reachable step
  });

  it("with no explicit navigation at all, a fully-complete document still lands on step 1 -- completion alone never chooses the view", () => {
    const { activeStep, furthestReachableStep } = deriveWizardProgress({
      step1Complete: true,
      step2Complete: true,
      requestedStep: null,
    });
    expect(furthestReachableStep).toBe(3);
    expect(activeStep).toBe(1);
  });

  it("flags step 2 as needing attention (e.g. a purchase-package mismatch or a line still needing receiving) instead of merely current", () => {
    const { steps } = deriveWizardProgress({ step1Complete: true, step2Complete: false, step2NeedsAttention: true });
    expect(steps.find((s) => s.id === 2)?.state).toBe("needs_attention");
  });

  it("treats step2Complete=null as incomplete even if step 1 is done, never falsely marking it complete before data loads", () => {
    const { steps, furthestReachableStep } = deriveWizardProgress({ step1Complete: true, step2Complete: null });
    expect(steps.find((s) => s.id === 2)?.state).not.toBe("complete");
    expect(furthestReachableStep).toBe(2);
  });
});
