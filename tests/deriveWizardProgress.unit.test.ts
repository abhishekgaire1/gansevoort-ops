import { describe, expect, it } from "vitest";
import { deriveWizardProgress } from "@/app/lib/purchaseDocuments/deriveWizardProgress";

/**
 * COMPLETION, REACHABILITY, and ACTIVE STEP are three separate values --
 * a real browser-tested bug conflated them: activeStep used to default to
 * the furthest reachable step, so the instant Step 1's last required
 * field became valid (or AI matching finished on Step 2, or a receipt
 * landed on Step 3) the wizard auto-navigated forward without any click.
 * Completion may only mark steps complete, unlock the next step, and
 * enable Continue -- navigation happens exclusively through an explicit
 * requestedStep (Continue/Stepper click, or the ?step= URL param), merely
 * clamped by reachability.
 */
describe("deriveWizardProgress -- completion never navigates", () => {
  it("starts on step 1 when nothing is complete", () => {
    const { activeStep, furthestReachableStep, steps } = deriveWizardProgress({ step1Complete: false, step2Complete: null, step3Complete: null });
    expect(activeStep).toBe(1);
    expect(furthestReachableStep).toBe(1);
    expect(steps.find((s) => s.id === 1)?.state).toBe("current");
    expect(steps.find((s) => s.id === 2)?.state).toBe("not_started");
  });

  it("step 1 becoming complete makes step 2 REACHABLE but the manager REMAINS on step 1 -- no auto-jump on the last valid keystroke", () => {
    const { activeStep, furthestReachableStep, steps } = deriveWizardProgress({
      step1Complete: true,
      step2Complete: null,
      step3Complete: null,
      requestedStep: null, // no explicit navigation has happened
    });
    expect(furthestReachableStep).toBe(2); // Continue to Items is now allowed
    expect(activeStep).toBe(1); // but the view does not move
    // Receiving UX pass: the step the manager is CURRENTLY viewing never
    // shows a completion checkmark, even once its own requirements are
    // already satisfied -- "current" and "complete" are different facts,
    // and showing both at once is exactly the confusing state this pass
    // removes. The checkmark appears once the manager has moved on.
    expect(steps.find((s) => s.id === 1)?.state).toBe("current");
  });

  it("clicking Continue to Items (an explicit requestedStep) is what navigates to step 2", () => {
    const { activeStep } = deriveWizardProgress({ step1Complete: true, step2Complete: null, step3Complete: null, requestedStep: 2 });
    expect(activeStep).toBe(2);
  });

  it("once the manager has moved on, the now-past step DOES show its completion checkmark", () => {
    const { steps } = deriveWizardProgress({ step1Complete: true, step2Complete: null, step3Complete: null, requestedStep: 2 });
    expect(steps.find((s) => s.id === 1)?.state).toBe("complete");
    expect(steps.find((s) => s.id === 2)?.state).toBe("current");
  });

  it("a currently-viewed step whose OWN requirements are already met still reads as current, never complete -- true for step 2 as well as step 1", () => {
    const { steps } = deriveWizardProgress({ step1Complete: true, step2Complete: true, step3Complete: null, requestedStep: 2 });
    expect(steps.find((s) => s.id === 2)?.state).toBe("current");
  });

  it("step 2's AI matching / last new-item verification finishing asynchronously enables Continue but the manager REMAINS on step 2", () => {
    // Manager explicitly navigated to step 2 earlier; matching then
    // completes in the background.
    const { activeStep, furthestReachableStep } = deriveWizardProgress({
      step1Complete: true,
      step2Complete: true, // async completion just landed
      step3Complete: null,
      requestedStep: 2, // still where the manager last navigated
    });
    expect(furthestReachableStep).toBe(3);
    expect(activeStep).toBe(2); // inspect "✓ All items confirmed" in peace
  });

  it("step 3 receiving becoming complete after recordReceipt enables Continue but the manager REMAINS on step 3", () => {
    const { activeStep, furthestReachableStep } = deriveWizardProgress({
      step1Complete: true,
      step2Complete: true,
      step3Complete: true, // the refetch after Record Receipt just landed
      requestedStep: 3,
    });
    expect(furthestReachableStep).toBe(4);
    expect(activeStep).toBe(3); // one last visual inspection of quantities/locations
  });

  it("clicking Continue to Review & Send navigates to step 4", () => {
    const { activeStep } = deriveWizardProgress({ step1Complete: true, step2Complete: true, step3Complete: true, requestedStep: 4 });
    expect(activeStep).toBe(4);
  });

  it("backward navigation to an earlier completed step sticks -- later steps staying reachable never bounces the manager forward", () => {
    const { activeStep, furthestReachableStep } = deriveWizardProgress({
      step1Complete: true,
      step2Complete: true,
      step3Complete: true,
      requestedStep: 1, // manager clicked back to Step 1
    });
    expect(furthestReachableStep).toBe(4);
    expect(activeStep).toBe(1); // stable -- no auto-bounce to 3/4
  });

  it("a refresh with an explicit ?step= (fed back in as requestedStep) restores that exact step", () => {
    const { activeStep } = deriveWizardProgress({ step1Complete: true, step2Complete: true, step3Complete: null, requestedStep: 3 });
    expect(activeStep).toBe(3);
  });

  it("a manually-entered future step beyond reachability is clamped backward, never honored", () => {
    const { activeStep } = deriveWizardProgress({ step1Complete: true, step2Complete: false, step3Complete: null, requestedStep: 4 });
    expect(activeStep).toBe(2); // clamped to the furthest reachable step
  });

  it("with no explicit navigation at all, a fully-complete document still lands on step 1 -- completion alone never chooses the view", () => {
    const { activeStep, furthestReachableStep } = deriveWizardProgress({
      step1Complete: true,
      step2Complete: true,
      step3Complete: true,
      requestedStep: null,
    });
    expect(furthestReachableStep).toBe(4);
    expect(activeStep).toBe(1);
  });

  it("flags step 2 as needing attention (e.g. a STALE line) instead of merely current", () => {
    const { steps } = deriveWizardProgress({ step1Complete: true, step2Complete: false, step3Complete: null, step2NeedsAttention: true });
    expect(steps.find((s) => s.id === 2)?.state).toBe("needs_attention");
  });

  it("treats step2Complete=null as incomplete even if step 1 is done, never falsely marking it complete before data loads", () => {
    const { steps, furthestReachableStep } = deriveWizardProgress({ step1Complete: true, step2Complete: null, step3Complete: null });
    expect(steps.find((s) => s.id === 2)?.state).not.toBe("complete");
    expect(furthestReachableStep).toBe(2);
  });
});
